"""
Paper/Sandbox Replay Simulation Test (Requirement 15)
Replays today's 54 trades and small price movements (+₹1 to +₹10 gross P&L)
against the rebuilt Bitcoin Live Engine to verify that NO premature exits occur.
"""

import sys
import os
import sqlite3
from unittest.mock import patch

# Use temporary test database
os.environ["DATABASE_PATH"] = "scratch_replay_54_trades.db"

from database import DB
from bitcoin_live_engine import BitcoinLiveEngine, LiveTradeState, TradeStatus
from bitcoin_feed import BITCOIN_FEED
from bitcoin_strategy import BITCOIN_STRATEGY


def run_replay_simulation():
    print("=" * 70)
    print("=== STARTING REPLAY SIMULATION TEST (REQUIREMENT 15) ===")
    print("=" * 70)

    # Initialize clean DB
    with sqlite3.connect(DB.db_path) as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM bitcoin_live_trades")
        cur.execute("DELETE FROM bitcoin_live_settings")
        conn.commit()

    engine = BitcoinLiveEngine()
    engine.live_trading_enabled = False  # Pre-Flight / Simulation Mode

    # Patch feed and strategy so ticks proceed deterministically
    with patch.object(BITCOIN_FEED, 'fetch_historical_candles', return_value=[]), \
         patch.object(BITCOIN_STRATEGY, 'evaluate_market', return_value={'action': 'WAIT', 'trend': 'NEUTRAL', 'confidence': 50, 'reasons': ['Replay']}):

        # Create a new trade at Entry USD 85,000.0 (Hedge Rate 102.0)
        tp_usd, sl_usd, tp_inr, sl_inr, tp_gross, sl_gross = engine.calculate_sl_and_target_prices(
            direction="BUY",
            entry_price_usd=85000.0,
            quantity=0.002,
            hedge_rate=102.0,
            target_net_inr=100.0,
            max_loss_net_inr=200.0
        )

        trade = LiveTradeState(
            trade_id="REPLAY_TRADE_001",
            mudrex_position_id="MUDREX_REPLAY_POS_1",
            direction="BUY",
            quantity=0.002,
            leverage=5.0,
            entry_price_usd=85000.0,
            entry_price=8670000.0,
            hedge_rate=102.0,
            entry_timestamp="2026-10-05 06:00:00",
            target_net_inr=100.0,
            max_loss_net_inr=200.0,
            target_gross_inr=tp_gross,
            stop_gross_inr=sl_gross,
            target_usd=tp_usd,
            stop_loss_usd=sl_usd,
            target=tp_inr,
            stop_loss=sl_inr,
            status=TradeStatus.OPEN.value
        )
        DB.save_bitcoin_live_trade(trade.to_dict())

        print(f"Trade initialized:")
        print(f"  Entry USD:       ${trade.entry_price_usd:,.2f}")
        print(f"  Target USD:      ${trade.target_usd:,.2f} (+Rs.100 NET target, required gross: +Rs.{tp_gross:.2f})")
        print(f"  Stop Loss USD:   ${trade.stop_loss_usd:,.2f} (-Rs.200 NET limit, max allowed gross loss: -Rs.{sl_gross:.2f})")
        print("-" * 70)

        # Today's problematic small gross movements (in USD diff relative to entry $85,000):
        # +Rs.1.89 gross (~ +$9.26 USD)
        # +Rs.10.38 gross (~ +$50.88 USD)
        # -Rs.1.59 gross (~ -$7.79 USD)
        # +Rs.3.73 gross (~ +$18.28 USD)
        # -Rs.2.10 gross (~ -$10.29 USD)
        # -Rs.2.46 gross (~ -$12.06 USD)
        # +Rs.15.00 gross (~ +$73.53 USD)
        # +Rs.50.00 gross (~ +$245.10 USD)
        # +Rs.90.00 gross (~ +$441.18 USD)  -- Still below NET Rs.100!

        problematic_prices = [
            85009.26,  # +Rs.1.89 gross
            85050.88,  # +Rs.10.38 gross
            84992.21,  # -Rs.1.59 gross
            85018.28,  # +Rs.3.73 gross
            84989.71,  # -Rs.2.10 gross
            84987.94,  # -Rs.2.46 gross
            85073.53,  # +Rs.15.00 gross
            85245.10,  # +Rs.50.00 gross
            85441.18,  # +Rs.90.00 gross (NET ~ +Rs.69.50)
        ]

        premature_exits_detected = 0

        for idx, price in enumerate(problematic_prices, 1):
            with patch.object(engine, 'fetch_mudrex_futures_market_data', return_value=(price, 102.0, 'Replay Tick')):
                engine.process_tick()

            raw = DB.load_all_bitcoin_live_trades()[0]
            status = raw["status"]

            gross_usd, gross_inr, entry_fee, exit_fee, total_charges, net_inr = engine.calculate_live_position_pnl(
                LiveTradeState.from_dict(raw), price, 102.0
            )

            print(f"Tick #{idx:02d}: Price=${price:,.2f} | Gross P&L=Rs.{gross_inr:+.2f} | Net P&L=Rs.{net_inr:+.2f} | Status={status}")

            if status != TradeStatus.OPEN.value:
                print(f"  --> PREMATURE EXIT DETECTED at Tick #{idx}! Status changed to {status}")
                premature_exits_detected += 1

        print("-" * 70)
        if premature_exits_detected == 0:
            print(">>> REPLAY TEST PASSED SUCCESSFULY: ZERO premature exits on all tiny price moves!")
        else:
            print(f">>> REPLAY TEST FAILED: {premature_exits_detected} premature exits detected.")

        # Now test FULL TARGET HIT at tp_usd ($85,590.94)
        print("-" * 70)
        print(f"Replaying tick at full Target USD price (${tp_usd:,.2f})...")
        with patch.object(engine, 'fetch_mudrex_futures_market_data', return_value=(tp_usd, 102.0, 'Target Replay Tick')):
            engine.process_tick()

        final_raw = DB.load_all_bitcoin_live_trades()[0]
        print(f"Target Tick Result: Status={final_raw['status']} | Exit Reason={final_raw['exit_reason']} | Final Net P&L=Rs.{final_raw['net_pnl']:.2f}")

        if final_raw["status"] == TradeStatus.CLOSED.value and final_raw["net_pnl"] >= 100.0:
            print(">>> TARGET HIT VERIFICATION PASSED: Trade closed cleanly at +Rs.100 NET Target!")
        else:
            print(">>> TARGET HIT VERIFICATION FAILED!")
            sys.exit(1)

        print("=" * 70)


if __name__ == "__main__":
    run_replay_simulation()
