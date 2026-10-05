"""
Unit & Integration Tests for BTC UP-DOWN CAPTURE 10 Paper Test Engine.
Validates:
- UP signal -> LONG entry
- DOWN signal -> SHORT entry
- FLAT -> no entry
- Target close (+Rs. 100 NET)
- Max-loss close (-Rs. 60 NET)
- Slot replacement (closed slot becomes AVAILABLE & accepts new position)
- Maximum 10 simultaneous positions limit
- Fee-adjusted NET P&L math (taker fees)
- Zero real Mudrex order calls (100% paper execution)
- Restart / state persistence from SQLite DB
"""

import unittest
import os
import time
import json
from unittest.mock import MagicMock, patch

# Point DB to isolated test database
os.environ["DATABASE_PATH"] = "test_bitcoin_updown10_trading.db"

from database import DB
from bitcoin_updown10_engine import BITCOIN_UPDOWN10_ENGINE, BitcoinUpDown10Engine

class TestBitcoinUpDown10Engine(unittest.TestCase):

    def setUp(self):
        """Resets paper account and engine state before each test."""
        DB.reset_bitcoin_updown10_paper_account()
        self.engine = BitcoinUpDown10Engine()
        self.engine.reset_account()

    def tearDown(self):
        """Cleans up paper account state after each test."""
        DB.reset_bitcoin_updown10_paper_account()

    def test_01_up_signal_opens_long_position(self):
        """UP momentum signal must open a LONG (BUY) position in the first available slot."""
        candles = [
            {"open": 8000000.0, "high": 8010000.0, "low": 7990000.0, "close": 8000000.0},
            {"open": 8000000.0, "high": 8020000.0, "low": 8000000.0, "close": 8010000.0},
            {"open": 8010000.0, "high": 8050000.0, "low": 8010000.0, "close": 8050000.0} # +0.625% UP
        ]
        
        signal, change_pct, reason = self.engine.evaluate_direction_signal(candles)
        self.assertEqual(signal, "UP")
        self.assertGreater(change_pct, 0.03)

        with patch.object(self.engine, 'evaluate_direction_signal', return_value=("UP", 0.625, "UP signal")):
            state = self.engine.evaluate_tick(price_usd=80000.0, price_inr=8160000.0)
            self.assertEqual(state["active_slots_count"], 1)

            slot1 = self.engine.active_slots[1]
            self.assertIsNotNone(slot1)
            self.assertEqual(slot1["direction"], "BUY")
            self.assertEqual(slot1["slot_index"], 1)
            self.assertEqual(slot1["status"], "OPEN")
            print("[TEST 01 PASS] UP signal opened LONG position in Slot #1")

    def test_02_down_signal_opens_short_position(self):
        """DOWN momentum signal must open a SHORT (SELL) position in the first available slot."""
        candles = [
            {"open": 8050000.0, "high": 8050000.0, "low": 8000000.0, "close": 8050000.0},
            {"open": 8050000.0, "high": 8050000.0, "low": 8010000.0, "close": 8010000.0},
            {"open": 8010000.0, "high": 8010000.0, "low": 7980000.0, "close": 7980000.0} # -0.87% DOWN
        ]

        signal, change_pct, reason = self.engine.evaluate_direction_signal(candles)
        self.assertEqual(signal, "DOWN")

        # Mock feed return so engine sees DOWN signal
        with patch.object(self.engine, 'evaluate_direction_signal', return_value=("DOWN", -0.87, "DOWN signal")):
            state = self.engine.evaluate_tick(price_usd=78235.0, price_inr=7980000.0)
            self.assertEqual(state["active_slots_count"], 1)

            slot1 = self.engine.active_slots[1]
            self.assertIsNotNone(slot1)
            self.assertEqual(slot1["direction"], "SELL")
            self.assertEqual(slot1["slot_index"], 1)
            print("[TEST 02 PASS] DOWN signal opened SHORT position in Slot #1")

    def test_03_flat_signal_triggers_no_entry(self):
        """FLAT movement within noise band must NOT open any position."""
        candles = [
            {"open": 8000000.0, "high": 8001000.0, "low": 7999000.0, "close": 8000000.0},
            {"open": 8000000.0, "high": 8001000.0, "low": 7999000.0, "close": 8000100.0},
            {"open": 8000100.0, "high": 8001500.0, "low": 7999500.0, "close": 8000200.0} # +0.0025% FLAT
        ]

        signal, change_pct, reason = self.engine.evaluate_direction_signal(candles)
        self.assertEqual(signal, "FLAT")

        with patch.object(self.engine, 'evaluate_direction_signal', return_value=("FLAT", 0.002, "FLAT signal")):
            state = self.engine.evaluate_tick(price_usd=78433.0, price_inr=8000200.0)
            self.assertEqual(state["active_slots_count"], 0)
            print("[TEST 03 PASS] FLAT signal triggered NO new position")

    def test_04_target_close_plus_100_net(self):
        """Active position hitting NET P&L >= +Rs.100 must close position and free slot."""
        # Open LONG in slot #1 @ 8,000,000 INR
        self.engine.open_position_in_slot(1, "UP", 78431.0, 8000000.0, 102.0, "Test Entry")
        pos = self.engine.active_slots[1]
        self.assertIsNotNone(pos)

        # Quantity for 17,500 INR notional @ 8,000,000 = 0.0021875 BTC
        # Taker charges entry + exit ≈ Rs.17.50
        # To get +100 NET P&L, gross P&L must be ~+117.50 INR.
        # Price move needed: 117.50 / 0.0021875 = +53,714 INR (~8,054,000 INR)
        higher_price_inr = 8060000.0
        higher_price_usd = 79019.0

        with patch.object(self.engine, 'evaluate_direction_signal', return_value=("FLAT", 0.0, "FLAT")):
            state = self.engine.evaluate_tick(price_usd=higher_price_usd, price_inr=higher_price_inr)
            
            # Slot 1 should be closed & freed to AVAILABLE
            self.assertIsNone(self.engine.active_slots[1])
            self.assertEqual(state["target_hits_count"], 1)
            self.assertGreaterEqual(state["realized_test_pnl"], 100.0)
            print("[TEST 04 PASS] Profit Target (+Rs. 100 NET) closed position & freed Slot #1")

    def test_05_max_loss_close_minus_60_net(self):
        """Active position hitting NET P&L <= -Rs.60 must close position and free slot."""
        # Open LONG in slot #1 @ 8,000,000 INR
        self.engine.open_position_in_slot(1, "UP", 78431.0, 8000000.0, 102.0, "Test Entry")

        # Price drops significantly causing NET P&L <= -60
        drop_price_inr = 7960000.0 # -40,000 per BTC -> Gross ~ -87.50 INR
        drop_price_usd = 78039.0

        with patch.object(self.engine, 'evaluate_direction_signal', return_value=("FLAT", 0.0, "FLAT")):
            state = self.engine.evaluate_tick(price_usd=drop_price_usd, price_inr=drop_price_inr)
            
            self.assertIsNone(self.engine.active_slots[1])
            self.assertEqual(state["max_loss_hits_count"], 1)
            self.assertLessEqual(state["realized_test_pnl"], -60.0)
            print("[TEST 05 PASS] Max Loss (-Rs. 60 NET) closed position & freed Slot #1")

    def test_06_slot_replacement_and_reentry(self):
        """When a slot closes, it returns to AVAILABLE and can take a new position on next UP/DOWN signal."""
        # Open slot 1
        self.engine.open_position_in_slot(1, "UP", 78431.0, 8000000.0, 102.0, "Test Entry")
        self.assertIsNotNone(self.engine.active_slots[1])

        # Close slot 1 via emergency exit
        self.engine.emergency_exit_slot(1)
        self.assertIsNone(self.engine.active_slots[1])

        # Evaluate next tick with UP signal -> Slot 1 should accept new position
        with patch.object(self.engine, 'evaluate_direction_signal', return_value=("UP", 0.05, "New UP Signal")):
            state = self.engine.evaluate_tick(price_usd=78500.0, price_inr=8007000.0)
            self.assertEqual(state["active_slots_count"], 1)
            self.assertIsNotNone(self.engine.active_slots[1])
            print("[TEST 06 PASS] Slot replacement verified: Closed slot returned to AVAILABLE and took new position")

    def test_07_maximum_10_simultaneous_positions_limit(self):
        """Engine must enforce a strict limit of maximum 10 simultaneous positions."""
        for i in range(1, 11):
            res = self.engine.open_position_in_slot(i, "UP", 78431.0, 8000000.0, 102.0, f"Fill Slot #{i}")
            self.assertIsNotNone(res)

        self.assertEqual(self.engine.get_first_available_slot(), None)

        # Attempt 11th entry on UP signal
        with patch.object(self.engine, 'evaluate_direction_signal', return_value=("UP", 0.10, "UP Signal")):
            state = self.engine.evaluate_tick(price_usd=78500.0, price_inr=8007000.0)
            self.assertEqual(state["active_slots_count"], 10)
            self.assertEqual(state["available_slots_count"], 0)
            print("[TEST 07 PASS] Maximum 10 simultaneous positions strictly enforced")

    def test_08_fee_adjusted_net_pnl_math(self):
        """Verifies Mudrex taker fee model (0.05% entry + 0.05% exit) in NET P&L calculation."""
        # Entry @ 8,000,000 INR, Notional 17,500 INR -> Entry fee = 17500 * 0.0005 = 8.75 INR
        # Exit @ 8,000,000 INR -> Exit fee = 17500 * 0.0005 = 8.75 INR
        # Total fees = 17.50 INR. Gross PnL = 0.0. Net PnL = -17.50 INR.
        entry_fee, exit_fee, total_fee = self.engine.calculate_taker_charges(8000000.0, 8000000.0, 0.0021875)
        self.assertEqual(entry_fee, 8.75)
        self.assertEqual(exit_fee, 8.75)
        self.assertEqual(total_fee, 17.50)
        print("[TEST 08 PASS] Realistic Taker Fee calculation verified: 0.05% entry + 0.05% exit")

    def test_09_zero_real_mudrex_orders_called(self):
        """Verifies that no real Mudrex live ordering functions are invoked anywhere in this paper test engine."""
        import inspect
        source = inspect.getsource(BitcoinUpDown10Engine)
        self.assertNotIn("post_futures_order", source)
        self.assertNotIn("place_mudrex_order", source)
        self.assertNotIn("execute_live_mudrex_order", source)
        print("[TEST 09 PASS] 100% Paper/Test Isolation verified (Zero broker order calls)")

    def test_10_restart_state_persistence(self):
        """Verifies that open positions and settings persist to SQLite DB and restore on restart."""
        self.engine.update_settings(target_net_inr=150.0, max_loss_net_inr=80.0, min_movement_pct=0.04)
        self.engine.open_position_in_slot(3, "DOWN", 78000.0, 7950000.0, 102.0, "Persist Slot 3")

        # Create new engine instance simulating service restart
        new_engine = BitcoinUpDown10Engine()
        self.assertEqual(new_engine.target_net_inr, 150.0)
        self.assertEqual(new_engine.max_loss_net_inr, 80.0)
        self.assertEqual(new_engine.min_movement_pct, 0.04)

        slot3 = new_engine.active_slots[3]
        self.assertIsNotNone(slot3)
        self.assertEqual(slot3["direction"], "SELL")
        self.assertEqual(slot3["entry_price"], 7950000.0)
        print("[TEST 10 PASS] SQLite DB state persistence across service restarts verified")

if __name__ == "__main__":
    unittest.main()
