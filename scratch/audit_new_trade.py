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
print("MUDREX NEW EVENT AUDIT & RECONCILIATION")
print("================================================================================")
print(f"Current Mudrex Balance:   Rs. {funds.get('balance')}")
print(f"Current Locked Amount:    Rs. {funds.get('locked_amount')}")
print(f"Total Positions Count:    {len(pos_hist)}")
print(f"Total Orders Count:       {len(orders)}")
print("-" * 80)

def to_ist(ts_str):
    if not ts_str: return ""
    try:
        dt = datetime.strptime(ts_str.replace("Z", "+00:00"), "%Y-%m-%dT%H:%M:%S%z")
        return dt.astimezone(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d %H:%M:%S IST")
    except Exception:
        return ts_str

# Print all position history sorted by updated_at descending
pos_hist.sort(key=lambda x: x.get("updated_at", ""), reverse=True)

print("=== LATEST MUDREX POSITIONS HISTORY ===")
tot_pnl = 0.0
for idx, p in enumerate(pos_hist, 1):
    pid = p.get("position_id")
    side = p.get("position_type")
    qty = p.get("quantity")
    entry_p = float(p.get("entry_price") or 0.0)
    closed_p = float(p.get("closed_price") or 0.0)
    pnl = float(p.get("pnl") or 0.0)
    created = to_ist(p.get("created_at"))
    closed = to_ist(p.get("updated_at"))
    tot_pnl += pnl
    print(f"[{idx:02d}] PosID: {pid} | Side: {side:<5} | Qty: {qty} | Entry: ${entry_p:<8.2f} | Closed: ${closed_p:<8.2f} | PnL: Rs.{pnl:>+8.2f} | Closed Time: {closed}")

print("-" * 80)
print(f"Total Sum of Gross PnL across all {len(pos_hist)} positions: Rs. {tot_pnl:+.2f}")

