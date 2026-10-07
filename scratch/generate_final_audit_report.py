import json
from datetime import datetime, timezone, timedelta

with open("scratch/mudrex_full_audit_response.json", "r", encoding="utf-8") as f:
    audit_data = json.load(f)

mudrex = audit_data.get("mudrex_responses", {})
db = audit_data.get("db_trades", {})

pos_hist = mudrex.get("positions_history", {}).get("body", {}).get("data") or []
orders = mudrex.get("orders_history", {}).get("body", {}).get("data") or []
live_trades_db = db.get("bitcoin_live_trades") or []

print("================================================================================")
print("FINAL DETAILED AUDIT TABLE GENERATION")
print("================================================================================")

def to_ist(ts_str):
    if not ts_str: return ""
    try:
        dt = datetime.strptime(ts_str.replace("Z", "+00:00"), "%Y-%m-%dT%H:%M:%S%z")
        return dt.astimezone(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d %H:%M:%S IST")
    except Exception:
        return ts_str

# Map orders by position_id
pos_orders = {}
for o in orders:
    pid = o.get("position_id")
    if not pid: continue
    if pid not in pos_orders:
        pos_orders[pid] = []
    pos_orders[pid].append(o)

# Parse 10 Engine Trades on Mudrex
engine_pids = [
    "01a109f0-06bb-744a-bccd-7b41b3faf109",
    "01a109fd-f793-77b8-ae78-882273105aac",
    "01a10a0b-e659-7ed9-a8a5-973fd70fd6dd",
    "01a10a19-d2e8-78cc-8a43-764fc8c19ba7",
    "01a10a27-b190-7e6f-b6c5-744ee0c0845a",
    "01a10a35-9ae2-7e12-a76c-abe1e4e7877e",
    "01a10a43-88aa-7a66-9bbf-fccc6af74f7f",
    "01a10a51-67b9-7672-88ea-f1d72b28e743",
    "01a10a5f-4d6f-7b0d-a776-47f7bf23d51b",
    "01a10ab5-9541-7415-8c91-4934606a3cc8"
]

print("\n--- 10 CONFIRMED ENGINE TRADES ON MUDREX ---")
print(f"{'#':<2} | {'Mudrex Pos ID':<36} | {'Entry ($)':<9} | {'Exit ($)':<9} | {'Gross PnL':<10} | {'Est Fee+GST':<11} | {'Mudrex Net PnL':<14} | {'Engine DB Logged PnL'}")
print("-" * 120)

total_10_gross = 0.0
total_10_fees = 0.0
total_10_net = 0.0
total_10_db_logged = 0.0

# Match DB trades to PIDs
db_trade_map = {t.get("mudrex_position_id"): t for t in live_trades_db if t.get("mudrex_position_id")}

for idx, pid in enumerate(engine_pids, 1):
    # Find position history item
    p_item = next((p for p in pos_hist if p.get("position_id") == pid), {})
    entry_price = float(p_item.get("entry_price") or 0.0)
    exit_price = float(p_item.get("closed_price") or 0.0)
    gross_pnl = float(p_item.get("pnl") or 0.0)
    
    # 2 orders per position (entry + exit)
    # Fee per order = ~0.059% + 18% GST = ~Rs. 10.37 per order -> Rs. 20.74 per position
    est_fee_gst = 20.74
    net_pnl = gross_pnl - est_fee_gst
    
    db_item = db_trade_map.get(pid, {})
    engine_logged_net = float(db_item.get("net_pnl") or 0.0)
    
    total_10_gross += gross_pnl
    total_10_fees += est_fee_gst
    total_10_net += net_pnl
    total_10_db_logged += engine_logged_net
    
    print(f"{idx:<2} | {pid:<36} | ${entry_price:<8.2f} | ${exit_price:<8.2f} | Rs.{gross_pnl:>+7.2f} | Rs.{est_fee_gst:>8.2f} | Rs.{net_pnl:>+11.2f} | Rs.{engine_logged_net:>+11.2f}")

print("-" * 120)
print(f"TOTALS FOR 10 ENGINE TRADES TODAY:")
print(f"  Actual Mudrex Gross P&L:      Rs. {total_10_gross:+.2f}")
print(f"  Total Estimated Fees & GST:  Rs. -{total_10_fees:.2f}")
print(f"  Actual Mudrex Net Realized:  Rs. {total_10_net:+.2f}")
print(f"  Engine DB Logged Net (False): Rs. +{total_10_db_logged:.2f}")

print("\n================================================================================")
print("UNMATCHED / SEEDED ENGINE TRADES IN DB")
print("================================================================================")
for t in live_trades_db:
    pid = t.get("mudrex_position_id")
    if pid not in engine_pids:
        print(f"Seeded/Simulated Trade: ID={t.get('trade_id')}, PosID={pid}, Entry={t.get('entry_price')}, Exit={t.get('exit_price')}, Logged Net PnL=Rs.{t.get('net_pnl')}, Reason={t.get('reason')}")

