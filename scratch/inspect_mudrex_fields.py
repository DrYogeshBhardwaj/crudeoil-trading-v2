import json

with open("scratch/mudrex_full_audit_response.json", "r", encoding="utf-8") as f:
    audit_data = json.load(f)

mudrex = audit_data.get("mudrex_responses", {})
db = audit_data.get("db_trades", {})

print("=== MUDREX RESPONSES KEYS ===")
for k, v in mudrex.items():
    print(f"Key: {k}")

# Check orders_history fields
orders = mudrex.get("orders_history", {}).get("body", {}).get("data") or []
if orders:
    print("\n=== SAMPLE ORDER FIELDS ===")
    print(json.dumps(orders[0], indent=2))

# Check futures_funds_inr
funds = mudrex.get("futures_funds_inr", {})
print("\n=== FUTURES FUNDS INR ===")
print(json.dumps(funds, indent=2))

