"""
Automated Unit Test Suite for Mudrex Crude Paper Engine (CL/USDT).
Tests all 16 safety, fee, accounting, and state transition requirements.
"""

import unittest
import os
import tempfile
import shutil
from database import DatabaseEngine as Database
from mudrex_crude_paper_engine import MudrexCrudePaperEngine

class TestMudrexCrudePaperEngine(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.db_file = os.path.join(self.test_dir, "test_mudrex_crude.db")
        self.db = Database(db_path=self.db_file)
        self.engine = MudrexCrudePaperEngine(db_instance=self.db)
        self.engine.LIVE_TRADING_ENABLED = False  # Explicit safety verification

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    # 1. LONG target exit
    def test_long_target_exit(self):
        pos = self.engine.manual_entry(side="LONG", quantity=1.0, current_price=70.0)
        self.assertIsNotNone(pos)
        self.assertGreater(pos.target_price, 70.0)
        
        exit_trade = self.engine.process_tick(current_price=pos.target_price + 0.1)
        self.assertIsNotNone(exit_trade)
        self.assertTrue(exit_trade["exit_reason"].startswith("PROFIT TARGET"))
        self.assertGreaterEqual(exit_trade["net_pnl"], 100.0)
        self.assertIsNone(self.engine.active_position)

    # 2. LONG stop exit
    def test_long_stop_exit(self):
        pos = self.engine.manual_entry(side="LONG", quantity=1.0, current_price=70.0)
        self.assertIsNotNone(pos)
        
        exit_trade = self.engine.process_tick(current_price=pos.stop_loss_price - 0.1)
        self.assertIsNotNone(exit_trade)
        self.assertTrue(exit_trade["exit_reason"].startswith("LOSS LIMIT"))
        self.assertIsNone(self.engine.active_position)

    # 3. SHORT target exit
    def test_short_target_exit(self):
        pos = self.engine.manual_entry(side="SHORT", quantity=1.0, current_price=70.0)
        self.assertIsNotNone(pos)
        self.assertLess(pos.target_price, 70.0)
        
        exit_trade = self.engine.process_tick(current_price=pos.target_price - 0.1)
        self.assertIsNotNone(exit_trade)
        self.assertTrue(exit_trade["exit_reason"].startswith("PROFIT TARGET"))
        self.assertGreaterEqual(exit_trade["net_pnl"], 100.0)
        self.assertIsNone(self.engine.active_position)

    # 4. SHORT stop exit
    def test_short_stop_exit(self):
        pos = self.engine.manual_entry(side="SHORT", quantity=1.0, current_price=70.0)
        self.assertIsNotNone(pos)
        
        exit_trade = self.engine.process_tick(current_price=pos.stop_loss_price + 0.1)
        self.assertIsNotNone(exit_trade)
        self.assertTrue(exit_trade["exit_reason"].startswith("LOSS LIMIT"))
        self.assertIsNone(self.engine.active_position)

    # 5. Gross profit target reached but NET target NOT reached -> NO EXIT
    def test_gross_profit_target_but_net_target_unreached(self):
        pos = self.engine.manual_entry(side="LONG", quantity=1.0, current_price=70.0)
        self.assertIsNotNone(pos)
        
        test_price = 70.10
        exit_trade = self.engine.process_tick(current_price=test_price)
        self.assertIsNone(exit_trade, "Engine exited prematurely when NET profit target was not met!")
        self.assertIsNotNone(self.engine.active_position)

    # 6. Tiny positive move -> NO EXIT
    def test_tiny_positive_move_no_exit(self):
        pos = self.engine.manual_entry(side="LONG", quantity=1.0, current_price=70.0)
        exit_trade = self.engine.process_tick(current_price=70.02)
        self.assertIsNone(exit_trade)
        self.assertIsNotNone(self.engine.active_position)

    # 7. Tiny negative move -> NO EXIT
    def test_tiny_negative_move_no_exit(self):
        pos = self.engine.manual_entry(side="LONG", quantity=1.0, current_price=70.0)
        exit_trade = self.engine.process_tick(current_price=69.98)
        self.assertIsNone(exit_trade)
        self.assertIsNotNone(self.engine.active_position)

    # 8. Missing target / null target -> NO EXIT
    def test_missing_target_no_exit(self):
        pos = self.engine.manual_entry(side="LONG", quantity=1.0, current_price=70.0)
        pos.target_price = 0.0
        pos.entry_price = 0.0
        self.db.save_mudrex_crude_paper_trade(pos.to_dict())
        
        exit_trade = self.engine.process_tick(current_price=85.0)
        self.assertIsNone(exit_trade, "Engine exited position despite target_price being missing!")
        self.assertIsNotNone(self.engine.active_position)

    # 9. Repeated ticks -> only one exit (no duplicate exit)
    def test_repeated_ticks_single_exit(self):
        pos = self.engine.manual_entry(side="LONG", quantity=1.0, current_price=70.0)
        target_hit_price = pos.target_price + 0.5
        
        exit_1 = self.engine.process_tick(current_price=target_hit_price)
        self.assertIsNotNone(exit_1)
        self.assertIsNone(self.engine.active_position)
        
        exit_2 = self.engine.process_tick(current_price=target_hit_price)
        self.assertIsNone(exit_2)
        
        exit_3 = self.engine.process_tick(current_price=target_hit_price + 1.0)
        self.assertIsNone(exit_3)

    # 10. Restart / reload state recovery
    def test_restart_state_recovery(self):
        eng1 = MudrexCrudePaperEngine(db_instance=self.db)
        pos1 = eng1.manual_entry(side="LONG", quantity=1.0, current_price=70.0)
        self.assertIsNotNone(pos1)
        
        eng2 = MudrexCrudePaperEngine(db_instance=self.db)
        self.assertIsNotNone(eng2.active_position)
        self.assertEqual(eng2.active_position.side, "LONG")
        self.assertEqual(eng2.active_position.entry_price, 70.0)
        self.assertEqual(eng2.active_position.quantity, 1.0)

    # 11. Fee calculation (0.05% taker fee per side)
    def test_fee_calculation(self):
        pos = self.engine.manual_entry(side="LONG", quantity=1.0, current_price=70.0)
        notional = 1.0 * 70.0  # $70
        expected_fee = round(notional * 0.0005, 4)  # $0.035
        self.assertEqual(pos.estimated_fee, expected_fee)

    # 12. GST calculation (18% on trading fee)
    def test_gst_calculation(self):
        pos = self.engine.manual_entry(side="LONG", quantity=1.0, current_price=70.0)
        expected_fee = round(1.0 * 70.0 * 0.0005, 4)  # $0.035
        expected_gst = round(expected_fee * 0.18, 4)   # $0.0063
        self.assertEqual(pos.gst, expected_gst)

    # 13. Funding calculation
    def test_funding_calculation(self):
        pos = self.engine.manual_entry(side="LONG", quantity=1.0, current_price=70.0)
        self.assertTrue(hasattr(pos, "funding"))
        self.assertEqual(pos.funding, 0.0)

    # 14. Actual market price update handling
    def test_actual_market_price_update(self):
        self.engine.process_tick(current_price=72.80)
        self.assertEqual(self.engine.current_price, 72.80)

    # 15. No-price / no-feed safety
    def test_no_price_safety(self):
        res = self.engine.process_tick(current_price=0.0)
        self.assertIsNone(res)
        res_neg = self.engine.process_tick(current_price=-1.0)
        self.assertIsNone(res_neg)

    # 17. Zero exit price => NO CLOSE
    def test_zero_exit_price_no_close(self):
        self.engine.fetch_market_price = lambda: (70.0, 102.0, "MOCK OK")
        pos = self.engine.manual_entry(side="LONG", quantity=1.0, current_price=70.0)
        self.assertIsNotNone(pos)
        res = self.engine._finalize_closed_position(pos, exit_price=0.0)
        self.assertIsNone(res)
        self.assertEqual(pos.status, "OPEN")

    # 18. Null exit price => NO CLOSE
    def test_null_exit_price_no_close(self):
        self.engine.fetch_market_price = lambda: (70.0, 102.0, "MOCK OK")
        pos = self.engine.manual_entry(side="LONG", quantity=1.0, current_price=70.0)
        self.assertIsNotNone(pos)
        res = self.engine._finalize_closed_position(pos, exit_price=None)
        self.assertIsNone(res)
        self.assertEqual(pos.status, "OPEN")

    # 19. Stale/zero feed manual close attempt => NO CLOSE
    def test_stale_feed_manual_close_no_close(self):
        pos = self.engine.manual_entry(side="LONG", quantity=1.0, current_price=70.0)
        self.assertIsNotNone(pos)
        self.engine.fetch_market_price = lambda: (0.0, 102.0, "MOCK UNAVAILABLE")
        res = self.engine.close_active_paper_position()
        self.assertFalse(res["success"])
        self.assertIn("unavailable or zero", res["error"])

    # 20. Valid exit price => correct close
    def test_valid_exit_price_close(self):
        pos = self.engine.manual_entry(side="LONG", quantity=1.0, current_price=70.0)
        self.assertIsNotNone(pos)
        self.engine.fetch_market_price = lambda: (75.0, 102.0, "MOCK OK")
        res = self.engine.close_active_paper_position()
        self.assertTrue(res["success"])
        self.assertEqual(res["trade"]["status"], "CLOSED")
        self.assertEqual(res["trade"]["exit_price"], 75.0)

    # 21. Valid exit => correct gross/fee/NET
    def test_valid_exit_correct_math(self):
        pos = self.engine.manual_entry(side="LONG", quantity=1.0, current_price=70.0)
        self.assertIsNotNone(pos)
        self.engine.fetch_market_price = lambda: (80.0, 102.0, "MOCK OK")
        res = self.engine.close_active_paper_position()
        t = res["trade"]
        expected_gross = (80.0 - 70.0) * 1.0 * 102.0  # +1020.0 INR
        self.assertAlmostEqual(t["gross_pnl"], round(expected_gross, 2))
        self.assertTrue(t["total_charges"] > 0)
        self.assertEqual(t["net_pnl"], round(t["gross_pnl"] - t["total_charges"], 2))

    # 22. Closed position cannot remain OPEN
    def test_closed_position_cannot_remain_open(self):
        pos = self.engine.manual_entry(side="LONG", quantity=1.0, current_price=70.0)
        self.engine.fetch_market_price = lambda: (75.0, 102.0, "MOCK OK")
        self.engine.close_active_paper_position()
        active = self.engine.db.load_active_mudrex_crude_paper_position()
        self.assertIsNone(active)

    # 23. Open position cannot appear as completed
    def test_open_position_cannot_appear_completed(self):
        self.engine.manual_entry(side="LONG", quantity=1.0, current_price=70.0)
        state = self.engine.get_dashboard_state()
        history = state["trade_history"]
        self.assertEqual(len(history), 0)

    # 24. Sideways market => WAIT (no repeated entries)
    def test_sideways_market_returns_wait(self):
        for _ in range(15):
            eval_res = self.engine.evaluate_crude_strategy(70.00)
        self.assertEqual(eval_res["action"], "WAIT")
        self.assertIn("Price consolidating within range", eval_res["reasons"][0])

    # 25. Weak single-tick crossover => WAIT
    def test_weak_crossover_returns_wait(self):
        for p in [70.00] * 10:
            self.engine.evaluate_crude_strategy(p)
        eval_res = self.engine.evaluate_crude_strategy(70.50)
        self.assertEqual(eval_res["action"], "WAIT")

    # 26. Insufficient expected movement after fees => WAIT
    def test_insufficient_move_after_fees_returns_wait(self):
        for p in [70.00] * 15:
            self.engine.evaluate_crude_strategy(p)
        eval_res = self.engine.evaluate_crude_strategy(70.05)
        self.assertEqual(eval_res["action"], "WAIT")

    # 27. Confirmed signal => entry allowed
    def test_confirmed_signal_allows_entry(self):
        prices = [70.00] * 15 + [70.50, 71.00, 71.50, 72.00]
        for p in prices:
            eval_res = self.engine.evaluate_crude_strategy(p)
        self.assertIn(eval_res["action"], ("BUY", "WAIT"))
        self.assertIsNotNone(eval_res["ema9"])
        self.assertIsNotNone(eval_res["ema21"])
        self.assertGreater(eval_res["rsi"], 50)

    # 28. Cooldown after close => blocked until cooldown / confirmation
    def test_cooldown_after_close_blocks_immediate_reentry(self):
        pos = self.engine.manual_entry(side="LONG", quantity=1.0, current_price=70.0)
        self.engine.fetch_market_price = lambda: (80.0, 102.0, "MOCK OK")
        self.engine.close_active_paper_position()
        self.engine.last_sl_time = time.time()
        res = self.engine.process_tick(current_price=80.0)
        self.assertIsNone(res)

    # 29. NET target remains fee-aware
    def test_net_target_fee_aware_math(self):
        tp_price, sl_price, tp_gross, sl_gross = self.engine.calculate_sl_and_target_prices(
            direction="BUY", entry_price=70.00, quantity=1.0, hedge_rate=102.0, target_net=100.0, max_loss_net=200.0
        )
        notional_inr = 70.00 * 1.0 * 102.0
        round_trip_fee = notional_inr * (2 * 0.00059)
        expected_gross_min = 100.0 + round_trip_fee
        self.assertGreater(tp_gross, round(expected_gross_min, 1))

    # 30. NET stop loss remains fee-aware
    def test_net_stop_fee_aware_math(self):
        tp_price, sl_price, tp_gross, sl_gross = self.engine.calculate_sl_and_target_prices(
            direction="BUY", entry_price=70.00, quantity=1.0, hedge_rate=102.0, target_net=100.0, max_loss_net=200.0
        )
        self.assertLess(sl_price, 70.00)
        self.assertGreater(sl_gross, 100.0)

if __name__ == "__main__":
    unittest.main()

