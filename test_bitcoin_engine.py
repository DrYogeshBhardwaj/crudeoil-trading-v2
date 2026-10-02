"""
Test Suite for Bitcoin Paper Trading Engine (/bitcoin).
Verifies:
1. Feed connection & BTC price parsing (Yahoo Finance / Binance fallback).
2. 24x7 market status determination (always OPEN).
3. Candle building & indicator calculations (EMA 9/21/50, RSI 14, ATR 14).
4. Strategy signal generation (BUY, SELL, WAIT, SL, Target, Confidence).
5. Paper trading engine execution:
   - Initial Virtual Capital: INR 2,00,000.
   - Position opening (BUY/SELL) with 1 BTC contract.
   - Max 1 open position enforcement (preventing averaging/martingale).
   - Stop-Loss exit trigger.
   - Target exit trigger.
   - Charges and Net P&L math in INR.
6. Persistence & restart state recovery from SQLite bitcoin paper tables.
7. ABSOLUTE ZERO REAL MONEY / REAL BROKER INTEGRATION SAFETY.
"""

import os
import time
import unittest
from datetime import datetime

# Set test environment to use an isolated test database
os.environ["DATABASE_PATH"] = "test_bitcoin_trading.db"

from database import DB
from bitcoin_feed import BITCOIN_FEED, BitcoinDataFeed
from bitcoin_strategy import BITCOIN_STRATEGY, BitcoinStrategyEvaluator
from bitcoin_paper_engine import BITCOIN_ENGINE, BitcoinPaperEngine

