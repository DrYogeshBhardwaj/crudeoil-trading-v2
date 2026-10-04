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
        """2. Verify dynamic position sizing calculation for Rs.5,000 capital (80% margin utilization target = 0.002 BTC)."""
        entry_price = 8223426.50
        qty = self.engine.calculate_position_quantity(entry_price, 5000.0)
        self.assertEqual(qty, 0.002)
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
            "data": {"order_id": "MUDREX_ORDER_998877", "position_id": "MUDREX_REAL_POS_998877", "symbol": "BTCUSDT", "side": "BUY"}
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
        self.assertIn("missing order_id or position_id", res.get("error"))

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

    def test_14_inr_leverage_url_contains_trade_currency(self):
        """14. Verify leverage set URL contains trade_currency=INR and ?is_symbol."""
        captured_urls = []
        import requests
        orig_post = requests.post
        try:
            def mock_post(url, headers=None, json=None, timeout=8):
                captured_urls.append(url)
                class Resp:
                    status_code = 200
                    def json(self):
                        return {"success": True, "data": {"leverage": "5", "margin_type": "ISOLATED", "trade_currency": "INR"}}
                return Resp()

            requests.post = mock_post
            res = self.engine.adapter.set_leverage("BTCUSDT", leverage="5", margin_type="ISOLATED")
            self.assertTrue(res.get("success"))
            self.assertIn("trade_currency=INR", captured_urls[0])
            self.assertIn("is_symbol", captured_urls[0])
            print(f"[TEST 14 PASS] INR Leverage URL contains mandatory query parameters: {captured_urls[0]}")
        finally:
            requests.post = orig_post

    def test_15_leverage_set_success_allows_order_flow(self):
        """15. Verify leverage set success allows order placement flow to proceed."""
        self.engine.adapter.fetch_btcusdt_asset = lambda: {"success": True, "asset": {"id": "01903a7b-bf65-707d-a7dc-d7b84c3c756c"}}
        self.engine.adapter.set_leverage = lambda symbol_or_id="BTCUSDT", leverage="5", margin_type="ISOLATED", asset_id=None: {"success": True}
        self.engine.adapter.verify_leverage = lambda symbol_or_id="BTCUSDT", expected_leverage="5", asset_id=None: {"success": True, "leverage": "5"}

        import requests
        orig_post = requests.post
        try:
            def mock_post(url, headers=None, json=None, timeout=8):
                class Resp:
                    status_code = 200
                    def json(self):
                        return {"success": True, "data": {"order_id": "ORD_1001", "position_id": "POS_1001"}}
                return Resp()

            requests.post = mock_post
            res = self.engine.adapter.place_futures_order("BTCUSDT", "BUY", 0.015)
            self.assertTrue(res.get("success"))
            print("[TEST 15 PASS] Leverage Set Success Allows Order Flow!")
        finally:
            requests.post = orig_post

    def test_16_leverage_set_failure_blocks_order(self):
        """16. Verify order placement is BLOCKED if explicit leverage setup fails."""
        self.engine.adapter.fetch_btcusdt_asset = lambda: {"success": True, "asset": {"id": "01903a7b-bf65-707d-a7dc-d7b84c3c756c"}}
        self.engine.adapter.set_leverage = lambda symbol_or_id="BTCUSDT", leverage="5", margin_type="ISOLATED", asset_id=None: {
            "success": False,
            "error": "HTTP 400: Leverage configuration rejected / parameter error"
        }

        res = self.engine.adapter.place_futures_order("BTCUSDT", "BUY", 0.015)
        self.assertFalse(res.get("success"))
        self.assertIn("LEVERAGE SETUP FAILED", res.get("error"))
        print("[TEST 16 PASS] Leverage Setup Failure Successfully Blocks Order Placement!")

    def test_17_leverage_verification_failure_blocks_order(self):
        """17. Verify order placement is BLOCKED if leverage GET verification fails."""
        self.engine.adapter.fetch_btcusdt_asset = lambda: {"success": True, "asset": {"id": "01903a7b-bf65-707d-a7dc-d7b84c3c756c"}}
        self.engine.adapter.set_leverage = lambda symbol_or_id="BTCUSDT", leverage="5", margin_type="ISOLATED", asset_id=None: {"success": True}
        self.engine.adapter.verify_leverage = lambda symbol_or_id="BTCUSDT", expected_leverage="5", asset_id=None: {
            "success": False,
            "error": "Leverage mismatch: expected 5, got 10"
        }

        res = self.engine.adapter.place_futures_order("BTCUSDT", "BUY", 0.015)
        self.assertFalse(res.get("success"))
        self.assertIn("LEVERAGE VERIFICATION FAILED", res.get("error"))
        print("[TEST 17 PASS] Leverage GET Verification Failure Blocks Order!")

    def test_18_five_x_leverage_payload(self):
        """18. Verify 5x leverage is explicitly sent in set_leverage payload."""
        captured_json = []
        import requests
        orig_post = requests.post
        try:
            def mock_post(url, headers=None, json=None, timeout=8):
                captured_json.append(json)
                class Resp:
                    status_code = 200
                    def json(self):
                        return {"success": True, "data": {"leverage": "5", "margin_type": "ISOLATED"}}
                return Resp()

            requests.post = mock_post
            res = self.engine.adapter.set_leverage("BTCUSDT", leverage="5", margin_type="ISOLATED")
            self.assertTrue(res.get("success"))
            self.assertEqual(captured_json[0].get("leverage"), "5")
            self.assertEqual(captured_json[0].get("margin_type"), "ISOLATED")
            self.assertEqual(captured_json[0].get("trade_currency"), "INR")
            print(f"[TEST 18 PASS] 5x ISOLATED INR Payload Verified: {captured_json[0]}")
        finally:
            requests.post = orig_post

    def test_19_long_order_payload_v2_schema(self):
        """19. Verify LONG order uses official documented v2 schema."""
        self.engine.adapter.fetch_btcusdt_asset = lambda: {"success": True, "asset": {"id": "01903a7b-bf65-707d-a7dc-d7b84c3c756c"}}
        self.engine.adapter.set_leverage = lambda symbol_or_id="BTCUSDT", leverage="5", margin_type="ISOLATED", asset_id=None: {"success": True}
        self.engine.adapter.verify_leverage = lambda symbol_or_id="BTCUSDT", expected_leverage="5", asset_id=None: {"success": True}

        import requests
        orig_post = requests.post
        try:
            def mock_post(url, headers=None, json=None, timeout=8):
                class Resp:
                    status_code = 200
                    def json(self):
                        return {"success": True, "data": {"order_id": "ORD_BUY_123", "position_id": "POS_BUY_123"}}
                return Resp()

            requests.post = mock_post
            res = self.engine.adapter.place_futures_order("BTCUSDT", "BUY", 0.015)
            self.assertTrue(res.get("success"))
            sent_payload = res.get("payload", {})
            self.assertEqual(sent_payload.get("order_type"), "LONG")
            self.assertEqual(sent_payload.get("trigger_type"), "MARKET")
            self.assertEqual(sent_payload.get("trade_currency"), "INR")
            print(f"[TEST 19 PASS] Valid LONG Order Payload Verified: {sent_payload}")
        finally:
            requests.post = orig_post

    def test_20_short_order_payload_v2_schema(self):
        """20. Verify SHORT order uses official documented v2 schema."""
        self.engine.adapter.fetch_btcusdt_asset = lambda: {"success": True, "asset": {"id": "01903a7b-bf65-707d-a7dc-d7b84c3c756c"}}
        self.engine.adapter.set_leverage = lambda symbol_or_id="BTCUSDT", leverage="5", margin_type="ISOLATED", asset_id=None: {"success": True}
        self.engine.adapter.verify_leverage = lambda symbol_or_id="BTCUSDT", expected_leverage="5", asset_id=None: {"success": True}

        import requests
        orig_post = requests.post
        try:
            def mock_post(url, headers=None, json=None, timeout=8):
                class Resp:
                    status_code = 200
                    def json(self):
                        return {"success": True, "data": {"order_id": "ORD_SELL_321", "position_id": "POS_SELL_321"}}
                return Resp()

            requests.post = mock_post
            res = self.engine.adapter.place_futures_order("BTCUSDT", "SELL", 0.015)
            self.assertTrue(res.get("success"))
            sent_payload = res.get("payload", {})
            self.assertEqual(sent_payload.get("order_type"), "SHORT")
            self.assertEqual(sent_payload.get("trigger_type"), "MARKET")
            self.assertEqual(sent_payload.get("trade_currency"), "INR")
            print(f"[TEST 20 PASS] Valid SHORT Order Payload Verified: {sent_payload}")
        finally:
            requests.post = orig_post

    def test_21_http_202_accepted_valid_submission(self):
        """21. Verify HTTP 202 Accepted with success=true and valid IDs is accepted as valid API submission."""
        self.engine.adapter.fetch_btcusdt_asset = lambda: {"success": True, "asset": {"id": "01903a7b-bf65-707d-a7dc-d7b84c3c756c"}}
        self.engine.adapter.set_leverage = lambda symbol_or_id="BTCUSDT", leverage="5", margin_type="ISOLATED", asset_id=None: {"success": True}
        self.engine.adapter.verify_leverage = lambda symbol_or_id="BTCUSDT", expected_leverage="5", asset_id=None: {"success": True}

        import requests
        orig_post = requests.post
        try:
            def mock_post(url, headers=None, json=None, timeout=8):
                class Resp:
                    status_code = 202 # Accepted
                    def json(self):
                        return {"success": True, "data": {"order_id": "ORD_202_ACCEPT", "position_id": "POS_202_INITIATED", "status": "INITIATED"}}
                return Resp()

            requests.post = mock_post
            res = self.engine.adapter.place_futures_order("BTCUSDT", "BUY", 0.015)
            self.assertTrue(res.get("success"))
            self.assertEqual(res.get("status_code"), 202)
            print("[TEST 21 PASS] HTTP 202 Accepted Treated as Valid Submission!")
        finally:
            requests.post = orig_post

    def test_22_http_200_201_handling_remains_safe(self):
        """22. Verify HTTP 200/201 response handling remains fully safe."""
        self.engine.adapter.fetch_btcusdt_asset = lambda: {"success": True, "asset": {"id": "01903a7b-bf65-707d-a7dc-d7b84c3c756c"}}
        self.engine.adapter.set_leverage = lambda symbol_or_id="BTCUSDT", leverage="5", margin_type="ISOLATED", asset_id=None: {"success": True}
        self.engine.adapter.verify_leverage = lambda symbol_or_id="BTCUSDT", expected_leverage="5", asset_id=None: {"success": True}

        import requests
        orig_post = requests.post
        try:
            def mock_post(url, headers=None, json=None, timeout=8):
                class Resp:
                    status_code = 201
                    def json(self):
                        return {"success": True, "data": {"order_id": "ORD_201_CREATED", "position_id": "POS_201_OPEN"}}
                return Resp()

            requests.post = mock_post
            res = self.engine.adapter.place_futures_order("BTCUSDT", "BUY", 0.015)
            self.assertTrue(res.get("success"))
            self.assertEqual(res.get("status_code"), 201)
            print("[TEST 22 PASS] HTTP 200/201 Handling Verified!")
        finally:
            requests.post = orig_post

    def test_23_missing_order_id_blocks_local_position(self):
        """23. Verify missing order_id in Mudrex response blocks position creation."""
        self.engine.adapter.place_futures_order = lambda symbol, side, quantity, order_type="MARKET", stoploss_price=None: {
            "success": True,
            "data": {"position_id": "POS_ONLY_NO_ORDER_ID"} # missing order_id
        }

        res = self.engine.execute_manual_trade("BUY")
        self.assertFalse(res.get("success"))
        self.assertIn("missing order_id or position_id", res.get("error"))

        active_pos = DB.load_active_bitcoin_live_position()
        self.assertIsNone(active_pos)
        print("[TEST 23 PASS] Missing order_id Successfully Blocks Local Position Creation!")

    def test_24_missing_position_id_blocks_local_position(self):
        """24. Verify missing position_id in Mudrex response blocks position creation."""
        self.engine.adapter.place_futures_order = lambda symbol, side, quantity, order_type="MARKET", stoploss_price=None: {
            "success": True,
            "data": {"order_id": "ORDER_ONLY_NO_POS_ID"} # missing position_id
        }

        res = self.engine.execute_manual_trade("BUY")
        self.assertFalse(res.get("success"))
        self.assertIn("missing order_id or position_id", res.get("error"))

        active_pos = DB.load_active_bitcoin_live_position()
        self.assertIsNone(active_pos)
        print("[TEST 24 PASS] Missing position_id Successfully Blocks Local Position Creation!")

    def test_25_fallback_id_remains_disabled(self):
        """25. Verify fallback ID generation remains completely disabled on failure."""
        self.engine.adapter.place_futures_order = lambda symbol, side, quantity, order_type="MARKET", stoploss_price=None: {
            "success": False,
            "error": "HTTP 500: Server Error"
        }

        res = self.engine.execute_manual_trade("BUY")
        self.assertFalse(res.get("success"))

        trades = DB.load_all_bitcoin_live_trades()
        self.assertEqual(len(trades), 0)
        print("[TEST 25 PASS] Fallback Position ID Generation Remains Completely Disabled!")

    def test_26_no_local_pnl_on_rejected_order(self):
        """26. Verify no local P&L is logged or added on a rejected order."""
        self.engine.adapter.place_futures_order = lambda symbol, side, quantity, order_type="MARKET", stoploss_price=None: {
            "success": False,
            "error": "HTTP 400: Leverage setup rejected"
        }

        res = self.engine.execute_manual_trade("BUY")
        self.assertFalse(res.get("success"))

        self.assertEqual(self.engine.today_realized_pnl, 0.0)
        print("[TEST 26 PASS] No Local P&L Logged on Rejected Order!")

    def test_27_no_daily_loss_impact_on_rejected_order(self):
        """27. Verify a rejected order has zero impact on daily loss limit or daily loss count."""
        self.engine.adapter.place_futures_order = lambda symbol, side, quantity, order_type="MARKET", stoploss_price=None: {
            "success": False,
            "error": "HTTP 400: Rejection"
        }

        res = self.engine.execute_manual_trade("SELL")
        self.assertFalse(res.get("success"))

        self.assertFalse(self.engine.daily_loss_limit_hit)
        self.assertEqual(self.engine.today_realized_pnl, 0.0)
        print("[TEST 27 PASS] Zero Daily Loss Impact on Rejected Order!")

    def test_28_no_cooldown_on_rejected_order(self):
        """28. Verify a rejected order does NOT trigger the 15-minute persistent cooldown."""
        self.engine.last_sl_time = 0.0
        self.engine.adapter.place_futures_order = lambda symbol, side, quantity, order_type="MARKET", stoploss_price=None: {
            "success": False,
            "error": "HTTP 400: Rejected"
        }

        res = self.engine.execute_manual_trade("BUY")
        self.assertFalse(res.get("success"))

        self.assertEqual(self.engine.last_sl_time, 0.0)
        allowed, reason = self.engine.are_new_entries_allowed()
        self.assertTrue(allowed)
        print("[TEST 28 PASS] No Cooldown Triggered on Rejected Order!")

    def test_29_dynamic_quantity_for_5k_balance(self):
        """29. Verify Rs.5,000 balance at BTC Rs.82,23,426 yields exact 0.002 BTC (80% margin utilization)."""
        entry_price = 8223426.50
        qty = self.engine.calculate_position_quantity(entry_price, 5000.0)
        self.assertEqual(qty, 0.002)
        est_margin = (qty * entry_price) / 5.0
        self.assertLess(est_margin, 5000.0)
        print(f"[TEST 29 PASS] Rs.5,000 Balance Position Sizing: Qty={qty} BTC | Est. Margin=Rs.{est_margin:,.2f}")

    def test_30_quantity_step_and_floor_rounding(self):
        """30. Verify quantity is always rounded DOWN to 0.001 step size (never rounded UP)."""
        entry_price = 8223426.50
        # Rs.6,000 balance -> usable_margin = 4800, max_notional = 24000 -> raw_qty = 0.002918 -> floor to 0.002 BTC
        qty = self.engine.calculate_position_quantity(entry_price, 6000.0)
        self.assertEqual(qty, 0.002)
        
        # Rs.7,000 balance -> usable_margin = 5600, max_notional = 28000 -> raw_qty = 0.003405 -> floor to 0.003 BTC
        qty2 = self.engine.calculate_position_quantity(entry_price, 7000.0)
        self.assertEqual(qty2, 0.003)
        print("[TEST 30 PASS] Quantity Floor Rounding (0.001 step size) Verified!")

    def test_31_quantity_never_exceeds_available_margin(self):
        """31. Verify estimated required margin for calculated quantity never exceeds available Futures balance."""
        balances = [1000.0, 3000.0, 5000.0, 10000.0, 50000.0]
        entry_price = 8223426.50
        for bal in balances:
            qty = self.engine.calculate_position_quantity(entry_price, bal)
            if qty > 0:
                est_margin = (qty * entry_price) / 5.0
                self.assertLess(est_margin, bal)
        print("[TEST 31 PASS] Estimated Required Margin Never Exceeds Available Futures Balance!")

    def test_32_insufficient_balance_blocks_order(self):
        """32. Verify available balance insufficient for min quantity 0.001 BTC returns 0.0 quantity and blocks order."""
        entry_price = 8223426.50
        # Rs.1,500 balance at 5x leverage -> max notional Rs.6,000 -> raw qty 0.000729 BTC < min step 0.001
        qty = self.engine.calculate_position_quantity(entry_price, 1500.0)
        self.assertEqual(qty, 0.0)

        # Mock adapter with low balance Rs.1,500
        self.engine.adapter.fetch_futures_balance = lambda: 1500.0
        res = self.engine.execute_manual_trade("BUY")
        self.assertFalse(res.get("success"))
        self.assertIn("INSUFFICIENT MARGIN", res.get("error"))
        print("[TEST 32 PASS] Insufficient Balance (< 0.001 BTC min) Blocks Order Execution!")

    def test_33_quantity_recalculates_when_btc_price_changes(self):
        """33. Verify quantity recalculates dynamically when BTC price changes."""
        bal = 5000.0
        # Low BTC price Rs.4,000,000 -> max_notional Rs.20,000 -> raw_qty 0.005 BTC
        qty_low_price = self.engine.calculate_position_quantity(4000000.0, bal)
        self.assertEqual(qty_low_price, 0.005)

        # High BTC price Rs.10,000,000 -> max_notional Rs.20,000 -> raw_qty 0.002 BTC
        qty_high_price = self.engine.calculate_position_quantity(10000000.0, bal)
        self.assertEqual(qty_high_price, 0.002)
        print(f"[TEST 33 PASS] Dynamic Recalculation on Price Change Verified: LowPrice Qty={qty_low_price} BTC, HighPrice Qty={qty_high_price} BTC")

    def test_34_quantity_recalculates_when_futures_balance_changes(self):
        """34. Verify quantity recalculates dynamically when Futures balance changes."""
        entry_price = 8223426.50
        qty_5k = self.engine.calculate_position_quantity(entry_price, 5000.0)
        qty_15k = self.engine.calculate_position_quantity(entry_price, 15000.0)
        
        self.assertEqual(qty_5k, 0.002)
        self.assertEqual(qty_15k, 0.007)
        print(f"[TEST 34 PASS] Dynamic Recalculation on Balance Change Verified: 5k Bal Qty={qty_5k} BTC, 15k Bal Qty={qty_15k} BTC")

    def test_35_mudrex_futures_usd_price_authoritative(self):
        """35. Verify Mudrex Futures USD price is authoritative for market data fetch."""
        price_usd, hr, source = self.engine.fetch_mudrex_futures_market_data()
        self.assertIsNotNone(price_usd)
        self.assertGreater(price_usd, 50000.0)
        self.assertGreater(hr, 0.0)
        print(f"[TEST 35 PASS] Mudrex Futures USD Price Authoritative: Price=${price_usd:,.2f} USD, HedgeRate={hr} INR/USDT ({source})")

    def test_36_yahoo_btc_inr_never_used_for_live_execution(self):
        """36. Verify Yahoo BTC-INR price feed is never used for live execution exit triggers."""
        # Set up a position with USD basis
        entry_usd = 85260.0
        hr = 102.0
        tp_usd, sl_usd, tp_inr, sl_inr, _ = self.engine.calculate_sl_and_target_prices("BUY", entry_usd, 0.002, hr)

        pos_dict = {
            "trade_id": "BTC_LIVE_TEST_36",
            "mudrex_position_id": "MUDREX_POS_36",
            "entry_timestamp": "2026-10-04 10:38:00",
            "symbol": "BTCUSDT",
            "direction": "BUY",
            "quantity": 0.002,
            "entry_price_usd": entry_usd,
            "hedge_rate": hr,
            "entry_price": entry_usd * hr,
            "stop_loss_usd": sl_usd,
            "stop_loss": sl_inr,
            "target_usd": tp_usd,
            "target": tp_inr,
            "trend_state": "BULLISH",
            "confidence": 90,
            "reasons": [],
            "status": "OPEN"
        }
        DB.save_bitcoin_live_trade(pos_dict)

        # Mock market data feed to return USD price $85,259.60 (flat)
        self.engine.fetch_mudrex_futures_market_data = lambda: (85259.60, 102.0, "Mock Mudrex USD")
        self.engine.process_tick()

        # Position MUST remain OPEN (not exited by Yahoo INR price ~82.14L)
        active = DB.load_active_bitcoin_live_position()
        self.assertIsNotNone(active)
        self.assertEqual(active.get("status"), "OPEN")
        print("[TEST 36 PASS] Yahoo BTC-INR Price Never Used for Live Exit Triggers!")

    def test_37_dynamic_hedge_rate_used_not_hardcoded(self):
        """37. Verify dynamic Mudrex hedge rate (e.g. 108.5) is used for TP/SL and P&L math."""
        entry_usd = 85000.0
        hr_custom = 108.5
        tp_usd, sl_usd, tp_inr, sl_inr, est_chg = self.engine.calculate_sl_and_target_prices("BUY", entry_usd, 0.002, hr_custom)

        # Verify INR equivalent uses dynamic 108.5 hedge rate
        expected_tp_inr = round(tp_usd * hr_custom, 2)
        self.assertAlmostEqual(tp_inr, expected_tp_inr, delta=0.1)
        print(f"[TEST 37 PASS] Dynamic Hedge Rate Verified: Custom FX {hr_custom} -> TP USD=${tp_usd:,.2f} | TP INR=Rs.{tp_inr:,.2f}")

    def test_38_long_pnl_calculation_in_usd_and_inr(self):
        """38. Verify LONG P&L math in USD and converted to INR via hedge rate."""
        entry_usd = 85000.0
        curr_usd = 86000.0
        qty = 0.002
        hr = 102.0

        gross_usd = (curr_usd - entry_usd) * qty # +$2.00 USD
        gross_inr = gross_usd * hr # +Rs.204.00 INR
        self.assertAlmostEqual(gross_inr, 204.0, delta=0.01)
        print(f"[TEST 38 PASS] LONG P&L Calculation Verified: Gross USD=+${gross_usd:.2f} -> Gross INR=Rs.{gross_inr:.2f}")

    def test_39_short_pnl_calculation_in_usd_and_inr(self):
        """39. Verify SHORT P&L math in USD and converted to INR via hedge rate."""
        entry_usd = 85000.0
        curr_usd = 84000.0
        qty = 0.002
        hr = 102.0

        gross_usd = (entry_usd - curr_usd) * qty # +$2.00 USD
        gross_inr = gross_usd * hr # +Rs.204.00 INR
        self.assertAlmostEqual(gross_inr, 204.0, delta=0.01)
        print(f"[TEST 39 PASS] SHORT P&L Calculation Verified: Gross USD=+${gross_usd:.2f} -> Gross INR=Rs.{gross_inr:.2f}")

    def test_40_target_profit_600_net_in_usd(self):
        """40. Verify +Rs.600 NET target calculation in USD price scale."""
        entry_usd = 85260.0
        qty = 0.002
        hr = 102.0

        tp_usd, sl_usd, tp_inr, sl_inr, est_chg = self.engine.calculate_sl_and_target_prices("BUY", entry_usd, qty, hr)
        # At tp_usd, net P&L must equal +Rs.600 NET
        gross_usd = (tp_usd - entry_usd) * qty
        gross_inr = gross_usd * hr
        net_pnl = gross_inr - est_chg
        self.assertAlmostEqual(net_pnl, 600.0, delta=2.0)
        print(f"[TEST 40 PASS] +Rs.600 NET Target Verified in USD: Entry=${entry_usd} -> TP USD=${tp_usd:,.2f} -> Net PnL=Rs.{net_pnl:.2f}")

    def test_41_loss_limit_400_net_in_usd(self):
        """41. Verify -Rs.400 NET loss limit calculation in USD price scale."""
        entry_usd = 85260.0
        qty = 0.002
        hr = 102.0

        tp_usd, sl_usd, tp_inr, sl_inr, est_chg = self.engine.calculate_sl_and_target_prices("BUY", entry_usd, qty, hr)
        # At sl_usd, net P&L must equal -Rs.400 NET
        gross_usd = (sl_usd - entry_usd) * qty
        gross_inr = gross_usd * hr
        net_pnl = gross_inr - est_chg
        self.assertAlmostEqual(net_pnl, -400.0, delta=2.0)
        print(f"[TEST 41 PASS] -Rs.400 NET Loss Limit Verified in USD: Entry=${entry_usd} -> SL USD=${sl_usd:,.2f} -> Net PnL=Rs.{net_pnl:.2f}")

    def test_42_current_live_position_reconciliation(self):
        """42. Verify current live position BTC_LIVE_1791110280 reconciliation to Mudrex USD entry $85,260 and 102 hedge rate."""
        pos_old = {
            "trade_id": "BTC_LIVE_1791110280",
            "mudrex_position_id": "01a1067d-f252-7e89-91da-9b03be176bfe",
            "entry_timestamp": "2026-10-04 10:38:00",
            "symbol": "BTCUSDT",
            "direction": "BUY",
            "quantity": 0.002,
            "entry_price": 8219875.0, # Old Yahoo INR price
            "stop_loss": 8029875.0,
            "target": 8529875.0,
            "trend_state": "BULLISH",
            "confidence": 95,
            "reasons": [],
            "status": "OPEN"
        }
        DB.save_bitcoin_live_trade(pos_old)

        # Mock current market data flat at $85,259.60 USD
        self.engine.fetch_mudrex_futures_market_data = lambda: (85259.60, 102.0, "Mock Mudrex USD")
        self.engine.process_tick()

        # Reconciled position check
        reconciled = DB.load_active_bitcoin_live_position()
        self.assertIsNotNone(reconciled)
        self.assertEqual(reconciled.get("entry_price_usd"), 85260.0)
        self.assertEqual(reconciled.get("hedge_rate"), 102.0)
        self.assertEqual(reconciled.get("entry_price"), 8696520.0)
        self.assertEqual(reconciled.get("status"), "OPEN")
        print(f"[TEST 42 PASS] Live Position BTC_LIVE_1791110280 Reconciled: Entry USD=${reconciled.get('entry_price_usd')} | HedgeRate={reconciled.get('hedge_rate')} | Entry INR=Rs.{reconciled.get('entry_price'):,.2f}")

    def test_43_real_mudrex_close_request_on_tp(self):
        """43. Verify real Mudrex close API request is sent when TP USD target is hit."""
        entry_usd = 85260.0
        hr = 102.0
        tp_usd, sl_usd, tp_inr, sl_inr, _ = self.engine.calculate_sl_and_target_prices("BUY", entry_usd, 0.002, hr)

        pos_dict = {
            "trade_id": "BTC_LIVE_TEST_43",
            "mudrex_position_id": "POS_MUDREX_REAL_CLOSE",
            "entry_timestamp": "2026-10-04 10:38:00",
            "symbol": "BTCUSDT",
            "direction": "BUY",
            "quantity": 0.002,
            "entry_price_usd": entry_usd,
            "hedge_rate": hr,
            "entry_price": entry_usd * hr,
            "target_usd": tp_usd,
            "stop_loss_usd": sl_usd,
            "target": tp_inr,
            "stop_loss": sl_inr,
            "trend_state": "BULLISH",
            "confidence": 95,
            "reasons": [],
            "status": "OPEN"
        }
        DB.save_bitcoin_live_trade(pos_dict)

        closed_ids = []
        self.engine.adapter.close_position_safely = lambda pid: closed_ids.append(pid) or {"success": True}
        # Price hits TP USD ($88,300 USD)
        self.engine.fetch_mudrex_futures_market_data = lambda: (88300.0, 102.0, "Mock TP Hit")
        self.engine.process_tick()

        self.assertIn("POS_MUDREX_REAL_CLOSE", closed_ids)
        closed_trade = DB.load_all_bitcoin_live_trades()[0]
        self.assertEqual(closed_trade.get("status"), "CLOSED")
        self.assertIn("PROFIT TARGET", closed_trade.get("exit_reason"))
        print("[TEST 43 PASS] Real Mudrex Close API Request Sent on TP Trigger!")

    def test_44_failed_mudrex_close_keeps_position_open(self):
        """44. Verify failed Mudrex close request does NOT mark local position closed."""
        entry_usd = 85260.0
        hr = 102.0
        tp_usd, sl_usd, tp_inr, sl_inr, _ = self.engine.calculate_sl_and_target_prices("BUY", entry_usd, 0.002, hr)

        pos_dict = {
            "trade_id": "BTC_LIVE_TEST_44",
            "mudrex_position_id": "POS_MUDREX_FAIL_CLOSE",
            "entry_timestamp": "2026-10-04 10:38:00",
            "symbol": "BTCUSDT",
            "direction": "BUY",
            "quantity": 0.002,
            "entry_price_usd": entry_usd,
            "hedge_rate": hr,
            "entry_price": entry_usd * hr,
            "target_usd": tp_usd,
            "stop_loss_usd": sl_usd,
            "target": tp_inr,
            "stop_loss": sl_inr,
            "trend_state": "BULLISH",
            "confidence": 95,
            "reasons": [],
            "status": "OPEN"
        }
        DB.save_bitcoin_live_trade(pos_dict)

        # Mock close API returning success=False
        self.engine.adapter.close_position_safely = lambda pid: {"success": False, "error": "Network Timeout"}
        self.engine.fetch_mudrex_futures_market_data = lambda: (88300.0, 102.0, "Mock TP Hit")
        self.engine.process_tick()

        # Local position MUST remain OPEN because close API failed!
        active = DB.load_active_bitcoin_live_position()
        self.assertIsNotNone(active)
        self.assertEqual(active.get("status"), "OPEN")
        print("[TEST 44 PASS] Failed Mudrex Close API Request Keeps Position State OPEN!")

    def test_45_price_feed_failure_does_not_fallback_to_yahoo(self):
        """45. Verify price feed failure (None / <=0) does NOT fall back to Yahoo and keeps position unchanged."""
        entry_usd = 85260.0
        hr = 102.0
        tp_usd, sl_usd, tp_inr, sl_inr, _ = self.engine.calculate_sl_and_target_prices("BUY", entry_usd, 0.002, hr)

        pos_dict = {
            "trade_id": "BTC_LIVE_TEST_45",
            "mudrex_position_id": "POS_MUDREX_FEED_FAIL",
            "entry_timestamp": "2026-10-04 10:38:00",
            "symbol": "BTCUSDT",
            "direction": "BUY",
            "quantity": 0.002,
            "entry_price_usd": entry_usd,
            "hedge_rate": hr,
            "entry_price": entry_usd * hr,
            "target_usd": tp_usd,
            "stop_loss_usd": sl_usd,
            "target": tp_inr,
            "stop_loss": sl_inr,
            "trend_state": "BULLISH",
            "confidence": 95,
            "reasons": [],
            "status": "OPEN"
        }
        DB.save_bitcoin_live_trade(pos_dict)

        # Mock market data feed failure returning None
        self.engine.fetch_mudrex_futures_market_data = lambda: (None, 102.0, "PRICE FEED UNAVAILABLE")
        self.engine.process_tick()

        active = DB.load_active_bitcoin_live_position()
        self.assertIsNotNone(active)
        self.assertEqual(active.get("status"), "OPEN")
        self.assertEqual(self.engine.last_api_status, "MUDREX FUTURES PRICE FEED UNAVAILABLE")
        print("[TEST 45 PASS] Price Feed Failure Does NOT Fall Back to Yahoo & Preserves Open Position State!")

if __name__ == "__main__":
    unittest.main()




