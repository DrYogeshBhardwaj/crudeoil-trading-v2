"""
Live Dhan Market Feed Ingestion & Live Paper Trading Engine Service.
Connects live market ticks, streams multi-timeframe candles, evaluates strategy,
manages paper positions, logs decisions, and serves real-time status for the Web Dashboard.
STRICTLY PAPER TRADING ONLY. REAL TRADING EXECUTION IS HARDCODED TO DISABLED.
"""

import asyncio
import json
import os
import threading
import time
from datetime import datetime, timedelta
from typing import Dict, Any, Optional

from config import CONFIG
from data_engine import Candle, MultiTimeframeCandleBuilder, SessionValidator
from indicator_engine import IndicatorEngine
from logger_and_reporter import AuditLogger, DailyReporter
from paper_engine import PaperExecutionEngine, PaperPosition
from pnl_calculator import PnLCalculator
from signal_engine import SignalEngine, TradeSignal
from structure_analyzer import StructureAnalyzer
from trend_detector import TrendDetector

class LivePaperTradingEngine:

    def __init__(self):
        self.candle_builder = MultiTimeframeCandleBuilder()
        self.paper_engine = PaperExecutionEngine()
        self.audit_logger = AuditLogger()
        
        self.current_signal: Optional[TradeSignal] = None
        self.latest_tick_time: Optional[datetime] = None
        self.current_price: float = 6500.0
        self.is_running: bool = False

        # Pre-seed warmup candles for instant MTF structure readiness
        self._seed_warmup_candles()

    def _seed_warmup_candles(self):
        """Pre-seeds 20 hours of historical warmup candles for MTF structure readiness."""
        start_time = datetime.now() - timedelta(minutes=1200)
        price = 6500.0
        for m in range(1200):
            t = start_time + timedelta(minutes=m)
            wave = m % 10
            delta = 2.0 if wave < 6 else -1.0
            price += delta
            c = Candle(timestamp=t, open=price-1, high=price+2, low=price-2, close=price, volume=3000.0, open_interest=5000.0)
            self.candle_builder.add_completed_1m_candle(c)
        self.current_price = price

    def process_live_tick(self, timestamp: datetime, price: float, volume: float = 0.0, oi: float = 0.0) -> Dict[str, Any]:
        """
        Main tick processor called on every incoming Dhan WebSocket / API tick.
        """
        self.latest_tick_time = timestamp
        self.current_price = price
        
        # Add tick to candle builder
        self.candle_builder.process_tick(timestamp, price, volume, oi)

        c1h = self.candle_builder.candles_1h
        c15m = self.candle_builder.candles_15m
        c5m = self.candle_builder.candles_5m

        # Evaluate strategy signal
        signal = SignalEngine.evaluate_signal(c1h, c15m, c5m, timestamp)
        self.current_signal = signal

        # Process Paper Execution Engine
        current_candle = c5m[-1] if c5m else Candle(timestamp=timestamp, open=price, high=price, low=price, close=price)
        pos_event = self.paper_engine.process_signal_and_market(signal, current_candle)

        # Audit Log
        self.audit_logger.log_decision(timestamp, price, signal, self.paper_engine.system_status)

        return self.get_dashboard_state()

    def get_dashboard_state(self) -> Dict[str, Any]:
        """Returns complete real-time JSON state for the Live Web Dashboard."""
        c1h = self.candle_builder.candles_1h
        c15m = self.candle_builder.candles_15m
        c5m = self.candle_builder.candles_5m

        trend_eval = TrendDetector.evaluate(c1h, c15m, c5m) if (c1h and c15m and c5m) else None
        
        # Calculate unrealized P/L if position is active
        unrealized_pnl = 0.0
        active_pos_dict = None
        if self.paper_engine.active_position:
            pos = self.paper_engine.active_position
            if pos.direction == "BUY":
                unrealized_pnl = (self.current_price - pos.entry_price) * CONFIG.LOT_SIZE
            else:
                unrealized_pnl = (pos.entry_price - self.current_price) * CONFIG.LOT_SIZE
            
            active_pos_dict = {
                "trade_id": pos.trade_id,
                "direction": pos.direction,
                "entry_timestamp": pos.entry_timestamp.strftime("%Y-%m-%d %H:%M:%S"),
                "entry_price": pos.entry_price,
                "stop_loss": pos.stop_loss,
                "target_1": pos.target_1,
                "target_2": pos.target_2,
                "unrealized_pnl": round(unrealized_pnl, 2),
                "trend_state": pos.trend_state,
                "confidence": pos.confidence
            }

        # Format closed trades ledger
        ledger_list = []
        for t in reversed(self.paper_engine.closed_trades):
            res = t.pnl_result
            ledger_list.append({
                "trade_id": t.trade_id,
                "entry_time": t.entry_timestamp.strftime("%H:%M:%S"),
                "exit_time": t.exit_timestamp.strftime("%H:%M:%S") if t.exit_timestamp else "-",
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

        signal_dict = {
            "action": self.current_signal.action if self.current_signal else "WAIT",
            "trend_state": self.current_signal.trend_state if self.current_signal else "RANGE",
            "confidence": self.current_signal.confidence if self.current_signal else 0,
            "entry_price": self.current_signal.entry_price if self.current_signal else None,
            "stop_loss": self.current_signal.stop_loss if self.current_signal else None,
            "target_1": self.current_signal.target_1 if self.current_signal else None,
            "target_2": self.current_signal.target_2 if self.current_signal else None,
            "risk_inr": round(self.current_signal.risk_inr, 2) if self.current_signal else 0.0,
            "reasons": self.current_signal.reasons if self.current_signal else []
        }

        # Daily Report Metrics
        report = DailyReporter.generate_report(
            date_str=datetime.now().strftime("%Y-%m-%d"),
            total_signals=self.paper_engine.trade_counter,
            wait_signals=0,
            closed_trades=self.paper_engine.closed_trades
        )

        return {
            "instrument": CONFIG.INSTRUMENT_NAME,
            "exchange": CONFIG.EXCHANGE,
            "real_trading_enabled": CONFIG.ENABLE_REAL_TRADING,
            "system_status": self.paper_engine.system_status,
            "current_price": round(self.current_price, 2),
            "last_tick_time": self.latest_tick_time.strftime("%Y-%m-%d %H:%M:%S") if self.latest_tick_time else datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "tf_1h_state": trend_eval.tf_1h_state if trend_eval else "RANGE",
            "tf_15m_state": trend_eval.tf_15m_state if trend_eval else "RANGE",
            "tf_5m_state": trend_eval.tf_5m_state if trend_eval else "RANGE",
            "signal": signal_dict,
            "active_position": active_pos_dict,
            "daily_realized_pnl": round(self.paper_engine.daily_net_pnl, 2),
            "daily_loss_limit": CONFIG.DAILY_LOSS_LIMIT_INR,
            "daily_loss_limit_hit": self.paper_engine.daily_loss_limit_hit,
            "total_trades_count": len(self.paper_engine.closed_trades),
            "report_summary": report,
            "trade_ledger": ledger_list[:50] # Top 50 recent trades
        }

# Global Singleton Instance for Service Access
LIVE_ENGINE = LivePaperTradingEngine()
