"""
Silver (SILVERM) Paper Trade Simulation Script
Simulates a live MCX Silver paper trade with:
- Capital: Rs. 3,30,000
- Target Profit: +Rs. 5,000 NET
- Max Loss / Stop Loss: -Rs. 10,000 NET
- Contract: MCX SILVERM (Silver Mini - 5 kg lot)
"""

def simulate_silver_paper_trade():
    capital = 330000.0
    lot_size = 5  # 5 kg per lot
    entry_price = 227654.0  # Current SILVERM price from Dhan screenshot
    
    # Target and Stop Loss in Rupees
    target_net_inr = 5000.0
    max_loss_inr = 10000.0
    
    # Point movement needed
    target_points = target_net_inr / lot_size  # +1,000 pts
    stop_loss_points = max_loss_inr / lot_size  # -2,000 pts
    
    target_price = entry_price + target_points
    stop_loss_price = entry_price - stop_loss_points
    
    # Margin calculation for Dhan Intraday (~15% of contract value)
    contract_value = entry_price * lot_size
    margin_required = contract_value * 0.15 # ~15% margin for futures
    free_capital = capital - margin_required
    
    print("=" * 60)
    print("      MCX SILVERM PAPER TRADE SIMULATION DEMO")
    print("=" * 60)
    print(f"Total Account Capital   : Rs. {capital:,.2f}")
    print(f"Contract Instrument     : MCX SILVERM NOV FUT")
    print(f"Lot Size                : {lot_size} kg")
    print(f"Entry Price (LTP)       : Rs. {entry_price:,.2f}")
    print(f"Contract Value (1 Lot)  : Rs. {contract_value:,.2f}")
    print(f"Margin Locked (Dhan)    : Rs. {margin_required:,.2f}")
    print(f"Free Cash Balance Left  : Rs. {free_capital:,.2f}")
    print("-" * 60)
    print(f"[TARGET PROFIT SETTING] : +Rs. {target_net_inr:,.2f} (+{target_points:,.0f} Pts) -> Price: Rs. {target_price:,.2f}")
    print(f"[STOP LOSS SETTING]     : -Rs. {max_loss_inr:,.2f} (-{stop_loss_points:,.0f} Pts) -> Price: Rs. {stop_loss_price:,.2f}")
    print("=" * 60)
    
    # Scenario A: Target Hit Simulation
    exit_target_price = target_price
    gross_pnl_win = (exit_target_price - entry_price) * lot_size
    charges_win = 85.0 # Dhan STT + Exchange charges + Brokerage (~Rs.85)
    net_pnl_win = gross_pnl_win - charges_win
    final_balance_win = capital + net_pnl_win
    
    print("\n--- SCENARIO 1: TARGET PROFIT HIT (BUY LONG WIN) ---")
    print(f"   Exit Price           : Rs. {exit_target_price:,.2f}")
    print(f"   Gross P&L            : +Rs. {gross_pnl_win:,.2f}")
    print(f"   Estimated Charges    : -Rs. {charges_win:,.2f}")
    print(f"   NET P&L REALIZED     : +Rs. {net_pnl_win:,.2f}")
    print(f"   NEW TOTAL CAPITAL    : Rs. {final_balance_win:,.2f}")

    # Scenario B: Stop Loss Hit Simulation
    exit_sl_price = stop_loss_price
    gross_pnl_loss = (exit_sl_price - entry_price) * lot_size
    charges_loss = 85.0
    net_pnl_loss = gross_pnl_loss - charges_loss
    final_balance_loss = capital + net_pnl_loss
    
    print("\n--- SCENARIO 2: STOP LOSS HIT (BUY LONG LOSS) ---")
    print(f"   Exit Price           : Rs. {exit_sl_price:,.2f}")
    print(f"   Gross P&L            : -Rs. {abs(gross_pnl_loss):,.2f}")
    print(f"   Estimated Charges    : -Rs. {charges_loss:,.2f}")
    print(f"   NET P&L REALIZED     : -Rs. {abs(net_pnl_loss):,.2f}")
    print(f"   NEW TOTAL CAPITAL    : Rs. {final_balance_loss:,.2f}")
    print("=" * 60)

if __name__ == "__main__":
    simulate_silver_paper_trade()
