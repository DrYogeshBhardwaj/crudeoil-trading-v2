import json

with open("scratch/mudrex_full_audit_response.json", "r", encoding="utf-8") as f:
    audit_data = json.load(f)

mudrex = audit_data.get("mudrex_responses", {})
db = audit_data.get("db_trades", {})

funds = mudrex.get("futures_funds_inr", {}).get("body", {}).get("data") or {}
open_pos = mudrex.get("open_positions", {}).get("body", {}).get("data") or []
pos_hist = mudrex.get("positions_history", {}).get("body", {}).get("data") or []

print("================================================================================")
print("CURRENT MUDREX LIVE ACCOUNT STATUS")
print("================================================================================")
print(f"Futures Cash Balance (Unused):  Rs. {funds.get('balance')}")
print(f"Futures Locked Margin (In-Use): Rs. {funds.get('locked_amount')}")
bal = float(funds.get('balance') or 0.0)
locked = float(funds.get('locked_amount') or 0.0)
print(f"Total Portfolio Value:          Rs. {bal + locked:.2f}")

print("\n--- OPEN POSITIONS (Count: {}) ---".format(len(open_pos)))
for p in open_pos:
    print(json.dumps(p, indent=2))

print("\n--- LATEST 3 POSITIONS HISTORY ---")
for p in pos_hist[:3]:
    print(f"PosID: {p.get('position_id')} | Status: {p.get('status')} | Entry: ${p.get('entry_price')} | Closed: ${p.get('closed_price')} | PnL: Rs.{p.get('pnl')} | Time: {p.get('updated_at')}")

