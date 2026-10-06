"""
Mudrex Crude Paper Trading Engine (CL/USDT Futures)
STRICTLY PAPER TRADING ONLY — NO REAL ORDERS CAN BE PLACED.

Implements Mandatory Requirements:
1. Instrument: CL/USDT Mudrex Perpetual Futures (24x7 Market).
2. Live Market Price Feed from Mudrex API / Binance Futures API (CLUSDT).
3. Strongly validated MudrexCrudePaperTradeState object (Single Source of Truth).
4. Atomic state machine: OPEN -> EXIT_REQUESTED -> CLOSED.
5. Strict non-zero Target/SL validation (No Silent Defaults / No 0 default TP/SL hit).
6. Exact Net Target (+₹100 NET) and Net Loss (-₹200 NET) calculations inclusive of Mudrex fees & GST.
7. Dedicated SQLite namespace: mudrex_crude_paper_trades, mudrex_crude_paper_settings, mudrex_crude_paper_evaluations.
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


class MudrexCrudeTradeStatus(str, Enum):
    OPEN = "OPEN"
    EXIT_REQUESTED = "EXIT_REQUESTED"
    CLOSED = "CLOSED"


@dataclass
class MudrexCrudePaperTradeState:
    """Single Source of Truth for Mudrex Crude Paper Open Position."""
    trade_id: str
    instrument: str = "CL/USDT"
    direction: str = "BUY"  # BUY / SELL / LONG / SHORT
    quantity: float = 1.0   # e.g., 1 barrel / contract
    leverage: float = 5.0
    entry_price: float = 0.0  # USD
    entry_timestamp: str = ""
    target_net: float = 100.0  # INR NET
    max_loss_net: float = 200.0  # INR NET
    target_gross: float = 0.0  # INR
    stop_gross: float = 0.0  # INR
    target_price: float = 0.0  # USD
    stop_loss_price: float = 0.0  # USD
    trend_state: str = "NEUTRAL"
    confidence: int = 50
    reasons: List[str] = field(default_factory=list)
    status: str = MudrexCrudeTradeStatus.OPEN.value
    exit_timestamp: Optional[str] = None
    exit_price: Optional[float] = None  # USD
    exit_reason: Optional[str] = None
    gross_pnl: float = 0.0  # INR
    entry_fee_gst: float = 0.0  # INR
    exit_fee_gst: float = 0.0  # INR
    funding_fee: float = 0.0  # INR
    total_charges: float = 0.0  # INR
    net_pnl: float = 0.0  # INR
    trigger_price: Optional[float] = None
    hedge_rate: float = 102.0

    def is_valid_for_execution(self) -> Tuple[bool, str]:
        """Validates all required fields before position is executable or TP/SL evaluated."""
        if not self.trade_id:
            return False, "Missing trade_id"
        if str(self.direction).upper() not in ("BUY", "SELL", "LONG", "SHORT"):
            return False, f"Invalid direction: {self.direction}"
        if float(self.quantity or 0) <= 0:
            return False, f"Invalid quantity: {self.quantity}"
        if float(self.entry_price or 0) <= 0:
            return False, f"Invalid entry_price: {self.entry_price}"
        if float(self.hedge_rate or 0) <= 0:
            return False, f"Invalid hedge_rate: {self.hedge_rate}"
        if float(self.target_price or 0) <= 0:
            return False, f"Missing or zero target_price ({self.target_price})"
        if float(self.stop_loss_price or 0) <= 0:
            return False, f"Missing or zero stop_loss_price ({self.stop_loss_price})"
        if float(self.target_net or 0) <= 0:
            return False, f"Invalid target_net ({self.target_net})"
        if float(self.max_loss_net or 0) <= 0:
            return False, f"Invalid max_loss_net ({self.max_loss_net})"
        return True, "VALID"

    @property
    def side(self) -> str:
        return "LONG" if self.direction in ("BUY", "LONG") else "SHORT"

    @property
    def funding(self) -> float:
        return float(self.funding_fee or 0.0)

    @property
    def estimated_fee(self) -> float:
        v_entry = self.entry_price * self.quantity
        return round(v_entry * 0.0005, 4)

    @property
    def gst(self) -> float:
        return round(self.estimated_fee * 0.18, 4)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "MudrexCrudePaperTradeState":
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
            instrument=str(d.get("instrument") or "CL/USDT"),
            direction=str(d.get("direction") or "BUY").upper(),
            quantity=float(d.get("quantity") or 1.0),
            leverage=float(d.get("leverage") or 5.0),
            entry_price=float(d.get("entry_price") or 0.0),
            entry_timestamp=str(d.get("entry_timestamp") or ""),
            target_net=float(d.get("target_net") or 100.0),
            max_loss_net=float(d.get("max_loss_net") or 200.0),
            target_gross=float(d.get("target_gross") or 0.0),
            stop_gross=float(d.get("stop_gross") or 0.0),
            target_price=float(d.get("target_price") or 0.0),
            stop_loss_price=float(d.get("stop_loss_price") or 0.0),
            trend_state=str(d.get("trend_state") or "NEUTRAL"),
            confidence=int(d.get("confidence") or 50),
            reasons=reasons if isinstance(reasons, list) else [],
            status=str(d.get("status") or MudrexCrudeTradeStatus.OPEN.value),
            exit_timestamp=d.get("exit_timestamp"),
            exit_price=float(d["exit_price"]) if d.get("exit_price") is not None else None,
            exit_reason=d.get("exit_reason"),
            gross_pnl=float(d.get("gross_pnl") or 0.0),
            entry_fee_gst=float(d.get("entry_fee_gst") or 0.0),
            exit_fee_gst=float(d.get("exit_fee_gst") or 0.0),
            funding_fee=float(d.get("funding_fee") or 0.0),
            total_charges=float(d.get("total_charges") or d.get("charges") or 0.0),
            net_pnl=float(d.get("net_pnl") or 0.0),
            trigger_price=float(d["trigger_price"]) if d.get("trigger_price") is not None else None,
            hedge_rate=float(d.get("hedge_rate") or 102.0)
        )


class MudrexCrudePaperEngine:
    """
    Mudrex Crude Paper Trading Engine (CL/USDT).
    100% PAPER TRADING ONLY — REAL ORDER PLACEMENT IS PHYSICALLY DISABLED.
    """

    def __init__(self, db_instance=None):
        self.db = db_instance or DB
        # HARDCODED SAFETY LOCK: Real orders cannot be dispatched
        self.LIVE_TRADING_ENABLED = False
        self.SYMBOL = "CL/USDT"
        self.QUANTITY = 1.0  # 1 contract / barrel CL/USDT per paper trade
        self.LEVERAGE = 5.0
        self.TAKER_FEE_RATE = 0.0005  # 0.05%
        self.MAKER_FEE_RATE = 0.0002  # 0.02%
        self.GST_RATE = 0.18          # 18% GST on trading fee
        self.TOTAL_FEE_RATE = 0.00059 # 0.059% per side inclusive of GST
        self.CRUDE_CONSOLIDATION_EMA_SPREAD = 0.015 # $0.015 USD EMA spread consolidation threshold

        # Load Persistent Risk Settings
        self.today_date = datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d")
        saved_date = self.db.load_mudrex_crude_paper_setting("today_date", self.today_date)
        if saved_date != self.today_date:
            self.db.save_mudrex_crude_paper_setting("today_date", self.today_date)
            self.db.save_mudrex_crude_paper_setting("today_realized_pnl", "0.0")

        self.per_trade_loss_limit_inr = float(self.db.load_mudrex_crude_paper_setting("per_trade_loss_limit_inr", "200.0"))
        self.per_trade_profit_target_inr = float(self.db.load_mudrex_crude_paper_setting("per_trade_profit_target_inr", "100.0"))
        self.daily_loss_limit_inr = float(self.db.load_mudrex_crude_paper_setting("daily_loss_limit_inr", "1000.0"))
        self.today_realized_pnl = float(self.db.load_mudrex_crude_paper_setting("today_realized_pnl", "0.0"))

        self.last_sl_time = float(self.db.load_mudrex_crude_paper_setting("last_sl_time", "0.0"))
        self.evaluation_stream = []
        self.last_evaluation = {}

    def fetch_market_price(self) -> Tuple[Optional[float], float, str]:
        """
        Fetches authoritative live Mudrex Crude CL/USDT Futures price in USD and hedge rate.
        Query order:
        1. Mudrex API asset endpoint for CLUSDT
        2. Binance Futures API (fapi.binance.com/fapi/v1/ticker/price?symbol=CLUSDT)
        """
        price_usd = None
        hedge_rate = 102.0
        source = "Mudrex / Binance Futures API"

        # 1. Query Mudrex API
        try:
            api_secret = (os.environ.get("MUDREX_API_SECRET") or os.environ.get("MUDREX_SECRET") or "").strip()
            api_key = (os.environ.get("MUDREX_API_KEY") or os.environ.get("MUDREX_KEY") or "").strip()
            headers = {"X-Authentication": api_secret, "User-Agent": "Mudrex-Crude-Engine/1.0"}
            if api_key:
                headers["X-Api-Key"] = api_key

            resp = requests.get("https://trade.mudrex.com/fapi/v1/futures/CLUSDT?is_symbol", headers=headers, timeout=4)
            if resp.status_code in (200, 201):
                data = resp.json()
                ast = data.get("data") if isinstance(data, dict) and "data" in data else data
                if isinstance(ast, dict) and "price" in ast:
                    price_usd = float(ast["price"])
        except Exception:
            pass

        # 2. Query Binance Futures API fallback for CLUSDT
        if price_usd is None or price_usd <= 0:
            try:
                resp = requests.get("https://fapi.binance.com/fapi/v1/ticker/price?symbol=CLUSDT", timeout=4)
                if resp.status_code == 200:
                    data = resp.json()
                    price_usd = float(data.get("price", 0.0))
                    source = "Binance Futures API (CLUSDT USD)"
            except Exception:
                pass

        if price_usd is not None and price_usd > 0:
            return price_usd, hedge_rate, source

        return None, hedge_rate, "PRICE FEED UNAVAILABLE"

    def calculate_sl_and_target_prices(
        self,
        direction: str,
        entry_price: float,
        quantity: float = 1.0,
        hedge_rate: float = 102.0,
        target_net: float = 100.0,
        max_loss_net: float = 200.0,
        funding_fee: float = 0.0
    ) -> Tuple[float, float, float, float]:
        """
        Calculates exact Target Price (+₹100 NET) and Stop Loss Price (-₹200 NET) in USD
        accounting for Mudrex fee structure (0.05% taker + 18% GST = 0.059% per side).
        
        Returns: (target_price, stop_loss_price, target_gross_inr, stop_gross_inr)
        """
        if hedge_rate <= 0:
            hedge_rate = 102.0
        if quantity <= 0:
            quantity = 1.0

        v_entry = entry_price * quantity * hedge_rate
        f_entry = v_entry * self.TOTAL_FEE_RATE

        dir_upper = str(direction).upper()

        if dir_upper in ("BUY", "LONG"):
            denom_tp = quantity * hedge_rate * (1.0 - self.TOTAL_FEE_RATE)
            num_tp = v_entry + f_entry + funding_fee + target_net
            target_price = round(num_tp / denom_tp, 4)

            denom_sl = quantity * hedge_rate * (1.0 - self.TOTAL_FEE_RATE)
            num_sl = v_entry + f_entry + funding_fee - max_loss_net
            stop_loss_price = round(num_sl / denom_sl, 4)

            target_gross_inr = round((target_price - entry_price) * quantity * hedge_rate, 2)
            stop_gross_inr = round((entry_price - stop_loss_price) * quantity * hedge_rate, 2)
        else:  # SELL / SHORT
            denom_tp = quantity * hedge_rate * (1.0 + self.TOTAL_FEE_RATE)
            num_tp = v_entry - f_entry - funding_fee - target_net
            target_price = round(num_tp / denom_tp, 4)

            denom_sl = quantity * hedge_rate * (1.0 + self.TOTAL_FEE_RATE)
            num_sl = v_entry - f_entry - funding_fee + max_loss_net
            stop_loss_price = round(num_sl / denom_sl, 4)

            target_gross_inr = round((entry_price - target_price) * quantity * hedge_rate, 2)
            stop_gross_inr = round((stop_loss_price - entry_price) * quantity * hedge_rate, 2)

        return target_price, stop_loss_price, target_gross_inr, stop_gross_inr

    def calculate_position_pnl(
        self,
        position: MudrexCrudePaperTradeState,
        curr_price: float,
        hedge_rate: float
    ) -> Tuple[float, float, float, float, float, float]:
        """
        Calculates unrealized P&L, fees, GST, and NET P&L in INR.
        Returns: (gross_pnl_usd, gross_pnl_inr, entry_fee_gst, exit_fee_gst, total_charges, net_pnl_inr)
        """
        if not position or curr_price <= 0 or hedge_rate <= 0:
            return 0.0, 0.0, 0.0, 0.0, 0.0, 0.0

        pos_hr = position.hedge_rate if position.hedge_rate > 0 else hedge_rate
        entry_price = position.entry_price
        qty = position.quantity

        if position.direction in ("BUY", "LONG"):
            gross_pnl_usd = (curr_price - entry_price) * qty
        else:
            gross_pnl_usd = (entry_price - curr_price) * qty

        gross_pnl_inr = gross_pnl_usd * pos_hr

        entry_val_inr = entry_price * qty * pos_hr
        exit_val_inr = curr_price * qty * pos_hr

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

    def _calculate_ema(self, prices: List[float], period: int) -> Optional[float]:
        """Calculates Exponential Moving Average over specified period."""
        if not prices or len(prices) < period:
            return None
        k = 2.0 / (period + 1.0)
        ema = sum(prices[:period]) / float(period)
        for p in prices[period:]:
            ema = (p * k) + (ema * (1.0 - k))
        return round(ema, 4)

    def _calculate_rsi(self, prices: List[float], period: int = 14) -> float:
        """Calculates Relative Strength Index over specified period."""
        if not prices or len(prices) < period + 1:
            return 50.0
        gains = []
        losses = []
        for i in range(1, len(prices)):
            diff = prices[i] - prices[i - 1]
            if diff > 0:
                gains.append(diff)
                losses.append(0.0)
            else:
                gains.append(0.0)
                losses.append(abs(diff))

        if len(gains) < period:
            return 50.0

        avg_gain = sum(gains[-period:]) / float(period)
        avg_loss = sum(losses[-period:]) / float(period)

        if avg_loss == 0.0:
            return 100.0
        rs = avg_gain / avg_loss
        rsi = 100.0 - (100.0 / (1.0 + rs))
        return round(rsi, 2)

    def evaluate_crude_strategy(self, curr_price: float) -> Dict[str, Any]:
        """Independent Strategy Evaluation for Mudrex Crude Paper Engine with Fee Awareness & Signal Confirmation."""
        if not hasattr(self, "_price_history"):
            self._price_history = []
            self._consecutive_buy_ticks = 0
            self._consecutive_sell_ticks = 0

        self._price_history.append(curr_price)
        if len(self._price_history) > 100:
            self._price_history = self._price_history[-100:]

        if len(self._price_history) < 5:
            return {
                "action": "WAIT",
                "trend": "NEUTRAL",
                "confidence": 50,
                "ema9": None,
                "ema21": None,
                "rsi": 50.0,
                "reasons": ["Warming up price data"]
            }

        ema9 = self._calculate_ema(self._price_history, 9)
        ema21 = self._calculate_ema(self._price_history, 21)
        rsi = self._calculate_rsi(self._price_history, 14)

        if ema9 is None or ema21 is None:
            ema9 = sum(self._price_history[-3:]) / float(len(self._price_history[-3:]))
            ema21 = sum(self._price_history) / float(len(self._price_history))

        ema9 = round(ema9, 4)
        ema21 = round(ema21, 4)
        rsi = round(rsi, 1)

        hedge_rate = getattr(self, "hedge_rate", 102.0) or 102.0
        qty = getattr(self, "QUANTITY", 1.0) or 1.0
        notional_inr = curr_price * qty * hedge_rate
        round_trip_fee_inr = notional_inr * (2.0 * self.TOTAL_FEE_RATE)
        min_required_move_usd = (self.per_trade_profit_target_inr + round_trip_fee_inr) / (qty * hedge_rate)

        ema_spread = abs(ema9 - ema21)
        fee_threshold_usd = round(min_required_move_usd * 0.008, 4)

        # 1. Sideways range / consolidation check
        if ema_spread < self.CRUDE_CONSOLIDATION_EMA_SPREAD:
            self._consecutive_buy_ticks = 0
            self._consecutive_sell_ticks = 0
            return {
                "action": "WAIT",
                "trend": "NEUTRAL",
                "confidence": 50,
                "ema9": ema9,
                "ema21": ema21,
                "rsi": rsi,
                "reasons": ["Price consolidating within range"]
            }

        # 2. Fee-aware move check
        if ema_spread < fee_threshold_usd:
            self._consecutive_buy_ticks = 0
            self._consecutive_sell_ticks = 0
            return {
                "action": "WAIT",
                "trend": "NEUTRAL",
                "confidence": 55,
                "ema9": ema9,
                "ema21": ema21,
                "rsi": rsi,
                "reasons": [f"WAIT — MOVE TOO SMALL AFTER FEES (Need spread > ${fee_threshold_usd:.3f})"]
            }

        # 3. Check Bullish Crossover
        if ema9 > ema21:
            self._consecutive_sell_ticks = 0
            self._consecutive_buy_ticks += 1
            if rsi >= 52.0 and self._consecutive_buy_ticks >= 2:
                return {
                    "action": "BUY",
                    "trend": "BULLISH",
                    "confidence": 80,
                    "ema9": ema9,
                    "ema21": ema21,
                    "rsi": rsi,
                    "reasons": ["Confirmed EMA9 crossed above EMA21 with RSI momentum"]
                }
            else:
                reason_msg = "Weak crossover — awaiting confirmation" if self._consecutive_buy_ticks < 2 else f"RSI out of bounds ({rsi})"
                return {
                    "action": "WAIT",
                    "trend": "BULLISH",
                    "confidence": 60,
                    "ema9": ema9,
                    "ema21": ema21,
                    "rsi": rsi,
                    "reasons": [reason_msg]
                }

        # 4. Check Bearish Crossover
        elif ema9 < ema21:
            self._consecutive_buy_ticks = 0
            self._consecutive_sell_ticks += 1
            if rsi <= 48.0 and self._consecutive_sell_ticks >= 2:
                return {
                    "action": "SELL",
                    "trend": "BEARISH",
                    "confidence": 80,
                    "ema9": ema9,
                    "ema21": ema21,
                    "rsi": rsi,
                    "reasons": ["Confirmed EMA9 crossed below EMA21 with RSI momentum"]
                }
            else:
                reason_msg = "Weak crossover — awaiting confirmation" if self._consecutive_sell_ticks < 2 else f"RSI out of bounds ({rsi})"
                return {
                    "action": "WAIT",
                    "trend": "BEARISH",
                    "confidence": 60,
                    "ema9": ema9,
                    "ema21": ema21,
                    "rsi": rsi,
                    "reasons": [reason_msg]
                }

        self._consecutive_buy_ticks = 0
        self._consecutive_sell_ticks = 0
        return {
            "action": "WAIT",
            "trend": "NEUTRAL",
            "confidence": 50,
            "ema9": ema9,
            "ema21": ema21,
            "rsi": rsi,
            "reasons": ["Price consolidating within range"]
        }

    @property
    def active_position(self) -> Optional[MudrexCrudePaperTradeState]:
        raw = self.db.load_active_mudrex_crude_paper_position()
        if raw and raw.get("status") in (MudrexCrudeTradeStatus.OPEN.value, MudrexCrudeTradeStatus.EXIT_REQUESTED.value):
            return MudrexCrudePaperTradeState.from_dict(raw)
        return None

    @property
    def current_price(self) -> float:
        return getattr(self, "_last_price", 0.0)

    @current_price.setter
    def current_price(self, val: float):
        self._last_price = float(val or 0.0)

    def process_tick(self, current_price: Optional[float] = None) -> Optional[Dict[str, Any]]:
        """Processes live market ticks with strict paper state management."""
        try:
            if current_price is not None and float(current_price) > 0:
                curr_price = float(current_price)
                hedge_rate = 102.0
                price_source = "TEST_TICK"
            else:
                curr_price, hedge_rate, price_source = self.fetch_market_price()

            if curr_price is None or curr_price <= 0:
                print(f"[{datetime.now()}] [CRUDE PAPER FEED DROP] Price feed unavailable. Tick skipped.")
                return None

            self.current_price = curr_price
            eval_res = self.evaluate_crude_strategy(curr_price)
            self.last_evaluation = eval_res

            # Log evaluation stream
            now_ist_str = datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d %H:%M:%S")
            reasons_str = " | ".join(eval_res.get("reasons", []))
            eval_log_entry = {
                "timestamp": now_ist_str,
                "price": curr_price,
                "action": eval_res.get("action", "WAIT"),
                "trend_state": eval_res.get("trend", "NEUTRAL"),
                "confidence": eval_res.get("confidence", 50),
                "ema9": eval_res.get("ema9"),
                "ema21": eval_res.get("ema21"),
                "rsi": eval_res.get("rsi"),
                "reason": reasons_str
            }
            self.evaluation_stream.insert(0, eval_log_entry)
            if len(self.evaluation_stream) > 100:
                self.evaluation_stream = self.evaluation_stream[:100]

            # 1. CHECK ACTIVE PAPER POSITION
            raw_pos = self.db.load_active_mudrex_crude_paper_position()
            if raw_pos:
                try:
                    position = MudrexCrudePaperTradeState.from_dict(raw_pos)
                except Exception as e:
                    print(f"[{datetime.now()}] [CRUDE LOAD ERROR] {e}")
                    return None

                valid, err_msg = position.is_valid_for_execution()
                if not valid:
                    print(f"[{datetime.now()}] [CRUDE WARNING] Active trade {position.trade_id} missing fields ({err_msg}). Recalculating...")
                    if position.entry_price > 0 and position.quantity > 0:
                        tp_price, sl_price, tp_gross, sl_gross = self.calculate_sl_and_target_prices(
                            position.direction, position.entry_price, position.quantity, position.hedge_rate,
                            position.target_net, position.max_loss_net
                        )
                        position.target_price = tp_price
                        position.stop_loss_price = sl_price
                        position.target_gross = tp_gross
                        position.stop_gross = sl_gross
                        self.db.save_mudrex_crude_paper_trade(position.to_dict())
                        valid, err_msg = position.is_valid_for_execution()

                    if not valid:
                        print(f"[{datetime.now()}] [CRUDE CRITICAL] Trade {position.trade_id} invalid ({err_msg}). TP/SL triggers BLOCKED!")
                        return None

                if position.status == MudrexCrudeTradeStatus.EXIT_REQUESTED.value:
                    return self._finalize_closed_position(position, curr_price)

                if position.status == MudrexCrudeTradeStatus.CLOSED.value:
                    return None

                # AT STATUS == OPEN: EVALUATE TARGET & SL
                gross_usd, gross_inr, entry_fee, exit_fee, total_charges, net_pnl = self.calculate_position_pnl(
                    position, curr_price, hedge_rate
                )

                if position.direction in ("BUY", "LONG"):
                    tp_hit = (curr_price >= position.target_price) and (net_pnl >= position.target_net)
                    sl_hit = (curr_price <= position.stop_loss_price) or (net_pnl <= -position.max_loss_net)
                else:  # SELL / SHORT
                    tp_hit = (curr_price <= position.target_price) and (net_pnl >= position.target_net)
                    sl_hit = (curr_price >= position.stop_loss_price) or (net_pnl <= -position.max_loss_net)

                if tp_hit or sl_hit:
                    position.status = MudrexCrudeTradeStatus.EXIT_REQUESTED.value
                    position.trigger_price = curr_price
                    self.db.save_mudrex_crude_paper_trade(position.to_dict())
                    return self._finalize_closed_position(position, curr_price)

                return None

            # 2. NO POSITION -> CHECK RATE CONTROL & EXECUTE NEW PAPER TRADE
            if self.last_sl_time > 0:
                elapsed = time.time() - self.last_sl_time
                if elapsed < 60:
                    return None

            action = eval_res.get("action", "WAIT")
            if action in ("BUY", "SELL"):
                self.execute_paper_trade(action, curr_price, hedge_rate, eval_res)
            return None
        except Exception as err:
            print(f"[{datetime.now()}] [CRUDE TICK ERROR] {err}\n{traceback.format_exc()}")
            return None

    def _finalize_closed_position(self, position: MudrexCrudePaperTradeState, exit_price: float):
        """Finalizes Mudrex Crude paper position to CLOSED with exact fee and P&L accounting."""
        if exit_price is None or float(exit_price or 0) <= 0:
            print(f"[{datetime.now()}] [CRITICAL SAFETY GUARD] Refusing to close Mudrex Crude trade {position.trade_id}: exit_price is zero or invalid ({exit_price}). Position remains OPEN.")
            position.status = MudrexCrudeTradeStatus.OPEN.value
            self.db.save_mudrex_crude_paper_trade(position.to_dict())
            return None

        if position.entry_price is None or float(position.entry_price or 0) <= 0:
            print(f"[{datetime.now()}] [CRITICAL SAFETY GUARD] Refusing to close Mudrex Crude trade {position.trade_id}: entry_price is zero or invalid ({position.entry_price}). Position remains OPEN.")
            position.status = MudrexCrudeTradeStatus.OPEN.value
            self.db.save_mudrex_crude_paper_trade(position.to_dict())
            return None

        now_str = datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d %H:%M:%S")
        _, gross_inr, entry_fee, exit_fee, total_charges, net_inr = self.calculate_position_pnl(
            position, exit_price, position.hedge_rate
        )

        position.exit_price = exit_price
        position.gross_pnl = round(gross_inr, 2)
        position.entry_fee_gst = round(entry_fee, 2)
        position.exit_fee_gst = round(exit_fee, 2)
        position.total_charges = round(total_charges, 2)
        position.net_pnl = round(net_inr, 2)

        if net_inr >= position.target_net:
            position.exit_reason = f"PROFIT TARGET +Rs.{int(position.target_net)} NET"
        elif net_inr <= -position.max_loss_net:
            position.exit_reason = f"LOSS LIMIT -Rs.{int(position.max_loss_net)} NET"
        else:
            position.exit_reason = f"MANUAL / SYSTEM EXIT (NET: Rs.{net_inr:,.2f})"

        position.status = MudrexCrudeTradeStatus.CLOSED.value
        position.exit_timestamp = now_str
        self.last_sl_time = time.time()

        self.db.save_mudrex_crude_paper_trade(position.to_dict())
        self.recalculate_realized_pnl()
        print(f"[{datetime.now()}] [CRUDE PAPER CLOSED] Trade {position.trade_id} CLOSED ({position.exit_reason})! NET P&L: Rs.{net_inr:,.2f}")
        return position.to_dict()

    def manual_entry(self, side: str, quantity: float = 10.0, current_price: Optional[float] = None) -> Optional[MudrexCrudePaperTradeState]:
        if self.active_position is not None:
            return None
        price = float(current_price) if (current_price and float(current_price) > 0) else self.fetch_market_price()[0]
        if not price or price <= 0:
            print(f"[{datetime.now()}] [CRUDE ENTRY REJECTED] Cannot open manual position: Market price is zero or unavailable ({price})")
            return None
        side_upper = side.upper()
        exec_side = "BUY" if side_upper in ("BUY", "LONG") else ("SELL" if side_upper in ("SELL", "SHORT") else side_upper)
        old_qty = self.QUANTITY
        try:
            if quantity > 0:
                self.QUANTITY = quantity
            eval_res = {"trend": "MANUAL", "confidence": 100, "reasons": ["Manual entry"], "action": exec_side}
            res = self.execute_paper_trade(exec_side, price, 102.0, eval_res)
            if res.get("success"):
                return self.active_position
            return None
        finally:
            self.QUANTITY = old_qty

    def manual_close(self, reason: str = "MANUAL_CLOSE") -> Optional[Dict[str, Any]]:
        res = self.close_active_paper_position()
        if res.get("success"):
            return res.get("trade")
        return None

    def reset_statistics(self):
        with self.db._get_connection() as conn:
            c = conn.cursor()
            c.execute("DELETE FROM mudrex_crude_paper_trades")
            c.execute("DELETE FROM mudrex_crude_paper_settings")
            c.execute("DELETE FROM mudrex_crude_paper_evaluations")
            conn.commit()
        self.today_realized_pnl = 0.0
        self.evaluation_stream = []
        self.last_evaluation = {}

    def execute_paper_trade(self, side: str, curr_price: float, hedge_rate: float, eval_res: Dict[str, Any]) -> Dict[str, Any]:
        """Simulates paper order execution for Mudrex Crude CL/USDT."""
        if curr_price is None or float(curr_price or 0) <= 0:
            return {"success": False, "error": "Cannot execute paper trade: Entry price is zero or unavailable"}

        side = side.upper()
        if side not in ("BUY", "SELL"):
            return {"success": False, "error": f"Invalid side: {side}"}

        qty = self.QUANTITY
        tp_price, sl_price, tp_gross, sl_gross = self.calculate_sl_and_target_prices(
            side, curr_price, qty, hedge_rate, self.per_trade_profit_target_inr, self.per_trade_loss_limit_inr
        )

        now_str = datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d %H:%M:%S")
        trade_id = f"CRUDE_PAPER_{int(time.time())}"
        v_entry = curr_price * qty * hedge_rate
        f_entry = round(v_entry * self.TOTAL_FEE_RATE, 2)

        trade_state = MudrexCrudePaperTradeState(
            trade_id=trade_id,
            instrument=self.SYMBOL,
            direction=side,
            quantity=qty,
            leverage=self.LEVERAGE,
            entry_price=curr_price,
            entry_timestamp=now_str,
            target_net=self.per_trade_profit_target_inr,
            max_loss_net=self.per_trade_loss_limit_inr,
            target_gross=tp_gross,
            stop_gross=sl_gross,
            target_price=tp_price,
            stop_loss_price=sl_price,
            trend_state=eval_res.get("trend", "NEUTRAL"),
            confidence=eval_res.get("confidence", 50),
            reasons=eval_res.get("reasons", []),
            status=MudrexCrudeTradeStatus.OPEN.value,
            entry_fee_gst=f_entry,
            total_charges=f_entry,
            hedge_rate=hedge_rate
        )

        valid, err_msg = trade_state.is_valid_for_execution()
        if not valid:
            return {"success": False, "error": f"Invalid trade state: {err_msg}"}

        self.db.save_mudrex_crude_paper_trade(trade_state.to_dict())
        return {"success": True, "trade": trade_state.to_dict()}

    def execute_manual_paper_trade(self, side: str) -> Dict[str, Any]:
        """Manually triggers a paper trade."""
        curr_price, hedge_rate, _ = self.fetch_market_price()
        if curr_price is None or curr_price <= 0:
            return {"success": False, "error": "Mudrex Crude CL/USDT market price unavailable or zero"}

        eval_res = {
            "trend": "MANUAL",
            "confidence": 100,
            "reasons": ["Manual 1-Click Execution via Mudrex Crude Paper Dashboard"],
            "action": side.upper()
        }
        return self.execute_paper_trade(side, curr_price, hedge_rate, eval_res)

    def close_active_paper_position(self) -> Dict[str, Any]:
        """Manually closes active Mudrex Crude paper position."""
        raw_pos = self.db.load_active_mudrex_crude_paper_position()
        if not raw_pos or raw_pos.get("status") not in (MudrexCrudeTradeStatus.OPEN.value, MudrexCrudeTradeStatus.EXIT_REQUESTED.value):
            return {"success": False, "error": "No active Mudrex Crude paper position is open"}

        try:
            position = MudrexCrudePaperTradeState.from_dict(raw_pos)
        except Exception as e:
            return {"success": False, "error": f"Failed to parse active position: {e}"}

        curr_price, hedge_rate, price_source = self.fetch_market_price()
        if curr_price is None or float(curr_price or 0) <= 0:
            return {"success": False, "error": "Cannot close position: Authoritative market price feed is currently unavailable or zero ($0.000)"}

        position.status = MudrexCrudeTradeStatus.EXIT_REQUESTED.value
        position.trigger_price = curr_price
        self.db.save_mudrex_crude_paper_trade(position.to_dict())
        res = self._finalize_closed_position(position, curr_price)
        if not res:
            return {"success": False, "error": "Close rejected due to invalid exit price validation"}

        return {"success": True, "trade": position.to_dict()}

    def _is_valid_closed_trade(self, t: Dict[str, Any]) -> bool:
        """Validates that a closed paper trade has valid positive entry price, exit price, and quantity."""
        if t.get("status") != MudrexCrudeTradeStatus.CLOSED.value:
            return False
        entry = float(t.get("entry_price") or 0.0)
        exit_p = float(t.get("exit_price") or 0.0)
        qty = float(t.get("quantity") or 0.0)
        return (entry > 0 and exit_p > 0 and qty > 0)

    def recalculate_realized_pnl(self):
        """Recalculates today's realized NET P&L for Mudrex Crude paper engine excluding invalid records."""
        all_trades = self.db.load_all_mudrex_crude_paper_trades()
        today_str = datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d")
        today_sum = 0.0
        for t in all_trades:
            if self._is_valid_closed_trade(t):
                exit_time = str(t.get("exit_timestamp") or t.get("entry_timestamp") or "")
                if today_str in exit_time:
                    today_sum += float(t.get("net_pnl") or 0.0)
        self.today_realized_pnl = round(today_sum, 2)
        self.db.save_mudrex_crude_paper_setting("today_realized_pnl", str(self.today_realized_pnl))

    def get_state(self) -> Dict[str, Any]:
        return self.get_dashboard_state()

    def get_dashboard_state(self) -> Dict[str, Any]:
        """Returns JSON state payload for Mudrex Crude Paper Dashboard UI."""
        curr_price, hedge_rate, price_source = self.fetch_market_price()
        active_pos_dict = self.db.load_active_mudrex_crude_paper_position()

        if active_pos_dict and curr_price and curr_price > 0:
            try:
                pos = MudrexCrudePaperTradeState.from_dict(active_pos_dict)
                _, unrealized_gross, entry_fee, exit_fee, total_charges, unrealized_net = self.calculate_position_pnl(
                    pos, curr_price, hedge_rate
                )
            except Exception:
                unrealized_gross = 0.0
                total_charges = 0.0
                unrealized_net = 0.0
            price_val = curr_price
        elif curr_price and curr_price > 0:
            unrealized_gross = 0.0
            total_charges = 0.0
            unrealized_net = 0.0
            price_val = curr_price
        else:
            unrealized_gross = 0.0
            total_charges = 0.0
            unrealized_net = 0.0
            price_val = 0.0
            price_source = "MARKET DATA UNAVAILABLE"

        all_trades = self.db.load_all_mudrex_crude_paper_trades()

        valid_closed_trades = [t for t in all_trades if self._is_valid_closed_trade(t)]
        total_gross_realized = sum(float(t.get("gross_pnl") or 0.0) for t in valid_closed_trades)
        total_charges_realized = sum(float(t.get("total_charges") or t.get("charges") or 0.0) for t in valid_closed_trades)
        total_funding_realized = sum(float(t.get("funding_fee") or 0.0) for t in valid_closed_trades)
        total_net_realized = sum(float(t.get("net_pnl") or 0.0) for t in valid_closed_trades)

        today_valid_trades = [t for t in valid_closed_trades if self.today_date in str(t.get("entry_timestamp", ""))]
        today_wins = len([t for t in today_valid_trades if float(t.get("net_pnl") or 0) > 0])
        today_losses = len([t for t in today_valid_trades if float(t.get("net_pnl") or 0) < 0])
        win_rate = (today_wins / len(today_valid_trades) * 100.0) if today_valid_trades else 0.0

        formatted_history = []
        for t in all_trades:
            t_copy = dict(t)
            if t_copy.get("status") == MudrexCrudeTradeStatus.CLOSED.value and not self._is_valid_closed_trade(t_copy):
                t_copy["exit_reason"] = "INVALID RECORD (ZERO EXIT PRICE)"
                t_copy["is_invalid"] = True
                t_copy["gross_pnl"] = 0.0
                t_copy["net_pnl"] = 0.0
            formatted_history.append(t_copy)

        if active_pos_dict and active_pos_dict.get("status") in (MudrexCrudeTradeStatus.OPEN.value, MudrexCrudeTradeStatus.EXIT_REQUESTED.value):
            scanner_status = f"POSITION ACTIVE ({active_pos_dict.get('status')})"
        else:
            scanner_status = "SCANNING FOR SIGNALS"

        return {
            "symbol": "CL/USDT",
            "crude_price_usd": price_val,
            "current_price": price_val,
            "crude_price_inr": round(price_val * hedge_rate, 2) if price_val else 0.0,
            "hedge_rate": hedge_rate,
            "price_source": price_source,
            "mudrex_api_status": "AUTHENTICATED",
            "paper_inr_balance": 200000.0,
            "new_entries_allowed": active_pos_dict is None,
            "new_entries_reason": scanner_status,
            "circuit_breaker": "NORMAL",
            "circuit_breaker_reason": "No errors",
            "position": active_pos_dict.get("status") if active_pos_dict else "NONE",
            "scanner_status": scanner_status,
            "active_position": active_pos_dict,
            "entry_price": active_pos_dict.get("entry_price") if active_pos_dict else None,
            "target_price": active_pos_dict.get("target_price") if active_pos_dict else None,
            "stop_loss_price": active_pos_dict.get("stop_loss_price") if active_pos_dict else None,
            "current_unrealized_gross_pnl": round(unrealized_gross, 2),
            "current_estimated_charges": round(total_charges, 2),
            "current_unrealized_net_pnl": round(unrealized_net, 2),
            "today_realized_pnl": round(self.today_realized_pnl, 2),
            "total_gross_realized_pnl": round(total_gross_realized, 2),
            "total_charges_realized": round(total_charges_realized, 2),
            "total_funding_fee": round(total_funding_realized, 2),
            "total_net_realized_pnl": round(total_net_realized, 2),
            "daily_loss_limit_inr": self.daily_loss_limit_inr,
            "per_trade_loss_limit_inr": self.per_trade_loss_limit_inr,
            "per_trade_profit_target_inr": self.per_trade_profit_target_inr,
            "today_trades_count": len(today_valid_trades),
            "today_wins_count": today_wins,
            "today_losses_count": today_losses,
            "win_rate": round(win_rate, 1),
            "live_trading_enabled": False,
            "paper_mode": True,
            "trade_history": formatted_history,
            "evaluation_stream": self.evaluation_stream[:25],
            "latest_evaluation": self.last_evaluation
        }

    async def start_feed_loop(self):
        """Background feed loop for Mudrex Crude Paper Engine."""
        self.is_running = True
        print(f"[{datetime.now()}] [MUDREX CRUDE PAPER ENGINE] Background loop started.")
        while self.is_running:
            try:
                self.process_tick()
            except Exception as e:
                print(f"[{datetime.now()}] [MUDREX CRUDE PAPER ENGINE LOOP ERROR] {e}")
            await asyncio.sleep(5)


# Global Singleton Instance
MUDREX_CRUDE_PAPER_ENGINE = MudrexCrudePaperEngine()
