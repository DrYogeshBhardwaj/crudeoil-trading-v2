"""
Comprehensive Unit & Integration Test Suite for WTI Crude Oil Paper Trading Engine.
Validates MCL Mode (100 Barrels) & CL Mode (1,000 Barrels) functionality.
"""

import unittest
import os
import sqlite3
from datetime import datetime

from wti_feed import WTI_FEED, is_nymex_market_open
from wti_strategy import WTI_STRATEGY
from wti_paper_engine import WTI_ENGINE
from database import DB

class TestWTIEngine(unittest.TestCase):

    def setUp(self):
        # Reset WTI DB state & enforce MCL mode for default tests
        WTI_ENGINE.reset_paper_account()
        WTI_ENGINE.set_contract_type("MCL")

    def test_1_feed_connection(self):
        """1. Feed connection test"""
        tick = WTI_FEED.fetch_latest_tick()
        self.assertIsNotNone(tick)
        self.assertIn("connection_status", tick)
        self.assertIn(tick["connection_status"], ["CONNECTED", "STALE", "DISCONNECTED"])
        print(f"[TEST 1 PASS] Feed Connection Status: {tick['connection_status']}")

    def test_2_price_parsing(self):
        """2. Price parsing test"""
        tick = WTI_FEED.fetch_latest_tick()
        self.assertEqual(tick["symbol"], "CL=F")
        self.assertIn("price", tick)
        self.assertGreater(tick["price"], 0.0)
        self.assertIn("change_pct", tick)
        print(f"[TEST 2 PASS] Price Parsing: Current Price = ${tick['price']}")

    def test_3_market_hours(self):
        """3. Market hours calculation test"""
        is_open = is_nymex_market_open()
        self.assertIsInstance(is_open, bool)
        print(f"[TEST 3 PASS] NYMEX Market Hours Check: Market Open = {is_open}")

    def test_4_candle_builder_and_strategy(self):
        """4. Candle builder & strategy evaluation test"""
        candles = WTI_FEED.fetch_historical_candles("5m", "1d")
        self.assertIsInstance(candles, list)
        self.assertGreater(len(candles), 0)

        tick = WTI_FEED.fetch_latest_tick()
        eval_res = WTI_STRATEGY.evaluate_market(candles, tick["price"])

        self.assertIn(eval_res["action"], ["BUY", "SELL", "WAIT"])
        self.assertIn(eval_res["trend"], ["BULLISH", "BEARISH", "NEUTRAL"])
        self.assertGreaterEqual(eval_res["confidence"], 0)
        self.assertLessEqual(eval_res["confidence"], 100)
        print(f"[TEST 4 PASS] Strategy Evaluation: Action={eval_res['action']}, Trend={eval_res['trend']}, Confidence={eval_res['confidence']}%")

    def test_5_buy_paper_trade(self):
        """5. BUY paper trade test"""
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        WTI_ENGINE._open_position(
            direction="BUY",
            entry_price=90.00,
            sl_price=89.00,
            target_price=92.00,
            trend_state="BULLISH",
            confidence=85,
            reasons=["Test Buy Signal"],
            timestamp_str=now_str
        )

        pos = WTI_ENGINE.active_position
        self.assertIsNotNone(pos)
        self.assertEqual(pos["direction"], "BUY")
        self.assertEqual(pos["entry_price"], 90.00)
        self.assertEqual(pos["status"], "OPEN")
        print(f"[TEST 5 PASS] BUY Paper Trade Entry Created: {pos['trade_id']}")

    def test_6_sell_paper_trade(self):
        """6. SELL paper trade test"""
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        WTI_ENGINE._open_position(
            direction="SELL",
            entry_price=95.00,
            sl_price=96.00,
            target_price=93.00,
            trend_state="BEARISH",
            confidence=80,
            reasons=["Test Sell Signal"],
            timestamp_str=now_str
        )

        pos = WTI_ENGINE.active_position
        self.assertIsNotNone(pos)
        self.assertEqual(pos["direction"], "SELL")
        self.assertEqual(pos["entry_price"], 95.00)
        self.assertEqual(pos["status"], "OPEN")
        print(f"[TEST 6 PASS] SELL Paper Trade Entry Created: {pos['trade_id']}")

    def test_7_stop_loss_exit_mcl(self):
        """7. Stop Loss hit test (MCL mode = 100 barrels)"""
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        WTI_ENGINE._open_position(
            direction="BUY",
            entry_price=90.00,
            sl_price=89.00,
            target_price=92.00,
            trend_state="BULLISH",
            confidence=85,
            reasons=["Test SL Hit"],
            timestamp_str=now_str
        )

        # Trigger exit with price hitting SL ($89.00)
        WTI_ENGINE._close_position(exit_price=89.00, exit_reason="STOP LOSS HIT", timestamp_str=now_str)

        self.assertIsNone(WTI_ENGINE.active_position)
        closed_trade = WTI_ENGINE.trade_ledger[0]
        self.assertEqual(closed_trade["status"], "CLOSED")
        self.assertEqual(closed_trade["exit_reason"], "STOP LOSS HIT")
        self.assertEqual(closed_trade["exit_price"], 89.00)
        # Gross PnL for 1 MCL contract = (89 - 90) * 1 * 100 = -$100.00
        self.assertEqual(closed_trade["gross_pnl"], -100.0)
        # Charges = $1.00 ($0.50 * 2), Net = -$101.00
        self.assertEqual(closed_trade["net_pnl"], -101.0)
        print(f"[TEST 7 PASS] Stop Loss Exit Executed (MCL Mode): Net PnL = ${closed_trade['net_pnl']}")

    def test_8_target_exit_mcl(self):
        """8. Target hit test (MCL mode = 100 barrels)"""
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        WTI_ENGINE._open_position(
            direction="BUY",
            entry_price=90.00,
            sl_price=89.00,
            target_price=92.00,
            trend_state="BULLISH",
            confidence=85,
            reasons=["Test Target Hit"],
            timestamp_str=now_str
        )

        # Trigger exit with price hitting Target ($92.00)
        WTI_ENGINE._close_position(exit_price=92.00, exit_reason="TARGET HIT", timestamp_str=now_str)

        self.assertIsNone(WTI_ENGINE.active_position)
        closed_trade = WTI_ENGINE.trade_ledger[0]
        self.assertEqual(closed_trade["status"], "CLOSED")
        self.assertEqual(closed_trade["exit_reason"], "TARGET HIT")
        # Gross PnL for 1 MCL contract = (92 - 90) * 1 * 100 = +$200.00
        self.assertEqual(closed_trade["gross_pnl"], 200.0)
        # Charges = $1.00 ($0.50 * 2), Net = +$199.00
        self.assertEqual(closed_trade["net_pnl"], 199.0)
        print(f"[TEST 8 PASS] Target Exit Executed (MCL Mode): Net PnL = ${closed_trade['net_pnl']}")

    def test_9_pnl_and_charges_math_mcl(self):
        """9. P&L & Charges Math test for MCL contract size ($100/dollar/contract)"""
        # BUY 1 contract from $90.00 to $91.50 ($1.50 move)
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        WTI_ENGINE._open_position("BUY", 90.00, 89.00, 92.00, "BULLISH", 85, ["Math test MCL"], now_str)
        WTI_ENGINE._close_position(91.50, "TARGET HIT", now_str)

        t = WTI_ENGINE.trade_ledger[0]
        expected_gross = (91.50 - 90.00) * 1.0 * 100.0 # $150.00 ($1.50 move * 100 barrels)
        expected_charges = 1.00 # $0.50 * 2
        expected_net = expected_gross - expected_charges # $149.00

        self.assertEqual(t["gross_pnl"], expected_gross)
        self.assertEqual(t["charges"], expected_charges)
        self.assertEqual(t["net_pnl"], expected_net)
        print(f"[TEST 9 PASS] P&L & Charges Math Verified (MCL): Gross=${t['gross_pnl']}, Charges=${t['charges']}, Net=${t['net_pnl']}")

    def test_10_restart_persistence(self):
        """10. Restart / Persistence test"""
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        WTI_ENGINE._open_position("BUY", 90.00, 89.00, 92.00, "BULLISH", 85, ["Persistence Test"], now_str)

        # Verify DB load directly
        saved_pos = DB.load_active_wti_position()
        self.assertIsNotNone(saved_pos)
        self.assertEqual(saved_pos["entry_price"], 90.00)
        self.assertEqual(saved_pos["status"], "OPEN")
        print(f"[TEST 10 PASS] Restart / Persistence Verified: Saved Trade {saved_pos['trade_id']} loaded from SQLite DB.")

    def test_11_no_real_order_safety(self):
        """11. No-real-order safety test"""
        with open(os.path.join(os.path.dirname(__file__), "wti_paper_engine.py"), "r", encoding="utf-8") as f:
            code = f.read()
        self.assertNotIn("Dhan", code)
        self.assertNotIn("dhanhq", code)
        self.assertNotIn("place_order", code)

        with open(os.path.join(os.path.dirname(__file__), "wti_feed.py"), "r", encoding="utf-8") as f:
            feed_code = f.read()
        self.assertNotIn("dhan", feed_code.lower())
        print("[TEST 11 PASS] Safety Check Passed: Zero broker / Dhan real-order calls found in WTI engine modules.")

    def test_12_contract_config_and_delayed_label(self):
        """12. Contract configuration & Delayed Data label test"""
        state = WTI_ENGINE.get_dashboard_state()
        self.assertEqual(state["data_feed_type"], "DELAYED MARKET DATA")
        self.assertEqual(state["data_status_label"], "DATA: DELAYED NYMEX DATA")
        
        cfg = state["contract_config"]
        self.assertEqual(cfg["active_contract"], "MCL")
        self.assertEqual(cfg["active_barrels"], 100)
        self.assertEqual(cfg["multiplier"], 100.0)

        # Test switching to Standard contract (CL)
        WTI_ENGINE.set_contract_type("CL")
        state_cl = WTI_ENGINE.get_dashboard_state()
        self.assertEqual(state_cl["contract_config"]["active_contract"], "CL")
        self.assertEqual(state_cl["contract_config"]["active_barrels"], 1000)
        self.assertEqual(state_cl["contract_config"]["multiplier"], 1000.0)

        # Reset back to MCL
        WTI_ENGINE.set_contract_type("MCL")
        print("[TEST 12 PASS] Contract Configuration (MCL=100 bbls vs CL=1000 bbls) & Delayed Data Label Verified.")

if __name__ == "__main__":
    unittest.main()
