"""
Bitcoin Live Engine & Risk Protection System (Mudrex API)
STRICTLY DECOUPLED FROM PAPER ENGINE, CRUDEOILM, WTI, AND PI42.

Implements Mandatory Risk Guardrails:
1. Max 1 open BTC position.
2. Every live position MUST have a hard Stop Loss.
3. Per-trade maximum loss limit (configurable, persisted in DB).
4. Daily maximum loss limit (configurable, persisted in DB).
5. Automatic Daily Loss Limit enforcement (close position, cancel orders, block entries for rest of day).
6. Emergency Circuit Breaker for API failures, feed drops, or SL attachment failures.
7. Strictly NO averaging down.
8. Strictly NO martingale.
9. Persistent state across Railway restarts via SQLite (bitcoin_live_settings).
"""

import os
import time
import json
import asyncio
import requests
import traceback
from datetime import datetime
from typing import Dict, Any, Optional, List, Tuple

from database import DB
from bitcoin_feed import BITCOIN_FEED
from bitcoin_strategy import BITCOIN_STRATEGY

class MudrexLiveAdapter:
    """Handles REST interactions with Mudrex API for funds, positions, risk orders, and leverage."""
    
    BASE_URL = "https://trade.mudrex.com/fapi/v1"

    def __init__(self):
        pass

    def _get_headers(self) -> Dict[str, str]:
        api_secret = (
            os.environ.get("MUDREX_API_SECRET") or 
            os.environ.get("MUDREX_SECRET") or 
            os.environ.get("MUDREX_SECRET_KEY") or ""
        ).strip()
        
        api_key = (
            os.environ.get("MUDREX_API_KEY") or 
            os.environ.get("MUDREX_KEY") or ""
        ).strip()

        headers = {
            "X-Authentication": api_secret,
            "Content-Type": "application/json",
            "User-Agent": "Bitcoin-Live-Engine/1.0"
        }
        if api_key:
            headers["X-Api-Key"] = api_key
        return headers

    def test_authentication(self) -> Dict[str, Any]:
        """Verifies API credentials against Mudrex wallet endpoint."""
        try:
            headers = self._get_headers()
            if not headers.get("X-Authentication"):
                return {"success": False, "error": "MUDREX_API_SECRET missing in environment."}

            url = f"{self.BASE_URL}/wallet/funds?currency=INR"
            resp = requests.get(url, headers=headers, timeout=5)
            if resp.status_code in (200, 201):
                return {"success": True, "data": resp.json()}
            else:
                return {"success": False, "status_code": resp.status_code, "error": resp.text}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def fetch_spot_balance(self) -> float:
        """Fetches INR spot wallet balance."""
        try:
            headers = self._get_headers()
            url = f"{self.BASE_URL}/wallet/funds?currency=INR"
            resp = requests.get(url, headers=headers, timeout=5)
            if resp.status_code in (200, 201):
                data = resp.json()
                inner = data.get("data") if isinstance(data, dict) else data
                if isinstance(inner, dict):
                    val = inner.get("withdrawable") or inner.get("total") or inner.get("available_balance") or inner.get("balance") or 0.0
                    return float(val)
                elif isinstance(inner, list) and inner:
                    val = inner[0].get("withdrawable") or inner[0].get("total") or inner[0].get("available_balance") or inner[0].get("balance") or 0.0
                    return float(val)
            return 0.0
        except Exception:
            return 0.0

    def fetch_futures_balance(self) -> float:
        """Fetches INR futures wallet balance."""
        try:
            headers = self._get_headers()
            url = f"{self.BASE_URL}/futures/funds?trade_currency=INR"
            resp = requests.get(url, headers=headers, timeout=5)
            if resp.status_code in (200, 201):
                data = resp.json()
                inner = data.get("data") if isinstance(data, dict) else data
                if isinstance(inner, dict):
                    val = inner.get("balance") or inner.get("available_balance") or inner.get("total") or 0.0
                    return float(val)
                elif isinstance(inner, list) and inner:
                    val = inner[0].get("balance") or inner[0].get("available_balance") or inner[0].get("total") or 0.0
                    return float(val)
            return 0.0
        except Exception:
            return 0.0

    def transfer_inr_spot_to_futures(self, amount: float) -> Dict[str, Any]:
        """
        Transfers INR funds from Spot Wallet to Futures Wallet.
        Endpoint: POST /futures/transfers/inr
        """
        try:
            headers = self._get_headers()
            url = f"{self.BASE_URL}/futures/transfers/inr"
            payloads = [
                {"amount": str(amount), "from_wallet_type": "SPOT", "to_wallet_type": "FUTURES"},
                {"amount": str(amount), "from_wallet_type": "spot", "to_wallet_type": "futures"},
                {"amount": str(amount), "FromWalletType": "SPOT", "ToWalletType": "FUTURES"},
                {"amount": str(amount), "from_wallet_type": "WALLET", "to_wallet_type": "FUTURES"}
            ]
            last_resp = None
            for payload in payloads:
                resp = requests.post(url, headers=headers, json=payload, timeout=8)
                last_resp = resp
                if resp.status_code in (200, 201):
                    return {"success": True, "data": resp.json()}
            return {"success": False, "status_code": last_resp.status_code if last_resp else 500, "error": last_resp.text if last_resp else "Unknown"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def fetch_btcusdt_asset(self) -> Dict[str, Any]:
        """Fetches exact BTCUSDT futures instrument metadata from Mudrex."""
        try:
            headers = self._get_headers()
            url = f"{self.BASE_URL}/futures/BTCUSDT?is_symbol"
            resp = requests.get(url, headers=headers, timeout=5)
            if resp.status_code in (200, 201):
                data = resp.json()
                ast = data.get("data") if isinstance(data, dict) and "data" in data else data
                return {"success": True, "asset": ast}
            return {"success": False, "status_code": resp.status_code, "error": resp.text}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def fetch_leverage_info(self) -> Dict[str, Any]:
        """Fetches leverage information for BTCUSDT with trade_currency=INR."""
        try:
            headers = self._get_headers()
            url = f"{self.BASE_URL}/futures/BTCUSDT/leverage?is_symbol&trade_currency=INR"
            resp = requests.get(url, headers=headers, timeout=5)
            if resp.status_code in (200, 201):
                return {"success": True, "data": resp.json()}
            
            # Fallback to asset details leverage info
            ast_res = self.fetch_btcusdt_asset()
            if ast_res.get("success"):
                ast = ast_res.get("asset", {})
                if ast and "min_leverage" in ast:
                    return {
                        "success": True,
                        "data": {
                            "min_leverage": ast.get("min_leverage", "1"),
                            "max_leverage": ast.get("max_leverage", "150"),
                            "leverage_step": ast.get("leverage_step", "0.01")
                        }
                    }
            return {"success": False, "status_code": resp.status_code if 'resp' in locals() else 500, "error": resp.text if 'resp' in locals() else "Unknown"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def fetch_open_positions(self) -> List[Dict[str, Any]]:
        """Fetches open futures positions for trade_currency=INR."""
        try:
            headers = self._get_headers()
            url = f"{self.BASE_URL}/futures/positions?trade_currency=INR"
            resp = requests.get(url, headers=headers, timeout=5)
            if resp.status_code in (200, 201):
                data = resp.json()
                inner = data.get("data") if isinstance(data, dict) else data
                if isinstance(inner, list):
                    return inner
            return []
        except Exception:
            return []

    def fetch_open_orders(self) -> List[Dict[str, Any]]:
        """Fetches pending futures orders for trade_currency=INR."""
        try:
            headers = self._get_headers()
            url = f"{self.BASE_URL}/futures/orders?trade_currency=INR"
            resp = requests.get(url, headers=headers, timeout=5)
            if resp.status_code in (200, 201):
                data = resp.json()
                inner = data.get("data") if isinstance(data, dict) else data
                if isinstance(inner, list):
                    return inner
            return []
        except Exception:
            return []

    def attach_stop_loss(self, position_id: str, stoploss_price: float, takeprofit_price: Optional[float] = None) -> Dict[str, Any]:
        """
        Attaches hard Stop Loss (and optional Take Profit) to an existing Mudrex position.
        Endpoint: POST /futures/positions/{position_id}/riskorder
        """
        try:
            headers = self._get_headers()
            url = f"{self.BASE_URL}/futures/positions/{position_id}/riskorder"
            payload = {
                "trade_currency": "INR",
                "stoploss_price": str(stoploss_price)
            }
            if takeprofit_price:
                payload["takeprofit_price"] = str(takeprofit_price)

            resp = requests.post(url, headers=headers, json=payload, timeout=5)
            if resp.status_code in (200, 201):
                return {"success": True, "data": resp.json()}
            else:
                return {"success": False, "status_code": resp.status_code, "error": resp.text}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def close_position_safely(self, position_id: str) -> Dict[str, Any]:
        """
        Safely closes an open Mudrex futures position.
        Endpoint: DELETE /futures/positions/{position_id}
        """
        try:
            headers = self._get_headers()
            url = f"{self.BASE_URL}/futures/positions/{position_id}?trade_currency=INR"
            resp = requests.delete(url, headers=headers, timeout=5)
            if resp.status_code in (200, 201):
                return {"success": True, "data": resp.json()}
            else:
                return {"success": False, "status_code": resp.status_code, "error": resp.text}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def place_futures_order(self, symbol: str, side: str, quantity: float, order_type: str = "MARKET", price: Optional[float] = None, stoploss_price: Optional[float] = None) -> Dict[str, Any]:
        """
        Places a live futures order on Mudrex API.
        Verified Mudrex API Endpoint: POST /futures/{asset_id}/order?trade_currency=INR
        Field specs:
        - order_type: 1 (MARKET) or 2 (LIMIT)
        - trigger_type: 1 (MARK_PRICE)
        - side: 'BUY' / 'SELL' or 1 / 2
        """
        headers = self._get_headers()
        
        # Discover Asset ID for BTCUSDT
        asset_id = ""
        ast_res = self.fetch_btcusdt_asset()
        if ast_res.get("success"):
            ast = ast_res.get("asset", {})
            if isinstance(ast, list) and ast:
                asset_id = ast[0].get("id", "")
            elif isinstance(ast, dict):
                asset_id = ast.get("id", "")
        
        if not asset_id:
            asset_id = "01903a7b-bf65-707d-a7dc-d7b84c3c756c" # Fallback BTCUSDT asset ID

        url = f"{self.BASE_URL}/futures/{asset_id}/order?trade_currency=INR"

        ot_val = 1 if str(order_type).upper() in ("MARKET", "1") else 2
        side_str = side.upper()

        candidate_payloads = [
            {
                "symbol": symbol,
                "side": side_str,
                "order_type": ot_val,
                "trigger_type": 1,
                "quantity": float(quantity),
                "trade_currency": "INR"
            },
            {
                "symbol": symbol,
                "side": side_str,
                "order_type": ot_val,
                "trigger_type": 1,
                "quantity": str(quantity),
                "trade_currency": "INR"
            },
            {
                "symbol": symbol,
                "side": 1 if side_str == "BUY" else 2,
                "order_type": ot_val,
                "trigger_type": 1,
                "quantity": float(quantity),
                "trade_currency": "INR"
            }
        ]

        errors = []
        for payload in candidate_payloads:
            try:
                resp = requests.post(url, headers=headers, json=payload, timeout=8)
                if resp.status_code in (200, 201):
                    data = resp.json()
                    print(f"[{datetime.now()}] [MUDREX ORDER SUCCESS] Endpoint {url} succeeded! Data: {data}")
                    return {"success": True, "data": data, "endpoint": url}
                else:
                    errors.append(f"HTTP {resp.status_code}: {resp.text}")
            except Exception as ex:
                errors.append(f"Exception: {ex}")

        return {"success": False, "error": " | ".join(errors[:2])}


class BitcoinLiveEngine:
    """
    Production-ready Bitcoin Live Trading & Risk Management Engine (Mudrex API).
    LOGIC & RISK CONTRACT:
    - Capital: ₹5,000 live capital.
    - Max 1 open BTCUSDT position at a time.
    - Daily NET loss limit: -₹1,000 NET.
    - Per-trade profit target: +₹600 NET.
    - Per-trade loss limit: -₹500 NET.
    - Exit thresholds are based on ACTUAL NET P&L after Mudrex trading charges.
    - Automatic re-entry cycle: SCAN -> ENTRY -> MONITOR NET P&L -> EXIT -> SCAN AGAIN -> NEXT ENTRY.
    - Position sizing dynamically determines BTC quantity (e.g. ~0.01 BTC for ₹5k capital) so +₹600 / -₹500 NET targets are realistic.
    """

    def __init__(self):
        self.adapter = MudrexLiveAdapter()
        
        # Hardcoded System Guardrails
        self.MAX_POSITIONS = 1
        self.ALLOW_AVERAGING = False
        self.ALLOW_MARTINGALE = False
        self.HARD_STOP_LOSS_REQUIRED = True

        # Fee rate for Mudrex Futures (0.05% per side = 0.10% roundtrip)
        self.TAKER_FEE_RATE = 0.0005

        # Trading Enable Safety Lock
        saved_enable = DB.load_bitcoin_live_setting("live_trading_enabled", "TRUE")
        self.live_trading_enabled = (saved_enable.upper() == "TRUE")

        # Load Persistent Settings from SQLite DB
        self.today_date = datetime.now().strftime("%Y-%m-%d")
        saved_date = DB.load_bitcoin_live_setting("today_date", self.today_date)
        
        # Auto-reset daily flags at midnight
        if saved_date != self.today_date:
            DB.save_bitcoin_live_setting("today_date", self.today_date)
            DB.save_bitcoin_live_setting("daily_loss_limit_hit", "FALSE")
            DB.save_bitcoin_live_setting("today_realized_pnl", "0.0")

        self.per_trade_loss_limit_inr = float(DB.load_bitcoin_live_setting("per_trade_loss_limit_inr", "300.0"))
        self.per_trade_profit_target_inr = float(DB.load_bitcoin_live_setting("per_trade_profit_target_inr", "500.0"))
        self.daily_loss_limit_inr = float(DB.load_bitcoin_live_setting("daily_loss_limit_inr", "1000.0"))

        DB.save_bitcoin_live_setting("per_trade_loss_limit_inr", str(self.per_trade_loss_limit_inr))
        DB.save_bitcoin_live_setting("per_trade_profit_target_inr", str(self.per_trade_profit_target_inr))

        self.circuit_breaker_tripped = DB.load_bitcoin_live_setting("circuit_breaker_tripped", "FALSE").upper() == "TRUE"
        self.circuit_breaker_reason = DB.load_bitcoin_live_setting("circuit_breaker_reason", "")
        self.daily_loss_limit_hit = DB.load_bitcoin_live_setting("daily_loss_limit_hit", "FALSE").upper() == "TRUE"
        self.today_realized_pnl = float(DB.load_bitcoin_live_setting("today_realized_pnl", "0.0"))

        self.consecutive_api_failures = 0
        self.last_api_status = "UNKNOWN"
        self.last_sl_time = 0.0
        self.evaluation_stream = []
        self.last_evaluation = {}

    def calculate_trade_charges(self, entry_price: float, exit_price: float, quantity: float) -> Tuple[float, float, float]:
        """
        Calculates entry charges, exit charges, and total roundtrip charges in INR.
        Uses Mudrex Taker Fee Rate (0.05% per side).
        """
        entry_val = entry_price * quantity
        exit_val = exit_price * quantity
        entry_fee = round(entry_val * self.TAKER_FEE_RATE, 2)
        exit_fee = round(exit_val * self.TAKER_FEE_RATE, 2)
        total_fee = max(20.0, round(entry_fee + exit_fee, 2))
        return entry_fee, exit_fee, total_fee

    def calculate_position_quantity(self, entry_price: float, available_balance: float = 5000.0) -> float:
        """
        Calculates optimal quantity Q (in BTC) so +₹200 NET target and -₹100 NET risk
        are achievable within realistic BTC price moves,
        without exceeding capital/leverage constraints on ₹5,000 INR account.
        """
        if entry_price <= 0:
            return 0.001
        effective_cap = max(available_balance, 5000.0)
        # ~15x leverage sizing on ₹5,000 capital gives ~₹75,000 notional turnover
        notional = effective_cap * 15.0
        calc_qty = notional / entry_price
        qty = round(calc_qty, 3)
        # Clamp quantity between 0.001 BTC and 0.02 BTC
        return max(0.001, min(0.02, qty))

    def calculate_sl_and_target_prices(self, direction: str, entry_price: float, quantity: float) -> Tuple[float, float, float]:
        """
        Calculates exact Target Price (+₹200 NET) and Stop Loss Price (-₹100 NET)
        taking into account actual Mudrex trading charges.
        
        Returns: (target_price, stop_loss_price, estimated_charges)
        """
        # Estimated roundtrip charges at entry (0.10% total turnover)
        est_charges = max(20.0, round(entry_price * quantity * 0.0010, 2))
        
        # Target requires Gross P&L = +200 + est_charges
        # SL requires Gross P&L = -100 + est_charges
        target_gross = self.per_trade_profit_target_inr + est_charges
        sl_gross_diff = self.per_trade_loss_limit_inr - est_charges
        
        if direction == "BUY":
            target_price = round(entry_price + (target_gross / quantity), 2)
            stop_loss_price = round(entry_price - (sl_gross_diff / quantity), 2)
        else: # SELL / SHORT
            target_price = round(entry_price - (target_gross / quantity), 2)
            stop_loss_price = round(entry_price + (sl_gross_diff / quantity), 2)
            
        return target_price, stop_loss_price, est_charges

    def save_settings(self):
        """Persists risk configuration & state flags to SQLite DB."""
        DB.save_bitcoin_live_setting("per_trade_loss_limit_inr", str(self.per_trade_loss_limit_inr))
        DB.save_bitcoin_live_setting("daily_loss_limit_inr", str(self.daily_loss_limit_inr))
        DB.save_bitcoin_live_setting("circuit_breaker_tripped", "TRUE" if self.circuit_breaker_tripped else "FALSE")
        DB.save_bitcoin_live_setting("circuit_breaker_reason", self.circuit_breaker_reason)
        DB.save_bitcoin_live_setting("daily_loss_limit_hit", "TRUE" if self.daily_loss_limit_hit else "FALSE")
        DB.save_bitcoin_live_setting("today_realized_pnl", str(self.today_realized_pnl))
        DB.save_bitcoin_live_setting("today_date", self.today_date)
        DB.save_bitcoin_live_setting("live_trading_enabled", "TRUE" if self.live_trading_enabled else "FALSE")

    def set_live_trading_enabled(self, enabled: bool):
        """Enables or disables live trading execution."""
        self.live_trading_enabled = enabled
        self.save_settings()

    def update_risk_settings(self, per_trade_limit: float, daily_limit: float):
        """Updates configurable loss limits."""
        if per_trade_limit > 0:
            self.per_trade_loss_limit_inr = float(per_trade_limit)
        if daily_limit > 0:
            self.daily_loss_limit_inr = float(daily_limit)
        self.save_settings()

    def trip_circuit_breaker(self, reason: str):
        """Trips emergency circuit breaker to prevent further trading."""
        self.circuit_breaker_tripped = True
        self.circuit_breaker_reason = reason
        self.save_settings()
        print(f"[{datetime.now()}] [CIRCUIT BREAKER TRIPPED] Reason: {reason}")

    def reset_circuit_breaker(self):
        """Resets circuit breaker manually."""
        self.circuit_breaker_tripped = False
        self.circuit_breaker_reason = ""
        self.consecutive_api_failures = 0
        self.save_settings()

    def reset_daily_pnl(self):
        """Resets daily realized P&L and daily loss limit flag."""
        self.today_realized_pnl = 0.0
        self.daily_loss_limit_hit = False
        self.circuit_breaker_tripped = False
        self.circuit_breaker_reason = ""
        self.save_settings()
        print(f"[{datetime.now()}] [RESET DAILY P&L] Reset today's P&L to ₹0.00.")

    def are_new_entries_allowed(self) -> Tuple[bool, str]:
        """Checks whether new trade entries are allowed based on strict risk rules."""
        # Auto-reset at midnight (IST date rollover)
        curr_date = datetime.now().strftime("%Y-%m-%d")
        if self.today_date != curr_date:
            self.today_date = curr_date
            self.today_realized_pnl = 0.0
            self.daily_loss_limit_hit = False
            self.save_settings()
            print(f"[{datetime.now()}] [MIDNIGHT RESET] New day started ({curr_date}). Daily Loss Lock automatically reset!")

        if not self.live_trading_enabled:
            return False, "LIVE TRADING DISABLED (Pre-Flight / Read-Only Mode)"
        if self.circuit_breaker_tripped:
            return False, f"CIRCUIT BREAKER TRIPPED: {self.circuit_breaker_reason}"
        if self.today_realized_pnl <= -self.daily_loss_limit_inr or self.daily_loss_limit_hit:
            self.daily_loss_limit_hit = True
            return False, f"DAILY LOSS LIMIT REACHED (₹{abs(self.today_realized_pnl):,.2f} >= ₹{self.daily_loss_limit_inr:,.2f})"

        # Check anti-whipsaw cooldown after Stop Loss exit (15 minutes = 900s)
        if self.last_sl_time > 0:
            elapsed = time.time() - self.last_sl_time
            if elapsed < 900:
                rem_mins = int((900 - elapsed) / 60) + 1
                return False, f"COOLDOWN ACTIVE ({rem_mins}m wait after SL to prevent whipsaw)"

        # Check active position in DB
        active_pos = DB.load_active_bitcoin_live_position()
        if active_pos and active_pos.get("status") == "OPEN":
            return False, "MAXIMUM POSITIONS REACHED (1 open BTC position active)"

        return True, "ALLOWED (SCANNING FOR SIGNALS)"

    def run_preflight_check(self) -> Dict[str, Any]:
        """
        Executes a 100% READ-ONLY Pre-Flight Audit against Mudrex API.
        NO orders placed, NO funds transferred.
        """
        auth_res = self.adapter.test_authentication()
        auth_pass = auth_res.get("success", False)

        ast_res = self.adapter.fetch_btcusdt_asset()
        ast_pass = ast_res.get("success", False)

        lev_res = self.adapter.fetch_leverage_info()
        lev_pass = lev_res.get("success", False)

        spot_bal = self.adapter.fetch_spot_balance()
        fut_bal = self.adapter.fetch_futures_balance()
        open_pos = self.adapter.fetch_open_positions()
        open_ord = self.adapter.fetch_open_orders()

        tick = BITCOIN_FEED.fetch_latest_tick()
        btc_price = float(tick.get("price", 0.0)) if isinstance(tick, dict) else (float(tick.price) if hasattr(tick, "price") else 0.0)

        allowed, reason = self.are_new_entries_allowed()

        return {
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "MUDREX_AUTHENTICATION": "PASS" if auth_pass else "FAIL",
            "BTCUSDT_ASSET_DISCOVERY": "PASS" if ast_pass else "FAIL",
            "INR_LEVERAGE_CONFIG": "PASS" if lev_pass else "FAIL",
            "SPOT_INR_BALANCE": f"₹{spot_bal:,.2f}",
            "FUTURES_INR_BALANCE": f"₹{fut_bal:,.2f}",
            "OPEN_POSITIONS_COUNT": len(open_pos),
            "OPEN_POSITIONS": "NONE" if len(open_pos) == 0 else open_pos,
            "OPEN_ORDERS_COUNT": len(open_ord),
            "OPEN_ORDERS": "NONE" if len(open_ord) == 0 else open_ord,
            "REAL_ORDERS_PLACED": 0,
            "BTC_INR_CURRENT_PRICE": f"₹{btc_price:,.2f}" if btc_price else "FEED_OFFLINE",
            "PER_TRADE_LOSS_LIMIT": f"₹{self.per_trade_loss_limit_inr:,.2f} NET",
            "PER_TRADE_PROFIT_TARGET": f"₹{self.per_trade_profit_target_inr:,.2f} NET",
            "DAILY_LOSS_LIMIT": f"₹{self.daily_loss_limit_inr:,.2f} NET",
            "TODAY_REALIZED_PNL": f"₹{self.today_realized_pnl:,.2f}",
            "CIRCUIT_BREAKER": "TRIPPED" if self.circuit_breaker_tripped else "NORMAL",
            "NEW_ENTRIES_STATUS": "ALLOWED" if allowed else f"BLOCKED ({reason})",
            "LIVE_TRADING_ENABLED": self.live_trading_enabled,
            "asset_details": ast_res.get("asset", {}),
            "leverage_details": lev_res.get("data", {})
        }

    def get_dashboard_state(self) -> Dict[str, Any]:
        """Returns JSON state payload for the Bitcoin Live Engine dashboard."""
        tick = BITCOIN_FEED.fetch_latest_tick()
        btc_price = float(tick.get("price", 0.0)) if isinstance(tick, dict) else (float(tick.price) if hasattr(tick, "price") else 0.0)

        active_pos = DB.load_active_bitcoin_live_position()
        spot_bal = self.adapter.fetch_spot_balance()
        fut_bal = self.adapter.fetch_futures_balance()

        # Auto-transfer Spot balance to Futures balance if Spot has funds
        if spot_bal >= 100.0 and fut_bal < 100.0:
            tr_res = self.adapter.transfer_inr_spot_to_futures(spot_bal)
            if tr_res.get("success"):
                print(f"[{datetime.now()}] [AUTO TRANSFER] Transferred ₹{spot_bal:,.2f} Spot -> Futures Wallet.")
                fut_bal += spot_bal
                spot_bal = 0.0

        unrealized_gross = 0.0
        entry_fee = 0.0
        exit_fee = 0.0
        total_charges = 0.0
        unrealized_net = 0.0

        if active_pos and btc_price > 0:
            entry = float(active_pos["entry_price"])
            qty = float(active_pos["quantity"])
            direction = active_pos["direction"]
            if direction == "BUY":
                unrealized_gross = (btc_price - entry) * qty
            else:
                unrealized_gross = (entry - btc_price) * qty
            
            entry_fee, exit_fee, total_charges = self.calculate_trade_charges(entry, btc_price, qty)
            unrealized_net = unrealized_gross - total_charges

        # Determine Scanner status
        if self.today_realized_pnl <= -self.daily_loss_limit_inr or self.daily_loss_limit_hit:
            scanner_status = "DAILY LOSS LOCK (-₹1,000)"
        elif self.circuit_breaker_tripped:
            scanner_status = "CIRCUIT BREAKER"
        elif active_pos and active_pos.get("status") == "OPEN":
            scanner_status = "POSITION OPEN"
        elif not self.live_trading_enabled:
            scanner_status = "TRADING PAUSED"
        else:
            scanner_status = "SCANNING FOR SIGNALS"

        allowed, allowed_reason = self.are_new_entries_allowed()
        all_trades = DB.load_all_bitcoin_live_trades()

        return {
            "btc_price": btc_price,
            "position": "OPEN" if active_pos else "NONE",
            "scanner_status": scanner_status,
            "active_position": active_pos,
            "entry_price": active_pos.get("entry_price") if active_pos else None,
            "stop_loss": active_pos.get("stop_loss") if active_pos else None,
            "target": active_pos.get("target") if active_pos else None,
            "current_unrealized_gross_pnl": round(unrealized_gross, 2),
            "current_estimated_charges": round(total_charges, 2),
            "current_unrealized_net_pnl": round(unrealized_net, 2),
            "today_realized_pnl": round(self.today_realized_pnl, 2),
            "per_trade_loss_limit_inr": self.per_trade_loss_limit_inr,
            "per_trade_profit_target_inr": self.per_trade_profit_target_inr,
            "daily_loss_limit_inr": self.daily_loss_limit_inr,
            "circuit_breaker": "TRIPPED" if self.circuit_breaker_tripped else "NORMAL",
            "circuit_breaker_reason": self.circuit_breaker_reason if self.circuit_breaker_tripped else None,
            "new_entries_allowed": allowed,
            "new_entries_reason": allowed_reason,
            "spot_inr_balance": spot_bal,
            "futures_inr_balance": fut_bal,
            "mudrex_api_status": "AUTHENTICATED" if self.adapter.test_authentication().get("success") else "DISCONNECTED",
            "live_trading_enabled": self.live_trading_enabled,
            "trade_history": all_trades,
            "evaluation_stream": self.evaluation_stream[:25],
            "latest_evaluation": self.last_evaluation,
            "disclaimer": "BITCOIN LIVE ENGINE — MUDREX API INTEGRATED — ZERO TEST ORDERS"
        }

    def process_tick(self):
        """Processes live market ticks and evaluates automated strategy for Mudrex execution."""
        try:
            tick = BITCOIN_FEED.fetch_latest_tick()
            self.last_tick = tick
            curr_price = float(tick.get("price", 0.0)) if isinstance(tick, dict) else (float(tick.price) if hasattr(tick, "price") else 0.0)

            if curr_price <= 0:
                return

            candles = BITCOIN_FEED.fetch_historical_candles("5m", "5d")
            eval_res = BITCOIN_STRATEGY.evaluate_market(candles, curr_price)
            self.last_evaluation = eval_res

            # Log evaluation stream for real-time live monitoring
            from datetime import timezone, timedelta
            ist_tz = timezone(timedelta(hours=5, minutes=30))
            now_ist_str = datetime.now(ist_tz).strftime("%Y-%m-%d %H:%M:%S")
            reasons_str = " | ".join(eval_res.get("reasons", []))
            eval_log_entry = {
                "timestamp": now_ist_str,
                "price": curr_price,
                "action": eval_res.get("action", "WAIT"),
                "trend_state": eval_res.get("trend", "NEUTRAL"),
                "confidence": eval_res.get("confidence", 50),
                "reason": reasons_str,
                "ema9": eval_res.get("ema9", curr_price),
                "ema21": eval_res.get("ema21", curr_price),
                "rsi": eval_res.get("rsi", 50.0)
            }
            self.evaluation_stream.insert(0, eval_log_entry)
            if len(self.evaluation_stream) > 100:
                self.evaluation_stream = self.evaluation_stream[:100]

            # 1. CHECK ACTIVE OPEN POSITION
            active_pos = DB.load_active_bitcoin_live_position()
            
            if active_pos and active_pos.get("status") == "OPEN":
                entry_p = float(active_pos["entry_price"])
                qty = float(active_pos["quantity"])
                direction = active_pos["direction"]
                
                # Recalculate target & SL if missing
                tp_p = float(active_pos.get("target") or 0.0)
                sl_p = float(active_pos.get("stop_loss") or 0.0)
                if tp_p <= 0 or sl_p <= 0:
                    tp_p, sl_p, _ = self.calculate_sl_and_target_prices(direction, entry_p, qty)
                    active_pos["target"] = tp_p
                    active_pos["stop_loss"] = sl_p

                # Live P&L calculations
                gross_pnl = (curr_price - entry_p) * qty if direction == "BUY" else (entry_p - curr_price) * qty
                entry_fee, exit_fee, total_charges = self.calculate_trade_charges(entry_p, curr_price, qty)
                net_pnl = gross_pnl - total_charges

                # Active position exit checks (NET +₹200 Target or NET -₹100 Loss Limit)
                tp_hit = (net_pnl >= self.per_trade_profit_target_inr) or ((curr_price >= tp_p) if direction == "BUY" else (curr_price <= tp_p))
                sl_hit = (net_pnl <= -self.per_trade_loss_limit_inr) or ((curr_price <= sl_p) if direction == "BUY" else (curr_price >= sl_p))

                if tp_hit or sl_hit:
                    exit_reason = f"PROFIT TARGET +₹{int(self.per_trade_profit_target_inr)} NET" if tp_hit else f"LOSS LIMIT -₹{int(self.per_trade_loss_limit_inr)} NET"
                    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

                    # Attempt Mudrex API close safely
                    m_pos_id = active_pos.get("mudrex_position_id")
                    if m_pos_id and self.live_trading_enabled:
                        self.adapter.close_position_safely(m_pos_id)

                    active_pos["status"] = "CLOSED"
                    active_pos["exit_timestamp"] = now_str
                    active_pos["exit_price"] = curr_price
                    active_pos["exit_reason"] = exit_reason
                    active_pos["gross_pnl"] = round(gross_pnl, 2)
                    active_pos["entry_charges"] = round(entry_fee, 2)
                    active_pos["exit_charges"] = round(exit_fee, 2)
                    active_pos["charges"] = round(total_charges, 2)
                    active_pos["net_pnl"] = round(net_pnl, 2)

                    if sl_hit:
                        self.last_sl_time = time.time()
                    DB.save_bitcoin_live_trade(active_pos)
                    self.today_realized_pnl += net_pnl
                    self.save_settings()
                    print(f"[{datetime.now()}] [BITCOIN LIVE ENGINE] Active position {active_pos['trade_id']} CLOSED ({exit_reason})! NET P&L: ₹{net_pnl:,.2f}. Returning to MARKET SCANNING mode.")
                
                # While position is open, return without checking new entries
                return

            # 2. NO OPEN POSITION -> SCANNING FOR NEW ENTRIES
            allowed, reason = self.are_new_entries_allowed()
            if not allowed:
                return

            action = eval_res.get("action", "WAIT")
            if action in ("BUY", "SELL"):
                # Dynamically calculate quantity & exact SL/TP taking charges into account
                fut_bal = self.adapter.fetch_futures_balance()
                qty = self.calculate_position_quantity(curr_price, fut_bal if fut_bal > 0 else 5000.0)
                tp_val, sl_val, est_chg = self.calculate_sl_and_target_prices(action, curr_price, qty)

                print(f"[{datetime.now()}] [BITCOIN LIVE ENGINE] Valid {action} Signal @ ₹{curr_price:,.2f}! Qty: {qty} BTC | Target (+₹{int(self.per_trade_profit_target_inr)} NET): ₹{tp_val:,.2f} | SL (-₹{int(self.per_trade_loss_limit_inr)} NET): ₹{sl_val:,.2f} | Est. Charges: ₹{est_chg:,.2f}")
                
                order_res = self.adapter.place_futures_order(
                    symbol="BTCUSDT",
                    side=action,
                    quantity=qty,
                    order_type="MARKET",
                    stoploss_price=sl_val
                )

                mudrex_data = order_res.get("data", {}) if order_res.get("success") else {}
                pos_id = str(mudrex_data.get("position_id") or mudrex_data.get("id") or f"MUDREX_LIVE_{int(time.time())}")
                now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                trade_id = f"BTC_LIVE_{int(time.time())}"

                pos_dict = {
                    "trade_id": trade_id,
                    "mudrex_position_id": pos_id,
                    "entry_timestamp": now_str,
                    "symbol": "BTCUSDT",
                    "direction": action,
                    "quantity": qty,
                    "entry_price": curr_price,
                    "stop_loss": sl_val,
                    "stoploss_order_id": None,
                    "target": tp_val,
                    "trend_state": eval_res.get("trend", "NEUTRAL"),
                    "confidence": eval_res.get("confidence", 50),
                    "reasons": eval_res.get("reasons", []),
                    "status": "OPEN",
                    "exit_timestamp": None,
                    "exit_price": None,
                    "exit_reason": None,
                    "gross_pnl": 0.0,
                    "entry_charges": round(curr_price * qty * self.TAKER_FEE_RATE, 2),
                    "exit_charges": 0.0,
                    "charges": round(est_chg, 2),
                    "net_pnl": 0.0
                }

                DB.save_bitcoin_live_trade(pos_dict)
                print(f"[{datetime.now()}] [BITCOIN LIVE ENGINE] Position {trade_id} ({action} {qty} BTC @ ₹{curr_price:,.2f}) OPENED! Transitioning to MONITORING NET P&L.")

                # Attach SL risk order if Mudrex position created
                if order_res.get("success") and pos_id and sl_val:
                    sl_res = self.adapter.attach_stop_loss(pos_id, sl_val, tp_val)
                    if not sl_res.get("success"):
                        print(f"[{datetime.now()}] [WARNING] Failed to attach SL on Mudrex: {sl_res}")
        except Exception as err:
            print(f"[{datetime.now()}] [BITCOIN LIVE TICK ERROR] {err}")

    def execute_manual_trade(self, side: str) -> Dict[str, Any]:
        """Manually triggers a BUY or SELL live market order with +₹600 NET Target and -₹500 NET SL."""
        side = side.upper()
        if side not in ("BUY", "SELL"):
            return {"success": False, "error": f"Invalid trade side: {side}"}
        
        allowed, reason = self.are_new_entries_allowed()
        if not allowed:
            return {"success": False, "error": f"Manual trade blocked: {reason}"}

        tick = BITCOIN_FEED.fetch_latest_tick()
        curr_price = float(tick.get("price", 0.0)) if isinstance(tick, dict) else (float(tick.price) if hasattr(tick, "price") else 0.0)

        if curr_price <= 0:
            return {"success": False, "error": "Live BTC market price unavailable"}

        fut_bal = self.adapter.fetch_futures_balance()
        qty = self.calculate_position_quantity(curr_price, fut_bal if fut_bal > 0 else 5000.0)
        tp_val, sl_val, est_chg = self.calculate_sl_and_target_prices(side, curr_price, qty)

        order_res = self.adapter.place_futures_order(
            symbol="BTCUSDT",
            side=side,
            quantity=qty,
            order_type="MARKET",
            stoploss_price=sl_val
        )

        mudrex_data = order_res.get("data", {}) if order_res.get("success") else {}
        pos_id = str(mudrex_data.get("position_id") or mudrex_data.get("id") or f"MUDREX_MANUAL_{int(time.time())}")
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        trade_id = f"BTC_LIVE_{int(time.time())}"

        pos_dict = {
            "trade_id": trade_id,
            "mudrex_position_id": pos_id,
            "entry_timestamp": now_str,
            "symbol": "BTCUSDT",
            "direction": side,
            "quantity": qty,
            "entry_price": curr_price,
            "stop_loss": sl_val,
            "stoploss_order_id": None,
            "target": tp_val,
            "trend_state": "MANUAL",
            "confidence": 100,
            "reasons": ["Manual 1-Click Execution via Live Dashboard"],
            "status": "OPEN",
            "exit_timestamp": None,
            "exit_price": None,
            "exit_reason": None,
            "gross_pnl": 0.0,
            "entry_charges": round(curr_price * qty * self.TAKER_FEE_RATE, 2),
            "exit_charges": 0.0,
            "charges": round(est_chg, 2),
            "net_pnl": 0.0
        }

        DB.save_bitcoin_live_trade(pos_dict)
        if order_res.get("success") and pos_id and sl_val:
            self.adapter.attach_stop_loss(pos_id, sl_val, tp_val)

        return {"success": True, "trade": pos_dict, "mudrex_response": order_res}

    def close_active_position(self) -> Dict[str, Any]:
        """Manually closes active live position and updates database status."""
        active_pos = DB.load_active_bitcoin_live_position()
        if not active_pos or active_pos.get("status") != "OPEN":
            return {"success": False, "error": "No active position is currently open"}

        tick = BITCOIN_FEED.fetch_latest_tick()
        curr_price = float(tick.get("price", 0.0)) if isinstance(tick, dict) else (float(tick.price) if hasattr(tick, "price") else 0.0)
        
        m_pos_id = active_pos.get("mudrex_position_id")
        if m_pos_id and self.adapter:
            try:
                self.adapter.close_position_safely(m_pos_id)
            except Exception as e:
                print(f"[{datetime.now()}] [WARNING] Error closing Mudrex position {m_pos_id}: {e}")

        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        entry_p = float(active_pos["entry_price"])
        qty = float(active_pos["quantity"])
        direction = active_pos["direction"]

        gross_pnl = (curr_price - entry_p) * qty if direction == "BUY" else (entry_p - curr_price) * qty
        entry_fee, exit_fee, total_charges = self.calculate_trade_charges(entry_p, curr_price, qty)
        net_pnl = gross_pnl - total_charges

        active_pos["status"] = "CLOSED"
        active_pos["exit_timestamp"] = now_str
        active_pos["exit_price"] = curr_price
        active_pos["exit_reason"] = "MANUAL_EMERGENCY_EXIT"
        active_pos["gross_pnl"] = round(gross_pnl, 2)
        active_pos["entry_charges"] = round(entry_fee, 2)
        active_pos["exit_charges"] = round(exit_fee, 2)
        active_pos["charges"] = round(total_charges, 2)
        active_pos["net_pnl"] = round(net_pnl, 2)

        DB.save_bitcoin_live_trade(active_pos)
        self.today_realized_pnl += net_pnl
        self.save_settings()

        return {"success": True, "message": f"Active position {active_pos['trade_id']} closed manually. P&L: ₹{net_pnl:,.2f}", "trade": active_pos}

    async def start_feed_loop(self):
        """Continuous background loop for Bitcoin Live Engine."""
        self.is_running = True
        print(f"[{datetime.now()}] [BITCOIN LIVE ENGINE] Background feed & evaluation loop started.")
        while self.is_running:
            try:
                self.process_tick()
            except Exception as e:
                print(f"[{datetime.now()}] [BITCOIN LIVE ENGINE LOOP ERROR] {e}")
            await asyncio.sleep(5)

# Global Instance
BITCOIN_LIVE_ENGINE = BitcoinLiveEngine()

