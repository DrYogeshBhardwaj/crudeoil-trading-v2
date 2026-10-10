"""
Comprehensive Unit Test Suite for Crude Oil Pair Strategy Engine (/crude/pair-test).
Tests:
- Serial numbering integrity (sl_no)
- Initial pair creation
- Repeated entries & exits
- Retention of older open positions
- Exact P/L and trading fee calculations
- State persistence & restart recovery
- Summary reconciliation against ledger
- CSV Export generation
"""

import os
import unittest
import tempfile
import sqlite3

# Set test environment DB before importing
TEST_DB_PATH = "test_crude_pair_trading.db"
os.environ["DATABASE_PATH"] = TEST_DB_PATH

from database import DB
from crude_pair_engine import CrudePairEngine, MOVEMENT_THRESHOLDS


class TestCrudePairLogic(unittest.TestCase):
    def setUp(self):
        # Override DB path for test isolated database
        DB.db_path = TEST_DB_PATH
        DB._init_db()
        DB.reset_crude_pair_account()
        
        self.engine = CrudePairEngine()
        self.engine.positions.clear()
        self.engine.movements.clear()
        self.engine.is_running = False

    def tearDown(self):
        DB.reset_crude_pair_account()
        if os.path.exists(TEST_DB_PATH):
            try:
                os.remove(TEST_DB_PATH)
            except Exception:
                pass

    def test_01_serial_numbering_sequential(self):
        """1. Verify serial numbers (sl_no) are strictly sequential (1, 2, 3...) and never repeat."""
        p_id1, b1, s1 = self.engine._create_pair_unlocked(entry_price=80.00, reason="TEST PAIR 1")
        self.assertEqual(b1["sl_no"], 1)
        self.assertEqual(s1["sl_no"], 2)

        p_id2, b2, s2 = self.engine._create_pair_unlocked(entry_price=81.00, reason="TEST PAIR 2")
        self.assertEqual(b2["sl_no"], 3)
        self.assertEqual(s2["sl_no"], 4)

        all_sls = [p["sl_no"] for p in self.engine.positions]
        self.assertEqual(all_sls, [1, 2, 3, 4])
        self.assertEqual(len(set(all_sls)), 4)  # No duplicates

    def test_02_initial_pair_creation(self):
        """2. Verify starting simulation creates 1 BUY and 1 SELL position at reference price."""
        res = self.engine.start_simulation(initial_price=80.00)
        self.assertTrue(res["success"])
        self.assertEqual(len(self.engine.positions), 2)
        
        buy_pos = self.engine.positions[0]
        sell_pos = self.engine.positions[1]

        self.assertEqual(buy_pos["direction"], "BUY")
        self.assertEqual(sell_pos["direction"], "SELL")
        self.assertEqual(buy_pos["entry_price"], 80.00)
        self.assertEqual(sell_pos["entry_price"], 80.00)
        self.assertEqual(buy_pos["status"], "OPEN")
        self.assertEqual(sell_pos["status"], "OPEN")

    def test_03_repeated_entries_manual(self):
        """3. Verify repeated manual pair creations generate distinct Pair IDs and position IDs."""
        r1 = self.engine.create_manual_pair()
        r2 = self.engine.create_manual_pair()

        self.assertEqual(r1["pair_id"], "PAIR-001")
        self.assertEqual(r2["pair_id"], "PAIR-002")

        self.assertEqual(len(self.engine.positions), 4)
        pos_ids = [p["position_id"] for p in self.engine.positions]
        self.assertEqual(len(pos_ids), len(set(pos_ids)))  # All position IDs unique

    def test_04_profit_booking_and_old_positions_retention(self):
        """4. Verify profit booking closes winning position while keeping opposing older position OPEN at original price."""
        self.engine.start_simulation(initial_price=80.00)
        buy_pos = self.engine.positions[0]
        sell_pos = self.engine.positions[1]

        # Simulate price rise to $81.50 (+$1.50 movement, exceeding $1.00 threshold)
        triggered = self.engine.process_tick(current_price=81.50, timestamp_str="2026-10-10 10:00:00 IST")

        self.assertEqual(len(triggered), 1)
        closed_item = triggered[0]
        self.assertEqual(closed_item["position_id"], buy_pos["position_id"])
        self.assertEqual(closed_item["status"], "CLOSED")
        self.assertEqual(closed_item["exit_price"], 81.50)

        # Opposing SELL position (POS-002-SELL) MUST remain OPEN at original entry price ($80.00)
        db_positions = DB.load_all_crude_pair_trades()
        old_sell = next(p for p in db_positions if p["position_id"] == sell_pos["position_id"])
        self.assertEqual(old_sell["status"], "OPEN")
        self.assertEqual(old_sell["entry_price"], 80.00)

        # A new pair (PAIR-002) MUST have been created at execution price $81.50
        all_pairs = set(p["pair_id"] for p in db_positions)
        self.assertIn("PAIR-002", all_pairs)
        self.assertEqual(len(db_positions), 4)  # 2 old + 2 new

    def test_05_pnl_and_charges_calculations(self):
        """5. Verify exact math for gross P/L, trading fees (0.05% per side), and net P/L."""
        self.engine.fee_rate = 0.0005  # 0.05%
        pos = {
            "sl_no": 1,
            "pair_id": "PAIR-001",
            "position_id": "POS-001-BUY",
            "direction": "BUY",
            "entry_price": 80.00,
            "quantity": 1.0,
            "threshold_usd": 1.00,
            "entry_timestamp": "2026-10-10 10:00:00 IST",
            "status": "OPEN",
            "reason": "TEST"
        }
        self.engine.positions.append(pos)
        
        # Close at $82.00 (+ $2.00 gross P/L)
        closed = self.engine._close_position_unlocked(pos, exit_price=82.00, exit_reason="TEST EXIT", trigger_reentry=False)
        
        expected_gross = (82.00 - 80.00) * 1.0  # +$2.00
        expected_fees = (80.00 * 1.0 + 82.00 * 1.0) * 0.0005  # $0.081
        expected_net = expected_gross - expected_fees  # $1.919

        self.assertAlmostEqual(closed["gross_pnl"], expected_gross, places=3)
        self.assertAlmostEqual(closed["trading_fees"], expected_fees, places=3)
        self.assertAlmostEqual(closed["net_pnl"], expected_net, places=3)

    def test_06_refresh_persistence(self):
        """6. Verify DB state loading preserves all positions and serial numbers after simulated page refresh."""
        self.engine.start_simulation(initial_price=80.00)
        self.engine.create_manual_pair()

        pos_count_before = len(self.engine.positions)
        sl_next_before = self.engine.get_next_serial_number()

        # Re-instantiate engine (simulating service restart / page refresh)
        new_engine = CrudePairEngine()
        self.assertEqual(len(new_engine.positions), pos_count_before)
        self.assertEqual(new_engine.get_next_serial_number(), sl_next_before)

    def test_07_summary_reconciliation(self):
        """7. Verify summary metrics match exact sum of underlying ledger rows."""
        self.engine.start_simulation(initial_price=80.00)
        self.engine.process_tick(current_price=82.00, timestamp_str="2026-10-10 10:00:00 IST")

        state = self.engine.get_dashboard_state()
        summary = state["summary"]
        ledger = state["ledger"]

        calc_open = sum(1 for p in ledger if p["status"] == "OPEN")
        calc_closed = sum(1 for p in ledger if p["status"] == "CLOSED")
        calc_realized_net = sum(float(p.get("net_pnl", 0)) for p in ledger if p["status"] == "CLOSED")

        self.assertEqual(summary["total_open_positions"], calc_open)
        self.assertEqual(summary["total_closed_positions"], calc_closed)
        self.assertAlmostEqual(summary["realized_net_pnl"], round(calc_realized_net, 2), places=2)
        self.assertAlmostEqual(summary["combined_net_equity"], round(summary["realized_net_pnl"] + summary["current_unrealized_pnl"], 2), places=2)

    def test_08_csv_export_format(self):
        """8. Verify CSV export generates valid CSV format with required column headers."""
        self.engine.start_simulation(initial_price=80.00)
        csv_str = self.engine.generate_csv_export()
        lines = csv_str.strip().split("\n")
        
        header = lines[0]
        self.assertIn("Sl. No.", header)
        self.assertIn("Pair ID", header)
        self.assertIn("Position ID", header)
        self.assertIn("BUY / SELL", header)
        self.assertIn("Net Realized P/L ($)", header)
        self.assertTrue(len(lines) >= 3)  # Header + 2 initial positions

    def test_09_unresolved_rules_reporting(self):
        """9. Verify unresolved strategy rules are reported in state payload."""
        state = self.engine.get_dashboard_state()
        rules = state.get("unresolved_rules", [])
        self.assertTrue(len(rules) >= 4)
        rule_ids = [r["rule_id"] for r in rules]
        self.assertIn("RULE_1_BOOKING_THRESHOLD", rule_ids)
        self.assertIn("RULE_4_LOSS_MANAGEMENT", rule_ids)


if __name__ == "__main__":
    unittest.main()
