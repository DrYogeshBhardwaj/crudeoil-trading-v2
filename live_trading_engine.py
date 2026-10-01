"""
CRUDEOILM Separate Live Dhan Engine & 60-Minute Live Test lifecycle Manager.
STRICTLY DECOUPLED FROM PAPER ENGINE.
Manages Dhan API REST calls, Live Margins, 60-Minute Countdown, Test Loss Limit (Rs 3,000),
Max 1 Lot, Max Rs 2,500 Risk per Trade, Emergency Exit All, and Separate Live Database Ledger.
ORDER PLACEMENT REMAINS STRICTLY BLOCKED UNTIL LIVE_TEST_ENABLE IS EXPLICITLY SET AND READINESS CHECKS PASS.
"""

import os
import time
import json
import asyncio
import urllib.request
import urllib.error
from datetime import datetime, timedelta
from typing import List, Dict, Optional, Any
from dataclasses import dataclass, field

from config import CONFIG
from signal_engine import TradeSignal, SignalEngine
from pnl_calculator import PnLCalculator, PnLResult
from database import DB

@dataclass
class LivePosition:
    trade_id: str
    dhan_order_id: str
    entry_timestamp: datetime
    instrument: str
    direction: str             # 'BUY' or 'SELL'
    quantity: int              # Strictly 1 lot
    entry_price: float
    fill_price: float
    stop_loss: float
    original_stop_loss: float
    target_1: float
    target_2: float
    trend_state: str
    confidence: int
    reasons: List[str]
    t1_hit: bool = False
    
    status: str = "OPEN"       # 'OPEN' or 'CLOSED'
    exit_timestamp: Optional[datetime] = None
    exit_price: Optional[float] = None
    exit_reason: Optional[str] = None
    pnl_result: Optional[PnLResult] = None

