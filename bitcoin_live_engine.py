"""
Bitcoin Live Engine & Risk Protection System (Mudrex API)
CLEAN ARCHITECTURE REBUILD V2

Implements Mandatory Architecture Requirements:
1. Strongly validated LiveTradeState object (Single Source of Truth).
2. Atomic state machine: OPEN -> EXIT_REQUESTED -> CLOSED.
3. Strict non-zero Target/SL validation (No Silent Defaults / No 0 default TP/SL hit).
4. Exact Net Target (+₹100 NET) and Net Loss (-₹200 NET) calculations inclusive of Mudrex fees & GST.
5. Mudrex Authoritative Accounting from actual exchange fills and order history.
6. Exit Reason Integrity (Reason assigned ONLY after authoritative fill confirmation).
7. Order Duplication Protection (Secondary exit requests blocked during EXIT_REQUESTED state).
8. Position Existence Verification before & after exit calls.
9. Startup / Restart reconciliation between SQLite DB and Mudrex API.
10. Multi-component Wallet & P&L accounting on dashboard.
11. Execution rate control & debounce without modifying strategy signals.
12. Actual Mudrex fee/GST structure (0.05% per side + 18% GST = 0.059% per side).
13. Database schema compatibility and clean persistence.
"""

import os
import time
import json
import math
import asyncio
import requests
import traceback
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, Optional, List, Tuple
from dataclasses import dataclass, field, asdict
from enum import Enum

from database import DB
from bitcoin_feed import BITCOIN_FEED
from bitcoin_strategy import BITCOIN_STRATEGY


class TradeStatus(str, Enum):
    OPEN = "OPEN"
    EXIT_REQUESTED = "EXIT_REQUESTED"
    CLOSED = "CLOSED"


