import json
import sqlite3
from datetime import datetime, timezone, timedelta

# Load JSON response
with open("scratch/mudrex_full_audit_response.json", "r", encoding="utf-8") as f:
    audit_data = json.load(f)

mudrex = audit_data.get("mudrex_responses", {})
db = audit_data.get("db_trades", {})

print("================================================================================")
print("FULL MUDREX AUDIT & RECONCILIATION DATA ANALYSIS")
print("================================================================================")

# 1. Wallet Status
futures_funds = mudrex.get("futures_funds_inr", {}).get("body", {}).get("data", {})
print("\n--- 1. MUDREX WALLET BALANCE ---")
print(f"Balance:       Rs. {futures_funds.get('balance')}")
print(f"Locked Amount: Rs. {futures_funds.get('locked_amount')}")

# 2. Orders History
orders = mudrex.get("orders_history", {}).get("body", {}).get("data") or []
print(f"\n--- 2. MUDREX ORDERS HISTORY (Count: {len(orders)}) ---")

# Group by position_id
pos_groups = {}
for o in orders:
    pid = o.get("position_id") or o.get("future_position_uuid") or "NO_PID"
    if pid not in pos_groups:
        pos_groups[pid] = []
    pos_groups[pid].append(o)

print(f"Total Unique Mudrex Position IDs in Orders History: {len(pos_groups)}")

def to_ist(ts_str):
    if not ts_str: return ""
    try:
        dt = datetime.strptime(ts_str.replace("Z", "+00:00"), "%Y-%m-%dT%H:%M:%S%z")
        return dt.astimezone(timezone(timedelta(hours=5, minutes=30))).strftime("%H:%M:%S IST")
    except Exception:
        return ts_str

pos_summary = []

for pid, ords in pos_groups.items():
    ords.sort(key=lambda x: x.get("created_at", ""))
    
    entry_ord = None
    exit_ord = None
    
    for o in ords:
        # Check order side / reduces_only / direction
        reduces = o.get("reduces_only")
        side = o.get("order_type") or o.get("side")
        status = o.get("status")
        
        if not reduces and status == "FILLED":
            if not entry_ord:
                entry_ord = o
        elif reduces and status == "FILLED":
            exit_ord = o

    total_fee = sum(float(o.get("fee") or o.get("commission") or 0.0) for o in ords)
    total_gst = sum(float(o.get("gst_on_fee") or 0.0) for o in ords)
    
    pos_summary.append({
        "pid": pid,
        "orders_count": len(ords),
        "entry_ord": entry_ord,
        "exit_ord": exit_ord,
        "all_orders": ords,
        "total_fee": total_fee,
        "total_gst": total_gst
    })

print("\n--- MUDREX POSITIONS BREAKDOWN ---")
for idx, p in enumerate(pos_summary, 1):
    pid = p["pid"]
    ords = p["all_orders"]
    print(f"\n[{idx}] Position ID: {pid}")
    for o in ords:
        print(f"   Order ID: {o.get('id')} | Type: {o.get('order_type')} | Status: {o.get('status')} | Price: ${o.get('filled_price') or o.get('price')} | Qty: {o.get('quantity')} | Fee: Rs.{o.get('fee')} | GST: Rs.{o.get('gst_on_fee')} | Time: {to_ist(o.get('created_at'))}")

# 3. DB Trades (bitcoin_live_trades)
live_trades = db.get("bitcoin_live_trades") or []
print(f"\n================================================================================")
print(f"ENGINE DB TRADES (bitcoin_live_trades) - Count: {len(live_trades)}")
print("================================================================================")
for t in live_trades:
    print(f"Trade ID: {t.get('trade_id')} | PosID: {t.get('mudrex_position_id')} | Status: {t.get('status')} | Dir: {t.get('direction')} | Entry: ${t.get('entry_price')} @ {t.get('entry_timestamp')} | Exit: ${t.get('exit_price')} @ {t.get('exit_timestamp')} | Gross PnL: Rs.{t.get('gross_pnl')} | Net PnL: Rs.{t.get('net_pnl')} | Reason: {t.get('reason')}")

# Also check other tables
print(f"\nDB bitcoin_live5_trades count: {len(db.get('bitcoin_live5_trades') or [])}")
print(f"DB bitcoin_updown10_trades count: {len(db.get('bitcoin_updown10_trades') or [])}")

