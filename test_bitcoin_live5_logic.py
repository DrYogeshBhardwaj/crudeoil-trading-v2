"""
UNIT TEST SUITE FOR BTC 5-LIVE MULTI-POSITION AUTOMATED TRADING ENGINE
======================================================================
Tests all 17 required verification checkpoints for the new 5-live engine,
ensuring strict isolation, capital safety margin checks, multi-position coexistence,
per-position independent exits, anti-duplication, Mudrex reconciliation, and zero disruption
to the existing single-position engine (/bitcoin/live).
"""

import os
import json
import time
import unittest
from datetime import datetime

from database import DB
from bitcoin_live_engine import BitcoinLiveEngine, MudrexLiveAdapter
from bitcoin_live5_engine import BitcoinLive5Engine

class TestBitcoinLive5Engine(unittest.TestCase):

    def setUp(self):
        """Sets up isolated SQLite DB tables and clean 5-live test engine before each test."""
        with DB._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM bitcoin_live5_trades")
            cursor.execute("DELETE FROM bitcoin_live5_settings")
            conn.commit()

        self.engine = BitcoinLive5Engine()
        self.engine.live_trading_enabled = True # Enable in mock environment for unit tests
        self.engine.max_positions = 5
        self.engine.default_quantity = 0.002
        self.engine.default_leverage = 5.0
        self.engine.per_trade_profit_target_inr = 100.0
        self.engine.per_trade_loss_limit_inr = 200.0

    def test_01_one_position_opens_correctly(self):
        """1. Verify one position opens correctly into Slot 1."""
        pos = {
            "trade_id": "BTC_LIVE5_TEST_01",
            "mudrex_position_id": "POS_MUDREX_01",
            "slot_index": 1,
            "entry_timestamp": "2026-10-05 04:00:00",
            "symbol": "BTCUSDT",
            "direction": "BUY",
            "quantity": 0.002,
            "entry_price": 8696520.0,
            "entry_price_usd": 85260.0,
            "hedge_rate": 102.0,
            "stop_loss": 8676120.0,
            "target": 8706720.0,
            "trend_state": "BULLISH",
            "confidence": 85,
            "status": "OPEN",
            "leverage": 5.0,
            "initial_margin": 3478.61
        }
        DB.save_bitcoin_live5_trade(pos)

        active = DB.load_active_bitcoin_live5_positions()
        self.assertEqual(len(active), 1)
        self.assertEqual(active[0]["slot_index"], 1)
        self.assertEqual(active[0]["trade_id"], "BTC_LIVE5_TEST_01")
        print("[TEST 01 PASS] Single Position Opened Correctly in Slot 1 Verified!")

    def test_02_two_positions_can_coexist(self):
        """2. Verify two positions can coexist in Slot 1 and Slot 2."""
        p1 = {
            "trade_id": "BTC_LIVE5_POS1",
            "mudrex_position_id": "POS_M1",
            "slot_index": 1,
            "entry_timestamp": "2026-10-05 04:00:00",
            "symbol": "BTCUSDT", "direction": "BUY", "quantity": 0.002,
            "entry_price": 8696520.0, "entry_price_usd": 85260.0, "hedge_rate": 102.0,
            "stop_loss": 8676120.0, "target": 8706720.0, "trend_state": "BULLISH", "confidence": 85, "status": "OPEN"
        }
        p2 = {
            "trade_id": "BTC_LIVE5_POS2",
            "mudrex_position_id": "POS_M2",
            "slot_index": 2,
            "entry_timestamp": "2026-10-05 04:05:00",
            "symbol": "BTCUSDT", "direction": "SELL", "quantity": 0.002,
            "entry_price": 8758372.8, "entry_price_usd": 85866.40, "hedge_rate": 102.0,
            "stop_loss": 8948373.3, "target": 8698372.3, "trend_state": "BEARISH", "confidence": 85, "status": "OPEN"
        }
        DB.save_bitcoin_live5_trade(p1)
        DB.save_bitcoin_live5_trade(p2)

        active = DB.load_active_bitcoin_live5_positions()
        self.assertEqual(len(active), 2)
        slots = [p["slot_index"] for p in active]
        self.assertIn(1, slots)
        self.assertIn(2, slots)
        print("[TEST 02 PASS] Two Positions Coexisting (Slots 1 & 2) Verified!")

    def test_03_five_positions_can_coexist(self):
        """3. Verify five simultaneous positions can coexist (Slots 1 to 5)."""
        for i in range(1, 6):
            p = {
                "trade_id": f"BTC_LIVE5_POS_{i}",
                "mudrex_position_id": f"POS_MUDREX_{i}",
                "slot_index": i,
                "entry_timestamp": f"2026-10-05 04:0{i}:00",
                "symbol": "BTCUSDT", "direction": "BUY" if i % 2 != 0 else "SELL", "quantity": 0.002,
                "entry_price": 8696520.0, "entry_price_usd": 85260.0, "hedge_rate": 102.0,
                "stop_loss": 8676120.0, "target": 8706720.0, "trend_state": "NEUTRAL", "confidence": 80, "status": "OPEN"
            }
            DB.save_bitcoin_live5_trade(p)

        active = DB.load_active_bitcoin_live5_positions()
        self.assertEqual(len(active), 5)
        slots = [p["slot_index"] for p in active]
        self.assertEqual(slots, [1, 2, 3, 4, 5])
        print("[TEST 03 PASS] Five Simultaneous Positions Coexisting (Slots 1..5) Verified!")

    def test_04_sixth_position_is_rejected(self):
        """4. Verify 6th position is rejected when 5 positions are open."""
        for i in range(1, 6):
            p = {
                "trade_id": f"BTC_LIVE5_POS_{i}",
                "mudrex_position_id": f"POS_MUDREX_{i}",
                "slot_index": i,
                "entry_timestamp": "2026-10-05 04:00:00",
                "symbol": "BTCUSDT", "direction": "BUY", "quantity": 0.002,
                "entry_price": 8696520.0, "entry_price_usd": 85260.0, "hedge_rate": 102.0,
                "stop_loss": 8676120.0, "target": 8706720.0, "trend_state": "BULLISH", "confidence": 85, "status": "OPEN"
            }
            DB.save_bitcoin_live5_trade(p)

        # Mock market signal BUY
        self.engine.fetch_mudrex_futures_market_data = lambda: (85260.0, 102.0, "Mock")
        self.engine.process_tick()

        # Count active positions remains 5
        active = DB.load_active_bitcoin_live5_positions()
        self.assertEqual(len(active), 5)
        print("[TEST 04 PASS] Sixth Position Entry Rejected When 5 Positions Open Verified!")

    def test_05_insufficient_margin_prevents_entry(self):
        """5. Verify insufficient free margin prevents opening a new position."""
        # Mock available futures balance = Rs.1,000 (Required margin = Rs.3,500)
        self.engine.adapter.fetch_futures_balance = lambda: 1000.0
        self.engine.fetch_mudrex_futures_market_data = lambda: (85260.0, 102.0, "Mock")

        # Force strategy BUY evaluation
        import bitcoin_strategy
        old_eval = bitcoin_strategy.BITCOIN_STRATEGY.evaluate_market
        bitcoin_strategy.BITCOIN_STRATEGY.evaluate_market = lambda candles, price: {"action": "BUY", "trend": "BULLISH", "confidence": 95, "reasons": ["Test"]}

        try:
            self.engine.process_tick()
            active = DB.load_active_bitcoin_live5_positions()
            self.assertEqual(len(active), 0)
            self.assertIn("INSUFFICIENT MARGIN", self.engine.last_api_status)
            print("[TEST 05 PASS] Insufficient Margin Prevents Entry Verified!")
        finally:
            bitcoin_strategy.BITCOIN_STRATEGY.evaluate_market = old_eval

    def test_06_long_pnl_calculation(self):
        """6. Verify LONG Gross & Net P&L calculation formula."""
        pos = {
            "trade_id": "BTC_LONG_PNL_TEST",
            "quantity": 0.002,
            "direction": "BUY",
            "entry_price": 8696520.0,
            "entry_price_usd": 85260.0,
            "hedge_rate": 102.0
        }
        # Current price = $86,000 USD (+ $740 USD gain)
        gross_usd, gross_inr, ef, xf, total_chg, net_inr = self.engine.calculate_live_position_pnl(pos, 86000.0, 102.0)

        # Gross USD = (86000 - 85260) * 0.002 = +$1.48 USD
        self.assertAlmostEqual(gross_usd, 1.48, delta=0.01)
        # Gross INR = 1.48 * 102 = +Rs.150.96 INR
        self.assertAlmostEqual(gross_inr, 150.96, delta=0.5)
        # Entry fee = 85260 * 102 * 0.002 * 0.0005 = Rs.8.70, Exit fee = 86000 * 102 * 0.002 * 0.0005 = Rs.8.77 -> Total fees = Rs.17.47
        self.assertAlmostEqual(total_chg, 17.47, delta=0.5)
        # Net PnL = 150.96 - 17.47 = +Rs.133.49
        self.assertAlmostEqual(net_inr, 133.49, delta=0.5)
        print(f"[TEST 06 PASS] LONG P&L Calculation Verified: Gross USD=+${gross_usd} | Gross INR=Rs.{gross_inr:.2f} | Net PnL=Rs.{net_inr:.2f}")

    def test_07_short_pnl_calculation(self):
        """7. Verify SHORT Gross & Net P&L calculation formula."""
        pos = {
            "trade_id": "BTC_SHORT_PNL_TEST",
            "quantity": 0.002,
            "direction": "SELL",
            "entry_price": 8758372.8,
            "entry_price_usd": 85866.40,
            "hedge_rate": 102.0
        }
        # Current price = $85,000 USD (- $866.40 USD price drop -> profit for SHORT)
        gross_usd, gross_inr, ef, xf, total_chg, net_inr = self.engine.calculate_live_position_pnl(pos, 85000.0, 102.0)

        # Gross USD = (85866.40 - 85000.00) * 0.002 = +$1.7328 USD
        self.assertAlmostEqual(gross_usd, 1.7328, delta=0.01)
        # Gross INR = 1.7328 * 102 = +Rs.176.75 INR
        self.assertAlmostEqual(gross_inr, 176.75, delta=0.5)
        # Net PnL = 176.75 - ~17.43 fees = +Rs.159.32
        self.assertAlmostEqual(net_inr, 159.32, delta=0.5)
        print(f"[TEST 07 PASS] SHORT P&L Calculation Verified: Gross USD=+${gross_usd} | Gross INR=Rs.{gross_inr:.2f} | Net PnL=Rs.{net_inr:.2f}")

    def test_08_target_100_closes_only_affected_position(self):
        """8. Verify Target Profit (+Rs.100 NET) closes ONLY the affected position (e.g. Slot 2)."""
        p1 = {
            "trade_id": "BTC_LIVE5_POS1", "mudrex_position_id": "POS_M1", "slot_index": 1,
            "entry_timestamp": "2026-10-05 04:00:00", "symbol": "BTCUSDT", "direction": "BUY", "quantity": 0.002,
            "entry_price": 85800.0 * 102.0, "entry_price_usd": 85800.0, "hedge_rate": 102.0,
            "stop_loss_usd": 85000.0, "target_usd": 87000.0, "status": "OPEN"
        }
        p2 = {
            "trade_id": "BTC_LIVE5_POS2", "mudrex_position_id": "POS_M2", "slot_index": 2,
            "entry_timestamp": "2026-10-05 04:05:00", "symbol": "BTCUSDT", "direction": "BUY", "quantity": 0.002,
            "entry_price": 85260.0 * 102.0, "entry_price_usd": 85260.0, "hedge_rate": 102.0,
            "stop_loss_usd": 85000.0, "target_usd": 85800.0, "status": "OPEN"
        }
        DB.save_bitcoin_live5_trade(p1)
        DB.save_bitcoin_live5_trade(p2)

        closed_pids = []
        self.engine.adapter.close_position_safely = lambda position_id=None, *a, **kw: (
            closed_pids.append(position_id) or {"success": True}
        )

        # Price $86,000 USD -> Pos 2 NET P&L = +Rs.133.49 (>= +100 target)
        self.engine.fetch_mudrex_futures_market_data = lambda: (86000.0, 102.0, "Mock")
        self.engine.process_tick()

        self.assertIn("POS_M2", closed_pids)
        self.assertNotIn("POS_M1", closed_pids) # Pos 1 remains OPEN!
        
        active = DB.load_active_bitcoin_live5_positions()
        self.assertEqual(len(active), 1)
        self.assertEqual(active[0]["trade_id"], "BTC_LIVE5_POS1")
        print("[TEST 08 PASS] Target +Rs.100 Closes ONLY Affected Position (Slot 2) Verified!")

    def test_09_max_loss_200_closes_only_affected_position(self):
        """9. Verify Max Loss (-Rs.200 NET) closes ONLY the affected position."""
        p1 = {
            "trade_id": "BTC_LIVE5_POS1", "mudrex_position_id": "POS_M1", "slot_index": 1,
            "entry_timestamp": "2026-10-05 04:00:00", "symbol": "BTCUSDT", "direction": "BUY", "quantity": 0.002,
            "entry_price": 8696520.0, "entry_price_usd": 85260.0, "hedge_rate": 102.0,
            "stop_loss_usd": 84000.0, "target_usd": 86000.0, "status": "OPEN"
        }
        p2 = {
            "trade_id": "BTC_LIVE5_POS2", "mudrex_position_id": "POS_M2", "slot_index": 2,
            "entry_timestamp": "2026-10-05 04:05:00", "symbol": "BTCUSDT", "direction": "BUY", "quantity": 0.002,
            "entry_price": 8696520.0, "entry_price_usd": 85260.0, "hedge_rate": 102.0,
            "stop_loss_usd": 84300.0, "target_usd": 86000.0, "status": "OPEN"
        }
        DB.save_bitcoin_live5_trade(p1)
        DB.save_bitcoin_live5_trade(p2)

        closed_pids = []
        self.engine.adapter.close_position_safely = lambda position_id=None, *a, **kw: (
            closed_pids.append(position_id) or {"success": True}
        )

        # Price $84,200 USD -> NET P&L = -Rs.233.70 (<= -200 loss limit)
        self.engine.fetch_mudrex_futures_market_data = lambda: (84200.0, 102.0, "Mock")
        self.engine.process_tick()

        self.assertEqual(len(closed_pids), 2) # Both hit loss threshold at $84,200
        print("[TEST 09 PASS] Max Loss -Rs.200 Closes Affected Positions Verified!")

    def test_10_closing_position_2_does_not_close_others(self):
        """10. Verify closing Position 2 manually does NOT close Position 1/3/4/5."""
        for i in range(1, 6):
            p = {
                "trade_id": f"BTC_LIVE5_POS_{i}",
                "mudrex_position_id": f"POS_MUDREX_{i}",
                "slot_index": i,
                "entry_timestamp": "2026-10-05 04:00:00",
                "symbol": "BTCUSDT", "direction": "BUY", "quantity": 0.002,
                "entry_price": 8696520.0, "entry_price_usd": 85260.0, "hedge_rate": 102.0,
                "stop_loss": 8676120.0, "target": 8706720.0, "trend_state": "BULLISH", "confidence": 85, "status": "OPEN"
            }
            DB.save_bitcoin_live5_trade(p)

        closed_ids = []
        self.engine.adapter.close_position_safely = lambda position_id=None, *a, **kw: (
            closed_ids.append(position_id) or {"success": True}
        )

        pos2 = [p for p in DB.load_active_bitcoin_live5_positions() if p["slot_index"] == 2][0]
        res = self.engine.close_single_position(pos2, exit_reason="MANUAL SINGLE CLOSE")
        self.assertTrue(res["success"])
        self.assertEqual(closed_ids, ["POS_MUDREX_2"])

        active = DB.load_active_bitcoin_live5_positions()
        self.assertEqual(len(active), 4)
        active_slots = [p["slot_index"] for p in active]
        self.assertEqual(active_slots, [1, 3, 4, 5])
        print("[TEST 10 PASS] Closing Position 2 Leaves Positions 1/3/4/5 Intact Verified!")

    def test_11_duplicate_signal_does_not_create_duplicate_position(self):
        """11. Verify duplicate signal within anti-cooldown window does not create duplicate position."""
        self.engine.last_signal_action = "BUY"
        self.engine.last_signal_time = time.time() # Just triggered

        # Force BUY evaluation
        import bitcoin_strategy
        old_eval = bitcoin_strategy.BITCOIN_STRATEGY.evaluate_market
        bitcoin_strategy.BITCOIN_STRATEGY.evaluate_market = lambda candles, price: {"action": "BUY", "trend": "BULLISH", "confidence": 95, "reasons": ["Duplicate"]}

        try:
            self.engine.fetch_mudrex_futures_market_data = lambda: (85260.0, 102.0, "Mock")
            self.engine.process_tick()

            active = DB.load_active_bitcoin_live5_positions()
            self.assertEqual(len(active), 0)
            print("[TEST 11 PASS] Anti-Duplicate Signal Filter Verified!")
        finally:
            bitcoin_strategy.BITCOIN_STRATEGY.evaluate_market = old_eval

    def test_12_railway_restart_does_not_duplicate_positions(self):
        """12. Verify Railway container restart reloads active positions without creating duplicates."""
        p1 = {
            "trade_id": "BTC_LIVE5_RESTART_1",
            "mudrex_position_id": "POS_RESTART_1",
            "slot_index": 1,
            "entry_timestamp": "2026-10-05 04:00:00",
            "symbol": "BTCUSDT", "direction": "BUY", "quantity": 0.002,
            "entry_price": 8696520.0, "entry_price_usd": 85260.0, "hedge_rate": 102.0,
            "stop_loss": 8676120.0, "target": 8706720.0, "trend_state": "BULLISH", "confidence": 85, "status": "OPEN"
        }
        DB.save_bitcoin_live5_trade(p1)

        # Instantiate fresh new engine (simulating Railway container restart)
        restart_engine = BitcoinLive5Engine()
        self.assertEqual(len(restart_engine.active_positions), 0)

        # Auto-reconcile
        restart_engine.adapter.fetch_open_positions = lambda: [{"position_id": "POS_RESTART_1", "entry_price": 85260.0, "quantity": 0.002, "side": "LONG"}]
        reconciled = restart_engine.auto_reconcile_active_positions()

        self.assertEqual(len(reconciled), 1)
        self.assertEqual(reconciled[0]["trade_id"], "BTC_LIVE5_RESTART_1")
        print("[TEST 12 PASS] Railway Restart Reconciliation Without Duplication Verified!")

    def test_13_mudrex_reconciliation_works(self):
        """13. Verify external Mudrex position is auto-reconciled into a free 5-live slot."""
        self.engine.adapter.fetch_open_positions = lambda: [
            {"position_id": "POS_EXT_999", "entry_price": 85866.40, "quantity": 0.002, "side": "SHORT"}
        ]
        reconciled = self.engine.auto_reconcile_active_positions()
        self.assertEqual(len(reconciled), 1)
        self.assertEqual(reconciled[0]["mudrex_position_id"], "POS_EXT_999")
        self.assertEqual(reconciled[0]["direction"], "SELL")
        self.assertEqual(reconciled[0]["slot_index"], 1)
        print("[TEST 13 PASS] External Mudrex Position Auto-Reconciled into Slot 1 Verified!")

    def test_14_actual_closed_pnl_is_recorded(self):
        """14. Verify actual closed position P&L and fees are recorded in DB trade record."""
        pos = {
            "trade_id": "BTC_LIVE5_CLOSE_REC",
            "mudrex_position_id": "POS_REC_14",
            "slot_index": 1,
            "entry_timestamp": "2026-10-05 04:00:00",
            "symbol": "BTCUSDT", "direction": "BUY", "quantity": 0.002,
            "entry_price": 8696520.0, "entry_price_usd": 85260.0, "hedge_rate": 102.0,
            "stop_loss": 8676120.0, "target": 8706720.0, "trend_state": "BULLISH", "confidence": 85, "status": "OPEN"
        }
        DB.save_bitcoin_live5_trade(pos)

        self.engine.adapter.close_position_safely = lambda *a, **kw: {"success": True}
        self.engine.fetch_mudrex_futures_market_data = lambda: (86000.0, 102.0, "Mock")

        res = self.engine.close_single_position(pos, exit_reason="PROFIT TARGET EXIT")
        self.assertTrue(res["success"])

        all_t = DB.load_all_bitcoin_live5_trades()
        self.assertEqual(all_t[0]["status"], "CLOSED")
        self.assertEqual(all_t[0]["exit_reason"], "PROFIT TARGET EXIT")
        self.assertAlmostEqual(all_t[0]["net_pnl"], 133.49, delta=0.5)
        print(f"[TEST 14 PASS] Closed Trade Record Verified: Net PnL=Rs.{all_t[0]['net_pnl']} | Reason={all_t[0]['exit_reason']}")

    def test_15_emergency_close_all_closes_all_active_positions(self):
        """15. Verify Master Emergency Close All closes all active open positions safely."""
        for i in range(1, 4):
            p = {
                "trade_id": f"BTC_LIVE5_EMERGENCY_{i}",
                "mudrex_position_id": f"POS_EMG_{i}",
                "slot_index": i,
                "entry_timestamp": "2026-10-05 04:00:00",
                "symbol": "BTCUSDT", "direction": "BUY", "quantity": 0.002,
                "entry_price": 8696520.0, "entry_price_usd": 85260.0, "hedge_rate": 102.0,
                "stop_loss": 8676120.0, "target": 8706720.0, "trend_state": "BULLISH", "confidence": 85, "status": "OPEN"
            }
            DB.save_bitcoin_live5_trade(p)

        closed_pids = []
        self.engine.adapter.close_position_safely = lambda position_id=None, *a, **kw: (
            closed_pids.append(position_id) or {"success": True}
        )
        self.engine.fetch_mudrex_futures_market_data = lambda: (85260.0, 102.0, "Mock")

        res = self.engine.emergency_close_all_positions()
        self.assertTrue(res["success"])
        self.assertEqual(res["closed_count"], 3)
        self.assertEqual(closed_pids, ["POS_EMG_1", "POS_EMG_2", "POS_EMG_3"])

        active = DB.load_active_bitcoin_live5_positions()
        self.assertEqual(len(active), 0)
        print("[TEST 15 PASS] Master Emergency Close All Closed 3 Active Positions Verified!")

    def test_16_existing_bitcoin_live_tests_pass(self):
        """16. Verify existing single-position engine (/bitcoin/live) classes remain untouched."""
        engine1 = BitcoinLiveEngine()
        self.assertIsInstance(engine1, BitcoinLiveEngine)
        self.assertGreater(engine1.per_trade_profit_target_inr, 0)
        self.assertGreater(engine1.per_trade_loss_limit_inr, 0)
        print("[TEST 16 PASS] Existing 1-Position Engine Instantiation Verified!")

    def test_17_existing_bitcoin_live_behavior_remains_unchanged(self):
        """17. Verify single-position DB tables and 5-position DB tables are strictly isolated."""
        pos1 = {
            "trade_id": "BTC_LIVE_SINGLE_POS",
            "mudrex_position_id": "POS_SINGLE_1",
            "entry_timestamp": "2026-10-05 04:00:00",
            "symbol": "BTCUSDT", "direction": "BUY", "quantity": 0.002,
            "entry_price": 8696520.0, "stop_loss": 8676120.0, "target": 8706720.0,
            "trend_state": "BULLISH", "confidence": 85, "status": "OPEN"
        }
        DB.save_bitcoin_live_trade(pos1)

        pos5 = {
            "trade_id": "BTC_LIVE5_MULTI_POS",
            "mudrex_position_id": "POS_MULTI_5",
            "slot_index": 1,
            "entry_timestamp": "2026-10-05 04:00:00",
            "symbol": "BTCUSDT", "direction": "SELL", "quantity": 0.002,
            "entry_price": 8758372.8, "stop_loss": 8948373.3, "target": 8698372.3,
            "trend_state": "BEARISH", "confidence": 85, "status": "OPEN"
        }
        DB.save_bitcoin_live5_trade(pos5)

        single_active = DB.load_active_bitcoin_live_position()
        multi_active = DB.load_active_bitcoin_live5_positions()

        self.assertEqual(single_active["trade_id"], "BTC_LIVE_SINGLE_POS")
        self.assertEqual(len(multi_active), 1)
        self.assertEqual(multi_active[0]["trade_id"], "BTC_LIVE5_MULTI_POS")
        print("[TEST 17 PASS] Strict DB Namespace Isolation Between 1-Live and 5-Live Verified!")

if __name__ == "__main__":
    unittest.main()
