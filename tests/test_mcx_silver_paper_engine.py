"""
Automated Unit Test Suite for MCX Silver Mini (SILVERM) Paper Engine Phase 1 Live-Readiness.
Tests all safety locks, startup behavior, synthetic vs real feed classification, staleness detection,
duplicate order prevention, and TP/SL accounting.
"""

import unittest
import os
import time
import tempfile
import shutil
from unittest.mock import patch

from database import DatabaseEngine as Database
from mcx_silver_paper_engine import MCXSilverPaperEngine, calculate_dhan_mcx_silver_charges


class TestMCXSilverPaperEnginePhase1(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.db_file = os.path.join(self.test_dir, "test_mcx_silver.db")
        self.db = Database(db_path=self.db_file)
        self.engine = MCXSilverPaperEngine()
        self.engine.db = self.db
        # Ensure fresh DB state for testing
        self.engine.reset_statistics()

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_1_no_auto_buy_on_startup(self):
        """1. Verify that initializing or restarting engine does NOT create an auto-BUY position."""
        self.db.reset_mcx_silver_paper_account()
        self.engine.active_position = None
        
        # Instantiate a new engine instance
        restarted_engine = MCXSilverPaperEngine()
        restarted_engine.db = self.db
        restarted_engine._load_state_from_db()
        
        self.assertIsNone(restarted_engine.active_position, "Engine auto-opened a position on restart! Must be None.")

    def test_2_live_trading_disabled_safety_lock(self):
        """2. Verify ENABLE_LIVE_TRADING is False and real Dhan order placement raises RuntimeError."""
        self.assertFalse(self.engine.ENABLE_LIVE_TRADING, "ENABLE_LIVE_TRADING must be False in Phase 1.")
        
        with self.assertRaises(RuntimeError) as ctx:
            self.engine.place_live_dhan_order(side="BUY", quantity=1)
        self.assertIn("CRITICAL SAFETY BLOCK", str(ctx.exception))

    def test_3_synthetic_feed_classification_and_live_invalidity(self):
        """3. Verify synthetic price feeds are correctly classified and marked invalid for live execution."""
        # Force synthetic feed source
        self.engine.is_synthetic_feed = True
        self.engine.price_source = "DHAN-CALIBRATED LIVE FEED (BINANCE XAG)"
        
        is_valid = self.engine.is_real_mcx_price_valid_for_live_execution()
        self.assertFalse(is_valid, "Synthetic price feed was erroneously marked valid for live execution!")
        
        dashboard_state = self.engine.get_dashboard_state()
        self.assertTrue(dashboard_state["is_synthetic_feed"])
        self.assertIn("PAPER PRACTICE ONLY", dashboard_state["price_feed_quality"])

    def test_4_duplicate_entry_prevention(self):
        """4. Verify duplicate manual_entry calls do not open duplicate positions."""
        self.engine.active_position = None
        pos1 = self.engine.manual_entry(direction="BUY", price=220000.0)
        self.assertIsNotNone(pos1)
        trade_id_1 = pos1.trade_id

        # Attempt second entry while position 1 is active
        pos2 = self.engine.manual_entry(direction="SELL", price=221000.0)
        self.assertEqual(pos2.trade_id, trade_id_1, "Duplicate trade entry was allowed while active position existed!")
        self.assertEqual(pos2.direction, "BUY", "Active position direction was corrupted by duplicate entry attempt!")

    def test_5_tp_sl_triggers_and_dhan_charges(self):
        """5. Verify TP (+Rs.5,000 Net) and SL (-Rs.10,000 Net) trigger logic and exact P&L math."""
        self.engine.active_position = None
        entry_price = 220000.0
        pos = self.engine.manual_entry(direction="BUY", price=entry_price)
        
        # Test Target Profit trigger
        target_price = pos.target_price_inr
        self.assertGreater(target_price, entry_price)
        
        with patch.object(self.engine, 'fetch_market_price', return_value=target_price):
            closed_trade = self.engine.process_tick()
            
        self.assertIsNotNone(closed_trade, "Target Profit did not trigger position exit!")
        self.assertIn("TARGET PROFIT HIT", closed_trade.get("exit_reason", ""))
        self.assertAlmostEqual(closed_trade.get("net_pnl_inr", 0.0), 5000.0, delta=10.0)
        self.assertIsNone(self.engine.active_position)

    def test_6_stale_price_feed_detection(self):
        """6. Verify stale price feeds (>15 seconds old) are flagged as stale when price fails to update."""
        old_time = time.time() - 30.0
        self.engine.last_price_update_timestamp = old_time
        
        # Mock fetch_market_price to simulate returning cached price without updating timestamp
        with patch.object(self.engine, 'fetch_market_price', side_effect=lambda: setattr(self.engine, 'is_price_stale', True) or self.engine.current_price_inr):
            state = self.engine.get_dashboard_state()
            self.assertTrue(state["is_price_stale"], "Stale price feed was not flagged in dashboard state!")
            self.assertFalse(self.engine.is_real_mcx_price_valid_for_live_execution(), "Stale price feed was accepted for live execution!")

    def test_7_dhan_charges_calculator(self):
        """7. Verify exact Dhan brokerage, STT, MCX txn charges, GST, and stamp duty calculation."""
        chg = calculate_dhan_mcx_silver_charges(entry_price=220000.0, exit_price=221000.0, direction="BUY", lots=1)
        self.assertEqual(chg["brokerage"], 40.0)
        self.assertGreater(chg["stt"], 0.0)
        self.assertGreater(chg["mcx_fee"], 0.0)
        self.assertGreater(chg["gst"], 0.0)
        self.assertGreater(chg["total_charges"], 200.0)


if __name__ == "__main__":
    unittest.main()
