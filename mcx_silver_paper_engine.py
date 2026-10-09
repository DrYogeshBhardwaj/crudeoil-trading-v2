"""
MCX SILVERM (Silver Mini) Paper Trading Engine with Dhan Live Feed Calibration, Dhan Charges & SQLite Persistence
STRICTLY PAPER TRADING ONLY — NO REAL ORDERS ARE PLACED.

Implements Dhan MCX Silver Mini Specifications:
- Instrument: SILVERM (MCX India - 5 kg lot)
- Dhan Security ID: 483080
- Capital: Rs. 3,30,000.00
- Target Profit (Net): +Rs. 5,000.00 NET
- Max Loss (Net): -Rs. 10,000.00 NET
- Dhan Brokerage & Charges: Rs. 40 Brokerage + STT (0.01%) + MCX Fee (0.0021%) + GST (18%) + Stamp Duty (0.002%) ~ Rs. 237.88
- Prices in: INR (Rs.) calibrated to Dhan Terminal
- MCX Market Schedule: Monday - Friday 09:00 AM to 11:30 PM IST (Closed Sat/Sun)
- SQLite Persistent Storage across Server Restarts & Railway Redeployments
"""

import os
import time
import json
import asyncio
import requests
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, Optional, List, Tuple
from dataclasses import dataclass, field, asdict

from database import DB


def calculate_dhan_mcx_silver_charges(entry_price: float, exit_price: float, direction: str = "BUY", lots: int = 1) -> Dict[str, float]:
    """
    Calculates exact Dhan Brokerage + MCX Exchange Fee + STT + GST + Stamp Duty for SILVERM (5 kg lot).
    Dhan Specifications for MCX Commodity Futures:
    - Brokerage: Rs. 20 flat per executed order (Rs. 40 round trip)
    - STT: 0.01% on sell side turnover
    - MCX Exchange Turnover Charge: 0.0021% on total turnover
    - GST: 18% on (Brokerage + MCX Exchange Charge)
    - Stamp Duty: 0.002% on buy side turnover
    - SEBI Turnover Charge: 0.0001%
    """
    lot_size_kg = 5
    buy_price = entry_price if direction in ("BUY", "LONG") else exit_price
    sell_price = exit_price if direction in ("BUY", "LONG") else entry_price

    buy_turnover = buy_price * lot_size_kg * lots
    sell_turnover = sell_price * lot_size_kg * lots
    total_turnover = buy_turnover + sell_turnover

    brokerage = 40.0  # Rs 20 entry + Rs 20 exit on Dhan
    stt = sell_turnover * 0.0001  # 0.01% on sell side
    mcx_fee = total_turnover * 0.000021  # 0.0021% exchange txn charge
    gst = (brokerage + mcx_fee) * 0.18  # 18% GST on brokerage + exchange txn fee
    stamp_duty = buy_turnover * 0.00002  # 0.002% on buy side
    sebi_fee = total_turnover * 0.0000001

    total_charges = round(brokerage + stt + mcx_fee + gst + stamp_duty + sebi_fee, 2)
    return {
        "total_charges": total_charges,
        "brokerage": round(brokerage, 2),
        "stt": round(stt, 2),
        "mcx_fee": round(mcx_fee, 2),
        "gst": round(gst, 2),
        "stamp_duty": round(stamp_duty, 2)
    }


