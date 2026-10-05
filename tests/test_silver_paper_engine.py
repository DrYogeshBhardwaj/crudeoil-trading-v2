"""
Automated Unit Test Suite for Silver Paper Engine (XAG/USDT).
Tests all 16 safety, fee, accounting, and state transition requirements.
"""

import unittest
import os
import tempfile
import shutil
from database import DatabaseEngine as Database
from silver_paper_engine import SilverPaperEngine

class TestSilverPaperEngine(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.db_file = os.path.join(self.test_dir, "test_silver.db")
        self.db = Database(db_path=self.db_file)
        self.engine = SilverPaperEngine(db_instance=self.db)
        self.engine.LIVE_TRADING_ENABLED = False  # Explicit safety verification

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    # 1. LONG target exit
    def test_long_target_exit(self):
        pos = self.engine.manual_entry(side="LONG", quantity=10.0, current_price=30.0)
        self.assertIsNotNone(pos)
        self.assertGreater(pos.target_price, 30.0)
        
        exit_trade = self.engine.process_tick(current_price=pos.target_price + 0.1)
        self.assertIsNotNone(exit_trade)
        self.assertTrue(exit_trade["exit_reason"].startswith("PROFIT TARGET"))
        self.assertGreaterEqual(exit_trade["net_pnl"], 100.0)
        self.assertIsNone(self.engine.active_position)

    # 2. LONG stop exit
    def test_long_stop_exit(self):
        pos = self.engine.manual_entry(side="LONG", quantity=10.0, current_price=30.0)
        self.assertIsNotNone(pos)
        
        exit_trade = self.engine.process_tick(current_price=pos.stop_loss_price - 0.1)
        self.assertIsNotNone(exit_trade)
        self.assertTrue(exit_trade["exit_reason"].startswith("LOSS LIMIT"))
        self.assertIsNone(self.engine.active_position)

    # 3. SHORT target exit
    def test_short_target_exit(self):
        pos = self.engine.manual_entry(side="SHORT", quantity=10.0, current_price=30.0)
        self.assertIsNotNone(pos)
        self.assertLess(pos.target_price, 30.0)
        
        exit_trade = self.engine.process_tick(current_price=pos.target_price - 0.1)
        self.assertIsNotNone(exit_trade)
        self.assertTrue(exit_trade["exit_reason"].startswith("PROFIT TARGET"))
        self.assertGreaterEqual(exit_trade["net_pnl"], 100.0)
        self.assertIsNone(self.engine.active_position)

    # 4. SHORT stop exit
    def test_short_stop_exit(self):
        pos = self.engine.manual_entry(side="SHORT", quantity=10.0, current_price=30.0)
        self.assertIsNotNone(pos)
        
        exit_trade = self.engine.process_tick(current_price=pos.stop_loss_price + 0.1)
        self.assertIsNotNone(exit_trade)
        self.assertTrue(exit_trade["exit_reason"].startswith("LOSS LIMIT"))
        self.assertIsNone(self.engine.active_position)

    # 5. Gross profit target reached but NET target NOT reached -> NO EXIT
    def test_gross_profit_target_but_net_target_unreached(self):
        pos = self.engine.manual_entry(side="LONG", quantity=10.0, current_price=30.0)
        self.assertIsNotNone(pos)
        
        # Price move where gross profit is positive but NET profit < configured net target (Rs 100)
        test_price = 30.05
        exit_trade = self.engine.process_tick(current_price=test_price)
        self.assertIsNone(exit_trade, "Engine exited prematurely when NET profit target was not met!")
        self.assertIsNotNone(self.engine.active_position)

    # 6. Tiny positive move -> NO EXIT
    def test_tiny_positive_move_no_exit(self):
        pos = self.engine.manual_entry(side="LONG", quantity=10.0, current_price=30.0)
        exit_trade = self.engine.process_tick(current_price=30.01)
        self.assertIsNone(exit_trade)
        self.assertIsNotNone(self.engine.active_position)

    # 7. Tiny negative move -> NO EXIT
    def test_tiny_negative_move_no_exit(self):
        pos = self.engine.manual_entry(side="LONG", quantity=10.0, current_price=30.0)
        exit_trade = self.engine.process_tick(current_price=29.99)
        self.assertIsNone(exit_trade)
        self.assertIsNotNone(self.engine.active_position)

    # 8. Missing target / null target -> NO EXIT
    def test_missing_target_no_exit(self):
        pos = self.engine.manual_entry(side="LONG", quantity=10.0, current_price=30.0)
        pos.target_price = 0.0
        pos.entry_price = 0.0
        self.db.save_silver_paper_trade(pos.to_dict())
        
        exit_trade = self.engine.process_tick(current_price=35.0)
        self.assertIsNone(exit_trade, "Engine exited position despite target_price being missing!")
        self.assertIsNotNone(self.engine.active_position)

    # 9. Repeated ticks -> only one exit (no duplicate exit)
    def test_repeated_ticks_single_exit(self):
        pos = self.engine.manual_entry(side="LONG", quantity=10.0, current_price=30.0)
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
        eng1 = SilverPaperEngine(db_instance=self.db)
        pos1 = eng1.manual_entry(side="LONG", quantity=10.0, current_price=30.0)
        self.assertIsNotNone(pos1)
        
        eng2 = SilverPaperEngine(db_instance=self.db)
        self.assertIsNotNone(eng2.active_position)
        self.assertEqual(eng2.active_position.side, "LONG")
        self.assertEqual(eng2.active_position.entry_price, 30.0)
        self.assertEqual(eng2.active_position.quantity, 10.0)

    # 11. Fee calculation (0.05% taker fee per side)
    def test_fee_calculation(self):
        pos = self.engine.manual_entry(side="LONG", quantity=10.0, current_price=30.0)
        notional = 10.0 * 30.0  # $300
        expected_fee = round(notional * 0.0005, 4)  # $0.15
        self.assertEqual(pos.estimated_fee, expected_fee)

    # 12. GST calculation (18% on trading fee)
    def test_gst_calculation(self):
        pos = self.engine.manual_entry(side="LONG", quantity=10.0, current_price=30.0)
        expected_fee = round(10.0 * 30.0 * 0.0005, 4)  # $0.15
        expected_gst = round(expected_fee * 0.18, 4)   # $0.027
        self.assertEqual(pos.gst, expected_gst)

    # 13. Funding calculation
    def test_funding_calculation(self):
        pos = self.engine.manual_entry(side="LONG", quantity=10.0, current_price=30.0)
        self.assertTrue(hasattr(pos, "funding"))
        self.assertEqual(pos.funding, 0.0)

    # 14. Actual market price update handling
    def test_actual_market_price_update(self):
        self.engine.process_tick(current_price=31.25)
        self.assertEqual(self.engine.current_price, 31.25)

    # 15. No-price / no-feed safety
    def test_no_price_safety(self):
        res = self.engine.process_tick(current_price=0.0)
        self.assertIsNone(res)
        res_neg = self.engine.process_tick(current_price=-5.0)
        self.assertIsNone(res_neg)

    # 16. No duplicate position (second entry rejected)
    def test_no_duplicate_position(self):
        pos1 = self.engine.manual_entry(side="LONG", quantity=10.0, current_price=30.0)
        self.assertIsNotNone(pos1)
        
        pos2 = self.engine.manual_entry(side="SHORT", quantity=10.0, current_price=30.0)
        self.assertIsNone(pos2, "Engine allowed opening duplicate active position!")
        self.assertEqual(self.engine.active_position.side, "LONG")

if __name__ == "__main__":
    unittest.main()
