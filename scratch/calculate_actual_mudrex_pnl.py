import json
from datetime import datetime, timezone, timedelta

with open("scratch/mudrex_full_audit_response.json", "r", encoding="utf-8") as f:
    audit_data = json.load(f)

mudrex = audit_data.get("mudrex_responses", {})
db = audit_data.get("db_trades", {})

orders = mudrex.get("orders_history", {}).get("body", {}).get("data") or []

# Fixed USD to INR rate used in system or standard conversion
# Let's check if mudrex provides exchange rate or if 1 USD = 100 INR / 88.5 INR etc.
# Mudrex USDT/INR fixed rate is often 100 or ~90-100 INR/USDT. Let's check order fees or wallet units.

print("================================================================================")
print("EXACT MUDREX LIVE TRADES AUDIT (FROM MUDREX API API ORDERS)")
print("================================================================================")

# Group orders by position_id
pos_map = {}
for o in orders:
    pid = o.get("position_id") or o.get("future_position_uuid")
    if not pid: continue
    if pid not in pos_map:
        pos_map[pid] = []
    pos_map[pid].append(o)

def to_ist(ts_str):
    if not ts_str: return ""
    try:
        dt = datetime.strptime(ts_str.replace("Z", "+00:00"), "%Y-%m-%dT%H:%M:%S%z")
        return dt.astimezone(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d %H:%M:%S IST")
    except Exception:
        return ts_str

mudrex_trades_detail = []

for pid, ords in pos_map.items():
    ords.sort(key=lambda x: x.get("created_at", ""))
    
    entry_o = None
    exit_o = None
    
    for o in ords:
        # Check if entry or exit
        # Direction: LONG or SHORT
        # Entry order is the first filled order, exit is reduces_only or second order
        if o.get("status") == "FILLED":
            if not entry_o:
                entry_o = o
            else:
                exit_o = o

    if not entry_o or not exit_o:
        print(f"WARNING: Position {pid} does not have complete entry and exit orders! Count: {len(ords)}")
        continue

    entry_price = float(entry_o.get("filled_price") or entry_o.get("price") or 0.0)
    exit_price = float(exit_o.get("filled_price") or exit_o.get("price") or 0.0)
    qty = float(entry_o.get("quantity") or entry_o.get("qty") or 0.0)
    direction = entry_o.get("order_type") or entry_o.get("side") # LONG / SHORT

    # Price difference in USD per BTC
    if direction == "LONG":
        usd_pnl = (exit_price - entry_price) * qty
    else:
        usd_pnl = (entry_price - exit_price) * qty

    # Mudrex fee fields
    entry_fee = float(entry_o.get("fee") or entry_o.get("commission") or 0.0)
    exit_fee = float(exit_o.get("fee") or exit_o.get("commission") or 0.0)
    entry_gst = float(entry_o.get("gst_on_fee") or 0.0)
    exit_gst = float(exit_o.get("gst_on_fee") or 0.0)

    mudrex_trades_detail.append({
        "pid": pid,
        "entry_time": to_ist(entry_o.get("created_at")),
        "exit_time": to_ist(exit_o.get("created_at")),
        "direction": direction,
        "qty": qty,
        "entry_price": entry_price,
        "exit_price": exit_price,
        "usd_pnl": usd_pnl,
        "entry_fee": entry_fee,
        "exit_fee": exit_fee,
        "entry_gst": entry_gst,
        "exit_gst": exit_gst,
        "entry_order_id": entry_o.get("id"),
        "exit_order_id": exit_o.get("id")
    })

# Sort by entry time
mudrex_trades_detail.sort(key=lambda x: x["entry_time"])

print(f"Total Completed Mudrex Positions Found: {len(mudrex_trades_detail)}")
print("-" * 100)
print(f"{'#':<3} | {'Position ID':<38} | {'Side':<5} | {'Qty':<6} | {'Entry ($)':<10} | {'Exit ($)':<10} | {'USD PnL':<10}")
print("-" * 100)

total_usd_pnl = 0.0
for idx, t in enumerate(mudrex_trades_detail, 1):
    total_usd_pnl += t['usd_pnl']
    print(f"{idx:<3} | {t['pid']:<38} | {t['direction']:<5} | {t['qty']:<6} | ${t['entry_price']:<9.2f} | ${t['exit_price']:<9.2f} | ${t['usd_pnl']:<+9.4f}")

print("-" * 100)
print(f"TOTAL REALIZED GROSS MUDREX P&L (in USD): ${total_usd_pnl:+.4f} USD")
print("================================================================================")
