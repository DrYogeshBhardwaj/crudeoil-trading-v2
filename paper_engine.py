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

from database import DB

class PaperExecutionEngine:

    def __init__(self, starting_capital: float = CONFIG.STARTING_VIRTUAL_CAPITAL_INR, restore_db: bool = True):
        self.starting_capital: float = starting_capital
        self.active_position: Optional[PaperPosition] = None
        self.closed_trades: List[PaperPosition] = []
        self.daily_net_pnl: float = 0.0
        self.daily_loss_limit_hit: bool = False
        self.system_status: str = "WATCHING"   # 'WATCHING', 'PAPER ACTIVE', 'PAUSED', 'NO TRADE'
        self.trade_counter: int = 0
        if restore_db:
            self._restore_from_db()

    def _restore_from_db(self):
        """Restores closed trades and active position from SQLite database for crash persistence."""
        try:
            db_trades = DB.load_all_trades()
            for dt in db_trades:
                entry_ts = datetime.strptime(dt["entry_timestamp"], "%Y-%m-%d %H:%M:%S") if isinstance(dt["entry_timestamp"], str) else dt["entry_timestamp"]
                exit_ts = datetime.strptime(dt["exit_timestamp"], "%Y-%m-%d %H:%M:%S") if dt.get("exit_timestamp") and isinstance(dt["exit_timestamp"], str) else dt.get("exit_timestamp")
                
                pos = PaperPosition(
                    trade_id=dt["trade_id"],
                    entry_timestamp=entry_ts,
                    instrument=dt["instrument"],
                    direction=dt["direction"],
                    quantity=dt["quantity"],
                    entry_price=dt["entry_price"],
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
                    pnl_res = PnLCalculator.calculate_trade_pnl(
                        direction=dt["direction"],
                        entry_price=dt["entry_price"],
                        exit_price=dt["exit_price"],
                        quantity=dt["quantity"]
                    )
                    pos.pnl_result = pnl_res

                if dt["status"] == "OPEN":
                    self.active_position = pos
                    self.system_status = "PAPER ACTIVE"
                else:
                    self.closed_trades.append(pos)
                    if pos.pnl_result:
                        self.daily_net_pnl += pos.pnl_result.net_pnl
                
                self.trade_counter += 1
        except Exception as e:
            print(f"Warning restoring paper state from DB: {e}")

    @property
    def total_realized_pnl(self) -> float:
        return sum(t.pnl_result.net_pnl for t in self.closed_trades if t.pnl_result)

    @property
    def current_virtual_capital(self) -> float:
        return self.starting_capital + self.total_realized_pnl

    @property
    def total_charges(self) -> float:
        return sum(t.pnl_result.charges.total_deductions - t.pnl_result.charges.slippage for t in self.closed_trades if t.pnl_result)

    @property
    def total_slippage(self) -> float:
        return sum(t.pnl_result.charges.slippage for t in self.closed_trades if t.pnl_result)

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
            self.system_status = "PAUSED — DAILY LOSS LIMIT"
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
        if self.daily_loss_limit_hit or self.daily_net_pnl <= -CONFIG.DAILY_LOSS_LIMIT_INR:
            self.daily_loss_limit_hit = True
            self.system_status = "PAUSED — DAILY LOSS LIMIT"
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
            
            # Persist OPEN position to SQLite DB
            DB.save_paper_trade({
                "trade_id": new_pos.trade_id,
                "entry_timestamp": new_pos.entry_timestamp.strftime("%Y-%m-%d %H:%M:%S"),
                "instrument": new_pos.instrument,
                "direction": new_pos.direction,
                "quantity": new_pos.quantity,
                "entry_price": new_pos.entry_price,
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
        
        # Persist CLOSED trade to SQLite DB
        DB.save_paper_trade({
            "trade_id": pos.trade_id,
            "entry_timestamp": pos.entry_timestamp.strftime("%Y-%m-%d %H:%M:%S"),
            "instrument": pos.instrument,
            "direction": pos.direction,
            "quantity": pos.quantity,
            "entry_price": pos.entry_price,
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
        
        if self.daily_net_pnl <= -CONFIG.DAILY_LOSS_LIMIT_INR:
            self.daily_loss_limit_hit = True
            self.system_status = "PAUSED — DAILY LOSS LIMIT"
        else:
            self.system_status = "WATCHING"

        return pos