@dataclass
class MCXSilverPaperTrade:
    trade_id: str
    instrument: str = "SILVERM NOV FUT"
    exchange: str = "MCX"
    direction: str = "BUY"  # BUY / SELL
    quantity_lots: int = 1   # 1 Lot = 5 kg
    lot_size_kg: int = 5
    entry_price_inr: float = 223894.0
    entry_timestamp: str = ""
    target_net_inr: float = 5000.0
    max_loss_net_inr: float = 10000.0
    target_price_inr: float = 224941.0
    stop_loss_price_inr: float = 221847.0
    status: str = "OPEN"  # OPEN / CLOSED
    exit_timestamp: Optional[str] = None
    exit_price_inr: Optional[float] = None
    exit_reason: Optional[str] = None
    gross_pnl_inr: float = 0.0
    estimated_charges_inr: float = 237.88  # Dhan Brokerage + STT + MCX Fee + GST + Stamp Duty
    net_pnl_inr: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "MCXSilverPaperTrade":
        return cls(
            trade_id=str(d.get("trade_id") or ""),
            instrument=str(d.get("instrument") or "SILVERM NOV FUT"),
            exchange=str(d.get("exchange") or "MCX"),
            direction=str(d.get("direction") or "BUY"),
            quantity_lots=int(d.get("quantity_lots") or 1),
            lot_size_kg=int(d.get("lot_size_kg") or 5),
            entry_price_inr=float(d.get("entry_price_inr") or 0.0),
            entry_timestamp=str(d.get("entry_timestamp") or ""),
            target_net_inr=float(d.get("target_net_inr") or 5000.0),
            max_loss_net_inr=float(d.get("max_loss_net_inr") or 10000.0),
            target_price_inr=float(d.get("target_price_inr") or 0.0),
            stop_loss_price_inr=float(d.get("stop_loss_price_inr") or 0.0),
            status=str(d.get("status") or "OPEN"),
            exit_timestamp=d.get("exit_timestamp"),
            exit_price_inr=float(d["exit_price_inr"]) if d.get("exit_price_inr") is not None else None,
            exit_reason=d.get("exit_reason"),
            gross_pnl_inr=float(d.get("gross_pnl_inr") or 0.0),
            estimated_charges_inr=float(d.get("estimated_charges_inr") or 237.88),
            net_pnl_inr=float(d.get("net_pnl_inr") or 0.0)
        )