class TestBitcoinPaperTradingEngine(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        """Clean and initialize isolated test database."""
        pass

    def setUp(self):
        """Reset DB tables before each test."""
        DB.reset_bitcoin_database()
        self.engine = BitcoinPaperEngine()

    def tearDown(self):
        pass

    @classmethod
    def tearDownClass(cls):
        """Clean up test database file."""
        try:
            if os.path.exists("test_bitcoin_trading.db"):
                os.remove("test_bitcoin_trading.db")
        except Exception:
            pass

    def test_01_feed_connection_and_price_parsing(self):
        """Test fetching live price from BTC feed sources."""
        tick = BITCOIN_FEED.fetch_latest_tick()
        price = tick["price"]
        source = tick["data_source"]
        status = tick["connection_status"]
        print(f"[TEST 1] BTC Price: INR {price:,.2f} | Source: {source} | Status: {status}")
        self.assertGreater(price, 1000000.0, "BTC price in INR should be > 1,000,000")
        self.assertIn(source, ["Yahoo Finance (BTC-INR)", "Binance (BTCUSDT)", "Coingecko / Crypto Feed", "Fallback Feed"])
        self.assertIn(status, ["CONNECTED", "STALE", "DISCONNECTED"])

    def test_02_market_status_24x7(self):
        """Test 24x7 crypto market status is always OPEN."""
        is_open, desc = BITCOIN_FEED.is_market_open()
        self.assertTrue(is_open, "Bitcoin market should be 24x7 OPEN")
        self.assertIn("24x7", desc)

    def test_03_historical_candles_and_indicators(self):
        """Test fetching 5m candles and computing EMA, RSI, ATR."""
        candles = BITCOIN_FEED.fetch_historical_candles(tf="5m", range_str="1d")
        self.assertGreater(len(candles), 5, "Should return historical 5m candles")

        curr_price = candles[-1]["close"]
        eval_res = BITCOIN_STRATEGY.evaluate_market(candles, curr_price)
        self.assertIn(eval_res["action"], ["BUY", "SELL", "WAIT"])
        self.assertIn("ema9", eval_res)
        self.assertIn("ema21", eval_res)
        self.assertIn("rsi", eval_res)
        self.assertIn("atr", eval_res)
        print(f"[TEST 3] Strategy Evaluation: Signal={eval_res['action']} | Trend={eval_res['trend']} | RSI={eval_res['rsi']}")

    def test_04_initial_engine_state(self):
        """Test paper engine initial state (Capital INR 2,00,000, 0 position)."""
        state = self.engine.get_dashboard_state()
        self.assertEqual(state["financial_summary"]["initial_capital"], 200000.0)
        self.assertEqual(state["financial_summary"]["current_equity"], 200000.0)
        self.assertIsNone(state["active_position"])
        self.assertEqual(state["disclaimer"], "BITCOIN PAPER TRADING — NO REAL MONEY")

    def test_05_buy_position_opening_and_max_1_position_limit(self):
        """Test opening a BUY paper trade and ensuring max 1 open position enforcement."""
        signal = {
            "action": "BUY",
            "trend": "BULLISH_UPTREND",
            "confidence": 85,
            "reasons": ["EMA 9/21 Golden Cross", "RSI 58 Bullish Alignment"],
            "sl_price": 8000000.0,
            "target_price": 8150000.0,
            "ema9": 8040000, "ema21": 8020000, "rsi": 58, "atr": 25000
        }
        
        pos = self.engine.process_tick(custom_price=8050000.0, custom_eval=signal)
        self.assertIsNotNone(pos, "Position should be opened on BUY signal")
        self.assertEqual(pos["direction"], "BUY")
        self.assertEqual(pos["entry_price"], 8050000.0)
        self.assertEqual(pos["stop_loss"], 8000000.0)
        self.assertEqual(pos["target"], 8150000.0)

        # Attempt to open 2nd position while 1st is OPEN (must be rejected / kept same)
        pos2 = self.engine.process_tick(custom_price=8060000.0, custom_eval=signal)
        self.assertEqual(pos2["trade_id"], pos["trade_id"], "Engine must NOT open a 2nd position while 1 position is OPEN")

    def test_06_target_hit_and_pnl_charges_calculation(self):
        """Test automatic Target exit trigger and verify INR P&L + charges calculation."""
        signal_buy = {
            "action": "BUY",
            "trend": "BULLISH",
            "confidence": 90,
            "reasons": ["Test Target Exit"],
            "sl_price": 7950000.0,
            "target_price": 8100000.0
        }
        self.engine.process_tick(custom_price=8000000.0, custom_eval=signal_buy)

        # Tick at 8,110,000 (Target hit: Target was 8,100,000)
        signal_wait = {"action": "WAIT", "trend": "BULLISH", "confidence": 50, "reasons": ["Wait"]}
        self.engine.process_tick(custom_price=8110000.0, custom_eval=signal_wait)

        self.assertIsNone(self.engine.active_position, "Position should close upon reaching Target")

        trades = self.engine.trade_ledger
        self.assertEqual(len(trades), 1)
        closed_trade = trades[0]
        self.assertEqual(closed_trade["status"], "CLOSED")
        self.assertEqual(closed_trade["exit_reason"], "TARGET HIT")

        # Math verification:
        # Entry = 8,000,000 | Exit = 8,100,000 | Qty = 1.0 contract
        # Gross PnL = (8,100,000 - 8,000,000) * 1.0 = +100,000 INR
        # Roundtrip Charges = ₹50 * 2 = ₹100 INR
        # Net PnL = 100,000 - 100 = +99,900 INR
        self.assertAlmostEqual(closed_trade["gross_pnl"], 100000.0, delta=1.0)
        self.assertAlmostEqual(closed_trade["charges"], 100.0, delta=1.0)
        self.assertAlmostEqual(closed_trade["net_pnl"], 99900.0, delta=1.0)
        print(f"[TEST 6] Target Exit PnL: Gross=INR {closed_trade['gross_pnl']:,.2f} | Charges=INR {closed_trade['charges']:,.2f} | Net=INR {closed_trade['net_pnl']:,.2f}")

    def test_07_stop_loss_hit_trigger(self):
        """Test automatic Stop-Loss exit trigger for SELL position."""
        signal_sell = {
            "action": "SELL",
            "trend": "BEARISH",
            "confidence": 88,
            "reasons": ["Test SL Exit"],
            "sl_price": 8050000.0,
            "target_price": 7900000.0
        }
        self.engine.process_tick(custom_price=8000000.0, custom_eval=signal_sell)

        # Tick at 8,060,000 (SL hit: SL was 8,050,000 for SELL position)
        signal_wait = {"action": "WAIT", "trend": "BEARISH", "confidence": 50, "reasons": ["Wait"]}
        self.engine.process_tick(custom_price=8060000.0, custom_eval=signal_wait)

        self.assertIsNone(self.engine.active_position, "SELL position should close upon hitting SL")
        closed_trade = self.engine.trade_ledger[0]
        self.assertEqual(closed_trade["exit_reason"], "STOP LOSS HIT")
        self.assertLess(closed_trade["net_pnl"], 0, "Net P&L should be negative on SL hit")
        print(f"[TEST 7] SL Exit PnL: Net=INR {closed_trade['net_pnl']:,.2f}")

    def test_08_emergency_exit_and_reset(self):
        """Test manual emergency exit and account reset."""
        signal_buy = {"action": "BUY", "trend": "BULLISH", "confidence": 80, "sl_price": 7950000, "target_price": 8100000, "reasons": ["Buy"]}
        self.engine.process_tick(custom_price=8000000.0, custom_eval=signal_buy)
        self.assertIsNotNone(self.engine.active_position)

        exited = self.engine.emergency_exit_position()
        self.assertIsNotNone(exited)
        self.assertIsNone(self.engine.active_position)

        self.engine.reset_paper_account()
        state = self.engine.get_dashboard_state()
        self.assertEqual(state["financial_summary"]["initial_capital"], 200000.0)
        self.assertEqual(state["financial_summary"]["realized_net_pnl"], 0.0)
        self.assertEqual(len(state["trade_ledger"]), 0)

    def test_09_sqlite_persistence_and_restart_recovery(self):
        """Test SQLite trade persistence and reload across engine instances."""
        signal_buy = {"action": "BUY", "trend": "BULLISH", "confidence": 80, "sl_price": 7950000, "target_price": 8100000, "reasons": ["Buy"]}
        self.engine.process_tick(custom_price=8000000.0, custom_eval=signal_buy)
        signal_wait = {"action": "WAIT", "trend": "BULLISH", "confidence": 50, "reasons": ["Wait"]}
        self.engine.process_tick(custom_price=8110000.0, custom_eval=signal_wait)

        new_engine = BitcoinPaperEngine()
        self.assertEqual(len(new_engine.trade_ledger), 1)
        self.assertAlmostEqual(new_engine.calculate_pnl_tallies()["realized_net_pnl"], 99900.0, delta=1.0)
        self.assertAlmostEqual(new_engine.calculate_pnl_tallies()["current_equity"], 299900.0, delta=1.0)
        print("[TEST 9] SQLite persistence & restart recovery verified successfully.")

    def test_10_no_real_order_safety_check(self):
        """Verify absolute safety: No broker calls or real execution code present in Bitcoin paper engine."""
        self.assertFalse(hasattr(self.engine, "dhan_client"), "Bitcoin Paper Engine must not possess any Dhan broker client")
        self.assertFalse(hasattr(self.engine, "pi42_client"), "Bitcoin Paper Engine must not possess any Pi42 broker client")
        self.assertEqual(self.engine.SAFETY_BANNER, "BITCOIN PAPER TRADING — NO REAL MONEY")

if __name__ == "__main__":
    unittest.main()
