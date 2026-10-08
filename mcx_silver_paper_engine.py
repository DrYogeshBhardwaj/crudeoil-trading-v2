"""
MCX SILVERM (Silver Mini) Paper Trading Engine with Auto-Trading Loop, Market Timing Control & SQLite Persistence
STRICTLY PAPER TRADING ONLY — NO REAL ORDERS ARE PLACED.

Implements MCX Silver Mini Specifications:
- Instrument: SILVERM (MCX India - 5 kg lot)
- Capital: Rs. 3,30,000.00
- Target Profit (Net): +Rs. 5,000.00 NET
- Max Loss (Net): -Rs. 10,000.00 NET
- Prices in: INR (Rs.)
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


@dataclass
class MCXSilverPaperTrade:
    trade_id: str
    instrument: str = "SILVERM NOV FUT"
    exchange: str = "MCX"
    direction: str = "BUY"  # BUY / SELL
    quantity_lots: int = 1   # 1 Lot = 5 kg
    lot_size_kg: int = 5
    entry_price_inr: float = 226500.0
    entry_timestamp: str = ""
    target_net_inr: float = 5000.0
    max_loss_net_inr: float = 10000.0
    target_price_inr: float = 227517.0
    stop_loss_price_inr: float = 224517.0
    status: str = "OPEN"  # OPEN / CLOSED
    exit_timestamp: Optional[str] = None
    exit_price_inr: Optional[float] = None
    exit_reason: Optional[str] = None
    gross_pnl_inr: float = 0.0
    estimated_charges_inr: float = 85.0  # Brokerage + STT + GST
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
            estimated_charges_inr=float(d.get("estimated_charges_inr") or 85.0),
            net_pnl_inr=float(d.get("net_pnl_inr") or 0.0)
        )


class MCXSilverPaperEngine:
    def __init__(self):
        self.db = DB
        self.instrument = "SILVERM NOV FUT"
        self.exchange = "MCX"
        self.lot_size = 5  # 5 kg per lot
        self.starting_capital = 330000.0
        self.current_price_inr = 226500.0
        self.system_status = "AUTOMATED PAPER SCANNING ACTIVE"
        self.auto_paper_trading_enabled = True
        self._price_history: List[float] = []
        self._feed_running = False

        # Load persisted settings
        t_net = self.db.load_mcx_silver_paper_setting("target_net_inr", "5000.0")
        l_net = self.db.load_mcx_silver_paper_setting("max_loss_net_inr", "10000.0")
        self.target_net_inr = float(t_net) if t_net else 5000.0
        self.max_loss_net_inr = float(l_net) if l_net else 10000.0

        # Load active position & history from database
        self._load_state_from_db()

        # If no active position in DB and market is open, initialize open position
        if not self.active_position:
            m_open, _ = self.check_mcx_market_status()
            if m_open:
                initial_price = self.fetch_market_price() or 226500.0
                self.manual_entry(direction="BUY", price=initial_price)

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

    def fetch_market_price(self) -> float:
        """Fetches live MCX Silver price in INR per kg with multi-source fallback."""
        price_inr = None

        # 1. Binance Futures XAGUSDT
        try:
            r = requests.get("https://fapi.binance.com/fapi/v1/ticker/price?symbol=XAGUSDT", timeout=3)
            if r.status_code == 200:
                xag_usd = float(r.json().get("price", 0))
                if xag_usd > 0:
                    # Convert USD/oz to INR/kg: 1 kg = 32.1507425 troy oz
                    # USDINR rate ~96.78 + MCX import duty/landed multiplier (~1.235)
                    price_inr = round(xag_usd * 32.1507425 * 96.78 * 1.235, 2)
        except Exception:
            pass

        # 2. Yahoo Finance fallback (SI=F and USDINR=X)
        if not price_inr or price_inr <= 50000:
            try:
                r1 = requests.get("https://query1.finance.yahoo.com/v8/finance/chart/SI=F", headers={"User-Agent": "Mozilla/5.0"}, timeout=3)
                r2 = requests.get("https://query1.finance.yahoo.com/v8/finance/chart/USDINR=X", headers={"User-Agent": "Mozilla/5.0"}, timeout=3)
                if r1.status_code == 200 and r2.status_code == 200:
                    xag_usd = r1.json()["chart"]["result"][0]["meta"]["regularMarketPrice"]
                    usdinr = r2.json()["chart"]["result"][0]["meta"]["regularMarketPrice"]
                    if xag_usd > 0 and usdinr > 0:
                        price_inr = round(xag_usd * 32.1507425 * usdinr * 1.235, 2)
            except Exception:
                pass

        if price_inr and price_inr > 50000:
            self.current_price_inr = price_inr
            return price_inr

        return self.current_price_inr

    def get_latest_price(self) -> float:
        return self.fetch_market_price()

    def evaluate_strategy_signal(self, curr_price: float) -> str:
        """Technical Analysis Signal Generator (EMA & Momentum) for SILVERM."""
        self._price_history.append(curr_price)
        if len(self._price_history) > 50:
            self._price_history = self._price_history[-50:]

        if len(self._price_history) < 5:
            return "BUY"

        prices = self._price_history
        ema9 = sum(prices[-9:]) / float(len(prices[-9:]))
        ema21 = sum(prices[-21:]) / float(len(prices[-21:]))

        if ema9 >= ema21:
            return "BUY"
        else:
            return "SELL"

    def process_tick(self) -> Optional[Dict[str, Any]]:
        """Processes live market price tick with MCX schedule enforcement."""
        market_open, status_msg = self.check_mcx_market_status()
        self.system_status = status_msg

        curr_price = self.fetch_market_price()

        # If active position exists, evaluate TP/SL triggers
        if self.active_position:
            pos = self.active_position
            if pos.direction == "BUY":
                gross = (curr_price - pos.entry_price_inr) * pos.lot_size_kg
            else:
                gross = (pos.entry_price_inr - curr_price) * pos.lot_size_kg

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
            # Auto-open new position ONLY when MCX market is OPEN
            signal = self.evaluate_strategy_signal(curr_price)
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

        entry = price or self.fetch_market_price() or 226500.0
        trade_id = f"MCX_AG_{int(time.time())}"
        now_str = datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d %H:%M:%S IST")

        target_pts = (self.target_net_inr + 85.0) / self.lot_size
        stop_pts = (self.max_loss_net_inr - 85.0) / self.lot_size

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
            status="OPEN"
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

        charges = pos.estimated_charges_inr
        net = gross - charges

        pos.status = "CLOSED"
        pos.exit_timestamp = now_str
        pos.exit_price_inr = round(eprice, 2)
        pos.exit_reason = reason
        pos.gross_pnl_inr = round(gross, 2)
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
            target_pts = (self.target_net_inr + 85.0) / pos.lot_size_kg
            stop_pts = (self.max_loss_net_inr - 85.0) / pos.lot_size_kg
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
        m_open, _ = self.check_mcx_market_status()
        if m_open:
            curr = self.fetch_market_price() or 226500.0
            self.manual_entry("BUY", price=curr)

    def get_dashboard_state(self) -> Dict[str, Any]:
        market_open, status_msg = self.check_mcx_market_status()
        curr_price = self.fetch_market_price()
        unrealized_pnl = 0.0
        active_pos_dict = None

        if self.active_position:
            pos = self.active_position
            if pos.direction == "BUY":
                gross_unrealized = (curr_price - pos.entry_price_inr) * pos.lot_size_kg
            else:
                gross_unrealized = (pos.entry_price_inr - curr_price) * pos.lot_size_kg
            unrealized_pnl = gross_unrealized - pos.estimated_charges_inr

            active_pos_dict = pos.to_dict()
            active_pos_dict["unrealized_pnl_inr"] = round(unrealized_pnl, 2)

        return {
            "timestamp": datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d %H:%M:%S IST"),
            "instrument": "SILVERM NOV FUT",
            "exchange": "MCX",
            "currency": "INR",
            "market_open": market_open,
            "market_schedule": "Mon-Fri 09:00 AM - 11:30 PM IST",
            "current_price_inr": curr_price,
            "starting_capital_inr": self.starting_capital,
            "account_capital_inr": round(self.capital, 2),
            "target_net_inr": self.target_net_inr,
            "max_loss_net_inr": self.max_loss_net_inr,
            "today_realized_pnl_inr": round(self.today_realized_pnl, 2),
            "unrealized_pnl_inr": round(unrealized_pnl, 2),
            "active_position": active_pos_dict,
            "trade_history": self.trade_history,
            "system_status": status_msg
        }


MCX_SILVER_ENGINE = MCXSilverPaperEngine()
