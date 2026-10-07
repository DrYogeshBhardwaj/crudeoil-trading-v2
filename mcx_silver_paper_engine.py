"""
MCX SILVERM (Silver Mini) Paper Trading Engine with Auto-Trading Loop
STRICTLY PAPER TRADING ONLY — NO REAL ORDERS ARE PLACED.

Implements MCX Silver Mini Specifications:
- Instrument: SILVERM (MCX India - 5 kg lot)
- Capital: Rs. 3,30,000.00
- Target Profit (Net): +Rs. 5,000.00 NET
- Max Loss (Net): -Rs. 10,000.00 NET
- Prices in: INR (Rs.)
"""

import os
import time
import json
import asyncio
import requests
from datetime import datetime, timedelta
from typing import Dict, Any, Optional, List
from dataclasses import dataclass, field, asdict


@dataclass
class MCXSilverPaperTrade:
    trade_id: str
    instrument: str = "SILVERM NOV FUT"
    exchange: str = "MCX"
    direction: str = "BUY"  # BUY / SELL
    quantity_lots: int = 1   # 1 Lot = 5 kg
    lot_size_kg: int = 5
    entry_price_inr: float = 227654.0
    entry_timestamp: str = ""
    target_net_inr: float = 5000.0
    max_loss_net_inr: float = 10000.0
    target_price_inr: float = 228654.0
    stop_loss_price_inr: float = 225654.0
    status: str = "OPEN"  # OPEN / CLOSED
    exit_timestamp: Optional[str] = None
    exit_price_inr: Optional[float] = None
    exit_reason: Optional[str] = None
    gross_pnl_inr: float = 0.0
    estimated_charges_inr: float = 85.0  # Brokerage + STT + GST
    net_pnl_inr: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class MCXSilverPaperEngine:
    def __init__(self):
        self.instrument = "SILVERM NOV FUT"
        self.exchange = "MCX"
        self.lot_size = 5  # 5 kg per lot
        self.starting_capital = 330000.0
        self.capital = 330000.0
        self.target_net_inr = 5000.0
        self.max_loss_net_inr = 10000.0
        self.current_price_inr = 227654.0
        self.active_position: Optional[MCXSilverPaperTrade] = None
        self.trade_history: List[Dict[str, Any]] = []
        self.system_status = "AUTOMATED PAPER SCANNING ACTIVE"
        self.today_realized_pnl = 0.0
        self.auto_paper_trading_enabled = True
        
        # Start initial active paper position for immediate visual feedback
        self._init_demo_active_position()

    def _init_demo_active_position(self):
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S IST")
        pos = MCXSilverPaperTrade(
            trade_id=f"MCX_AG_{int(time.time())}",
            instrument="SILVERM NOV FUT",
            exchange="MCX",
            direction="BUY",
            quantity_lots=1,
            lot_size_kg=5,
            entry_price_inr=227654.0,
            entry_timestamp=now_str,
            target_net_inr=5000.0,
            max_loss_net_inr=10000.0,
            target_price_inr=228654.0,  # +1000 pts
            stop_loss_price_inr=225654.0, # -2000 pts
            status="OPEN"
        )
        self.active_position = pos

    def get_latest_price(self) -> float:
        try:
            r = requests.get("https://api.binance.com/api/3/ticker/price?symbol=XAGUSDT", timeout=3)
            if r.status_code == 200:
                val = float(r.json().get("price", 60.5))
                calc_inr = round(val * 32.1507 * 102.0, 2)
                if calc_inr > 100000:
                    self.current_price_inr = calc_inr
        except Exception:
            pass
        return self.current_price_inr

    def manual_entry(self, direction: str = "BUY", price: Optional[float] = None) -> MCXSilverPaperTrade:
        if self.active_position:
            return self.active_position
        
        entry = price or self.get_latest_price() or 227654.0
        trade_id = f"MCX_AG_{int(time.time())}"
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S IST")
        
        target_pts = self.target_net_inr / self.lot_size  # +1000 Pts
        stop_pts = self.max_loss_net_inr / self.lot_size    # -2000 Pts
        
        if direction.upper() in ("BUY", "LONG"):
            t_price = entry + target_pts
            s_price = entry - stop_pts
        else:
            t_price = entry - target_pts
            s_price = entry + stop_pts
            
        pos = MCXSilverPaperTrade(
            trade_id=trade_id,
            instrument="SILVERM NOV FUT",
            exchange="MCX",
            direction="BUY" if direction.upper() in ("BUY", "LONG") else "SELL",
            quantity_lots=1,
            lot_size_kg=5,
            entry_price_inr=entry,
            entry_timestamp=now_str,
            target_net_inr=self.target_net_inr,
            max_loss_net_inr=self.max_loss_net_inr,
            target_price_inr=t_price,
            stop_loss_price_inr=s_price,
            status="OPEN"
        )
        self.active_position = pos
        return pos

    def manual_close(self, exit_price: Optional[float] = None, reason: str = "MANUAL_CLOSE") -> Optional[Dict[str, Any]]:
        if not self.active_position:
            return None
        
        pos = self.active_position
        eprice = exit_price or self.get_latest_price() or pos.entry_price_inr
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S IST")
        
        if pos.direction == "BUY":
            gross = (eprice - pos.entry_price_inr) * pos.lot_size_kg
        else:
            gross = (pos.entry_price_inr - eprice) * pos.lot_size_kg
            
        charges = 85.0
        net = gross - charges
        
        pos.status = "CLOSED"
        pos.exit_timestamp = now_str
        pos.exit_price_inr = eprice
        pos.exit_reason = reason
        pos.gross_pnl_inr = round(gross, 2)
        pos.net_pnl_inr = round(net, 2)
        
        trade_dict = pos.to_dict()
        self.trade_history.insert(0, trade_dict)
        self.capital += net
        self.today_realized_pnl += net
        self.active_position = None
        return trade_dict

    def update_settings(self, target_net: float, max_loss: float):
        self.target_net_inr = float(target_net)
        self.max_loss_net_inr = float(max_loss)
        if self.active_position:
            pos = self.active_position
            pos.target_net_inr = self.target_net_inr
            pos.max_loss_net_inr = self.max_loss_net_inr
            target_pts = self.target_net_inr / pos.lot_size_kg
            stop_pts = self.max_loss_net_inr / pos.lot_size_kg
            if pos.direction == "BUY":
                pos.target_price_inr = pos.entry_price_inr + target_pts
                pos.stop_loss_price_inr = pos.entry_price_inr - stop_pts
            else:
                pos.target_price_inr = pos.entry_price_inr - target_pts
                pos.stop_loss_price_inr = pos.entry_price_inr + stop_pts

    def get_dashboard_state(self) -> Dict[str, Any]:
        curr_price = self.get_latest_price()
        unrealized_pnl = 0.0
        active_pos_dict = None
        
        if self.active_position:
            pos = self.active_position
            if pos.direction == "BUY":
                gross_unrealized = (curr_price - pos.entry_price_inr) * pos.lot_size_kg
            else:
                gross_unrealized = (pos.entry_price_inr - curr_price) * pos.lot_size_kg
            unrealized_pnl = gross_unrealized - 85.0
            
            active_pos_dict = pos.to_dict()
            active_pos_dict["unrealized_pnl_inr"] = round(unrealized_pnl, 2)
            
            # Auto TP / SL triggers
            if pos.direction == "BUY":
                if curr_price >= pos.target_price_inr:
                    self.manual_close(exit_price=pos.target_price_inr, reason="TARGET PROFIT HIT (+Rs.5,000 NET)")
                elif curr_price <= pos.stop_loss_price_inr:
                    self.manual_close(exit_price=pos.stop_loss_price_inr, reason="STOP LOSS HIT (-Rs.10,000 NET)")
            else:
                if curr_price <= pos.target_price_inr:
                    self.manual_close(exit_price=pos.target_price_inr, reason="TARGET PROFIT HIT (+Rs.5,000 NET)")
                elif curr_price >= pos.stop_loss_price_inr:
                    self.manual_close(exit_price=pos.stop_loss_price_inr, reason="STOP LOSS HIT (-Rs.10,000 NET)")
        elif self.auto_paper_trading_enabled:
            # Auto re-open new paper position when previous finishes
            self.manual_entry("BUY")

        return {
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S IST"),
            "instrument": "SILVERM NOV FUT",
            "exchange": "MCX",
            "currency": "INR",
            "current_price_inr": curr_price,
            "starting_capital_inr": self.starting_capital,
            "account_capital_inr": round(self.capital, 2),
            "target_net_inr": self.target_net_inr,
            "max_loss_net_inr": self.max_loss_net_inr,
            "today_realized_pnl_inr": round(self.today_realized_pnl, 2),
            "unrealized_pnl_inr": round(unrealized_pnl, 2),
            "active_position": active_pos_dict,
            "trade_history": self.trade_history,
            "system_status": self.system_status
        }


MCX_SILVER_ENGINE = MCXSilverPaperEngine()
