import json
from datetime import datetime, timezone, timedelta

with open("scratch/mudrex_full_audit_response.json", "r", encoding="utf-8") as f:
    audit = json.load(f)

mudrex = audit.get("mudrex_responses", {})
db = audit.get("db_trades", {})

print("=" * 80)
print("MUDREX REAL-TIME ACCOUNT & ORDERS RECONCILIATION ANALYSIS")
print("=" * 80)

# 1. Wallet funds
futures_funds = mudrex.get("futures_funds_inr", {}).get("body", {}).get("data", {})
spot_funds = mudrex.get("spot_funds_inr", {}).get("body", {}).get("data", {})

bal = float(futures_funds.get("balance") or 0.0)
locked = float(futures_funds.get("locked_amount") or 0.0)
total_equity = bal + locked

print(f"Mudrex Futures Cash Balance (Unused):  Rs. {bal:,.2f}")
print(f"Mudrex Futures Locked Margin (In Use): Rs. {locked:,.2f}")
print(f"Mudrex Futures Total Account Equity:  Rs. {total_equity:,.2f}")
print("-" * 80)

# 2. Open Positions
open_positions = mudrex.get("open_positions", {}).get("body", {}).get("data") or []
print(f"Mudrex Open Positions Count: {len(open_positions)}")
for pos in open_positions:
    print(f"  -> ID: {pos.get('id')} | Sym: {pos.get('symbol')} | Side: {pos.get('order_type')} | Qty: {pos.get('quantity')} | Entry: ${pos.get('entry_price')} | Margin: Rs.{pos.get('initial_margin')}")

print("-" * 80)

# 3. Orders History
orders = mudrex.get("orders_history", {}).get("body", {}).get("data") or []
print(f"Mudrex Total Orders in History: {len(orders)}")

# Group orders by position_id / future_position_uuid
positions_map = {}
for ord_item in orders:
    pid = ord_item.get("position_id") or ord_item.get("future_position_uuid") or "NO_POSITION_ID"
    if pid not in positions_map:
        positions_map[pid] = []
    positions_map[pid].append(ord_item)

print(f"Mudrex Total Distinct Positions in Orders History: {len(positions_map)}")
print("-" * 80)

# Convert UTC timestamp string to IST string
def to_ist(ts_str):
    try:
        dt = datetime.strptime(ts_str.replace("Z", "+00:00"), "%Y-%m-%dT%H:%M:%S%z")
        dt_ist = dt.astimezone(timezone(timedelta(hours=5, minutes=30)))
        return dt_ist.strftime("%Y-%m-%d %H:%M:%S IST")
    except Exception:
        return ts_str

for pid, ord_list in positions_map.items():
    print(f"\nPOSITION ID: {pid}")
    ord_list.sort(key=lambda x: x.get("created_at", ""))
    total_pos_fee = 0.0
    for o in ord_list:
        fee = float(o.get("fee") or o.get("commission") or 0.0)
        total_pos_fee += fee
        created_utc = o.get("created_at")
        created_ist = to_ist(created_utc)
        print(f"  Order ID: {o.get('id')} | Type: {o.get('order_type')} | Status: {o.get('status')} | Price: ${o.get('filled_price') or o.get('price')} | Qty: {o.get('quantity')} | Time: {created_ist} (UTC: {created_utc})")

# 4. DB Trades
live_trades_db = db.get("bitcoin_live_trades") or []
print("\n" + "=" * 80)
print("ENGINE DB RECORDS: bitcoin_live_trades")
print("=" * 80)

for t in live_trades_db:
    print(f"DB Trade ID: {t.get('trade_id')} | Pos ID: {t.get('mudrex_position_id')} | Dir: {t.get('direction')} | Status: {t.get('status')} | Entry: {t.get('entry_timestamp')} | Exit: {t.get('exit_timestamp')} | Gross: Rs.{t.get('gross_pnl')} | Net: Rs.{t.get('net_pnl')}")
