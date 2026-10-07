import json

with open("scratch/mudrex_full_audit_response.json", "r", encoding="utf-8") as f:
    audit_data = json.load(f)

mudrex = audit_data.get("mudrex_responses", {})
pos_hist = mudrex.get("positions_history", {}).get("body", {}).get("data") or []

print("================================================================================")
print(f"ALL MUDREX POSITIONS HISTORY RECORDS (Count: {len(pos_hist)})")
print("================================================================================")

tot_pnl = 0.0
for idx, p in enumerate(pos_hist, 1):
    pid = p.get("position_id")
    ptype = p.get("position_type")
    entry_p = p.get("entry_price")
    close_p = p.get("closed_price")
    qty = p.get("quantity")
    pnl = float(p.get("pnl") or 0.0)
    created = p.get("created_at")
    closed = p.get("updated_at")
    tot_pnl += pnl
    print(f"[{idx:02d}] PosID: {pid} | Side: {ptype:<5} | Qty: {qty} | Entry: ${entry_p} | Closed: ${close_p} | PnL: Rs.{pnl:>+8.2f} | Created: {created} | Closed: {closed}")

print("-" * 80)
print(f"SUM OF ALL POSITIONS HISTORY PNL: Rs. {tot_pnl:+.2f}")
print("================================================================================")
