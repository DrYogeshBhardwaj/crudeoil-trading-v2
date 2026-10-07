import json
from datetime import datetime, timezone, timedelta

with open("scratch/mudrex_full_audit_response.json", "r", encoding="utf-8") as f:
    audit_data = json.load(f)

mudrex = audit_data.get("mudrex_responses", {})
db = audit_data.get("db_trades", {})

pos_hist = mudrex.get("positions_history", {}).get("body", {}).get("data") or []
orders = mudrex.get("orders_history", {}).get("body", {}).get("data") or []
funds = mudrex.get("futures_funds_inr", {}).get("body", {}).get("data") or {}

print("================================================================================")
print("AUDIT OF NEW TRADES SINCE Rs. 4,566.842 AUDIT")
print("================================================================================")

def to_ist(ts_str):
    if not ts_str: return ""
    try:
        dt = datetime.strptime(ts_str.replace("Z", "+00:00"), "%Y-%m-%dT%H:%M:%S%z")
        return dt.astimezone(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d %H:%M:%S IST")
    except Exception:
        return ts_str

# Sort positions chronologically by created_at
pos_hist.sort(key=lambda x: x.get("created_at", ""))

# Find cutoff position 01a10ac3-77dc-7674-bb05-46b0e83ed8cd
cutoff_pid = "01a10ac3-77dc-7674-bb05-46b0e83ed8cd"

new_positions = []
found_cutoff = False

for p in pos_hist:
    pid = p.get("position_id")
    if found_cutoff:
        new_positions.append(p)
    if pid == cutoff_pid:
        found_cutoff = True

print(f"New Positions Count after cutoff: {len(new_positions)}")

# Map orders by position ID
pos_orders_map = {}
for o in orders:
    pid = o.get("position_id")
    if not pid: continue
    if pid not in pos_orders_map:
        pos_orders_map[pid] = []
    pos_orders_map[pid].append(o)

print("\n------------------------------------------------------------------------------------------------------------------------")
print(f"{'#':<2} | {'Mudrex Pos ID':<36} | {'Side':<4} | {'Entry ($)':<9} | {'Exit ($)':<9} | {'Gross PnL':<10} | {'Est Fee+GST':<11} | {'Mudrex Net PnL':<14} | {'Closed Time (IST)'}")
print("------------------------------------------------------------------------------------------------------------------------")

total_new_gross = 0.0
total_new_fees = 0.0
total_new_net = 0.0
reached_100_net_count = 0
closed_before_100_count = 0

for idx, p in enumerate(new_positions, 1):
    pid = p.get("position_id")
    ptype = p.get("position_type")
    qty = float(p.get("quantity") or 0.002)
    entry_usd = float(p.get("entry_price") or 0.0)
    exit_usd = float(p.get("closed_price") or 0.0)
    gross_pnl = float(p.get("pnl") or 0.0)
    closed_time = to_ist(p.get("updated_at"))
    
    # 2 orders per position -> fee + GST = 0.059% per order -> ~Rs. 10.37 * 2 = Rs. 20.74 per trade
    ords = pos_orders_map.get(pid, [])
    fee_gst = 0.0
    for o in ords:
        amt = float(o.get("actual_amount") or 0.0)
        if amt <= 0:
            p_val = float(o.get("filled_price") or o.get("price") or 0.0)
            q_val = float(o.get("filled_quantity") or o.get("quantity") or qty)
            amt = p_val * q_val * 102.0
        fee_gst += (amt * 0.00059)
        
    if fee_gst == 0.0:
        fee_gst = (entry_usd * qty * 102.0 * 0.00059) + (exit_usd * qty * 102.0 * 0.00059)
        
    net_pnl = gross_pnl - fee_gst
    
    total_new_gross += gross_pnl
    total_new_fees += fee_gst
    total_new_net += net_pnl
    
    if net_pnl >= 100.0:
        reached_100_net_count += 1
    else:
        closed_before_100_count += 1
        
    print(f"{idx:<2} | {pid:<36} | {ptype:<4} | ${entry_usd:<8.2f} | ${exit_usd:<8.2f} | Rs.{gross_pnl:>+7.2f} | Rs.{fee_gst:>8.2f} | Rs.{net_pnl:>+11.2f} | {closed_time}")

print("------------------------------------------------------------------------------------------------------------------------")
print(f"SUM OF NEW TRADES PERFORMANCE:")
print(f"  Total Realized Gross P&L:   Rs. {total_new_gross:+.2f}")
print(f"  Total Trading Fees & GST:   Rs. -{total_new_fees:.2f}")
print(f"  Total Realized Net P&L:     Rs. {total_new_net:+.2f}")
print(f"  Trades Reached +Rs.100 NET: {reached_100_net_count}")
print(f"  Trades Closed Before Target: {closed_before_100_count}")

# Wallet Balance Check
starting_ref = 4566.842
current_cash_bal = float(funds.get("balance") or 0.0)
current_locked = float(funds.get("locked_amount") or 0.0)
total_current = current_cash_bal + current_locked

print("\n=== MATHEMATICAL RECONCILIATION ===")
print(f"Previous Reference Balance:  Rs. {starting_ref:>10.3f}")
print(f"Current Cash Balance:        Rs. {current_cash_bal:>10.3f}")
print(f"Current Locked Margin:       Rs. {current_locked:>10.3f}")
print(f"Total Current Equity:        Rs. {total_current:>10.3f}")
print(f"Expected Equity (Ref + Net): Rs. {starting_ref + total_new_net:>10.3f}")
print(f"Discrepancy:                 Rs. {(starting_ref + total_new_net) - total_current:>10.3f}")