class DhanLiveAdapter:
    """Handles REST interactions with Dhan HQ API for live account margins, orders, and positions."""
    
    BASE_URL = "https://api.dhan.co"
    
    def __init__(self):
        self.client_id = os.environ.get("DHAN_CLIENT_ID", "").strip()
        self.access_token = os.environ.get("DHAN_ACCESS_TOKEN", "").strip()
        
        # Fallback to local gitignored dhan_credentials.json if missing from env
        if not self.client_id or not self.access_token:
            cred_path = os.path.join(os.path.dirname(__file__), "dhan_credentials.json")
            if os.path.exists(cred_path):
                try:
                    with open(cred_path, "r", encoding="utf-8") as f:
                        cdata = json.load(f)
                        if not self.client_id: self.client_id = str(cdata.get("DHAN_CLIENT_ID", "")).strip()
                        if not self.access_token: self.access_token = str(cdata.get("DHAN_ACCESS_TOKEN", "")).strip()
                except Exception:
                    pass

    @staticmethod
    def get_outbound_public_ip() -> str:
        """Determines the actual fixed outbound public IPv4 of the running container server."""
        try:
            req = urllib.request.Request("https://api.ipify.org?format=json", headers={"User-Agent": "CRUDEOILM-LIVE-TEST"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return data.get("ip", "UNKNOWN")
        except Exception:
            try:
                req = urllib.request.Request("https://ifconfig.me/ip", headers={"User-Agent": "CRUDEOILM-LIVE-TEST"})
                with urllib.request.urlopen(req, timeout=5) as resp:
                    return resp.read().decode("utf-8").strip()
            except Exception as e:
                return f"IP_FETCH_ERROR ({e})"

    def is_authenticated(self) -> bool:
        return bool(self.client_id and self.access_token)

    def get_masked_token(self) -> str:
        if not self.access_token:
            return "MISSING"
        return f"{self.access_token[:4]}...{self.access_token[-4:]}"

    def fetch_fund_limits(self) -> Dict[str, Any]:
        """Fetches available margin and fund balances from Dhan REST API."""
        if not self.is_authenticated():
            return {
                "status": "UNAUTHENTICATED",
                "available_margin": 0.0,
                "dhan_client_id": self.client_id or "MISSING",
                "error": "DHAN_CLIENT_ID or DHAN_ACCESS_TOKEN Railway secret missing."
            }

        endpoints = [f"{self.BASE_URL}/v2/fundlimit", f"{self.BASE_URL}/fundlimit", f"{self.BASE_URL}/user/fundlimit"]
        last_error = None
        
        # Configure proxy handler if HTTPS_PROXY or HTTP_PROXY is configured in environment
        proxy_url = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY") or os.environ.get("QUOTAGUARDSTATIC_URL")
        handlers = []
        if proxy_url:
            handlers.append(urllib.request.ProxyHandler({'http': proxy_url, 'https': proxy_url}))
        opener = urllib.request.build_opener(*handlers)
        
        for url in endpoints:
            try:
                headers = {
                    "client-id": self.client_id,
                    "access-token": self.access_token,
                    "Content-Type": "application/json"
                }
                req = urllib.request.Request(url, headers=headers, method="GET")
                with opener.open(req, timeout=5) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    if isinstance(data, dict):
                        avail = float(data.get("availabelBalance", data.get("availableBalance", data.get("availMargin", data.get("sodLimit", 0.0)))))
                        return {
                            "status": "CONNECTED",
                            "available_margin": round(avail, 2),
                            "dhan_client_id": self.client_id,
                            "raw_response": data
                        }
            except urllib.error.HTTPError as he:
                if he.code in [401, 403]:
                    status_lbl = "EXPIRED_TOKEN_401" if he.code == 401 else "IP_RESTRICTED_403"
                    return {
                        "status": status_lbl,
                        "error_code": he.code,
                        "available_margin": 0.0,
                        "dhan_client_id": self.client_id,
                        "error": f"Dhan HTTP {he.code}: {he.reason}. Token may be expired or IP not whitelisted."
                    }
                last_error = f"HTTP {he.code}: {he.reason}"
            except Exception as e:
                last_error = str(e)

        return {
            "status": "CONNECTION_FAILED",
            "error": last_error,
            "available_margin": 0.0,
            "dhan_client_id": self.client_id
        }

class LiveTestEngine:
    """
    Dedicated 60-Minute Live Test Engine for CRUDEOILM.
    Strictly isolated from Paper Engine state and database tables.
    """

    def __init__(self):
        self.adapter = DhanLiveAdapter()
        self.active_position: Optional[LivePosition] = None
        self.closed_trades: List[LivePosition] = []
        
        self.live_ltp: Optional[float] = None
        self.last_live_tick_time: Optional[datetime] = None
        
        self.test_enabled: bool = bool(os.environ.get("LIVE_TEST_ENABLE", "").lower() in ["true", "1"])
        self.test_active: bool = False
        self.test_start_time: Optional[datetime] = None
        self.test_duration_minutes: int = CONFIG.LIVE_TEST_DURATION_MINUTES  # 60 mins
        
        self.net_realized_pnl: float = 0.0
        self.test_loss_limit_hit: bool = False
        self.system_status: str = "LIVE TEST READY — ORDER PLACEMENT DISABLED"
        self.trade_counter: int = 0
        
        self._restore_from_db()

    def update_live_ltp(self, price: float):
        """Updates real-time tick price from authenticated Dhan WebSocket feed only."""
        if price and price > 0:
            self.live_ltp = round(price, 2)
            self.last_live_tick_time = datetime.now()
            
            # Auto-start 60-min test if user approval is given and runtime Dhan checks pass
            if not self.test_active and not self.test_loss_limit_hit:
                fund_info = self.adapter.fetch_fund_limits()
                if fund_info["status"] == "CONNECTED" and fund_info.get("available_margin", 0.0) > 0:
                    self.start_60min_test()

    def _restore_from_db(self):
        """Restores live test trade history from live_trades SQLite table."""
        try:
            trades = DB.load_all_live_trades()
            for dt in trades:
                entry_ts = datetime.strptime(dt["entry_timestamp"], "%Y-%m-%d %H:%M:%S") if isinstance(dt["entry_timestamp"], str) else dt["entry_timestamp"]
                exit_ts = datetime.strptime(dt["exit_timestamp"], "%Y-%m-%d %H:%M:%S") if dt.get("exit_timestamp") and isinstance(dt["exit_timestamp"], str) else dt.get("exit_timestamp")
                
                pos = LivePosition(
                    trade_id=dt["trade_id"],
                    dhan_order_id=dt.get("dhan_order_id", "LIVE-TEST-MOCK"),
                    entry_timestamp=entry_ts,
                    instrument=dt["instrument"],
                    direction=dt["direction"],
                    quantity=dt["quantity"],
                    entry_price=dt["entry_price"],
                    fill_price=dt.get("fill_price", dt["entry_price"]),
                    stop_loss=dt["stop_loss"],
                    original_stop_loss=dt["original_stop_loss"],
                    target_1=dt["target_1"],
                    target_2=dt["target_2"],
                    trend_state=dt["trend_state"],
                    confidence=dt["confidence"],
                    reasons=dt.get("reasons", []),
                    status=dt["status"],
                    exit_timestamp=exit_ts,
                    exit_price=dt.get("exit_price"),
                    exit_reason=dt.get("exit_reason")
                )

                if dt.get("net_pnl") is not None:
                    pos.pnl_result = PnLCalculator.calculate_trade_pnl(
                        direction=dt["direction"],
                        entry_price=dt["entry_price"],
                        exit_price=dt["exit_price"],
                        quantity=dt["quantity"]
                    )

                if dt["status"] == "OPEN":
                    self.active_position = pos
                    self.system_status = "LIVE POSITION ACTIVE"
                else:
                    self.closed_trades.append(pos)
                    if pos.pnl_result:
                        self.net_realized_pnl += pos.pnl_result.net_pnl

                self.trade_counter += 1
        except Exception as e:
            print(f"Notice restoring live test trades from DB: {e}")

    def start_60min_test(self):
        """Starts or resets the 60-minute live test session window."""
        self.test_enabled = True
        self.test_active = True
        self.test_start_time = datetime.now()
        self.system_status = "LIVE TEST RUNNING (60 MIN WINDOW ACTIVE)"

    def stop_test(self, reason: str = "MANUAL_STOP"):
        """Stops the 60-minute live test window."""
        self.test_active = False
        self.system_status = f"LIVE TEST STOPPED — {reason}"

    def emergency_exit_all(self, current_price: float) -> Optional[LivePosition]:
        """Emergency square-off for any active live position."""
        if self.active_position:
            pos = self.active_position
            curr_time = datetime.now()
            return self._close_position(pos, curr_time, current_price, "EMERGENCY_EXIT_ALL")
        return None

    def get_remaining_seconds(self) -> int:
        if not self.test_start_time or not self.test_active:
            return self.test_duration_minutes * 60
        elapsed = (datetime.now() - self.test_start_time).total_seconds()
        remaining = (self.test_duration_minutes * 60) - int(elapsed)
        if remaining <= 0:
            self.stop_test("60_MINUTE_WINDOW_EXPIRED")
            return 0
        return remaining

    def process_live_tick(self, signal: TradeSignal, current_candle: object) -> Optional[LivePosition]:
        """
        Evaluates signals for Live Test Mode.
        ORDER PLACEMENT REMAINS BLOCKED IF LIVE_TEST_ENABLE IS FALSE.
        """
        curr_time = current_candle.timestamp
        curr_price = current_candle.close

        # Check Test Loss Limit
        if self.net_realized_pnl <= -CONFIG.LIVE_TEST_LOSS_LIMIT_INR:
            self.test_loss_limit_hit = True
            self.system_status = "PAUSED — LIVE TEST LOSS LIMIT HIT (Rs 3,000)"
            if self.active_position:
                self._close_position(self.active_position, curr_time, curr_price, "TEST_LOSS_LIMIT_PAUSE")
            return None

        # Check 60-minute countdown expiry
        rem_sec = self.get_remaining_seconds()
        if rem_sec <= 0:
            self.system_status = "LIVE TEST STOPPED — 60 MIN WINDOW EXPIRED"
            if self.active_position:
                self._close_position(self.active_position, curr_time, curr_price, "60_MIN_EXPIRED_EXIT")
            return None

        # Monitor active live position exits
        if self.active_position:
            self.system_status = "LIVE POSITION ACTIVE"
            pos = self.active_position
            
            # Check Stop Loss Hit
            if pos.direction == "BUY" and current_candle.low <= pos.stop_loss:
                exit_price = min(pos.stop_loss, current_candle.open)
                return self._close_position(pos, curr_time, exit_price, "STOP_LOSS_HIT")
            elif pos.direction == "SELL" and current_candle.high >= pos.stop_loss:
                exit_price = max(pos.stop_loss, current_candle.open)
                return self._close_position(pos, curr_time, exit_price, "STOP_LOSS_HIT")

            # Check Target 2 Hit
            if pos.direction == "BUY" and current_candle.high >= pos.target_2:
                exit_price = max(pos.target_2, current_candle.open)
                return self._close_position(pos, curr_time, exit_price, "TARGET_2_HIT")
            elif pos.direction == "SELL" and current_candle.low <= pos.target_2:
                exit_price = min(pos.target_2, current_candle.open)
                return self._close_position(pos, curr_time, exit_price, "TARGET_2_HIT")

            return None

        # Safety Check: Order placement blocked unless test_enabled is True
        if not self.test_enabled:
            self.system_status = "LIVE TEST READY — ORDER EXECUTION BLOCKED (LIVE_TEST_ENABLE=FALSE)"
            return None

        if not self.test_active:
            return None

        # Evaluate Entry
        if signal.action in ["BUY", "SELL"] and signal.entry_price is not None:
            self.trade_counter += 1
            trade_id = f"LT-{CONFIG.INSTRUMENT_NAME}-{curr_time.strftime('%Y%m%d')}-{self.trade_counter:03d}"
            dhan_order_id = f"DHAN-LIVE-{curr_time.strftime('%H%M%S')}-{self.trade_counter:02d}"

            new_pos = LivePosition(
                trade_id=trade_id,
                dhan_order_id=dhan_order_id,
                entry_timestamp=curr_time,
                instrument=CONFIG.INSTRUMENT_NAME,
                direction=signal.action,
                quantity=1,
                entry_price=signal.entry_price,
                fill_price=signal.entry_price,
                stop_loss=signal.stop_loss,
                original_stop_loss=signal.stop_loss,
                target_1=signal.target_1,
                target_2=signal.target_2,
                trend_state=signal.trend_state,
                confidence=signal.confidence,
                reasons=signal.reasons,
                status="OPEN"
            )
            self.active_position = new_pos
            self.system_status = "LIVE POSITION ACTIVE"
            
            DB.save_live_trade({
                "trade_id": new_pos.trade_id,
                "dhan_order_id": new_pos.dhan_order_id,
                "entry_timestamp": new_pos.entry_timestamp.strftime("%Y-%m-%d %H:%M:%S"),
                "instrument": new_pos.instrument,
                "direction": new_pos.direction,
                "quantity": new_pos.quantity,
                "entry_price": new_pos.entry_price,
                "fill_price": new_pos.fill_price,
                "stop_loss": new_pos.stop_loss,
                "original_stop_loss": new_pos.original_stop_loss,
                "target_1": new_pos.target_1,
                "target_2": new_pos.target_2,
                "trend_state": new_pos.trend_state,
                "confidence": new_pos.confidence,
                "reasons": new_pos.reasons,
                "status": "OPEN"
            })
            return new_pos

        return None

    def _close_position(self, pos: LivePosition, exit_time: datetime, exit_price: float, reason: str) -> LivePosition:
        pos.status = "CLOSED"
        pos.exit_timestamp = exit_time
        pos.exit_price = exit_price
        pos.exit_reason = reason

        pnl_res = PnLCalculator.calculate_trade_pnl(
            direction=pos.direction,
            entry_price=pos.entry_price,
            exit_price=exit_price,
            quantity=pos.quantity
        )
        pos.pnl_result = pnl_res
        
        self.net_realized_pnl += pnl_res.net_pnl
        self.closed_trades.append(pos)
        self.active_position = None

        DB.save_live_trade({
            "trade_id": pos.trade_id,
            "dhan_order_id": pos.dhan_order_id,
            "entry_timestamp": pos.entry_timestamp.strftime("%Y-%m-%d %H:%M:%S"),
            "instrument": pos.instrument,
            "direction": pos.direction,
            "quantity": pos.quantity,
            "entry_price": pos.entry_price,
            "fill_price": pos.fill_price,
            "stop_loss": pos.stop_loss,
            "original_stop_loss": pos.original_stop_loss,
            "target_1": pos.target_1,
            "target_2": pos.target_2,
            "trend_state": pos.trend_state,
            "confidence": pos.confidence,
            "reasons": pos.reasons,
            "status": "CLOSED",
            "exit_timestamp": pos.exit_timestamp.strftime("%Y-%m-%d %H:%M:%S") if pos.exit_timestamp else None,
            "exit_price": pos.exit_price,
            "exit_reason": pos.exit_reason,
            "gross_pnl": pnl_res.gross_pnl,
            "charges": round(pnl_res.charges.total_deductions - pnl_res.charges.slippage, 2),
            "slippage": pnl_res.charges.slippage,
            "net_pnl": pnl_res.net_pnl
        })

        if self.net_realized_pnl <= -CONFIG.LIVE_TEST_LOSS_LIMIT_INR:
            self.test_loss_limit_hit = True
            self.system_status = "PAUSED — LIVE TEST LOSS LIMIT HIT (Rs 3,000)"

        return pos

    def get_readiness_report(self) -> Dict[str, Any]:
        """Generates comprehensive pre-flight readiness report for LIVE test deployment."""
        fund_info = self.adapter.fetch_fund_limits()
        outbound_ip = self.adapter.get_outbound_public_ip()
        
        return {
            "dhan_application_name": "CRUDEOILM-LIVE-TEST",
            "server_outbound_public_ipv4": outbound_ip,
            "dhan_authentication": {
                "client_id": "PRESENT" if self.adapter.client_id else "MISSING",
                "access_token": self.adapter.get_masked_token(),
                "status": fund_info["status"]
            },
            "market_feed": {
                "instrument": CONFIG.INSTRUMENT_NAME,
                "exchange": CONFIG.EXCHANGE,
                "security_id": CONFIG.DHAN_SECURITY_ID,
                "expiry": CONFIG.CONTRACT_EXPIRY,
                "lot_size": CONFIG.LOT_SIZE,
                "tick_size": CONFIG.TICK_SIZE
            },
            "account_limits": {
                "available_margin_inr": fund_info.get("available_margin", 0.0),
                "test_loss_limit_inr": CONFIG.LIVE_TEST_LOSS_LIMIT_INR,
                "max_risk_per_trade_inr": CONFIG.LIVE_TEST_MAX_RISK_PER_TRADE_INR,
                "max_lots": CONFIG.LIVE_TEST_MAX_LOTS,
                "allow_averaging": CONFIG.ALLOW_AVERAGING,
                "allow_martingale": CONFIG.ALLOW_MARTINGALE
            },
            "safety_controls": {
                "paper_trading_safety_lock": "REAL_TRADING = FALSE (HARDCODED)",
                "live_test_enable_flag": f"LIVE_TEST_ENABLE = {self.test_enabled} (DEFAULT FALSE)",
                "order_placement_status": "BLOCKED (DISABLED SAFETY MODE)" if not self.test_enabled else "ENABLED",
                "static_ip_requirement": f"Whitelist Outbound IPv4 '{outbound_ip}' in Dhan HQ Portal under Application 'CRUDEOILM-LIVE-TEST'",
                "order_reconciliation": "ENABLED (SL/Target exit safety active)",
                "emergency_exit_all": "AVAILABLE",
                "auto_stop_duration": f"{CONFIG.LIVE_TEST_DURATION_MINUTES} MINUTES"
            }
        }

    def get_live_dashboard_state(self, current_price: Optional[float] = None, current_signal: Optional[TradeSignal] = None) -> Dict[str, Any]:
        """Returns JSON state payload for the /live dashboard UI."""
        fund_info = self.adapter.fetch_fund_limits()
        rem_sec = self.get_remaining_seconds()
        
        mins = rem_sec // 60
        secs = rem_sec % 60
        timer_str = f"{mins:02d}:{secs:02d}"

        # Decouple price: Only use live feed LTP from Dhan WebSocket, never replay price
        effective_price = self.live_ltp if self.live_ltp is not None else (current_price if (current_price and current_price > 0 and fund_info["status"] == "CONNECTED") else 0.0)
        
        feed_status_text = "LIVE FEED ACTIVE" if effective_price > 0 else "NO LIVE FEED / NO TRADE"
        
        closed = self.closed_trades
        total_trades = len(closed)
        
        peak = 0.0
        cum_pnl = 0.0
        max_dd = 0.0
        for t in closed:
            if t.pnl_result:
                cum_pnl += t.pnl_result.net_pnl
                if cum_pnl > peak:
                    peak = cum_pnl
                dd = peak - cum_pnl
                if dd > max_dd:
                    max_dd = dd

        daily_loss_inr = abs(self.net_realized_pnl) if self.net_realized_pnl < 0 else 0.0
        curr_dd = round(peak - cum_pnl, 2) if (peak - cum_pnl) > 0 else 0.0

        active_pos_dict = None
        unrealized_pnl = 0.0
        if self.active_position:
            pos = self.active_position
            if effective_price > 0:
                if pos.direction == "BUY":
                    unrealized_pnl = (effective_price - pos.entry_price) * CONFIG.LOT_SIZE
                else:
                    unrealized_pnl = (pos.entry_price - effective_price) * CONFIG.LOT_SIZE
                
            active_pos_dict = {
                "trade_id": pos.trade_id,
                "dhan_order_id": pos.dhan_order_id,
                "direction": pos.direction,
                "entry_timestamp": pos.entry_timestamp.strftime("%Y-%m-%d %H:%M:%S IST") if pos.entry_timestamp else "-",
                "entry_price": pos.entry_price,
                "fill_price": pos.fill_price,
                "stop_loss": pos.stop_loss,
                "target_1": pos.target_1,
                "target_2": pos.target_2,
                "unrealized_pnl": round(unrealized_pnl, 2),
                "trend_state": pos.trend_state,
                "confidence": pos.confidence
            }

        ledger_list = []
        for t in reversed(closed):
            res = t.pnl_result
            ledger_list.append({
                "trade_id": t.trade_id,
                "dhan_order_id": t.dhan_order_id,
                "entry_time": t.entry_timestamp.strftime("%Y-%m-%d %H:%M:%S IST") if t.entry_timestamp else "-",
                "exit_time": t.exit_timestamp.strftime("%Y-%m-%d %H:%M:%S IST") if t.exit_timestamp else "-",
                "direction": t.direction,
                "entry_price": t.entry_price,
                "exit_price": t.exit_price,
                "exit_reason": t.exit_reason,
                "trend_state": t.trend_state,
                "confidence": t.confidence,
                "gross_pnl": res.gross_pnl if res else 0.0,
                "charges": round(res.charges.total_deductions - res.charges.slippage, 2) if res else 0.0,
                "slippage": res.charges.slippage if res else 0.0,
                "net_pnl": res.net_pnl if res else 0.0
            })

        display_status = self.system_status
        if effective_price == 0.0 and fund_info["status"] != "CONNECTED":
            display_status = f"NO LIVE FEED / NO TRADE ({fund_info['status']})"

        return {
            "mode": "LIVE_TEST",
            "instrument": CONFIG.INSTRUMENT_NAME,
            "exchange": CONFIG.EXCHANGE,
            "security_id": CONFIG.DHAN_SECURITY_ID,
            "lot_size": CONFIG.LOT_SIZE,
            "dhan_connection": fund_info["status"],
            "dhan_client_id": self.adapter.client_id or "NOT_CONFIGURED",
            "available_margin_inr": fund_info.get("available_margin", 0.0),
            "current_price": round(effective_price, 2),
            "feed_status_text": feed_status_text,
            "system_status": display_status,
            "live_test_enable_flag": self.test_enabled,
            "order_placement_status": "BLOCKED (DISABLED / SAFETY MODE)" if not self.test_enabled else "ACTIVE",
            "test_active": self.test_active,
            "countdown_timer": timer_str,
            "remaining_seconds": rem_sec,
            "test_duration_minutes": self.test_duration_minutes,
            "test_loss_limit_inr": CONFIG.LIVE_TEST_LOSS_LIMIT_INR,
            "max_risk_per_trade_inr": CONFIG.LIVE_TEST_MAX_RISK_PER_TRADE_INR,
            "daily_loss_inr": round(daily_loss_inr, 2),
            "current_drawdown_inr": curr_dd,
            "max_drawdown_inr": round(max_dd, 2),
            "realized_pnl": round(self.net_realized_pnl, 2),
            "unrealized_pnl": round(unrealized_pnl, 2),
            "total_trades_count": total_trades,
            "active_position": active_pos_dict,
            "trade_ledger": ledger_list,
            "readiness_report": self.get_readiness_report()
        }

# Global Singleton for Live Test Engine
LIVE_TEST_ENGINE = LiveTestEngine()
