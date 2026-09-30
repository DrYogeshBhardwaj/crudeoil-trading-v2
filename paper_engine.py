"""
Paper Execution Engine & Position Lifecycle Manager.
STRICTLY PAPER TRADING ONLY - REAL TRADING IS HARDCODED TO DISABLED.
Enforces Max 1 Lot, No Martingale, No Averaging, Daily Loss Limits, Trailing SL, and Session Exits.
"""

from typing import List, Dict, Optional
from dataclasses import dataclass, field
from datetime import datetime
from config import CONFIG
from signal_engine import TradeSignal
from pnl_calculator import PnLCalculator, PnLResult

@dataclass
class PaperPosition:
    trade_id: str
    entry_timestamp: datetime
    instrument: str
    direction: str             # 'BUY' or 'SELL'
    quantity: int              # Strictly 1 lot
    entry_price: float
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

class PaperExecutionEngine:

    def __init__(self):
        self.active_position: Optional[PaperPosition] = None
        self.closed_trades: List[PaperPosition] = []
        self.daily_net_pnl: float = 0.0
        self.daily_loss_limit_hit: bool = False
        self.system_status: str = "WATCHING"   # 'WATCHING', 'PAPER ACTIVE', 'PAUSED', 'NO TRADE'
        self.trade_counter: int = 0

    def process_signal_and_market(self, signal: TradeSignal, current_candle: object) -> Optional[PaperPosition]:
        """
        Main execution tick handler.
        1. Monitors active paper position for exit rules.
        2. Evaluates entry signals if no active position is open.
        """
        curr_time = current_candle.timestamp
        curr_price = current_candle.close

        # Check Daily Loss Limit status
        if self.daily_net_pnl <= -CONFIG.DAILY_LOSS_LIMIT_INR:
            self.daily_loss_limit_hit = True
            self.system_status = "PAUSED"
            if self.active_position:
                self._close_position(self.active_position, curr_time, curr_price, "DAILY_LOSS_LIMIT_PAUSE")
            return None

        # 1. MONITOR ACTIVE POSITION EXITS
        if self.active_position:
            self.system_status = "PAPER ACTIVE"
            pos = self.active_position

            # End-of-Session Exit Check (23:15 IST)
            if curr_time.time() >= datetime.strptime(CONFIG.EOD_SQUAREOFF_TIME, "%H:%M:%S").time():
                return self._close_position(pos, curr_time, curr_price, "EOD_SESSION_EXIT")

            # Structure Reversal Check
            if (pos.direction == "BUY" and signal.trend_state in ["DOWN", "STRONG DOWN"]) or \
               (pos.direction == "SELL" and signal.trend_state in ["UP", "STRONG UP"]):
                return self._close_position(pos, curr_time, curr_price, "STRUCTURE_REVERSAL_EXIT")

            # Check BUY Position Exits
            if pos.direction == "BUY":
                # Check Stop Loss Hit
                if current_candle.low <= pos.stop_loss:
                    exit_price = min(pos.stop_loss, current_candle.open)
                    return self._close_position(pos, curr_time, exit_price, "STOP_LOSS_HIT")

                # Check Target 1 Hit -> Move SL to Break-Even (Trailing Exit)
                if not pos.t1_hit and current_candle.high >= pos.target_1:
                    pos.t1_hit = True
                    pos.stop_loss = max(pos.stop_loss, pos.entry_price)  # Move SL to Break-Even

                # Check Target 2 Hit -> Full Take Profit Exit
                if current_candle.high >= pos.target_2:
                    exit_price = max(pos.target_2, current_candle.open)
                    return self._close_position(pos, curr_time, exit_price, "TARGET_2_HIT")

            # Check SELL Position Exits
            elif pos.direction == "SELL":
                # Check Stop Loss Hit
                if current_candle.high >= pos.stop_loss:
                    exit_price = max(pos.stop_loss, current_candle.open)
                    return self._close_position(pos, curr_time, exit_price, "STOP_LOSS_HIT")

                # Check Target 1 Hit -> Move SL to Break-Even (Trailing Exit)
                if not pos.t1_hit and current_candle.low <= pos.target_1:
                    pos.t1_hit = True
                    pos.stop_loss = min(pos.stop_loss, pos.entry_price)  # Move SL to Break-Even

                # Check Target 2 Hit -> Full Take Profit Exit
                if current_candle.low <= pos.target_2:
                    exit_price = min(pos.target_2, current_candle.open)
                    return self._close_position(pos, curr_time, exit_price, "TARGET_2_HIT")

            return None

        # 2. EVALUATE NEW PAPER TRADE ENTRY
        if self.daily_loss_limit_hit:
            self.system_status = "PAUSED"
            return None

        self.system_status = "WATCHING"

        if signal.action in ["BUY", "SELL"] and signal.entry_price is not None:
            self.trade_counter += 1
            trade_id = f"PT-{CONFIG.INSTRUMENT_NAME}-{curr_time.strftime('%Y%m%d')}-{self.trade_counter:03d}"

            # HARD ENFORCEMENT: Strictly 1 Lot Max, No Martingale, No Averaging
            new_pos = PaperPosition(
                trade_id=trade_id,
                entry_timestamp=curr_time,
                instrument=CONFIG.INSTRUMENT_NAME,
                direction=signal.action,
                quantity=1,  # Strictly 1 lot
                entry_price=signal.entry_price,
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
            self.system_status = "PAPER ACTIVE"
            return new_pos

        return None

    def _close_position(self, pos: PaperPosition, exit_time: datetime, exit_price: float, reason: str) -> PaperPosition:
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
        
        self.daily_net_pnl += pnl_res.net_pnl
        self.closed_trades.append(pos)
        self.active_position = None
        
        if self.daily_net_pnl <= -CONFIG.DAILY_LOSS_LIMIT_INR:
            self.daily_loss_limit_hit = True
            self.system_status = "PAUSED"
        else:
            self.system_status = "WATCHING"

        return pos
