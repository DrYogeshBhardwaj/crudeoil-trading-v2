import json

with open("scratch/mudrex_full_audit_response.json", "r", encoding="utf-8") as f:
    audit_data = json.load(f)

mudrex = audit_data.get("mudrex_responses", {})
db = audit_data.get("db_trades", {})

pos_hist = mudrex.get("positions_history", {}).get("body", {}).get("data") or []
orders = mudrex.get("orders_history", {}).get("body", {}).get("data") or []
open_orders = mudrex.get("open_orders", {}).get("body", {}).get("data") or []

# Target position ID from Trade #5 (or latest trade in screenshot)
# In DB output: Trade ID: BTC_LIVE_1791186775 | PosID: 01a10b0d-2be1-7c65-b593-42edbcdebf8f
target_pid = "01a10b0d-2be1-7c65-b593-42edbcdebf8f"

pos_item = next((p for p in pos_hist if p.get("position_id") == target_pid), {})
related_orders = [o for o in orders if o.get("position_id") == target_pid]

print("================================================================================")
print(f"DEEP EXECUTION AUDIT FOR POSITION: {target_pid}")
print("================================================================================")
print("POSITION HISTORY RECORD:")
print(json.dumps(pos_item, indent=2))

print("\nRELATED ORDERS HISTORY:")
for o in related_orders:
    print(json.dumps(o, indent=2))

print("\nOPEN / PENDING ORDERS:")
print(json.dumps(open_orders, indent=2))

