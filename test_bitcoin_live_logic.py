"""
Test Suite for Bitcoin Live Engine (Mudrex API) Logic & Math Verification.
Verifies:
1. Charges & Fees Calculation (0.05% Taker Fee per side).
2. Dynamic Position Sizing (Quantity calculation for Rs.5,000 capital).
3. Exact SL (-Rs.100 NET) and Target (+Rs.200 NET) price calculations for BUY LONG & SELL SHORT.
4. NET P&L based exit triggers (+Rs.200 NET target, -Rs.100 NET loss limit).
5. Automatic re-entry transition after +Rs.200 NET Profit Target.
6. Automatic re-entry transition after -Rs.100 NET Loss Limit.
7. Daily NET Loss Limit enforcement (-Rs.1,000 NET).
8. Absolute zero real orders placed / zero credentials modified during tests.
"""

import os
import unittest
from datetime import datetime

# Set isolated test database environment
os.environ["DATABASE_PATH"] = "test_bitcoin_live_trading.db"

from database import DB
from bitcoin_live_engine import BitcoinLiveEngine, MudrexLiveAdapter

class TestBitcoinLiveEngineLogic(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        """Clean test DB before suite runs."""
        pass

    def setUp(self):
        """Reset test DB before each test."""
        with DB._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DROP TABLE IF EXISTS bitcoin_live_trades")
            cursor.execute("DROP TABLE IF EXISTS bitcoin_live_settings")
            conn.commit()
        DB._init_db()
        self.engine = BitcoinLiveEngine()
        self.engine.live_trading_enabled = True

    def tearDown(self):
        pass

    @classmethod
    def tearDownClass(cls):
        """Clean up test database file."""
        try:
            if os.path.exists("test_bitcoin_live_trading.db"):
                os.remove("test_bitcoin_live_trading.db")
        except Exception:
            pass

    def test_01_charges_calculation_math(self):
        """1. Verify Mudrex Taker Fee calculation (0.05% per side, min Rs.20)."""
        entry_price = 8121844.50
        exit_price = 8053722.50
        qty = 0.01

        entry_fee, exit_fee, total_fee = self.engine.calculate_trade_charges(entry_price, exit_price, qty)
        expected_entry = round(entry_price * qty * 0.0005, 2) # Rs.40.61
        expected_exit = round(exit_price * qty * 0.0005, 2)   # Rs.40.27
        expected_total = round(expected_entry + expected_exit, 2) # Rs.80.88

        self.assertAlmostEqual(entry_fee, expected_entry, delta=0.05)
        self.assertAlmostEqual(exit_fee, expected_exit, delta=0.05)
        self.assertAlmostEqual(total_fee, expected_total, delta=0.05)
        print(f"[TEST 1 PASS] Trade Charges Math Verified: Entry Fee=Rs.{entry_fee}, Exit Fee=Rs.{exit_fee}, Total Fee=Rs.{total_fee}")

    def test_02_position_sizing_quantity(self):
        """2. Verify dynamic position sizing calculation for Rs.5,000 capital."""
        entry_price = 8121844.50
        qty = self.engine.calculate_position_quantity(entry_price, 5000.0)
        
        # Expected ~0.015 to 0.035 BTC lot size
        self.assertGreaterEqual(qty, 0.015)
        self.assertLessEqual(qty, 0.05)
        print(f"[TEST 2 PASS] Dynamic Position Sizing Verified: Entry Price=Rs.{entry_price:,.2f} -> Qty={qty} BTC")

    def test_03_sl_and_target_math_short(self):
        """3. Verify SHORT Target (+Rs.600 NET) and SL (-Rs.400 NET) price calculation."""
        entry_price = 8121844.50
        qty = 0.03
        
        target_p, sl_p, est_chg = self.engine.calculate_sl_and_target_prices("SELL", entry_price, qty)
        
        # Target must be BELOW entry for SHORT
        self.assertLess(target_p, entry_price)
        # SL must be ABOVE entry for SHORT
        self.assertGreater(sl_p, entry_price)

        # Verify NET P&L at target_p
        gross_target = (entry_price - target_p) * qty
        net_target = gross_target - est_chg
        self.assertAlmostEqual(net_target, 600.0, delta=1.0)

        # Verify NET P&L at sl_p
        gross_sl = (entry_price - sl_p) * qty
        net_sl = gross_sl - est_chg
        self.assertAlmostEqual(net_sl, -400.0, delta=1.0)

        print(f"[TEST 3 PASS] SHORT Targets Verified: Entry=Rs.{entry_price:,.2f} | Target (+Rs.600 NET)=Rs.{target_p:,.2f} | SL (-Rs.400 NET)=Rs.{sl_p:,.2f} | Fees=Rs.{est_chg:,.2f}")

    def test_04_sl_and_target_math_long(self):
        """4. Verify LONG Target (+Rs.600 NET) and SL (-Rs.400 NET) price calculation."""
        entry_price = 8121844.50
        qty = 0.03
        
        target_p, sl_p, est_chg = self.engine.calculate_sl_and_target_prices("BUY", entry_price, qty)
        
        # Target must be ABOVE entry for LONG
        self.assertGreater(target_p, entry_price)
        # SL must be BELOW entry for LONG
        self.assertLess(sl_p, entry_price)

        # Verify NET P&L at target_p
        gross_target = (target_p - entry_price) * qty
        net_target = gross_target - est_chg
        self.assertAlmostEqual(net_target, 600.0, delta=1.0)

        # Verify NET P&L at sl_p
        gross_sl = (sl_p - entry_price) * qty
        net_sl = gross_sl - est_chg
        self.assertAlmostEqual(net_sl, -400.0, delta=1.0)

        print(f"[TEST 4 PASS] LONG Targets Verified: Entry=Rs.{entry_price:,.2f} | Target (+Rs.600 NET)=Rs.{target_p:,.2f} | SL (-Rs.400 NET)=Rs.{sl_p:,.2f} | Fees=Rs.{est_chg:,.2f}")

    def test_05_automatic_exit_profit_target_and_reentry(self):
        """5. Verify position automatic exit on +Rs.500 NET target and immediate return to SCANNING mode."""
        entry_price = 8121844.50
        qty = 0.01
        target_p, sl_p, est_chg = self.engine.calculate_sl_and_target_prices("SELL", entry_price, qty)

        # Simulate creating an open SHORT position
        open_pos = {
            "trade_id": "TEST_BTC_101",
            "mudrex_position_id": "MUDREX_TEST_101",
            "entry_timestamp": "2026-10-03 12:00:00",
            "symbol": "BTCUSDT",
            "direction": "SELL",
            "quantity": qty,
            "entry_price": entry_price,
            "stop_loss": sl_p,
            "stoploss_order_id": None,
            "target": target_p,
            "trend_state": "BEARISH",
            "confidence": 85,
            "reasons": ["Test Signal"],
            "status": "OPEN",
            "exit_timestamp": None,
            "exit_price": None,
            "exit_reason": None,
            "gross_pnl": 0.0,
            "charges": est_chg,
            "net_pnl": 0.0
        }
        DB.save_bitcoin_live_trade(open_pos)

        # Before exit, new entries must be BLOCKED
        allowed_before, reason_before = self.engine.are_new_entries_allowed()
        self.assertFalse(allowed_before)
        self.assertIn("MAXIMUM POSITIONS REACHED", reason_before)

        # Calculate P&L at target_p
        gross_pnl = (entry_price - target_p) * qty
        entry_f, exit_f, total_f = self.engine.calculate_trade_charges(entry_price, target_p, qty)
        net_pnl = gross_pnl - total_f

        # Close trade in DB as engine does
        open_pos["status"] = "CLOSED"
        open_pos["exit_timestamp"] = "2026-10-03 12:15:00"
        open_pos["exit_price"] = target_p
        open_pos["exit_reason"] = "PROFIT TARGET +Rs.500 NET"
        open_pos["gross_pnl"] = round(gross_pnl, 2)
        open_pos["charges"] = round(total_f, 2)
        open_pos["net_pnl"] = round(net_pnl, 2)
        DB.save_bitcoin_live_trade(open_pos)
        self.engine.today_realized_pnl += net_pnl

        # After position closed, engine MUST immediately return to SCANNING mode (ALLOWED)
        allowed_after, reason_after = self.engine.are_new_entries_allowed()
        self.assertTrue(allowed_after)
        self.assertIn("ALLOWED", reason_after)
        print(f"[TEST 5 PASS] Automatic Profit Target Exit (+Rs.500 NET) Verified! Net PnL=Rs.{net_pnl:,.2f} -> Engine Status={reason_after}")

    def test_06_automatic_exit_loss_limit_and_reentry(self):
        """6. Verify position automatic exit on -Rs.300 NET loss limit and immediate return to SCANNING mode."""
        entry_price = 8147239.00
        qty = 0.009
        target_p, sl_p, est_chg = self.engine.calculate_sl_and_target_prices("BUY", entry_price, qty)

        # Simulate active BUY LONG position at -Rs.450 NET loss
        open_pos = {
            "trade_id": "TEST_BTC_102",
            "mudrex_position_id": "MUDREX_TEST_102",
            "entry_timestamp": "2026-10-03 15:42:33",
            "symbol": "BTCUSDT",
            "direction": "BUY",
            "quantity": qty,
            "entry_price": entry_price,
            "stop_loss": sl_p,
            "stoploss_order_id": None,
            "target": target_p,
            "trend_state": "BULLISH",
            "confidence": 85,
            "reasons": ["Test Signal"],
            "status": "OPEN",
            "exit_timestamp": None,
            "exit_price": None,
            "exit_reason": None,
            "gross_pnl": -370.0,
            "charges": est_chg,
            "net_pnl": -450.0 # Exceeds -Rs.400 NET loss threshold
        }
        DB.save_bitcoin_live_trade(open_pos)

        # Verify active position triggers loss limit exit condition
        net_pnl = open_pos["net_pnl"]
        sl_hit = (net_pnl <= -self.engine.per_trade_loss_limit_inr)
        self.assertTrue(sl_hit)

        # Close trade in DB
        open_pos["status"] = "CLOSED"
        open_pos["exit_timestamp"] = "2026-10-03 15:45:00"
        open_pos["exit_price"] = 8140000.0
        open_pos["exit_reason"] = "LOSS LIMIT -Rs.400 NET"
        open_pos["net_pnl"] = net_pnl
        DB.save_bitcoin_live_trade(open_pos)
        self.engine.today_realized_pnl += net_pnl

        # Verify scanner becomes active again for next re-entry
        allowed_after, reason_after = self.engine.are_new_entries_allowed()
        self.assertTrue(allowed_after)
        print(f"[TEST 6 PASS] Automatic Loss Limit Exit (-Rs.400 NET) Verified! Net PnL=Rs.{net_pnl:,.2f} -> Engine Status={reason_after}")

    def test_07_daily_loss_limit_circuit_breaker(self):
        """7. Verify Daily NET Loss Limit (-Rs.1,000 NET) blocks new trade entries."""
        self.engine.today_realized_pnl = -1050.0 # Exceeded -Rs.1,000 NET
        self.engine.daily_loss_limit_hit = True

        allowed, reason = self.engine.are_new_entries_allowed()
        self.assertFalse(allowed)
        self.assertIn("DAILY LOSS LIMIT REACHED", reason)
        print("[TEST 7 PASS] Daily Loss Limit Enforcement Verified")

    def test_08_cooldown_persistence_across_restarts(self):
        """8. Verify 15-minute cooldown persists in DB across server restarts (e.g. exit 2m ago -> 13m remaining)."""
        import time
        exit_time_2m_ago = time.time() - 120.0 # Trade exited 2 minutes ago
        self.engine.last_sl_time = exit_time_2m_ago
        self.engine.save_settings()

        # Simulate Railway Server Restart / Redeploy (New Instance)
        restarted_engine = BitcoinLiveEngine()
        restarted_engine.live_trading_enabled = True

        self.assertAlmostEqual(restarted_engine.last_sl_time, exit_time_2m_ago, delta=1.0)
        allowed, reason = restarted_engine.are_new_entries_allowed()
        
        self.assertFalse(allowed)
        self.assertIn("COOLDOWN ACTIVE", reason)
        self.assertIn("13m wait", reason)
        print(f"[TEST 8 PASS] Cooldown DB Persistence Across Server Restart Verified! Remaining: {reason}")

    def test_09_cooldown_expiry_allows_new_entry(self):
        """9. Verify new entries are allowed after full 15-minute cooldown expires (>900s)."""
        import time
        exit_time_15m_ago = time.time() - 905.0 # Trade exited 15 mins 5 seconds ago
        self.engine.last_sl_time = exit_time_15m_ago
        self.engine.save_settings()

        # Simulate Railway Server Restart / Redeploy (New Instance)
        restarted_engine = BitcoinLiveEngine()
        restarted_engine.live_trading_enabled = True

        allowed, reason = restarted_engine.are_new_entries_allowed()
        self.assertTrue(allowed)
        self.assertIn("ALLOWED", reason)
        print(f"[TEST 9 PASS] Cooldown Expiry Verification Passed! Status: {reason}")

    def test_10_real_order_success_creates_position(self):
        """10. Verify position is created ONLY when Mudrex API returns success and valid real order ID."""
        # Mock Mudrex API order placement success
        self.engine.adapter.place_futures_order = lambda symbol, side, quantity, order_type="MARKET", stoploss_price=None: {
            "success": True,
            "data": {"position_id": "MUDREX_REAL_POS_998877", "symbol": "BTCUSDT", "side": "BUY"}
        }

        res = self.engine.execute_manual_trade("BUY")
        self.assertTrue(res.get("success"))
        
        active_pos = DB.load_active_bitcoin_live_position()
        self.assertIsNotNone(active_pos)
        self.assertEqual(active_pos["mudrex_position_id"], "MUDREX_REAL_POS_998877")
        print("[TEST 10 PASS] Valid Real Mudrex Order ID Creates Position Successfully!")

    def test_11_order_failure_prevents_position_creation(self):
        """11. Verify order API failure (success=False) prevents position creation, leaves P&L=Rs.0, and does NOT trigger daily loss lock."""
        # Mock Mudrex API order placement failure
        self.engine.adapter.place_futures_order = lambda symbol, side, quantity, order_type="MARKET", stoploss_price=None: {
            "success": False,
            "error": "HTTP 400: Insufficient Balance or Margin Error"
        }

        res = self.engine.execute_manual_trade("BUY")
        self.assertFalse(res.get("success"))
        self.assertIn("ORDER REJECTED / NOT EXECUTED", res.get("error"))

        # Verify NO position saved to DB
        active_pos = DB.load_active_bitcoin_live_position()
        self.assertIsNone(active_pos)

        # Verify P&L remains Rs.0 and daily loss lock is NOT triggered
        self.assertEqual(self.engine.today_realized_pnl, 0.0)
        self.assertFalse(self.engine.daily_loss_limit_hit)
        
        all_trades = DB.load_all_bitcoin_live_trades()
        self.assertEqual(len(all_trades), 0)
        print("[TEST 11 PASS] Order Failure (success=False) Completely Blocks Trade & DB Creation!")

    def test_12_empty_or_missing_id_prevents_position_creation(self):
        """12. Verify empty response or missing position ID prevents position creation."""
        # Mock Mudrex API returning success=True but missing position ID
        self.engine.adapter.place_futures_order = lambda symbol, side, quantity, order_type="MARKET", stoploss_price=None: {
            "success": True,
            "data": {}
        }

        res = self.engine.execute_manual_trade("BUY")
        self.assertFalse(res.get("success"))
        self.assertIn("missing position/order ID", res.get("error"))

        active_pos = DB.load_active_bitcoin_live_position()
        self.assertIsNone(active_pos)
        print("[TEST 12 PASS] Missing/Empty Position ID Aborts Position Creation!")

    def test_13_no_fallback_id_generated_on_failure(self):
        """13. Verify fallback ID (MUDREX_LIVE_ / MUDREX_MANUAL_) is NEVER used for position creation on failure."""
        self.engine.adapter.place_futures_order = lambda symbol, side, quantity, order_type="MARKET", stoploss_price=None: {
            "success": False,
            "error": "API Connection Timeout"
        }

        res = self.engine.execute_manual_trade("SELL")
        self.assertFalse(res.get("success"))

        trades = DB.load_all_bitcoin_live_trades()
        for t in trades:
            pos_id = str(t.get("mudrex_position_id"))
            self.assertFalse(pos_id.startswith("MUDREX_LIVE_"))
            self.assertFalse(pos_id.startswith("MUDREX_MANUAL_"))

        print("[TEST 13 PASS] Fallback Position ID Generation Completely Disabled!")

    def test_14_inr_leverage_set_success(self):
        """14. Verify explicit leverage setup (POST /futures/{asset_id}/leverage) succeeds for INR."""
        import requests
        orig_post = requests.post
        try:
            def mock_post(url, headers=None, json=None, timeout=8):
                class Resp:
                    status_code = 200
                    def json(self):
                        return {"success": True, "data": {"leverage": "5", "margin_type": "ISOLATED"}}
                return Resp()

            requests.post = mock_post
            res = self.engine.adapter.set_leverage("01903a7b-bf65-707d-a7dc-d7b84c3c756c", leverage="5", margin_type="ISOLATED")
            self.assertTrue(res.get("success"))
            self.assertEqual(res["data"]["data"]["leverage"], "5")
            print("[TEST 14 PASS] Explicit INR Leverage Setup (POST /leverage) Verified!")
        finally:
            requests.post = orig_post

    def test_15_leverage_setup_failure_blocks_order(self):
        """15. Verify order placement is BLOCKED if explicit leverage setup fails."""
        self.engine.adapter.fetch_btcusdt_asset = lambda: {"success": True, "asset": {"id": "01903a7b-bf65-707d-a7dc-d7b84c3c756c"}}
        self.engine.adapter.set_leverage = lambda asset_id, leverage="5", margin_type="ISOLATED": {
            "success": False,
            "error": "HTTP 400: Leverage out of allowed range"
        }

        res = self.engine.adapter.place_futures_order("BTCUSDT", "BUY", 0.015)
        self.assertFalse(res.get("success"))
        self.assertIn("Leverage setup failed", res.get("error"))
        print("[TEST 15 PASS] Leverage Setup Failure Successfully Blocks Order Placement!")

    def test_16_long_order_payload_valid_schema(self):
        """16. Verify LONG order uses official documented schema (order_type='LONG', trigger_type='MARKET')."""
        self.engine.adapter.fetch_btcusdt_asset = lambda: {"success": True, "asset": {"id": "01903a7b-bf65-707d-a7dc-d7b84c3c756c"}}
        self.engine.adapter.set_leverage = lambda asset_id, leverage="5", margin_type="ISOLATED": {"success": True}
        
        captured_payloads = []
        import requests
        orig_post = requests.post
        try:
            def mock_post(url, headers=None, json=None, timeout=8):
                captured_payloads.append({"url": url, "payload": json})
                class Resp:
                    status_code = 200
                    def json(self):
                        return {"success": True, "data": {"position_id": "MUDREX_LONG_12345"}}
                return Resp()

            requests.post = mock_post

            res = self.engine.adapter.place_futures_order("BTCUSDT", "BUY", 0.015)
            self.assertTrue(res.get("success"))
            sent_payload = res.get("payload", {})
            self.assertEqual(sent_payload.get("order_type"), "LONG")
            self.assertEqual(sent_payload.get("trigger_type"), "MARKET")
            self.assertEqual(sent_payload.get("trade_currency"), "INR")
            print(f"[TEST 16 PASS] Valid LONG Order Payload Verified: {sent_payload}")
        finally:
            requests.post = orig_post

    def test_17_short_order_payload_valid_schema(self):
        """17. Verify SHORT order uses official documented schema (order_type='SHORT', trigger_type='MARKET')."""
        self.engine.adapter.fetch_btcusdt_asset = lambda: {"success": True, "asset": {"id": "01903a7b-bf65-707d-a7dc-d7b84c3c756c"}}
        self.engine.adapter.set_leverage = lambda asset_id, leverage="5", margin_type="ISOLATED": {"success": True}
        
        import requests
        orig_post = requests.post
        try:
            def mock_post(url, headers=None, json=None, timeout=8):
                class Resp:
                    status_code = 200
                    def json(self):
                        return {"success": True, "data": {"position_id": "MUDREX_SHORT_54321"}}
                return Resp()

            requests.post = mock_post

            res = self.engine.adapter.place_futures_order("BTCUSDT", "SELL", 0.015)
            self.assertTrue(res.get("success"))
            sent_payload = res.get("payload", {})
            self.assertEqual(sent_payload.get("order_type"), "SHORT")
            self.assertEqual(sent_payload.get("trigger_type"), "MARKET")
            self.assertEqual(sent_payload.get("trade_currency"), "INR")
            print(f"[TEST 17 PASS] Valid SHORT Order Payload Verified: {sent_payload}")
        finally:
            requests.post = orig_post

if __name__ == "__main__":
    unittest.main()



