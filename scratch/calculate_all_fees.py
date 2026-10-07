import json

with open("scratch/mudrex_full_audit_response.json", "r", encoding="utf-8") as f:
    audit_data = json.load(f)

mudrex = audit_data.get("mudrex_responses", {})
orders = mudrex.get("orders_history", {}).get("body", {}).get("data") or []

print("================================================================================")
print(f"CALCULATING FEES AND GST FOR ALL ORDERS (Count: {len(orders)})")
print("================================================================================")

total_fee = 0.0
total_gst = 0.0

for o in orders:
    fee = float(o.get("fee") or o.get("commission") or 0.0)
    gst = float(o.get("gst_on_fee") or 0.0)
    total_fee += fee
    total_gst += gst

print(f"Total Trading Fees: Rs. {total_fee:.2f}")
print(f"Total GST on Fees:  Rs. {total_gst:.2f}")

# Check orders details
print("\nOrders Fee Breakdown:")
for idx, o in enumerate(orders, 1):
    pid = o.get("position_id")
    side = o.get("order_type")
    price = o.get("filled_price") or o.get("price")
    qty = o.get("quantity")
    fee = float(o.get("fee") or o.get("commission") or 0.0)
    gst = float(o.get("gst_on_fee") or 0.0)
    actual_amt = float(o.get("actual_amount") or 0.0)
    print(f"[{idx:02d}] PosID: {pid} | Side: {side:<5} | Price: ${price} | Qty: {qty} | Amount: Rs.{actual_amt:.2f} | Fee: Rs.{fee} | GST: Rs.{gst}")

