"""
Automated Test Suite for Bitcoin Live Engine Rebuild V2 (Requirements A through Q)
Verifies 100% compliance before production deployment approval.
"""

import unittest
import os
import time
import json
import sqlite3
from unittest.mock import MagicMock, patch
from datetime import datetime

# Environment override for test database
os.environ["DATABASE_PATH"] = "test_bitcoin_live_rebuild_trading.db"

from database import DB
from bitcoin_live_engine import BitcoinLiveEngine, MudrexLiveAdapter, LiveTradeState, TradeStatus
from bitcoin_feed import BITCOIN_FEED
from bitcoin_strategy import BITCOIN_STRATEGY


class TestBitcoinLiveEngineRebuild(unittest.TestCase):

    def setUp(self):
        # Reset test DB tables before each test
        with sqlite3.connect(DB.db_path) as conn:
            cur = conn.cursor()
            cur.execute("DELETE FROM bitcoin_live_trades")
            cur.execute("DELETE FROM bitcoin_live_settings")
            conn.commit()

        self.feed_patcher = patch.object(BITCOIN_FEED, 'fetch_historical_candles', return_value=[])
        self.strat_patcher = patch.object(BITCOIN_STRATEGY, 'evaluate_market', return_value={'action': 'WAIT', 'trend': 'NEUTRAL', 'confidence': 50, 'reasons': ['Mock']})
        self.mock_candles = self.feed_patcher.start()
        self.mock_eval = self.strat_patcher.start()

        self.engine = BitcoinLiveEngine()
        self.engine.live_trading_enabled = False  # Test mode
        self.adapter = self.engine.adapter

    def tearDown(self):
        self.feed_patcher.stop()
        self.strat_patcher.stop()

    # TEST A: LONG target
    def test_A_long_target_hit(self):
        tp_usd, sl_usd, tp_inr, sl_inr, tp_gross, sl_gross = self.engine.calculate_sl_and_target_prices(
            direction="BUY", entry_price_usd=85000.0, quantity=0.002, hedge_rate=102.0, target_net_inr=100.0, max_loss_net_inr=200.0
        )
        
        trade = LiveTradeState(
            trade_id="TEST_LONG_TP",
            mudrex_position_id="MUDREX_POS_001",
            direction="BUY",
            quantity=0.002,
            leverage=5.0,
            entry_price_usd=85000.0,
            entry_price=8670000.0,
            hedge_rate=102.0,
            entry_timestamp="2026-10-05 10:00:00",
            target_net_inr=100.0,
            max_loss_net_inr=200.0,
            target_usd=tp_usd,
            stop_loss_usd=sl_usd,
            target=tp_inr,
            stop_loss=sl_inr,
            status=TradeStatus.OPEN.value
        )
        DB.save_bitcoin_live_trade(trade.to_dict())

        with patch.object(self.engine, 'fetch_mudrex_futures_market_data', return_value=(tp_usd + 5.0, 102.0, 'Mock Price')):
            self.engine.process_tick()

        raw = DB.load_all_bitcoin_live_trades()[0]
        self.assertEqual(raw["status"], TradeStatus.CLOSED.value)
        self.assertIn("PROFIT TARGET", raw["exit_reason"])
        self.assertGreaterEqual(raw["net_pnl"], 100.0)

    # TEST B: LONG loss
    def test_B_long_loss_hit(self):
        tp_usd, sl_usd, tp_inr, sl_inr, _, _ = self.engine.calculate_sl_and_target_prices(
            direction="BUY", entry_price_usd=85000.0, quantity=0.002, hedge_rate=102.0, target_net_inr=100.0, max_loss_net_inr=200.0
        )
        
        trade = LiveTradeState(
            trade_id="TEST_LONG_SL",
            mudrex_position_id="MUDREX_POS_002",
            direction="BUY",
            quantity=0.002,
            leverage=5.0,
            entry_price_usd=85000.0,
            entry_price=8670000.0,
            hedge_rate=102.0,
            entry_timestamp="2026-10-05 10:00:00",
            target_net_inr=100.0,
            max_loss_net_inr=200.0,
            target_usd=tp_usd,
            stop_loss_usd=sl_usd,
            target=tp_inr,
            stop_loss=sl_inr,
            status=TradeStatus.OPEN.value
        )
        DB.save_bitcoin_live_trade(trade.to_dict())

        with patch.object(self.engine, 'fetch_mudrex_futures_market_data', return_value=(sl_usd - 5.0, 102.0, 'Mock Price')):
            self.engine.process_tick()

        raw = DB.load_all_bitcoin_live_trades()[0]
        self.assertEqual(raw["status"], TradeStatus.CLOSED.value)
        self.assertIn("LOSS LIMIT", raw["exit_reason"])
        self.assertLessEqual(raw["net_pnl"], -200.0)

    # TEST C: SHORT target
    def test_C_short_target_hit(self):
        tp_usd, sl_usd, tp_inr, sl_inr, _, _ = self.engine.calculate_sl_and_target_prices(
            direction="SELL", entry_price_usd=85000.0, quantity=0.002, hedge_rate=102.0, target_net_inr=100.0, max_loss_net_inr=200.0
        )

        trade = LiveTradeState(
            trade_id="TEST_SHORT_TP",
            mudrex_position_id="MUDREX_POS_003",
            direction="SELL",
            quantity=0.002,
            leverage=5.0,
            entry_price_usd=85000.0,
            entry_price=8670000.0,
            hedge_rate=102.0,
            entry_timestamp="2026-10-05 10:00:00",
            target_net_inr=100.0,
            max_loss_net_inr=200.0,
            target_usd=tp_usd,
            stop_loss_usd=sl_usd,
            target=tp_inr,
            stop_loss=sl_inr,
            status=TradeStatus.OPEN.value
        )
        DB.save_bitcoin_live_trade(trade.to_dict())

        with patch.object(self.engine, 'fetch_mudrex_futures_market_data', return_value=(tp_usd - 5.0, 102.0, 'Mock Price')):
            self.engine.process_tick()

        raw = DB.load_all_bitcoin_live_trades()[0]
        self.assertEqual(raw["status"], TradeStatus.CLOSED.value)
        self.assertIn("PROFIT TARGET", raw["exit_reason"])
        self.assertGreaterEqual(raw["net_pnl"], 100.0)

    # TEST D: SHORT loss
    def test_D_short_loss_hit(self):
        tp_usd, sl_usd, tp_inr, sl_inr, _, _ = self.engine.calculate_sl_and_target_prices(
            direction="SELL", entry_price_usd=85000.0, quantity=0.002, hedge_rate=102.0, target_net_inr=100.0, max_loss_net_inr=200.0
        )

        trade = LiveTradeState(
            trade_id="TEST_SHORT_SL",
            mudrex_position_id="MUDREX_POS_004",
            direction="SELL",
            quantity=0.002,
            leverage=5.0,
            entry_price_usd=85000.0,
            entry_price=8670000.0,
            hedge_rate=102.0,
            entry_timestamp="2026-10-05 10:00:00",
            target_net_inr=100.0,
            max_loss_net_inr=200.0,
            target_usd=tp_usd,
            stop_loss_usd=sl_usd,
            target=tp_inr,
            stop_loss=sl_inr,
            status=TradeStatus.OPEN.value
        )
        DB.save_bitcoin_live_trade(trade.to_dict())

        with patch.object(self.engine, 'fetch_mudrex_futures_market_data', return_value=(sl_usd + 5.0, 102.0, 'Mock Price')):
            self.engine.process_tick()

        raw = DB.load_all_bitcoin_live_trades()[0]
        self.assertEqual(raw["status"], TradeStatus.CLOSED.value)
        self.assertIn("LOSS LIMIT", raw["exit_reason"])

    # TEST E: Fees make gross ₹100 insufficient
    def test_E_gross_100_insufficient_for_net_100(self):
        tp_usd, sl_usd, _, _, _, _ = self.engine.calculate_sl_and_target_prices(
            direction="BUY", entry_price_usd=85000.0, quantity=0.002, hedge_rate=102.0, target_net_inr=100.0, max_loss_net_inr=200.0
        )
        
        trade = LiveTradeState(
            trade_id="TEST_GROSS_100",
            mudrex_position_id="MUDREX_POS_005",
            direction="BUY",
            quantity=0.002,
            leverage=5.0,
            entry_price_usd=85000.0,
            entry_price=8670000.0,
            hedge_rate=102.0,
            entry_timestamp="2026-10-05 10:00:00",
            target_net_inr=100.0,
            max_loss_net_inr=200.0,
            target_usd=tp_usd,
            stop_loss_usd=sl_usd,
            status=TradeStatus.OPEN.value
        )
        DB.save_bitcoin_live_trade(trade.to_dict())

        price_gross_100 = 85000.0 + (100.0 / (0.002 * 102.0))
        
        with patch.object(self.engine, 'fetch_mudrex_futures_market_data', return_value=(price_gross_100, 102.0, 'Mock Price')):
            self.engine.process_tick()

        raw = DB.load_all_bitcoin_live_trades()[0]
        self.assertEqual(raw["status"], TradeStatus.OPEN.value)

    # TEST F: Gross +₹120-ish with actual fees achieves NET ₹100
    def test_F_gross_120_achieves_net_100(self):
        tp_usd, sl_usd, _, _, _, _ = self.engine.calculate_sl_and_target_prices(
            direction="BUY", entry_price_usd=85000.0, quantity=0.002, hedge_rate=102.0, target_net_inr=100.0, max_loss_net_inr=200.0
        )

        trade = LiveTradeState(
            trade_id="TEST_NET_100_VERIFY",
            mudrex_position_id="MUDREX_POS_006",
            direction="BUY",
            quantity=0.002,
            leverage=5.0,
            entry_price_usd=85000.0,
            entry_price=8670000.0,
            hedge_rate=102.0,
            entry_timestamp="2026-10-05 10:00:00",
            target_net_inr=100.0,
            max_loss_net_inr=200.0,
            target_usd=tp_usd,
            stop_loss_usd=sl_usd,
            status=TradeStatus.OPEN.value
        )
        DB.save_bitcoin_live_trade(trade.to_dict())

        with patch.object(self.engine, 'fetch_mudrex_futures_market_data', return_value=(tp_usd, 102.0, 'Mock Price')):
            self.engine.process_tick()

        raw = DB.load_all_bitcoin_live_trades()[0]
        self.assertEqual(raw["status"], TradeStatus.CLOSED.value)
        self.assertGreaterEqual(raw["net_pnl"], 100.0)

    # TEST G: Tiny positive move (Gross +₹2) MUST NOT close
    def test_G_tiny_positive_move_does_not_close(self):
        tp_usd, sl_usd, _, _, _, _ = self.engine.calculate_sl_and_target_prices(
            direction="BUY", entry_price_usd=85000.0, quantity=0.002, hedge_rate=102.0, target_net_inr=100.0, max_loss_net_inr=200.0
        )

        trade = LiveTradeState(
            trade_id="TEST_TINY_POS",
            mudrex_position_id="MUDREX_POS_007",
            direction="BUY",
            quantity=0.002,
            leverage=5.0,
            entry_price_usd=85000.0,
            entry_price=8670000.0,
            hedge_rate=102.0,
            entry_timestamp="2026-10-05 10:00:00",
            target_net_inr=100.0,
            max_loss_net_inr=200.0,
            target_usd=tp_usd,
            stop_loss_usd=sl_usd,
            status=TradeStatus.OPEN.value
        )
        DB.save_bitcoin_live_trade(trade.to_dict())

        with patch.object(self.engine, 'fetch_mudrex_futures_market_data', return_value=(85010.0, 102.0, 'Mock Price')):
            self.engine.process_tick()

        raw = DB.load_all_bitcoin_live_trades()[0]
        self.assertEqual(raw["status"], TradeStatus.OPEN.value)

    # TEST H: Tiny negative move (Gross -₹2) MUST NOT close
    def test_H_tiny_negative_move_does_not_close(self):
        tp_usd, sl_usd, _, _, _, _ = self.engine.calculate_sl_and_target_prices(
            direction="BUY", entry_price_usd=85000.0, quantity=0.002, hedge_rate=102.0, target_net_inr=100.0, max_loss_net_inr=200.0
        )

        trade = LiveTradeState(
            trade_id="TEST_TINY_NEG",
            mudrex_position_id="MUDREX_POS_008",
            direction="BUY",
            quantity=0.002,
            leverage=5.0,
            entry_price_usd=85000.0,
            entry_price=8670000.0,
            hedge_rate=102.0,
            entry_timestamp="2026-10-05 10:00:00",
            target_net_inr=100.0,
            max_loss_net_inr=200.0,
            target_usd=tp_usd,
            stop_loss_usd=sl_usd,
            status=TradeStatus.OPEN.value
        )
        DB.save_bitcoin_live_trade(trade.to_dict())

        with patch.object(self.engine, 'fetch_mudrex_futures_market_data', return_value=(84990.0, 102.0, 'Mock Price')):
            self.engine.process_tick()

        raw = DB.load_all_bitcoin_live_trades()[0]
        self.assertEqual(raw["status"], TradeStatus.OPEN.value)

    # TEST I: Missing target_usd / target price (0 or None)
    def test_I_missing_target_usd_does_not_close(self):
        trade = LiveTradeState(
            trade_id="TEST_MISSING_KEY",
            mudrex_position_id="MUDREX_POS_009",
            direction="BUY",
            quantity=0.002,
            leverage=5.0,
            entry_price_usd=85000.0,
            entry_price=8670000.0,
            hedge_rate=102.0,
            entry_timestamp="2026-10-05 10:00:00",
            target_net_inr=100.0,
            max_loss_net_inr=200.0,
            target_usd=0.0,
            stop_loss_usd=0.0,
            status=TradeStatus.OPEN.value
        )
        DB.save_bitcoin_live_trade(trade.to_dict())

        with patch.object(self.engine, 'fetch_mudrex_futures_market_data', return_value=(85050.0, 102.0, 'Mock Price')):
            self.engine.process_tick()

        raw = DB.load_all_bitcoin_live_trades()[0]
        self.assertNotEqual(raw["status"], TradeStatus.CLOSED.value)
        self.assertGreater(raw["target_usd"], 0.0)

    # TEST J & Q: Repeated 100 ticks while in EXIT_REQUESTED
    def test_J_Q_repeated_ticks_blocked_during_exit_requested(self):
        tp_usd, sl_usd, _, _, _, _ = self.engine.calculate_sl_and_target_prices(
            direction="BUY", entry_price_usd=85000.0, quantity=0.002, hedge_rate=102.0, target_net_inr=100.0, max_loss_net_inr=200.0
        )

        trade = LiveTradeState(
            trade_id="TEST_REPEATED_TICKS",
            mudrex_position_id="MUDREX_POS_010",
            direction="BUY",
            quantity=0.002,
            leverage=5.0,
            entry_price_usd=85000.0,
            entry_price=8670000.0,
            hedge_rate=102.0,
            entry_timestamp="2026-10-05 10:00:00",
            target_net_inr=100.0,
            max_loss_net_inr=200.0,
            target_usd=tp_usd,
            stop_loss_usd=sl_usd,
            status=TradeStatus.EXIT_REQUESTED.value
        )
        DB.save_bitcoin_live_trade(trade.to_dict())

        close_mock = MagicMock(return_value={"success": True})
        self.adapter.close_position_safely = close_mock

        with patch.object(self.engine, 'fetch_mudrex_futures_market_data', return_value=(tp_usd + 10.0, 102.0, 'Mock Price')):
            for _ in range(100):
                self.engine.process_tick()

        self.assertEqual(close_mock.call_count, 0)

    # TEST K: Restart during OPEN position
    def test_K_restart_during_open_position(self):
        trade = LiveTradeState(
            trade_id="TEST_RESTART",
            mudrex_position_id="MUDREX_POS_011",
            direction="BUY",
            quantity=0.002,
            leverage=5.0,
            entry_price_usd=85000.0,
            entry_price=8670000.0,
            hedge_rate=102.0,
            entry_timestamp="2026-10-05 10:00:00",
            target_net_inr=100.0,
            max_loss_net_inr=200.0,
            target_usd=85600.0,
            stop_loss_usd=84100.0,
            status=TradeStatus.OPEN.value
        )
        DB.save_bitcoin_live_trade(trade.to_dict())

        new_engine = BitcoinLiveEngine()
        new_engine.live_trading_enabled = False

        mock_positions = [{"position_id": "MUDREX_POS_011", "entry_price": 85000.0, "quantity": 0.002}]
        with patch.object(new_engine.adapter, 'fetch_open_positions', return_value=mock_positions):
            reconciled = new_engine.auto_reconcile_active_position()

        self.assertIsNotNone(reconciled)
        self.assertEqual(reconciled["trade_id"], "TEST_RESTART")
        self.assertEqual(reconciled["status"], TradeStatus.OPEN.value)

    # TEST L: Mudrex delayed close confirmation
    def test_L_delayed_mudrex_close_confirmation(self):
        trade = LiveTradeState(
            trade_id="TEST_DELAYED_CLOSE",
            mudrex_position_id="MUDREX_POS_012",
            direction="BUY",
            quantity=0.002,
            leverage=5.0,
            entry_price_usd=85000.0,
            entry_price=8670000.0,
            hedge_rate=102.0,
            entry_timestamp="2026-10-05 10:00:00",
            target_net_inr=100.0,
            max_loss_net_inr=200.0,
            target_usd=85600.0,
            stop_loss_usd=84100.0,
            status=TradeStatus.EXIT_REQUESTED.value
        )
        DB.save_bitcoin_live_trade(trade.to_dict())

        self.engine.live_trading_enabled = True
        mock_positions = [{"position_id": "MUDREX_POS_012", "entry_price": 85000.0, "quantity": 0.002}]
        with patch.object(self.adapter, 'fetch_open_positions', return_value=mock_positions):
            with patch.object(self.engine, 'fetch_mudrex_futures_market_data', return_value=(85610.0, 102.0, 'Mock Price')):
                self.engine.process_tick()

        raw = DB.load_all_bitcoin_live_trades()[0]
        self.assertEqual(raw["status"], TradeStatus.EXIT_REQUESTED.value)

    # TEST M: Slippage (Trigger price != actual fill)
    def test_M_slippage_uses_actual_fill(self):
        trade = LiveTradeState(
            trade_id="TEST_SLIPPAGE",
            mudrex_position_id="MUDREX_POS_013",
            direction="BUY",
            quantity=0.002,
            leverage=5.0,
            entry_price_usd=85000.0,
            entry_price=8670000.0,
            hedge_rate=102.0,
            entry_timestamp="2026-10-05 10:00:00",
            target_net_inr=100.0,
            max_loss_net_inr=200.0,
            target_usd=85600.0,
            stop_loss_usd=84100.0,
            trigger_price_usd=85600.0,
            status=TradeStatus.EXIT_REQUESTED.value
        )
        DB.save_bitcoin_live_trade(trade.to_dict())

        audit_mock = {
            "entry_price_usd": 85000.0,
            "exit_price_usd": 85650.0,  # Actual fill had $50 slippage
            "entry_price_inr": 8670000.0,
            "exit_price_inr": 8736300.0,
            "quantity": 0.002,
            "hedge_rate": 102.0,
            "gross_pnl_inr": 132.60,
            "entry_fee_gst": 10.23,
            "exit_fee_gst": 10.31,
            "charges": 20.54,
            "funding_fee": 0.0,
            "net_pnl_inr": 112.06,
            "raw_position": {}
        }

        self.engine.live_trading_enabled = True
        with patch.object(self.adapter, 'fetch_open_positions', return_value=[]):
            with patch.object(self.adapter, 'fetch_closed_position_audit', return_value=audit_mock):
                with patch.object(self.engine, 'fetch_mudrex_futures_market_data', return_value=(85650.0, 102.0, 'Mock Price')):
                    self.engine.process_tick()

        raw = DB.load_all_bitcoin_live_trades()[0]
        self.assertEqual(raw["status"], TradeStatus.CLOSED.value)
        self.assertEqual(raw["exit_price_usd"], 85650.0)
        self.assertEqual(raw["net_pnl"], 112.06)

    # TEST N: Actual Mudrex fees different from estimate
    def test_N_actual_fees_override_estimate(self):
        trade = LiveTradeState(
            trade_id="TEST_FEE_OVERRIDE",
            mudrex_position_id="MUDREX_POS_014",
            direction="BUY",
            quantity=0.002,
            leverage=5.0,
            entry_price_usd=85000.0,
            entry_price=8670000.0,
            hedge_rate=102.0,
            entry_timestamp="2026-10-05 10:00:00",
            target_net_inr=100.0,
            max_loss_net_inr=200.0,
            target_usd=85600.0,
            stop_loss_usd=84100.0,
            status=TradeStatus.EXIT_REQUESTED.value
        )
        DB.save_bitcoin_live_trade(trade.to_dict())

        audit_mock = {
            "entry_price_usd": 85000.0,
            "exit_price_usd": 85600.0,
            "entry_price_inr": 8670000.0,
            "exit_price_inr": 8731200.0,
            "quantity": 0.002,
            "hedge_rate": 102.0,
            "gross_pnl_inr": 122.40,
            "entry_fee_gst": 15.00,
            "exit_fee_gst": 15.00,
            "charges": 30.00,
            "funding_fee": 2.50,
            "net_pnl_inr": 89.90,     # Net drops to 89.90 (Below 100)
            "raw_position": {}
        }

        self.engine.live_trading_enabled = True
        with patch.object(self.adapter, 'fetch_open_positions', return_value=[]):
            with patch.object(self.adapter, 'fetch_closed_position_audit', return_value=audit_mock):
                with patch.object(self.engine, 'fetch_mudrex_futures_market_data', return_value=(85600.0, 102.0, 'Mock Price')):
                    self.engine.process_tick()

        raw = DB.load_all_bitcoin_live_trades()[0]
        self.assertEqual(raw["status"], TradeStatus.CLOSED.value)
        self.assertEqual(raw["charges"], 30.00)
        self.assertEqual(raw["net_pnl"], 89.90)
        self.assertNotIn("PROFIT TARGET +Rs.100 NET", raw["exit_reason"])

    # TEST O & P: External Mudrex TP/SL closure
    def test_O_P_external_mudrex_closure_reconciled(self):
        trade = LiveTradeState(
            trade_id="TEST_EXTERNAL_CLOSURE",
            mudrex_position_id="MUDREX_POS_015",
            direction="BUY",
            quantity=0.002,
            leverage=5.0,
            entry_price_usd=85000.0,
            entry_price=8670000.0,
            hedge_rate=102.0,
            entry_timestamp="2026-10-05 10:00:00",
            target_net_inr=100.0,
            max_loss_net_inr=200.0,
            target_usd=85600.0,
            stop_loss_usd=84100.0,
            status=TradeStatus.OPEN.value
        )
        DB.save_bitcoin_live_trade(trade.to_dict())

        with patch.object(self.adapter, 'fetch_open_positions', return_value=[]):
            with patch.object(self.engine, 'fetch_mudrex_futures_market_data', return_value=(85200.0, 102.0, 'Mock Price')):
                reconciled = self.engine.auto_reconcile_active_position()

        self.assertIsNone(reconciled)
        raw = DB.load_all_bitcoin_live_trades()[0]
        self.assertEqual(raw["status"], TradeStatus.CLOSED.value)
        self.assertIn("EXTERNAL MUDREX ORDER", raw["exit_reason"])


if __name__ == "__main__":
    unittest.main()