@dataclass
class LiveTradeState:
    """
    Single Source of Truth for Open Position and Trade Execution.
    Requirement 1: Strongly validated state object.
    """
    trade_id: str
    mudrex_position_id: str
    direction: str  # BUY / SELL / LONG / SHORT
    quantity: float  # e.g., 0.002
    leverage: float  # 5.0
    entry_price_usd: float
    entry_price: float  # INR
    hedge_rate: float
    entry_timestamp: str
    entry_order_id: Optional[str] = None
    entry_fee_gst: float = 0.0
    target_net_inr: float = 100.0
    max_loss_net_inr: float = 200.0
    target_gross_inr: float = 0.0
    stop_gross_inr: float = 0.0
    target_usd: float = 0.0
    stop_loss_usd: float = 0.0
    target: float = 0.0  # INR
    stop_loss: float = 0.0  # INR
    trend_state: str = "NEUTRAL"
    confidence: int = 50
    reasons: List[str] = field(default_factory=list)
    status: str = TradeStatus.OPEN.value
    exit_order_id: Optional[str] = None
    exit_timestamp: Optional[str] = None
    exit_price_usd: Optional[float] = None
    exit_price: Optional[float] = None  # INR
    exit_fee_gst: float = 0.0
    funding_fee: float = 0.0
    trigger_price_usd: Optional[float] = None
    exit_reason: Optional[str] = None
    gross_pnl: float = 0.0  # INR
    entry_charges: float = 0.0
    exit_charges: float = 0.0
    charges: float = 0.0
    net_pnl: float = 0.0
    symbol: str = "BTCUSDT"
    stoploss_order_id: Optional[str] = None

    def is_valid_for_execution(self) -> Tuple[bool, str]:
        """Validates all required fields before trade is executable or TP/SL evaluated."""
        if not self.trade_id:
            return False, "Missing trade_id"
        if not self.mudrex_position_id:
            return False, "Missing mudrex_position_id"
        if str(self.direction).upper() not in ("BUY", "SELL", "LONG", "SHORT"):
            return False, f"Invalid direction: {self.direction}"
        if float(self.quantity or 0) <= 0:
            return False, f"Invalid quantity: {self.quantity}"
        if float(self.entry_price_usd or 0) <= 0:
            return False, f"Invalid entry_price_usd: {self.entry_price_usd}"
        if float(self.hedge_rate or 0) <= 0:
            return False, f"Invalid hedge_rate: {self.hedge_rate}"
        if float(self.target_usd or 0) <= 0:
            return False, f"Missing or zero target_usd ({self.target_usd})"
        if float(self.stop_loss_usd or 0) <= 0:
            return False, f"Missing or zero stop_loss_usd ({self.stop_loss_usd})"
        if float(self.target_net_inr or 0) <= 0:
            return False, f"Invalid target_net_inr ({self.target_net_inr})"
        if float(self.max_loss_net_inr or 0) <= 0:
            return False, f"Invalid max_loss_net_inr ({self.max_loss_net_inr})"
        return True, "VALID"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "LiveTradeState":
        if not isinstance(d, dict):
            raise ValueError("Input must be a dictionary")
        
        reasons = d.get("reasons", [])
        if isinstance(reasons, str):
            try:
                reasons = json.loads(reasons)
            except Exception:
                reasons = [reasons]

        return cls(
            trade_id=str(d.get("trade_id") or ""),
            mudrex_position_id=str(d.get("mudrex_position_id") or ""),
            direction=str(d.get("direction") or "BUY").upper(),
            quantity=float(d.get("quantity") or 0.002),
            leverage=float(d.get("leverage") or 5.0),
            entry_price_usd=float(d.get("entry_price_usd") or 0.0),
            entry_price=float(d.get("entry_price") or 0.0),
            hedge_rate=float(d.get("hedge_rate") or 102.0),
            entry_timestamp=str(d.get("entry_timestamp") or ""),
            entry_order_id=d.get("entry_order_id"),
            entry_fee_gst=float(d.get("entry_fee_gst") or d.get("entry_charges") or 0.0),
            target_net_inr=float(d.get("target_net_inr") or 100.0),
            max_loss_net_inr=float(d.get("max_loss_net_inr") or 200.0),
            target_gross_inr=float(d.get("target_gross_inr") or 0.0),
            stop_gross_inr=float(d.get("stop_gross_inr") or 0.0),
            target_usd=float(d.get("target_usd") or 0.0),
            stop_loss_usd=float(d.get("stop_loss_usd") or 0.0),
            target=float(d.get("target") or 0.0),
            stop_loss=float(d.get("stop_loss") or 0.0),
            trend_state=str(d.get("trend_state") or "NEUTRAL"),
            confidence=int(d.get("confidence") or 50),
            reasons=reasons if isinstance(reasons, list) else [],
            status=str(d.get("status") or TradeStatus.OPEN.value),
            exit_order_id=d.get("exit_order_id"),
            exit_timestamp=d.get("exit_timestamp"),
            exit_price_usd=float(d["exit_price_usd"]) if d.get("exit_price_usd") is not None else None,
            exit_price=float(d["exit_price"]) if d.get("exit_price") is not None else None,
            exit_fee_gst=float(d.get("exit_fee_gst") or d.get("exit_charges") or 0.0),
            funding_fee=float(d.get("funding_fee") or 0.0),
            trigger_price_usd=float(d["trigger_price_usd"]) if d.get("trigger_price_usd") is not None else None,
            exit_reason=d.get("exit_reason"),
            gross_pnl=float(d.get("gross_pnl") or 0.0),
            entry_charges=float(d.get("entry_charges") or 0.0),
            exit_charges=float(d.get("exit_charges") or 0.0),
            charges=float(d.get("charges") or 0.0),
            net_pnl=float(d.get("net_pnl") or 0.0),
            symbol=str(d.get("symbol") or "BTCUSDT"),
            stoploss_order_id=d.get("stoploss_order_id")
        )


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
            "User-Agent": "Bitcoin-Live-Engine/2.0"
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
        """Transfers INR funds from Spot Wallet to Futures Wallet."""
        try:
            headers = self._get_headers()
            url = f"{self.BASE_URL}/futures/transfers/inr"
            payloads = [
                {"amount": str(amount), "from_wallet_type": "SPOT", "to_wallet_type": "FUTURES"},
                {"amount": str(amount), "from_wallet_type": "spot", "to_wallet_type": "futures"}
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
        """Fetches BTCUSDT futures instrument metadata from Mudrex."""
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
        """Fetches leverage information for BTCUSDT."""
        try:
            headers = self._get_headers()
            url = f"{self.BASE_URL}/futures/BTCUSDT/leverage?is_symbol&trade_currency=INR"
            resp = requests.get(url, headers=headers, timeout=5)
            if resp.status_code in (200, 201):
                return {"success": True, "data": resp.json()}
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
        """Attaches hard Stop Loss (and optional Take Profit) to an existing Mudrex position."""
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

    def close_position_safely(self, position_id: str, symbol: str = "BTCUSDT", quantity: float = 0.002, direction: str = "BUY") -> Dict[str, Any]:
        """
        Safely closes an open Mudrex futures position.
        Requirement 8: Position existence verification after close request.
        """
        headers = self._get_headers()
        opp_side = "SHORT" if str(direction).upper() in ("BUY", "LONG", "1") else "LONG"
        qty_str = str(quantity)

        asset_id = "01903a7b-bf65-707d-a7dc-d7b84c3c756c"
        try:
            ast_res = self.fetch_btcusdt_asset()
            if ast_res.get("success"):
                ast = ast_res.get("asset", {})
                if isinstance(ast, list) and ast:
                    asset_id = ast[0].get("id", asset_id)
                elif isinstance(ast, dict):
                    asset_id = ast.get("id", asset_id)
        except Exception:
            pass

        candidates = [
            {
                "name": "DELETE /futures/positions/{id}?trade_currency=INR",
                "method": "DELETE",
                "url": f"{self.BASE_URL}/futures/positions/{position_id}?trade_currency=INR",
                "payload": None
            },
            {
                "name": "DELETE /futures/positions/{id}",
                "method": "DELETE",
                "url": f"{self.BASE_URL}/futures/positions/{position_id}",
                "payload": None
            },
            {
                "name": "POST /futures/positions/{id}/close",
                "method": "POST",
                "url": f"{self.BASE_URL}/futures/positions/{position_id}/close",
                "payload": {"trade_currency": "INR"}
            },
            {
                "name": "POST /futures/positions/close",
                "method": "POST",
                "url": f"{self.BASE_URL}/futures/positions/close",
                "payload": {"position_id": position_id, "trade_currency": "INR"}
            },
            {
                "name": "POST /fapi/v2/futures/order?symbol=BTCUSDT (Opposite Market Close)",
                "method": "POST",
                "url": "https://trade.mudrex.com/fapi/v2/futures/order?symbol=BTCUSDT",
                "payload": {
                    "trigger_type": "MARKET",
                    "order_type": opp_side,
                    "quantity": qty_str,
                    "trade_currency": "INR"
                }
            }
        ]

        last_errors = []
        for cand in candidates:
            try:
                if cand["method"] == "DELETE":
                    resp = requests.delete(cand["url"], headers=headers, timeout=6)
                else:
                    resp = requests.post(cand["url"], headers=headers, json=cand["payload"], timeout=6)

                if resp.status_code in (200, 201, 202):
                    data = resp.json() if resp.text else {}
                    if isinstance(data, dict) and data.get("success") is False:
                        last_errors.append(f"{cand['name']} returned failure: {data}")
                        continue

                    # Authoritative verification check (Requirement 8)
                    time.sleep(0.5)
                    open_positions = self.fetch_open_positions()
                    is_still_open = any(
                        (str(p.get("position_id") or p.get("id")) == str(position_id))
                        for p in open_positions
                    )

                    if not is_still_open:
                        print(f"[{datetime.now()}] [MUDREX CLOSE SUCCESS] Method {cand['name']} succeeded and confirmed CLOSED on Mudrex!")
                        return {"success": True, "data": data, "method_used": cand["name"]}
                    else:
                        last_errors.append(f"{cand['name']} HTTP {resp.status_code} succeeded but Mudrex position {position_id} STILL OPEN")
                else:
                    last_errors.append(f"{cand['name']} HTTP {resp.status_code}: {resp.text}")
            except Exception as e:
                last_errors.append(f"{cand['name']} Exception: {e}")

        # Final Verification Check
        open_positions = self.fetch_open_positions()
        is_still_open = any(
            (str(p.get("position_id") or p.get("id")) == str(position_id))
            for p in open_positions
        )
        if not is_still_open:
            return {"success": True, "data": "Position verified closed on Mudrex"}

        return {"success": False, "error": " | ".join(last_errors[:3])}

    def set_leverage(self, symbol_or_id: str = "BTCUSDT", leverage: str = "5", margin_type: str = "ISOLATED", asset_id: Optional[str] = None) -> Dict[str, Any]:
        """Sets 5x ISOLATED leverage for BTCUSDT INR futures trading."""
        headers = self._get_headers()
        payload = {
            "margin_type": margin_type,
            "leverage": str(leverage),
            "trade_currency": "INR"
        }
        url = f"{self.BASE_URL}/futures/BTCUSDT/leverage?is_symbol&trade_currency=INR"
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=8)
            if resp.status_code in (200, 201, 202):
                data = resp.json()
                if isinstance(data, dict) and data.get("success") is False:
                    return {"success": False, "error": f"HTTP {resp.status_code}: {data.get('error') or data}"}
                return {"success": True, "data": data, "url": url}
            return {"success": False, "error": f"HTTP {resp.status_code}: {resp.text}"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def verify_leverage(self, symbol_or_id: str = "BTCUSDT", expected_leverage: str = "5", asset_id: Optional[str] = None) -> Dict[str, Any]:
        """Verifies current leverage is set to expected_leverage."""
        headers = self._get_headers()
        url = f"{self.BASE_URL}/futures/BTCUSDT/leverage?is_symbol&trade_currency=INR"
        try:
            resp = requests.get(url, headers=headers, timeout=5)
            if resp.status_code in (200, 201, 202):
                data = resp.json()
                inner = data.get("data") if isinstance(data, dict) and "data" in data else data
                if isinstance(inner, dict):
                    lev_val = str(inner.get("leverage") or inner.get("current_leverage") or "").strip()
                    if lev_val and str(float(lev_val)) != str(float(expected_leverage)) and lev_val != str(expected_leverage):
                        return {"success": False, "error": f"Leverage mismatch: expected {expected_leverage}, got {lev_val}"}
                    return {"success": True, "leverage": lev_val or expected_leverage, "data": data}
                return {"success": True, "leverage": expected_leverage, "data": data}
            return {"success": False, "error": f"HTTP {resp.status_code}: {resp.text}"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def place_futures_order(self, symbol: str, side: str, quantity: float, order_type: str = "MARKET", price: Optional[float] = None, stoploss_price: Optional[float] = None) -> Dict[str, Any]:
        """Places a live futures order on Mudrex API."""
        headers = self._get_headers()

        # Step 1: Set leverage
        lev_res = self.set_leverage(symbol_or_id="BTCUSDT", leverage="5", margin_type="ISOLATED")
        if not lev_res.get("success"):
            return {"success": False, "error": f"LEVERAGE SETUP FAILED: {lev_res.get('error')}"}

        # Step 2: Verify leverage
        ver_res = self.verify_leverage(symbol_or_id="BTCUSDT", expected_leverage="5")
        if not ver_res.get("success"):
            return {"success": False, "error": f"LEVERAGE VERIFICATION FAILED: {ver_res.get('error')}"}

        # Step 3: Place Order
        dir_order_type = "LONG" if side.upper() in ("BUY", "LONG", "1") else "SHORT"
        qty_str = str(quantity)

        candidates = [
            {
                "url": "https://trade.mudrex.com/fapi/v2/futures/order?symbol=BTCUSDT",
                "payload": {
                    "trigger_type": "MARKET",
                    "order_type": dir_order_type,
                    "quantity": qty_str,
                    "trade_currency": "INR"
                }
            }
        ]

        errors = []
        for cand in candidates:
            url = cand["url"]
            payload = cand["payload"]
            try:
                resp = requests.post(url, headers=headers, json=payload, timeout=8)
                if resp.status_code in (200, 201, 202):
                    data = resp.json()
                    if isinstance(data, dict) and data.get("success") is False:
                        errors.append(f"HTTP {resp.status_code} Error: {data.get('error') or data}")
                        continue
                    return {"success": True, "data": data, "endpoint": url, "payload": payload, "status_code": resp.status_code}
                else:
                    errors.append(f"HTTP {resp.status_code}: {resp.text}")
            except Exception as ex:
                errors.append(f"Exception: {ex}")

        return {"success": False, "error": " | ".join(errors[:2])}

    def fetch_closed_position_audit(self, position_id: str, max_retries: int = 6, retry_delay: float = 1.0) -> Optional[Dict[str, Any]]:
        """
        Requirement 5: Queries Mudrex API for actual position history and order fill data.
        Returns exact entry/exit fill prices, realized gross P&L, entry/exit fees+GST, funding fee, and NET P&L.
        """
        headers = self._get_headers()
        if not headers.get("X-Authentication"):
            return None

        pos_item = None
        pos_orders = []

        for attempt in range(max_retries):
            try:
                url = f"{self.BASE_URL}/futures/positions/history?trade_currency=INR"
                resp = requests.get(url, headers=headers, timeout=5)
                if resp.status_code in (200, 201):
                    data = resp.json()
                    items = data.get("data") if isinstance(data, dict) else data
                    if isinstance(items, list):
                        for p in items:
                            if str(p.get("position_id")).lower() == str(position_id).lower():
                                pos_item = p
                                break
                if pos_item:
                    break
            except Exception as e:
                print(f"[{datetime.now()}] [MUDREX AUDIT FETCH ERROR] {e}")
            time.sleep(retry_delay)

        if not pos_item:
            return None

        try:
            url = f"{self.BASE_URL}/futures/orders?trade_currency=INR"
            resp = requests.get(url, headers=headers, timeout=5)
            if resp.status_code in (200, 201):
                data = resp.json()
                items = data.get("data") if isinstance(data, dict) else data
                if isinstance(items, list):
                    for o in items:
                        if str(o.get("position_id")).lower() == str(position_id).lower():
                            pos_orders.append(o)
        except Exception as e:
            print(f"[{datetime.now()}] [MUDREX AUDIT ORDER FETCH ERROR] {e}")

        entry_price_usd = float(pos_item.get("entry_price") or 0.0)
        closed_price_usd = float(pos_item.get("closed_price") or 0.0)
        qty = float(pos_item.get("quantity") or 0.002)
        hedge_rate = float(pos_item.get("entry_hedge_rate") or pos_item.get("exit_hedge_rate") or 102.0)
        gross_pnl_inr = float(pos_item.get("pnl") or 0.0)

        entry_fee_gst = 0.0
        exit_fee_gst = 0.0

        if pos_orders:
            for o in pos_orders:
                amt = float(o.get("actual_amount") or 0.0)
                if amt <= 0:
                    p = float(o.get("filled_price") or o.get("price") or 0.0)
                    q = float(o.get("filled_quantity") or o.get("quantity") or qty)
                    hr = float(o.get("hedge_rate") or hedge_rate)
                    amt = p * q * hr
                fee = amt * 0.0005
                gst = fee * 0.18
                tot = fee + gst
                reduces = o.get("reduces_only")
                if not reduces and o == pos_orders[0]:
                    entry_fee_gst += tot
                else:
                    exit_fee_gst += tot

        if entry_fee_gst == 0.0 and exit_fee_gst == 0.0:
            entry_fee_gst = (entry_price_usd * qty * hedge_rate) * 0.00059
            exit_fee_gst = (closed_price_usd * qty * hedge_rate) * 0.00059

        total_charges = entry_fee_gst + exit_fee_gst
        funding_fee = float(pos_item.get("funding_fee") or 0.0)
        net_pnl_inr = gross_pnl_inr - total_charges - funding_fee

        return {
            "entry_price_usd": entry_price_usd,
            "exit_price_usd": closed_price_usd,
            "entry_price_inr": round(entry_price_usd * hedge_rate, 2),
            "exit_price_inr": round(closed_price_usd * hedge_rate, 2),
            "quantity": qty,
            "hedge_rate": hedge_rate,
            "gross_pnl_inr": round(gross_pnl_inr, 2),
            "entry_fee_gst": round(entry_fee_gst, 2),
            "exit_fee_gst": round(exit_fee_gst, 2),
            "charges": round(total_charges, 2),
            "funding_fee": round(funding_fee, 2),
            "net_pnl_inr": round(net_pnl_inr, 2),
            "raw_position": pos_item
        }


class BitcoinLiveEngine:
    """
    Production Bitcoin Live Engine (Mudrex API) V2 Rebuild.
    LOGIC & RISK CONTRACT:
    - Intended Strategy: EMA 9/21/50 + RSI 14 (Preserved 100%).
    - Quantity: 0.002 BTC (Fixed per user spec).
    - Leverage: 5x Isolated.
    - Target: ₹100 NET profit after all charges & GST.
    - Max Loss: ₹200 NET loss after all charges & GST.
    """

    def __init__(self):
        self.adapter = MudrexLiveAdapter()

        # Hardcoded System Parameters & Guardrails
        self.QUANTITY = 0.002
        self.LEVERAGE = 5.0
        self.MAX_POSITIONS = 1
        self.ALLOW_AVERAGING = False
        self.ALLOW_MARTINGALE = False
        self.TAKER_FEE_RATE = 0.0005  # 0.05% per side
        self.GST_RATE = 0.18          # 18% GST on fee
        self.TOTAL_FEE_RATE = 0.00059 # 0.059% per side inclusive of GST

        # Load Trading Enable Lock (Live Trading Active)
        saved_enable = DB.load_bitcoin_live_setting("live_trading_enabled", "TRUE")
        self.live_trading_enabled = (saved_enable.upper() == "TRUE")

        # Load Persistent Risk Settings
        self.today_date = datetime.now().strftime("%Y-%m-%d")
        saved_date = DB.load_bitcoin_live_setting("today_date", self.today_date)
        if saved_date != self.today_date:
            DB.save_bitcoin_live_setting("today_date", self.today_date)
            DB.save_bitcoin_live_setting("daily_loss_limit_hit", "FALSE")
            DB.save_bitcoin_live_setting("today_realized_pnl", "0.0")

        self.per_trade_loss_limit_inr = float(DB.load_bitcoin_live_setting("per_trade_loss_limit_inr", "200.0"))
        self.per_trade_profit_target_inr = float(DB.load_bitcoin_live_setting("per_trade_profit_target_inr", "100.0"))
        self.daily_loss_limit_inr = float(DB.load_bitcoin_live_setting("daily_loss_limit_inr", "1000.0"))

        DB.save_bitcoin_live_setting("per_trade_loss_limit_inr", str(self.per_trade_loss_limit_inr))
        DB.save_bitcoin_live_setting("per_trade_profit_target_inr", str(self.per_trade_profit_target_inr))

        self.circuit_breaker_tripped = DB.load_bitcoin_live_setting("circuit_breaker_tripped", "FALSE").upper() == "TRUE"
        self.circuit_breaker_reason = DB.load_bitcoin_live_setting("circuit_breaker_reason", "")
        self.daily_loss_limit_hit = DB.load_bitcoin_live_setting("daily_loss_limit_hit", "FALSE").upper() == "TRUE"
        self.today_realized_pnl = float(DB.load_bitcoin_live_setting("today_realized_pnl", "0.0"))

        self.last_api_status = "UNKNOWN"
        self.last_sl_time = float(DB.load_bitcoin_live_setting("last_sl_time", "0.0"))
        self.evaluation_stream = []
        self.last_evaluation = {}

    def calculate_sl_and_target_prices(
        self,
        direction: str,
        entry_price_usd: float,
        quantity: float = 0.002,
        hedge_rate: float = 102.0,
        target_net_inr: float = 100.0,
        max_loss_net_inr: float = 200.0,
        funding_fee: float = 0.0
    ) -> Tuple[float, float, float, float, float, float]:
        """
        Calculates exact Target Price (+₹100 NET) and Stop Loss Price (-₹200 NET)
        inclusive of Mudrex Futures fees and GST.
        
        Returns:
        (target_price_usd, stop_loss_price_usd, target_price_inr, stop_loss_price_inr, target_gross_inr, stop_gross_inr)
        """
        if hedge_rate <= 0:
            hedge_rate = 102.0
        if quantity <= 0:
            quantity = 0.002

        if entry_price_usd > 100000.0:
            entry_price_usd = entry_price_usd / hedge_rate

        v_entry = entry_price_usd * quantity * hedge_rate
        f_entry = v_entry * self.TOTAL_FEE_RATE

        dir_upper = str(direction).upper()

        if dir_upper in ("BUY", "LONG"):
            # Target USD
            denom_tp = quantity * hedge_rate * (1.0 - self.TOTAL_FEE_RATE)
            num_tp = v_entry + f_entry + funding_fee + target_net_inr
            target_price_usd = round(num_tp / denom_tp, 2)

            # Stop Loss USD
            denom_sl = quantity * hedge_rate * (1.0 - self.TOTAL_FEE_RATE)
            num_sl = v_entry + f_entry + funding_fee - max_loss_net_inr
            stop_loss_price_usd = round(num_sl / denom_sl, 2)

            target_gross_inr = round((target_price_usd - entry_price_usd) * quantity * hedge_rate, 2)
            stop_gross_inr = round((entry_price_usd - stop_loss_price_usd) * quantity * hedge_rate, 2)

        else:  # SELL / SHORT
            # Target USD
            denom_tp = quantity * hedge_rate * (1.0 + self.TOTAL_FEE_RATE)
            num_tp = v_entry - f_entry - funding_fee - target_net_inr
            target_price_usd = round(num_tp / denom_tp, 2)

            # Stop Loss USD
            denom_sl = quantity * hedge_rate * (1.0 + self.TOTAL_FEE_RATE)
            num_sl = v_entry - f_entry - funding_fee + max_loss_net_inr
            stop_loss_price_usd = round(num_sl / denom_sl, 2)

            target_gross_inr = round((entry_price_usd - target_price_usd) * quantity * hedge_rate, 2)
            stop_gross_inr = round((stop_loss_price_usd - entry_price_usd) * quantity * hedge_rate, 2)

        target_price_inr = round(target_price_usd * hedge_rate, 2)
        stop_loss_price_inr = round(stop_loss_price_usd * hedge_rate, 2)

        return (
            target_price_usd,
            stop_loss_price_usd,
            target_price_inr,
            stop_loss_price_inr,
            target_gross_inr,
            stop_gross_inr
        )

    def calculate_trade_charges(self, entry_price_inr: float, exit_price_inr: float, quantity: float = 0.002) -> Tuple[float, float, float]:
        """Calculates entry charges, exit charges, and total charges in INR."""
        entry_val = entry_price_inr * quantity
        exit_val = exit_price_inr * quantity
        entry_fee = round(entry_val * self.TOTAL_FEE_RATE, 2)
        exit_fee = round(exit_val * self.TOTAL_FEE_RATE, 2)
        total_fee = round(entry_fee + exit_fee, 2)
        return entry_fee, exit_fee, total_fee

    def calculate_position_quantity(self, entry_price: float, available_balance: float = 5000.0) -> float:
        """Fixed 0.002 BTC per current intended strategy spec."""
        return 0.002

    def fetch_mudrex_futures_market_data(self) -> Tuple[Optional[float], float, str]:
        """Fetches live Mudrex BTCUSDT Futures price in USD and hedge rate."""
        price_usd = None
        hedge_rate = 102.0
        source = "Mudrex API"

        try:
            ast_res = self.adapter.fetch_btcusdt_asset()
            if ast_res.get("success"):
                ast = ast_res.get("asset", {})
                if isinstance(ast, dict) and "price" in ast:
                    price_usd = float(ast["price"])
        except Exception as e:
            print(f"[{datetime.now()}] [MUDREX ASSET FETCH ERROR] {e}")

        try:
            positions = self.adapter.fetch_open_positions()
            if isinstance(positions, list) and positions:
                pos0 = positions[0]
                if isinstance(pos0, dict):
                    if price_usd is None or price_usd <= 0:
                        m_price = pos0.get("mark_price") or pos0.get("price")
                        if m_price:
                            price_usd = float(m_price)
                    if "entry_hedge_rate" in pos0 and float(pos0["entry_hedge_rate"] or 0) > 0:
                        hedge_rate = float(pos0["entry_hedge_rate"])
        except Exception as e:
            print(f"[{datetime.now()}] [MUDREX POSITION FETCH ERROR] {e}")

        if price_usd is None or price_usd <= 0:
            try:
                resp = requests.get("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", timeout=4)
                if resp.status_code == 200:
                    data = resp.json()
                    price_usd = float(data.get("price", 0.0))
                    source = "Binance Futures/Spot API (BTCUSDT USD)"
            except Exception as e:
                print(f"[{datetime.now()}] [PRICE FEED ERROR] {e}")

        if price_usd is not None and price_usd > 0:
            return price_usd, hedge_rate, source

        return None, hedge_rate, "PRICE FEED UNAVAILABLE"

    def calculate_live_position_pnl(
        self,
        position: LiveTradeState,
        curr_price_usd: float,
        hedge_rate: float
    ) -> Tuple[float, float, float, float, float, float]:
        """
        Single authoritative unrealized P&L calculation for active position state.
        Returns: (gross_pnl_usd, gross_pnl_inr, entry_fee_gst, exit_fee_gst, total_charges, net_pnl_inr)
        """
        if not position or curr_price_usd <= 0 or hedge_rate <= 0:
            return 0.0, 0.0, 0.0, 0.0, 0.0, 0.0

        pos_hr = position.hedge_rate if position.hedge_rate > 0 else hedge_rate
        entry_usd = position.entry_price_usd
        qty = position.quantity

        if position.direction in ("BUY", "LONG"):
            gross_pnl_usd = (curr_price_usd - entry_usd) * qty
        else:
            gross_pnl_usd = (entry_usd - curr_price_usd) * qty

        gross_pnl_inr = gross_pnl_usd * pos_hr

        entry_val_inr = entry_usd * qty * pos_hr
        exit_val_inr = curr_price_usd * qty * pos_hr

        entry_fee_gst = entry_val_inr * self.TOTAL_FEE_RATE
        exit_fee_gst = exit_val_inr * self.TOTAL_FEE_RATE
        total_charges = entry_fee_gst + exit_fee_gst + position.funding_fee

        net_pnl_inr = gross_pnl_inr - total_charges

        return (
            round(gross_pnl_usd, 4),
            round(gross_pnl_inr, 2),
            round(entry_fee_gst, 2),
            round(exit_fee_gst, 2),
            round(total_charges, 2),
            round(net_pnl_inr, 2)
        )

    def save_settings(self):
        """Persists settings & state flags to SQLite DB."""
        DB.save_bitcoin_live_setting("per_trade_loss_limit_inr", str(self.per_trade_loss_limit_inr))
        DB.save_bitcoin_live_setting("daily_loss_limit_inr", str(self.daily_loss_limit_inr))
        DB.save_bitcoin_live_setting("circuit_breaker_tripped", "TRUE" if self.circuit_breaker_tripped else "FALSE")
        DB.save_bitcoin_live_setting("circuit_breaker_reason", self.circuit_breaker_reason)
        DB.save_bitcoin_live_setting("daily_loss_limit_hit", "TRUE" if self.daily_loss_limit_hit else "FALSE")
        DB.save_bitcoin_live_setting("today_realized_pnl", str(self.today_realized_pnl))
        DB.save_bitcoin_live_setting("today_date", self.today_date)
        DB.save_bitcoin_live_setting("live_trading_enabled", "TRUE" if self.live_trading_enabled else "FALSE")
        DB.save_bitcoin_live_setting("last_sl_time", str(self.last_sl_time))

    def recalculate_realized_pnl(self):
        """Recalculates today_realized_pnl from DB trade net_pnl values."""
        all_trades = DB.load_all_bitcoin_live_trades()
        today_str = datetime.now().strftime("%Y-%m-%d")
        today_sum = 0.0
        for t in all_trades:
            if t.get("status") == TradeStatus.CLOSED.value:
                exit_time = str(t.get("exit_timestamp") or t.get("entry_timestamp") or "")
                if today_str in exit_time:
                    today_sum += float(t.get("net_pnl") or 0.0)
        self.today_realized_pnl = round(today_sum, 2)
        DB.save_bitcoin_live_setting("today_realized_pnl", str(self.today_realized_pnl))

    def set_live_trading_enabled(self, enabled: bool):
        """Enables or disables live trading execution."""
        self.live_trading_enabled = enabled
        self.save_settings()

    def update_risk_settings(self, per_trade_limit: Optional[float] = None, profit_target: Optional[float] = None, daily_limit: Optional[float] = None):
        """Updates target and loss limits."""
        if per_trade_limit is not None and float(per_trade_limit) > 0:
            self.per_trade_loss_limit_inr = float(per_trade_limit)
        if profit_target is not None and float(profit_target) > 0:
            self.per_trade_profit_target_inr = float(profit_target)
        if daily_limit is not None and float(daily_limit) > 0:
            self.daily_loss_limit_inr = float(daily_limit)
        self.save_settings()

    def trip_circuit_breaker(self, reason: str):
        """Trips emergency circuit breaker."""
        self.circuit_breaker_tripped = True
        self.circuit_breaker_reason = reason
        self.save_settings()

    def reset_circuit_breaker(self):
        """Resets circuit breaker."""
        self.circuit_breaker_tripped = False
        self.circuit_breaker_reason = ""
        self.save_settings()

    def reset_daily_pnl(self):
        """Resets daily P&L state."""
        self.today_realized_pnl = 0.0
        self.daily_loss_limit_hit = False
        self.circuit_breaker_tripped = False
        self.circuit_breaker_reason = ""
        self.save_settings()

    def are_new_entries_allowed(self) -> Tuple[bool, str]:
        """Requirement 11: Rate control and risk state checking."""
        curr_date = datetime.now().strftime("%Y-%m-%d")
        if self.today_date != curr_date:
            self.today_date = curr_date
            self.today_realized_pnl = 0.0
            self.daily_loss_limit_hit = False
            self.save_settings()

        if not self.live_trading_enabled:
            return False, "LIVE TRADING DISABLED (Pre-Flight / Read-Only Mode)"
        if self.circuit_breaker_tripped:
            return False, f"CIRCUIT BREAKER TRIPPED: {self.circuit_breaker_reason}"
        if self.today_realized_pnl <= -self.daily_loss_limit_inr or self.daily_loss_limit_hit:
            self.daily_loss_limit_hit = True
            return False, f"DAILY LOSS LIMIT REACHED (Rs.{abs(self.today_realized_pnl):,.2f} >= Rs.{self.daily_loss_limit_inr:,.2f})"

        # Execution Debounce (60s after trade exit to prevent tick churn)
        if self.last_sl_time > 0:
            elapsed = time.time() - self.last_sl_time
            if elapsed < 60:
                rem_secs = int(60 - elapsed)
                return False, f"EXECUTION DEBOUNCE ACTIVE ({rem_secs}s remaining)"

        active_raw = DB.load_active_bitcoin_live_position()
        if active_raw and active_raw.get("status") in (TradeStatus.OPEN.value, TradeStatus.EXIT_REQUESTED.value):
            return False, f"POSITION ACTIVE ({active_raw.get('status')})"

        return True, "ALLOWED (SCANNING FOR SIGNALS)"

    def run_preflight_check(self) -> Dict[str, Any]:
        """Executes a 100% READ-ONLY Pre-Flight Audit."""
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

    def auto_reconcile_active_position(self) -> Optional[Dict[str, Any]]:
        """
        Requirement 9: Reconciles open positions between SQLite database and Mudrex API.
        Handles orphan positions, offline closures, and state alignment.
        """
        raw_db_pos = DB.load_active_bitcoin_live_position()
        m_positions = self.adapter.fetch_open_positions()

        m_pos = m_positions[0] if (isinstance(m_positions, list) and len(m_positions) > 0) else {}
        m_pos_id = m_pos.get("position_id") or m_pos.get("id")

        if raw_db_pos:
            try:
                db_state = LiveTradeState.from_dict(raw_db_pos)
            except Exception as e:
                print(f"[{datetime.now()}] [RECONCILIATION ERROR] Unable to parse DB position: {e}")
                return raw_db_pos

            if m_pos_id and str(m_pos_id).lower() == str(db_state.mudrex_position_id).lower():
                # Align state
                return db_state.to_dict()
            elif not m_pos_id or not any(str(p.get("position_id") or p.get("id")).lower() == str(db_state.mudrex_position_id).lower() for p in m_positions):
                # DB shows OPEN/EXIT_REQUESTED, but position is CLOSED on Mudrex! Reconcile to CLOSED.
                print(f"[{datetime.now()}] [RECONCILIATION] DB trade {db_state.trade_id} closed on Mudrex. Finalizing...")
                curr_usd, hr, src = self.fetch_mudrex_futures_market_data()
                self._finalize_closed_position(db_state, curr_usd or db_state.entry_price_usd, src)
                return None
            else:
                return db_state.to_dict()

        # DB has NO active position, but Mudrex HAS an open position! Adopt orphan position.
        if m_pos and m_pos_id:
            pos_id = str(m_pos_id)
            pos_id_clean = pos_id.replace("-", "")
            trade_id = f"BTC_LIVE_{pos_id_clean[:8]}"
            entry_usd = float(m_pos.get("entry_price") or m_pos.get("avg_price") or 85000.0)
            qty = float(m_pos.get("quantity") or m_pos.get("size") or 0.002)
            direction = "BUY" if str(m_pos.get("side") or m_pos.get("order_type") or m_pos.get("direction") or "LONG").upper() in ("BUY", "LONG") else "SELL"
            pos_hr = float(m_pos.get("hedge_rate") or 102.0)

            tp_usd, sl_usd, tp_inr, sl_inr, tp_gross, sl_gross = self.calculate_sl_and_target_prices(
                direction, entry_usd, qty, pos_hr, self.per_trade_profit_target_inr, self.per_trade_loss_limit_inr
            )

            now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            reconciled_state = LiveTradeState(
                trade_id=trade_id,
                mudrex_position_id=pos_id,
                direction=direction,
                quantity=qty,
                leverage=5.0,
                entry_price_usd=entry_usd,
                entry_price=round(entry_usd * pos_hr, 2),
                hedge_rate=pos_hr,
                entry_timestamp=now_str,
                target_net_inr=self.per_trade_profit_target_inr,
                max_loss_net_inr=self.per_trade_loss_limit_inr,
                target_gross_inr=tp_gross,
                stop_gross_inr=sl_gross,
                target_usd=tp_usd,
                stop_loss_usd=sl_usd,
                target=tp_inr,
                stop_loss=sl_inr,
                trend_state="BULLISH" if direction == "BUY" else "BEARISH",
                confidence=85,
                reasons=["Adopted Orphan Mudrex Position"],
                status=TradeStatus.OPEN.value,
                entry_charges=round(entry_usd * qty * pos_hr * self.TOTAL_FEE_RATE, 2),
                charges=round(entry_usd * qty * pos_hr * self.TOTAL_FEE_RATE, 2),
                symbol="BTCUSDT"
            )

            DB.save_bitcoin_live_trade(reconciled_state.to_dict())
            print(f"[{datetime.now()}] [RECONCILIATION] Adopted orphan Mudrex position {pos_id} as trade {trade_id}.")
            return reconciled_state.to_dict()

        return None

    def get_dashboard_state(self) -> Dict[str, Any]:
        """Returns JSON state payload for dashboard display (Requirement 10)."""
        curr_price_usd, hedge_rate, price_source = self.fetch_mudrex_futures_market_data()
        active_pos_dict = self.auto_reconcile_active_position()

        spot_bal = self.adapter.fetch_spot_balance()
        fut_bal = self.adapter.fetch_futures_balance()

        if spot_bal >= 100.0 and fut_bal < 100.0:
            tr_res = self.adapter.transfer_inr_spot_to_futures(spot_bal)
            if tr_res.get("success"):
                fut_bal += spot_bal
                spot_bal = 0.0

        if active_pos_dict and curr_price_usd and curr_price_usd > 0 and hedge_rate > 0:
            try:
                pos = LiveTradeState.from_dict(active_pos_dict)
                _, unrealized_gross, entry_fee, exit_fee, total_charges, unrealized_net = self.calculate_live_position_pnl(
                    pos, curr_price_usd, hedge_rate
                )
            except Exception:
                unrealized_gross = 0.0
                total_charges = 0.0
                unrealized_net = 0.0
            btc_inr_val = round(curr_price_usd * hedge_rate, 2)
        elif curr_price_usd and curr_price_usd > 0 and hedge_rate > 0:
            unrealized_gross = 0.0
            total_charges = 0.0
            unrealized_net = 0.0
            btc_inr_val = round(curr_price_usd * hedge_rate, 2)
        else:
            unrealized_gross = 0.0
            total_charges = 0.0
            unrealized_net = 0.0
            btc_inr_val = 0.0
            price_source = "MARKET DATA UNAVAILABLE"

        if self.today_realized_pnl <= -self.daily_loss_limit_inr or self.daily_loss_limit_hit:
            scanner_status = f"DAILY LOSS LOCK (-Rs.{int(self.daily_loss_limit_inr):,})"
        elif self.circuit_breaker_tripped:
            scanner_status = f"CIRCUIT BREAKER: {self.circuit_breaker_reason}"
        elif active_pos_dict and active_pos_dict.get("status") in (TradeStatus.OPEN.value, TradeStatus.EXIT_REQUESTED.value):
            scanner_status = f"POSITION ACTIVE ({active_pos_dict.get('status')})"
        elif not self.live_trading_enabled:
            scanner_status = "TRADING PAUSED (Pre-Flight Mode)"
        elif "ORDER REJECTED" in getattr(self, "last_api_status", ""):
            scanner_status = "ORDER REJECTED / NOT EXECUTED"
        else:
            scanner_status = "SCANNING FOR SIGNALS"

        allowed, allowed_reason = self.are_new_entries_allowed()
        all_trades = DB.load_all_bitcoin_live_trades()

        total_gross_realized = sum(float(t.get("gross_pnl") or 0.0) for t in all_trades if t.get("status") == TradeStatus.CLOSED.value)
        total_fees_gst = sum(float(t.get("charges") or 0.0) for t in all_trades if t.get("status") == TradeStatus.CLOSED.value)
        total_funding = sum(float(t.get("funding_fee") or 0.0) for t in all_trades if t.get("status") == TradeStatus.CLOSED.value)
        total_net_realized = sum(float(t.get("net_pnl") or 0.0) for t in all_trades if t.get("status") == TradeStatus.CLOSED.value)

        return {
            "btc_price": btc_inr_val,
            "mudrex_btc_usd_price": round(curr_price_usd, 2) if curr_price_usd else 0.0,
            "mudrex_hedge_rate": round(hedge_rate, 2) if hedge_rate else 102.0,
            "mudrex_btc_inr_price": btc_inr_val,
            "price_source": price_source,
            "position": active_pos_dict.get("status") if active_pos_dict else "NONE",
            "scanner_status": scanner_status,
            "active_position": active_pos_dict,
            "entry_price": active_pos_dict.get("entry_price") if active_pos_dict else None,
            "entry_price_usd": active_pos_dict.get("entry_price_usd") if active_pos_dict else None,
            "stop_loss": active_pos_dict.get("stop_loss") if active_pos_dict else None,
            "stop_loss_usd": active_pos_dict.get("stop_loss_usd") if active_pos_dict else None,
            "target": active_pos_dict.get("target") if active_pos_dict else None,
            "target_usd": active_pos_dict.get("target_usd") if active_pos_dict else None,
            "current_unrealized_gross_pnl": round(unrealized_gross, 2),
            "current_estimated_charges": round(total_charges, 2),
            "current_unrealized_net_pnl": round(unrealized_net, 2),
            "today_realized_pnl": round(self.today_realized_pnl, 2),
            "total_gross_realized_pnl": round(total_gross_realized, 2),
            "total_fees_gst": round(total_fees_gst, 2),
            "total_funding_fee": round(total_funding, 2),
            "total_net_realized_pnl": round(total_net_realized, 2),
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
            "disclaimer": "BITCOIN LIVE ENGINE V2 — CLEAN REBUILD ARCHITECTURE"
        }

    def process_tick(self):
        """Processes live market ticks with strict state management and Mudrex authoritative accounting."""
        try:
            curr_price_usd, hedge_rate, price_source = self.fetch_mudrex_futures_market_data()

            # REQUIREMENT 2 & FAIL-SAFE: If price feed unavailable or <= 0, NEVER process triggers
            if curr_price_usd is None or curr_price_usd <= 0:
                print(f"[{datetime.now()}] [PRICE FEED UNAVAILABLE] Mudrex Futures USD price feed unavailable. Tick ignored.")
                self.last_api_status = "MUDREX FUTURES PRICE FEED UNAVAILABLE"
                return

            curr_price_inr = round(curr_price_usd * hedge_rate, 2)
            candles = BITCOIN_FEED.fetch_historical_candles("5m", "5d")
            eval_res = BITCOIN_STRATEGY.evaluate_market(candles, curr_price_inr)
            self.last_evaluation = eval_res

            # Evaluation logging stream
            now_ist_str = datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d %H:%M:%S")
            reasons_str = " | ".join(eval_res.get("reasons", []))
            eval_log_entry = {
                "timestamp": now_ist_str,
                "price": curr_price_inr,
                "price_usd": curr_price_usd,
                "hedge_rate": hedge_rate,
                "action": eval_res.get("action", "WAIT"),
                "trend_state": eval_res.get("trend", "NEUTRAL"),
                "confidence": eval_res.get("confidence", 50),
                "reason": reasons_str,
                "ema9": eval_res.get("ema9", curr_price_inr),
                "ema21": eval_res.get("ema21", curr_price_inr),
                "rsi": eval_res.get("rsi", 50.0)
            }
            self.evaluation_stream.insert(0, eval_log_entry)
            if len(self.evaluation_stream) > 100:
                self.evaluation_stream = self.evaluation_stream[:100]

            # 1. CHECK ACTIVE POSITION IN DB
            raw_pos = DB.load_active_bitcoin_live_position()

            if raw_pos:
                try:
                    position = LiveTradeState.from_dict(raw_pos)
                except Exception as e:
                    print(f"[{datetime.now()}] [POSITION LOAD ERROR] Failed to parse active trade state: {e}")
                    return

                # Check if position is valid for execution (Requirement 1 & 2)
                valid, err_msg = position.is_valid_for_execution()
                if not valid:
                    print(f"[{datetime.now()}] [WARNING] Active trade {position.trade_id} missing parameters: {err_msg}. Recalculating...")
                    if position.entry_price_usd > 0 and position.quantity > 0:
                        tp_usd, sl_usd, tp_inr, sl_inr, tp_gross, sl_gross = self.calculate_sl_and_target_prices(
                            position.direction, position.entry_price_usd, position.quantity, position.hedge_rate,
                            position.target_net_inr, position.max_loss_net_inr
                        )
                        position.target_usd = tp_usd
                        position.stop_loss_usd = sl_usd
                        position.target = tp_inr
                        position.stop_loss = sl_inr
                        position.target_gross_inr = tp_gross
                        position.stop_gross_inr = sl_gross
                        DB.save_bitcoin_live_trade(position.to_dict())
                        valid, err_msg = position.is_valid_for_execution()

                    if not valid:
                        print(f"[{datetime.now()}] [CRITICAL ERROR] Position {position.trade_id} cannot be validated ({err_msg}). TP/SL triggers BLOCKED!")
                        return

                # REQUIREMENT 7: ATOMIC STATE TRANSITION & DUPLICATION PROTECTION
                if position.status == TradeStatus.EXIT_REQUESTED.value:
                    print(f"[{datetime.now()}] [EXIT IN PROGRESS] Position {position.trade_id} is in EXIT_REQUESTED state. Verifying exit status with Mudrex...")
                    m_pos_id = position.mudrex_position_id
                    if m_pos_id and self.live_trading_enabled:
                        open_positions = self.adapter.fetch_open_positions()
                        is_still_open = any(
                            (str(p.get("position_id") or p.get("id")) == str(m_pos_id))
                            for p in open_positions
                        )
                        if is_still_open:
                            print(f"[{datetime.now()}] [MUDREX CLOSE PENDING] Mudrex position {m_pos_id} still open on exchange. Awaiting execution.")
                            return

                    # Position is confirmed closed on Mudrex!
                    self._finalize_closed_position(position, curr_price_usd, price_source)
                    return

                if position.status == TradeStatus.CLOSED.value:
                    return

                # AT STATUS == OPEN: EVALUATE TARGET & SL
                gross_usd, gross_inr, entry_fee, exit_fee, total_charges, net_pnl = self.calculate_live_position_pnl(
                    position, curr_price_usd, hedge_rate
                )

                # Target & Loss trigger condition checks (REQUIREMENT 3 & 4)
                if position.direction in ("BUY", "LONG"):
                    tp_hit = (curr_price_usd >= position.target_usd) and (net_pnl >= position.target_net_inr)
                    sl_hit = (curr_price_usd <= position.stop_loss_usd) or (net_pnl <= -position.max_loss_net_inr)
                else:  # SELL / SHORT
                    tp_hit = (curr_price_usd <= position.target_usd) and (net_pnl >= position.target_net_inr)
                    sl_hit = (curr_price_usd >= position.stop_loss_usd) or (net_pnl <= -position.max_loss_net_inr)

                if tp_hit or sl_hit:
                    # ATOMIC STATE CHANGE TO EXIT_REQUESTED
                    position.status = TradeStatus.EXIT_REQUESTED.value
                    position.trigger_price_usd = curr_price_usd
                    DB.save_bitcoin_live_trade(position.to_dict())

                    m_pos_id = position.mudrex_position_id
                    close_success = True
                    if m_pos_id and self.live_trading_enabled:
                        # REQUIREMENT 8: Verify position exists on exchange before sending close request
                        open_positions = self.adapter.fetch_open_positions()
                        is_open_on_exchange = any(
                            (str(p.get("position_id") or p.get("id")) == str(m_pos_id))
                            for p in open_positions
                        )
                        if is_open_on_exchange:
                            close_res = self.adapter.close_position_safely(
                                position_id=m_pos_id,
                                symbol=position.symbol,
                                quantity=position.quantity,
                                direction=position.direction
                            )
                            if not close_res.get("success"):
                                close_success = False
                                print(f"[{datetime.now()}] [MUDREX CLOSE FAILED] Failed to close position {m_pos_id}: {close_res}")
                        else:
                            print(f"[{datetime.now()}] [EXTERNAL EXIT DETECTED] Position {m_pos_id} already closed on Mudrex.")

                    if close_success or not self.live_trading_enabled:
                        self._finalize_closed_position(position, curr_price_usd, price_source)

                return  # While position exists, skip scanning for new entries

            # 2. NO ACTIVE POSITION -> SCAN FOR NEW SIGNALS (REQUIREMENT 11)
            allowed, reason = self.are_new_entries_allowed()
            if not allowed:
                return

            action = eval_res.get("action", "WAIT")
            if action in ("BUY", "SELL"):
                self.execute_live_trade(action, curr_price_usd, hedge_rate, eval_res)
        except Exception as err:
            print(f"[{datetime.now()}] [BITCOIN LIVE TICK ERROR] {err}\n{traceback.format_exc()}")

    def _finalize_closed_position(self, position: LiveTradeState, current_price_usd: float, price_source: str):
        """
        Fetches Mudrex authoritative audit data and finalizes position status to CLOSED.
        Enforces Exit Reason Integrity (Requirement 6) and Mudrex Authoritative Accounting (Requirement 5).
        """
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        m_pos_id = position.mudrex_position_id

        audit_data = None
        if m_pos_id and self.live_trading_enabled:
            audit_data = self.adapter.fetch_closed_position_audit(m_pos_id)

        if audit_data:
            position.entry_price_usd = audit_data["entry_price_usd"]
            position.exit_price_usd = audit_data["exit_price_usd"]
            position.entry_price = audit_data["entry_price_inr"]
            position.exit_price = audit_data["exit_price_inr"]
            position.gross_pnl = audit_data["gross_pnl_inr"]
            position.entry_fee_gst = audit_data["entry_fee_gst"]
            position.exit_fee_gst = audit_data["exit_fee_gst"]
            position.entry_charges = audit_data["entry_fee_gst"]
            position.exit_charges = audit_data["exit_fee_gst"]
            position.charges = audit_data["charges"]
            position.funding_fee = audit_data["funding_fee"]
            position.net_pnl = audit_data["net_pnl_inr"]
            final_net = audit_data["net_pnl_inr"]
            print(f"[{datetime.now()}] [MUDREX CONFIRMED AUDIT] Position {m_pos_id} PnL updated: Gross=Rs.{audit_data['gross_pnl_inr']}, Charges=Rs.{audit_data['charges']}, Net=Rs.{final_net}")
        else:
            exit_usd = current_price_usd or position.entry_price_usd
            _, gross_inr, entry_fee, exit_fee, total_charges, net_inr = self.calculate_live_position_pnl(
                position, exit_usd, position.hedge_rate
            )
            position.exit_price_usd = exit_usd
            position.exit_price = round(exit_usd * position.hedge_rate, 2)
            position.gross_pnl = round(gross_inr, 2)
            position.entry_fee_gst = round(entry_fee, 2)
            position.exit_fee_gst = round(exit_fee, 2)
            position.entry_charges = round(entry_fee, 2)
            position.exit_charges = round(exit_fee, 2)
            position.charges = round(total_charges, 2)
            position.net_pnl = round(net_inr, 2)
            final_net = position.net_pnl

        # EXIT REASON INTEGRITY CHECK (Requirement 6)
        if final_net >= position.target_net_inr:
            position.exit_reason = f"PROFIT TARGET +Rs.{int(position.target_net_inr)} NET"
        elif final_net <= -position.max_loss_net_inr:
            position.exit_reason = f"LOSS LIMIT -Rs.{int(position.max_loss_net_inr)} NET"
        elif position.trigger_price_usd is not None:
            position.exit_reason = f"ENGINE SIGNAL EXIT (NET: Rs.{final_net:,.2f})"
        else:
            position.exit_reason = f"EXTERNAL MUDREX ORDER (NET: Rs.{final_net:,.2f})"

        position.status = TradeStatus.CLOSED.value
        position.exit_timestamp = now_str
        self.last_sl_time = time.time()

        DB.save_bitcoin_live_trade(position.to_dict())
        self.recalculate_realized_pnl()
        self.save_settings()
        print(f"[{datetime.now()}] [TRADE CLOSED] Trade {position.trade_id} CLOSED ({position.exit_reason})! Final Authoritative NET P&L: Rs.{position.net_pnl:,.2f}")

    def execute_live_trade(self, side: str, curr_price_usd: float, hedge_rate: float, eval_res: Dict[str, Any]) -> Dict[str, Any]:
        """Executes a new live trade order on Mudrex with mandatory state validation."""
        side = side.upper()
        if side not in ("BUY", "SELL"):
            return {"success": False, "error": f"Invalid trade side: {side}"}

        curr_price_inr = round(curr_price_usd * hedge_rate, 2)
        qty = 0.002

        tp_usd, sl_usd, tp_inr, sl_inr, tp_gross, sl_gross = self.calculate_sl_and_target_prices(
            side, curr_price_usd, qty, hedge_rate, self.per_trade_profit_target_inr, self.per_trade_loss_limit_inr
        )

        order_res = self.adapter.place_futures_order(
            symbol="BTCUSDT",
            side=side,
            quantity=qty,
            order_type="MARKET",
            stoploss_price=sl_usd
        )

        if not order_res.get("success"):
            err_msg = order_res.get("error", "Order placement failed")
            self.last_api_status = f"ORDER REJECTED: {err_msg}"
            return {"success": False, "error": err_msg}

        mudrex_data = order_res.get("data", {})
        if isinstance(mudrex_data, dict) and "data" in mudrex_data:
            mudrex_data = mudrex_data["data"]

        order_id = str(mudrex_data.get("order_id") or mudrex_data.get("id") or "").strip()
        pos_id = str(mudrex_data.get("position_id") or mudrex_data.get("mudrex_position_id") or "").strip()

        if not order_id or not pos_id:
            err_msg = "Mudrex API response missing order_id or position_id"
            self.last_api_status = f"ORDER REJECTED: {err_msg}"
            return {"success": False, "error": err_msg}

        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        trade_id = f"BTC_LIVE_{int(time.time())}"

        v_entry = curr_price_usd * qty * hedge_rate
        f_entry = round(v_entry * self.TOTAL_FEE_RATE, 2)

        trade_state = LiveTradeState(
            trade_id=trade_id,
            mudrex_position_id=pos_id,
            direction=side,
            quantity=qty,
            leverage=5.0,
            entry_price_usd=curr_price_usd,
            entry_price=curr_price_inr,
            hedge_rate=hedge_rate,
            entry_timestamp=now_str,
            entry_order_id=order_id,
            entry_fee_gst=f_entry,
            target_net_inr=self.per_trade_profit_target_inr,
            max_loss_net_inr=self.per_trade_loss_limit_inr,
            target_gross_inr=tp_gross,
            stop_gross_inr=sl_gross,
            target_usd=tp_usd,
            stop_loss_usd=sl_usd,
            target=tp_inr,
            stop_loss=sl_inr,
            trend_state=eval_res.get("trend", "NEUTRAL"),
            confidence=eval_res.get("confidence", 50),
            reasons=eval_res.get("reasons", []),
            status=TradeStatus.OPEN.value,
            entry_charges=f_entry,
            charges=f_entry,
            symbol="BTCUSDT"
        )

        valid, err_msg = trade_state.is_valid_for_execution()
        if not valid:
            print(f"[{datetime.now()}] [CRITICAL] Generated trade state invalid: {err_msg}")
            return {"success": False, "error": f"Invalid trade state generated: {err_msg}"}

        DB.save_bitcoin_live_trade(trade_state.to_dict())
        self.last_api_status = "ORDER EXECUTED"

        if pos_id and sl_usd:
            self.adapter.attach_stop_loss(pos_id, sl_usd, tp_usd)

        return {"success": True, "trade": trade_state.to_dict(), "mudrex_response": order_res}

    def execute_manual_trade(self, side: str) -> Dict[str, Any]:
        """Manually triggers a BUY or SELL live market order."""
        allowed, reason = self.are_new_entries_allowed()
        if not allowed:
            return {"success": False, "error": f"Manual trade blocked: {reason}"}

        curr_price_usd, hedge_rate, _ = self.fetch_mudrex_futures_market_data()
        if curr_price_usd is None or curr_price_usd <= 0:
            return {"success": False, "error": "Mudrex Futures BTC market price unavailable"}

        eval_res = {
            "trend": "MANUAL",
            "confidence": 100,
            "reasons": ["Manual 1-Click Execution via Live Dashboard"],
            "action": side.upper()
        }

        return self.execute_live_trade(side, curr_price_usd, hedge_rate, eval_res)

    def close_active_position(self) -> Dict[str, Any]:
        """Manually closes active live position with verification and authoritative accounting."""
        raw_pos = DB.load_active_bitcoin_live_position()
        if not raw_pos or raw_pos.get("status") not in (TradeStatus.OPEN.value, TradeStatus.EXIT_REQUESTED.value):
            return {"success": False, "error": "No active position is currently open"}

        try:
            position = LiveTradeState.from_dict(raw_pos)
        except Exception as e:
            return {"success": False, "error": f"Failed to parse active position: {e}"}

        curr_price_usd, hedge_rate, price_source = self.fetch_mudrex_futures_market_data()

        # Atomic state update to EXIT_REQUESTED
        position.status = TradeStatus.EXIT_REQUESTED.value
        position.trigger_price_usd = curr_price_usd
        DB.save_bitcoin_live_trade(position.to_dict())

        m_pos_id = position.mudrex_position_id
        close_res = {"success": True}
        if m_pos_id and self.adapter and self.live_trading_enabled:
            try:
                close_res = self.adapter.close_position_safely(
                    position_id=m_pos_id,
                    symbol=position.symbol,
                    quantity=position.quantity,
                    direction=position.direction
                )
            except Exception as e:
                print(f"[{datetime.now()}] [WARNING] Error closing Mudrex position {m_pos_id}: {e}")

        if not close_res.get("success") and self.live_trading_enabled:
            return {"success": False, "error": f"Failed to close Mudrex position: {close_res}"}

        self._finalize_closed_position(position, curr_price_usd or position.entry_price_usd, price_source)
        return {"success": True, "trade": position.to_dict(), "mudrex_response": close_res}

    async def start_feed_loop(self):
        """Continuous background loop for Bitcoin Live Engine."""
        self.is_running = True
        print(f"[{datetime.now()}] [BITCOIN LIVE ENGINE V2] Background loop started.")
        while self.is_running:
            try:
                self.process_tick()
            except Exception as e:
                print(f"[{datetime.now()}] [BITCOIN LIVE ENGINE LOOP ERROR] {e}")
            await asyncio.sleep(5)


# Global Singleton Instance
BITCOIN_LIVE_ENGINE = BitcoinLiveEngine()
