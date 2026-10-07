import json

with open("scratch/mudrex_full_audit_response.json", "r", encoding="utf-8") as f:
    audit_data = json.load(f)

mudrex = audit_data.get("mudrex_responses", {})
pos_hist = mudrex.get("positions_history", {}).get("body", {}).get("data") or []
orders = mudrex.get("orders_history", {}).get("body", {}).get("data") or []
funds = mudrex.get("futures_funds_inr", {}).get("body", {}).get("data") or {}

new_pid = "01a10ac3-77dc-7674-bb05-46b0e83ed8cd"

pos_item = next((p for p in pos_hist if p.get("position_id") == new_pid), {})
pos_orders = [o for o in orders if o.get("position_id") == new_pid]

print("================================================================================")
print(f"NEW MUDREX POSITION AUDIT DETAILS: {new_pid}")
print("================================================================================")
print("POSITION ITEM:")
print(json.dumps(pos_item, indent=2))

print("\nORDERS FOR THIS POSITION:")
for o in pos_orders:
    print(json.dumps(o, indent=2))

prev_wallet = 4599.059
curr_wallet = float(funds.get("balance"))
diff = curr_wallet - prev_wallet

gross_loss = float(pos_item.get("pnl") or 0.0)
# Implied fee + gst = diff - gross_loss
implied_fee_gst = diff - gross_loss

print("\n=== EXACT MATHEMATICAL RECONCILIATION ===")
print(f"Previous Wallet Balance:   Rs. {prev_wallet:>10.3f}")
print(f"Current Mudrex Balance:    Rs. {curr_wallet:>10.3f}")
print(f"Total Net Change:          Rs. {diff:>10.3f}")
print(f"Realized Gross PnL:        Rs. {gross_loss:>10.3f}")
print(f"Implied Fees + GST:        Rs. {implied_fee_gst:>10.3f}")
print(f"Fee+GST per order (2 ords): Rs. {abs(implied_fee_gst)/2:>10.3f}")

