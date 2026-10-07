import json

with open("scratch/mudrex_full_audit_response.json", "r", encoding="utf-8") as f:
    audit_data = json.load(f)

mudrex = audit_data.get("mudrex_responses", {})
pos_hist = mudrex.get("positions_history", {}).get("body", {}).get("data") or []
orders = mudrex.get("orders_history", {}).get("body", {}).get("data") or []

print("================================================================================")
print("EXACT RECONCILIATION MATH TEST")
print("================================================================================")

starting_balance = 5000.00
actual_balance = 4599.059
net_change = actual_balance - starting_balance

print(f"Starting Balance:         Rs. {starting_balance:>10.3f}")
print(f"Current Mudrex Balance:   Rs. {actual_balance:>10.3f}")
print(f"Total Change (Difference): Rs. {net_change:>10.3f}")
print("-" * 80)

# Calculate gross PnL for each category
test_pnl = 0.0 # Pos 18 & 19
early_bot_pnl = 0.0 # Pos 11-17
engine_10_pnl = 0.0 # Pos 1-10

for p in pos_hist:
    pid = p.get("position_id")
    pnl = float(p.get("pnl") or 0.0)
    created = p.get("created_at")
    
    # Identify category by PID or created time
    if pid == "01a1067d-f252-7e89-91da-9b03be176bfe":
        test_pnl += pnl # +124.13
    elif pid == "01a108eb-fdf2-735a-a74c-95ea825ee9aa":
        test_pnl += pnl # -188.84
    elif pid in [
        "01a109b1-8bc2-70db-a3a6-66c89458823d", "01a109b8-0da9-7cb3-9419-a0a42bcd5254",
        "01a109c5-fc59-76cf-a2d2-594cbbbeb720", "01a109c7-2e6e-73a4-9d43-cc7b4eac9c0b",
        "01a109d5-12c9-7b77-9848-513a6654d310", "01a109dc-01dc-7ca0-a9c2-1770eff669dd",
        "01a109e9-e74f-7dda-bb6c-752356ef273b"
    ]:
        early_bot_pnl += pnl
    else:
        engine_10_pnl += pnl

total_gross_pnl = test_pnl + early_bot_pnl + engine_10_pnl

print(f"1. Previous Test Trades Gross PnL (Pos 18 & 19):   Rs. {test_pnl:>+10.2f}")
print(f"2. Early Morning Trades Gross PnL (Pos 11-17):      Rs. {early_bot_pnl:>+10.2f}")
print(f"3. Today Engine 10 Trades Gross PnL (Pos 1-10):     Rs. {engine_10_pnl:>+10.2f}")
print(f"--------------------------------------------------------------------------------")
print(f"Total Gross Realized PnL Across All 19 Trades:     Rs. {total_gross_pnl:>+10.2f}")

fee_gst_funding_remainder = net_change - total_gross_pnl
print(f"Implied Fees + GST + Funding Deductions:          Rs. {fee_gst_funding_remainder:>10.3f}")

# Total orders executed:
# Orders count in orders_history = 20 (for 10 today trades)
# Total orders for all 19 positions = 38 orders
print(f"\nTotal Orders for 19 positions = 38 orders")
print(f"Average Fee + GST per Order = Rs. {abs(fee_gst_funding_remainder) / 38:.2f}")