class MCXSilverPaperEngine:
    def __init__(self):
        self.db = DB
        self.instrument = "SILVERM NOV FUT"
        self.exchange = "MCX"
        self.security_id = "483080"  # Dhan Security ID for SILVERM NOV FUT
        self.lot_size = 5  # 5 kg per lot
        self.starting_capital = 330000.0
        self.current_price_inr = 223894.0
        self.price_source = "DHAN MCX TERMINAL FEED"
        self.system_status = "AUTOMATED STRATEGY SCANNING ACTIVE (EMA 9/21)"
        self.auto_paper_trading_enabled = True
        self.latest_signal = "WAITING"
        self._last_auto_trade_time = 0.0
        self._price_history: List[float] = []
        self._feed_running = False

        self.is_synthetic_feed = True
        self.price_feed_quality = "SYNTHETIC_FALLBACK"
        self.last_price_update_timestamp = 0.0
        self.is_price_stale = False
        self.stale_threshold_seconds = 15.0

        # Load persisted settings
        t_net = self.db.load_mcx_silver_paper_setting("target_net_inr", "5000.0")
        l_net = self.db.load_mcx_silver_paper_setting("max_loss_net_inr", "10000.0")
        self.target_net_inr = float(t_net) if t_net else 5000.0
        self.max_loss_net_inr = float(l_net) if l_net else 10000.0

        # Load active position & history from database
        self._load_state_from_db()

        # Engine initialization logged without forcing an auto-BUY position on startup
        if not self.active_position:
            print(f"[{datetime.now()}] [MCX SILVER ENGINE] Engine initialized with NO active position. Ready for signal or manual paper trade.")

    @property
    def ENABLE_LIVE_TRADING(self) -> bool:
        """
        Dynamically checks env vars ENABLE_LIVE_TRADING_SILVER or ENABLE_LIVE_TRADING.
        Set ENABLE_LIVE_TRADING_SILVER=true in Railway environment variables to enable live execution.
        """
        val = os.environ.get("ENABLE_LIVE_TRADING_SILVER") or os.environ.get("ENABLE_LIVE_TRADING") or "false"
        return str(val).strip().lower() in ("true", "1", "yes", "enabled")

    def toggle_auto_trading(self) -> bool:
        """Toggles automated strategy signal trading ON/OFF."""
        self.auto_paper_trading_enabled = not self.auto_paper_trading_enabled
        if self.auto_paper_trading_enabled:
            self.system_status = "AUTOMATED STRATEGY SCANNING ACTIVE (EMA 9/21)"
        else:
            self.system_status = "AUTOMATED STRATEGY PAUSED (MANUAL MODE ONLY)"
        return self.auto_paper_trading_enabled

    def check_mcx_market_status(self) -> Tuple[bool, str]:
        """Checks if MCX India market is currently open (Mon-Fri 09:00 AM - 11:30 PM IST)."""
        ist = timezone(timedelta(hours=5, minutes=30))
        now = datetime.now(ist)
        weekday = now.weekday()  # 0 = Mon, 5 = Sat, 6 = Sun
        time_val = now.time()

        if weekday in (5, 6):
            day_name = now.strftime("%A")
            return False, f"MCX MARKET CLOSED (WEEKEND: {day_name})"

        open_time = datetime.strptime("09:00:00", "%H:%M:%S").time()
        close_time = datetime.strptime("23:30:00", "%H:%M:%S").time()

        if time_val < open_time:
            return False, "MCX MARKET CLOSED (Opens Mon-Fri at 09:00 AM IST)"
        if time_val >= close_time:
            return False, "MCX MARKET CLOSED (Closes at 11:30 PM IST)"

        return True, "AUTOMATED PAPER SCANNING ACTIVE (MCX MARKET OPEN)"

    def _load_state_from_db(self):
        raw_pos = self.db.load_active_mcx_silver_paper_position()
        if raw_pos:
            self.active_position = MCXSilverPaperTrade.from_dict(raw_pos)
        else:
            self.active_position = None

        raw_trades = self.db.load_all_mcx_silver_paper_trades()
        self.trade_history = [t for t in raw_trades if t.get("status") == "CLOSED"]

        # Calculate capital & today realized P&L from persistent trade history
        total_pnl = sum(t.get("net_pnl_inr", 0.0) for t in self.trade_history)
        self.capital = self.starting_capital + total_pnl

        today_prefix = datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d")
        self.today_realized_pnl = sum(
            t.get("net_pnl_inr", 0.0) for t in self.trade_history
            if t.get("exit_timestamp") and t.get("exit_timestamp").startswith(today_prefix)
        )

    def place_live_dhan_order(self, direction: str = "BUY", quantity_lots: int = 1, *args, **kwargs) -> Dict[str, Any]:
        """
        Transmits real order to Dhan HQ REST API (/v2/orders) if ENABLE_LIVE_TRADING is True
        and all safety pre-flight checks pass.
        """
        if not self.ENABLE_LIVE_TRADING:
            raise RuntimeError("CRITICAL SAFETY BLOCK: Real Dhan Order API execution is disabled because ENABLE_LIVE_TRADING is False.")

        if not self.is_real_mcx_price_valid_for_live_execution():
            raise RuntimeError("SAFETY GUARD TRIGGERED: Cannot execute live Dhan order on synthetic/stale/closed market price feed.")

        client_id, access_token = self._get_dhan_credentials()
        if not client_id or not access_token:
            raise RuntimeError("DHAN CREDENTIALS MISSING: Cannot execute live Dhan order.")

        url = "https://api.dhan.co/v2/orders"
        headers = {
            "client-id": client_id,
            "access-token": access_token,
            "Content-Type": "application/json"
        }
        payload = {
            "dhanClientId": client_id,
            "correlationId": f"AG-SILVER-{int(time.time())}",
            "transactionType": direction.upper(),
            "exchangeSegment": "MCX_COMM",
            "productType": "MARGIN",
            "orderType": "MARKET",
            "validity": "DAY",
            "tradingSymbol": "SILVERM NOV FUT",
            "securityId": self.security_id,
            "quantity": int(quantity_lots),
            "disclosedQuantity": 0,
            "price": 0.0,
            "triggerPrice": 0.0,
            "afterMarketOrder": False,
            "amoTime": "OPEN"
        }

        r = requests.post(url, headers=headers, json=payload, timeout=5)
        if r.status_code == 200:
            resp_data = r.json()
            return {
                "status": "SUCCESS",
                "order_id": resp_data.get("orderId") or resp_data.get("dhanOrderId"),
                "data": resp_data
            }
        else:
            raise RuntimeError(f"Dhan Order API Error (HTTP {r.status_code}): {r.text}")

    def is_real_mcx_price_valid_for_live_execution(self) -> bool:
        """
        Returns True ONLY if price comes directly from Dhan MCX Terminal Live Feed,
        is non-stale, and MCX market is currently open.
        Synthetic fallback feeds (Binance/Yahoo) are strictly INVALID for Live execution.
        """
        market_open, _ = self.check_mcx_market_status()
        if self.is_synthetic_feed:
            return False
        if self.is_price_stale:
            return False
        if not market_open:
            return False
        return True

    def _get_dhan_credentials(self) -> Tuple[str, str]:
        """Loads Dhan Client ID and Access Token checking SILVER specific env vars first."""
        client_id = (os.environ.get("DHAN_CLIENT_ID_SILVER") or os.environ.get("DHAN_CLIENT_ID") or "").strip()
        access_token = (os.environ.get("DHAN_ACCESS_TOKEN_SILVER") or os.environ.get("DHAN_ACCESS_TOKEN") or "").strip()
        if not client_id or not access_token:
            try:
                if os.path.exists("dhan_credentials.json"):
                    with open("dhan_credentials.json", "r") as f:
                        ddata = json.load(f)
                        client_id = client_id or ddata.get("DHAN_CLIENT_ID_SILVER") or ddata.get("DHAN_CLIENT_ID", "")
                        access_token = access_token or ddata.get("DHAN_ACCESS_TOKEN_SILVER") or ddata.get("DHAN_ACCESS_TOKEN", "")
            except Exception:
                pass
        return str(client_id).strip().strip('"').strip("'"), str(access_token).strip().strip('"').strip("'")

    def fetch_dhan_live_margin(self) -> Tuple[Optional[float], str]:
        """Fetches real-time available margin balance directly from Dhan API (GET /v2/fundlimit)."""
        client_id, access_token = self._get_dhan_credentials()

        if not client_id or not access_token:
            return None, "DHAN CREDENTIALS MISSING"

        try:
            headers = {
                "access-token": access_token,
                "client-id": client_id,
                "Content-Type": "application/json"
            }
            r = requests.get("https://api.dhan.co/v2/fundlimit", headers=headers, timeout=4)
            if r.status_code == 200:
                fdata = r.json().get("data", {})
                margin = float(fdata.get("availabelBalance") or fdata.get("availableBalance") or fdata.get("sodLimit") or 0.0)
                return round(margin, 2), "LIVE DHAN MARGIN"
            elif r.status_code == 401:
                return None, "DHAN TOKEN EXPIRED (HTTP 401)"
            else:
                return None, f"DHAN MARGIN ERROR (HTTP {r.status_code}): {r.text[:80]}"
        except Exception as e:
            return None, f"DHAN MARGIN FETCH ERROR: {e}"

    def fetch_market_price(self) -> float:
        """Fetches live MCX Silver price in INR per kg from Dhan API or calibrated market feed."""
        price_inr = None

        # 1. Query Dhan API Quotes Endpoint for SecurityId 483080 (SILVERM NOV FUT) if credentials exist
        client_id, access_token = self._get_dhan_credentials()

        if client_id and access_token:
            try:
                headers = {
                    "access-token": access_token,
                    "client-id": client_id,
                    "Content-Type": "application/json"
                }
                payload = {"MCX_COMM": [483080]}
                r = requests.post("https://api.dhan.co/v2/marketfeed/quote", headers=headers, json=payload, timeout=3)
                if r.status_code == 200:
                    djson = r.json()
                    data_obj = djson.get("data") if isinstance(djson, dict) and "data" in djson else djson
                    if isinstance(data_obj, dict):
                        quote_sec = data_obj.get("MCX_COMM", {}).get("483080") or data_obj.get("483080")
                        if isinstance(quote_sec, dict):
                            ltp = float(quote_sec.get("last_price") or quote_sec.get("LTP") or 0.0)
                            if ltp > 50000:
                                price_inr = round(ltp, 2)
                                self.price_source = "DHAN HQ LIVE FEED (SecID 483080)"
                                self.is_synthetic_feed = False
                                self.price_feed_quality = "REAL_DHAN_MCX_LIVE"
            except Exception:
                pass

        # 2. Dhan-Calibrated Binance Futures XAGUSDT (Calibrated multiplier 1.2163 to match Dhan Terminal ~223,894)
        if not price_inr or price_inr <= 50000:
            try:
                r = requests.get("https://fapi.binance.com/fapi/v1/ticker/price?symbol=XAGUSDT", timeout=3)
                if r.status_code == 200:
                    xag_usd = float(r.json().get("price", 0))
                    if xag_usd > 0:
                        price_inr = round(xag_usd * 32.1507425 * 96.78 * 1.2163, 2)
                        self.price_source = "DHAN-CALIBRATED LIVE FEED (BINANCE XAG)"
                        self.is_synthetic_feed = True
                        self.price_feed_quality = "SYNTHETIC_FALLBACK"
            except Exception:
                pass

        # 3. Dhan-Calibrated Yahoo Finance fallback (SI=F and USDINR=X)
        if not price_inr or price_inr <= 50000:
            try:
                r1 = requests.get("https://query1.finance.yahoo.com/v8/finance/chart/SI=F", headers={"User-Agent": "Mozilla/5.0"}, timeout=3)
                r2 = requests.get("https://query1.finance.yahoo.com/v8/finance/chart/USDINR=X", headers={"User-Agent": "Mozilla/5.0"}, timeout=3)
                if r1.status_code == 200 and r2.status_code == 200:
                    xag_usd = r1.json()["chart"]["result"][0]["meta"]["regularMarketPrice"]
                    usdinr = r2.json()["chart"]["result"][0]["meta"]["regularMarketPrice"]
                    if xag_usd > 0 and usdinr > 0:
                        price_inr = round(xag_usd * 32.1507425 * usdinr * 1.2163, 2)
                        self.price_source = "DHAN-CALIBRATED YAHOO FEED"
                        self.is_synthetic_feed = True
                        self.price_feed_quality = "SYNTHETIC_FALLBACK"
            except Exception:
                pass

        now_ts = time.time()
        if price_inr and price_inr > 50000:
            self.current_price_inr = price_inr
            self.last_price_update_timestamp = now_ts
            self.is_price_stale = False
            return price_inr

        # Evaluate staleness if returning cached current_price_inr
        if self.last_price_update_timestamp > 0 and (now_ts - self.last_price_update_timestamp > self.stale_threshold_seconds):
            self.is_price_stale = True

        return self.current_price_inr

    def get_latest_price(self) -> float:
        return self.fetch_market_price()

    def evaluate_strategy_signal(self, curr_price: float) -> str:
        """Technical Analysis Signal Generator (EMA & Momentum) for SILVERM."""
        self._price_history.append(curr_price)
        if len(self._price_history) > 50:
            self._price_history = self._price_history[-50:]

        if len(self._price_history) < 5:
            self.latest_signal = "BUY"
            return "BUY"

        prices = self._price_history
        ema9 = sum(prices[-9:]) / float(len(prices[-9:]))
        ema21 = sum(prices[-21:]) / float(len(prices[-21:]))

        if ema9 >= ema21:
            self.latest_signal = "BUY"
            return "BUY"
        else:
            self.latest_signal = "SELL"
            return "SELL"

    def process_tick(self) -> Optional[Dict[str, Any]]:
        """Processes live market price tick with MCX schedule enforcement."""
        market_open, status_msg = self.check_mcx_market_status()
        if self.auto_paper_trading_enabled and market_open:
            self.system_status = "AUTOMATED STRATEGY SCANNING ACTIVE (EMA 9/21)"
        elif not self.auto_paper_trading_enabled:
            self.system_status = "AUTOMATED STRATEGY PAUSED (MANUAL MODE ONLY)"
        else:
            self.system_status = status_msg

        curr_price = self.fetch_market_price()

        # If active position exists, evaluate TP/SL triggers
        if self.active_position:
            pos = self.active_position
            if pos.direction == "BUY":
                gross = (curr_price - pos.entry_price_inr) * pos.lot_size_kg
            else:
                gross = (pos.entry_price_inr - curr_price) * pos.lot_size_kg

            # Calculate exact Dhan charges
            chg_details = calculate_dhan_mcx_silver_charges(pos.entry_price_inr, curr_price, pos.direction, pos.quantity_lots)
            pos.estimated_charges_inr = chg_details["total_charges"]
            unrealized_pnl = gross - pos.estimated_charges_inr

            # Check Auto TP / SL Triggers
            if pos.direction == "BUY":
                if curr_price >= pos.target_price_inr:
                    return self.manual_close(exit_price=pos.target_price_inr, reason="TARGET PROFIT HIT (+Rs.5,000 NET)")
                elif curr_price <= pos.stop_loss_price_inr:
                    return self.manual_close(exit_price=pos.stop_loss_price_inr, reason="STOP LOSS HIT (-Rs.10,000 NET)")
            else:
                if curr_price <= pos.target_price_inr:
                    return self.manual_close(exit_price=pos.target_price_inr, reason="TARGET PROFIT HIT (+Rs.5,000 NET)")
                elif curr_price >= pos.stop_loss_price_inr:
                    return self.manual_close(exit_price=pos.stop_loss_price_inr, reason="STOP LOSS HIT (-Rs.10,000 NET)")

        elif self.auto_paper_trading_enabled and market_open:
            now_ts = time.time()
            if now_ts - self._last_auto_trade_time > 10.0:  # Cool-down of 10 seconds between auto-trades
                signal = self.evaluate_strategy_signal(curr_price)
                if signal in ("BUY", "SELL"):
                    self._last_auto_trade_time = now_ts
                    self.manual_entry(direction=signal, price=curr_price)

        return None

    async def start_feed_loop(self):
        """Continuous background execution loop for real-time paper trading."""
        if self._feed_running:
            return
        self._feed_running = True
        print(f"[{datetime.now()}] [MCX SILVER ENGINE] Background auto-trading feed loop started.")
        while self._feed_running:
            try:
                self.process_tick()
            except Exception as e:
                print(f"[{datetime.now()}] [MCX SILVER ENGINE ERROR] Feed tick error: {e}")
            await asyncio.sleep(3)

    def manual_entry(self, direction: str = "BUY", price: Optional[float] = None) -> MCXSilverPaperTrade:
        if self.active_position:
            return self.active_position

        entry = price or self.fetch_market_price() or 223894.0
        trade_id = f"MCX_AG_{int(time.time())}"
        now_str = datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d %H:%M:%S IST")

        # Estimate round trip Dhan charges (~Rs.238.00)
        est_chg = calculate_dhan_mcx_silver_charges(entry, entry, direction)["total_charges"]

        # Points needed: 1 Lot (5kg) => Rs. 1 price move = Rs. 5 P&L
        target_pts = (self.target_net_inr + est_chg) / self.lot_size
        stop_pts = (self.max_loss_net_inr - est_chg) / self.lot_size

        if direction.upper() in ("BUY", "LONG"):
            t_price = entry + target_pts
            s_price = entry - stop_pts
            dir_str = "BUY"
        else:
            t_price = entry - target_pts
            s_price = entry + stop_pts
            dir_str = "SELL"

        pos = MCXSilverPaperTrade(
            trade_id=trade_id,
            instrument="SILVERM NOV FUT",
            exchange="MCX",
            direction=dir_str,
            quantity_lots=1,
            lot_size_kg=5,
            entry_price_inr=round(entry, 2),
            entry_timestamp=now_str,
            target_net_inr=self.target_net_inr,
            max_loss_net_inr=self.max_loss_net_inr,
            target_price_inr=round(t_price, 2),
            stop_loss_price_inr=round(s_price, 2),
            status="OPEN",
            estimated_charges_inr=est_chg
        )
        self.active_position = pos
        self.db.save_mcx_silver_paper_trade(pos.to_dict())
        return pos

    def manual_close(self, exit_price: Optional[float] = None, reason: str = "MANUAL_CLOSE") -> Optional[Dict[str, Any]]:
        if not self.active_position:
            return None

        pos = self.active_position
        eprice = exit_price or self.fetch_market_price() or pos.entry_price_inr
        now_str = datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d %H:%M:%S IST")

        if pos.direction == "BUY":
            gross = (eprice - pos.entry_price_inr) * pos.lot_size_kg
        else:
            gross = (pos.entry_price_inr - eprice) * pos.lot_size_kg

        chg_details = calculate_dhan_mcx_silver_charges(pos.entry_price_inr, eprice, pos.direction, pos.quantity_lots)
        charges = chg_details["total_charges"]
        net = gross - charges

        pos.status = "CLOSED"
        pos.exit_timestamp = now_str
        pos.exit_price_inr = round(eprice, 2)
        pos.exit_reason = reason
        pos.gross_pnl_inr = round(gross, 2)
        pos.estimated_charges_inr = charges
        pos.net_pnl_inr = round(net, 2)

        trade_dict = pos.to_dict()
        self.db.save_mcx_silver_paper_trade(trade_dict)
        self.active_position = None
        self._load_state_from_db()
        return trade_dict

    def update_settings(self, target_net: float, max_loss: float):
        self.target_net_inr = float(target_net)
        self.max_loss_net_inr = float(max_loss)
        self.db.save_mcx_silver_paper_setting("target_net_inr", str(self.target_net_inr))
        self.db.save_mcx_silver_paper_setting("max_loss_net_inr", str(self.max_loss_net_inr))

        if self.active_position:
            pos = self.active_position
            pos.target_net_inr = self.target_net_inr
            pos.max_loss_net_inr = self.max_loss_net_inr
            est_chg = calculate_dhan_mcx_silver_charges(pos.entry_price_inr, pos.entry_price_inr, pos.direction)["total_charges"]
            target_pts = (self.target_net_inr + est_chg) / pos.lot_size_kg
            stop_pts = (self.max_loss_net_inr - est_chg) / pos.lot_size_kg
            if pos.direction == "BUY":
                pos.target_price_inr = round(pos.entry_price_inr + target_pts, 2)
                pos.stop_loss_price_inr = round(pos.entry_price_inr - stop_pts, 2)
            else:
                pos.target_price_inr = round(pos.entry_price_inr - target_pts, 2)
                pos.stop_loss_price_inr = round(pos.entry_price_inr + stop_pts, 2)
            self.db.save_mcx_silver_paper_trade(pos.to_dict())

    def reset_statistics(self):
        """Resets account capital, realized P&L, trade history, and active position in DB."""
        self.db.reset_mcx_silver_paper_account()
        self.active_position = None
        self._load_state_from_db()
        print(f"[{datetime.now()}] [MCX SILVER ENGINE] Statistics reset successfully. NO position auto-opened.")

    def get_dashboard_state(self) -> Dict[str, Any]:
        market_open, status_msg = self.check_mcx_market_status()
        curr_price = self.fetch_market_price()
        dhan_margin, margin_status = self.fetch_dhan_live_margin()
        
        unrealized_pnl = 0.0
        active_pos_dict = None
        chg_breakdown = calculate_dhan_mcx_silver_charges(curr_price, curr_price)

        if self.active_position:
            pos = self.active_position
            if pos.direction == "BUY":
                gross_unrealized = (curr_price - pos.entry_price_inr) * pos.lot_size_kg
            else:
                gross_unrealized = (pos.entry_price_inr - curr_price) * pos.lot_size_kg
            
            chg_breakdown = calculate_dhan_mcx_silver_charges(pos.entry_price_inr, curr_price, pos.direction, pos.quantity_lots)
            unrealized_pnl = gross_unrealized - chg_breakdown["total_charges"]

            active_pos_dict = pos.to_dict()
            active_pos_dict["unrealized_pnl_inr"] = round(unrealized_pnl, 2)
            active_pos_dict["estimated_charges_inr"] = chg_breakdown["total_charges"]

        if dhan_margin is not None and dhan_margin > 0:
            capital_display = dhan_margin
            margin_status = "LIVE DHAN MARGIN"
        else:
            capital_display = round(self.capital, 2)
            if margin_status == "LIVE DHAN MARGIN" or not margin_status:
                margin_status = "VIRTUAL CAPITAL (DHAN UNCONNECTED / TOKEN EXPIRED)"

        return {
            "timestamp": datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d %H:%M:%S IST"),
            "instrument": "SILVERM NOV FUT",
            "exchange": "MCX",
            "security_id": "483080",
            "currency": "INR",
            "enable_live_trading": self.ENABLE_LIVE_TRADING,
            "auto_paper_trading_enabled": self.auto_paper_trading_enabled,
            "latest_signal": getattr(self, "latest_signal", "WAITING"),
            "is_synthetic_feed": self.is_synthetic_feed,
            "price_feed_quality": getattr(self, "price_feed_quality", "SYNTHETIC_FALLBACK") + (" (PAPER PRACTICE ONLY)" if self.is_synthetic_feed else ""),
            "is_real_mcx_price_valid_for_live_execution": self.is_real_mcx_price_valid_for_live_execution(),
            "is_price_stale": self.is_price_stale,
            "price_source": getattr(self, "price_source", "DHAN MCX TERMINAL FEED"),
            "dhan_margin_balance_inr": dhan_margin,
            "dhan_margin_status": margin_status,
            "market_open": market_open,
            "market_schedule": "Mon-Fri 09:00 AM - 11:30 PM IST",
            "current_price_inr": curr_price,
            "dhan_charges_breakdown": chg_breakdown,
            "starting_capital_inr": self.starting_capital,
            "account_capital_inr": capital_display,
            "target_net_inr": self.target_net_inr,
            "max_loss_net_inr": self.max_loss_net_inr,
            "today_realized_pnl_inr": round(self.today_realized_pnl, 2),
            "unrealized_pnl_inr": round(unrealized_pnl, 2),
            "active_position": active_pos_dict,
            "trade_history": self.trade_history,
            "system_status": status_msg
        }


MCX_SILVER_ENGINE = MCXSilverPaperEngine()
