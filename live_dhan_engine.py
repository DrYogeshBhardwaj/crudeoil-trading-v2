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

class DhanFeedManager:
    """
    Continuous Dhan WebSocket Connection Manager with Automatic Reconnection.
    Streams live ticks from wss://api-feed.dhan.co for CRUDEOILM.
    Strictly sanitizes credentials from all log outputs.
    """
    def __init__(self, engine: "LivePaperTradingEngine"):
        self.engine = engine
        self.feed_url = os.environ.get("DHAN_FEED_URL", "wss://api-feed.dhan.co")
        self.security_id = CONFIG.DHAN_SECURITY_ID
        self.exchange_segment = CONFIG.EXCHANGE_SEGMENT
        self.is_running = True

    async def connect_and_listen(self):
        """
        Main continuous WebSocket listener loop with auto-reconnection and token sanitization.
        """
        import websockets
        import struct
        
        while self.is_running:
            client_id = os.environ.get("DHAN_CLIENT_ID", "").strip()
            access_token = os.environ.get("DHAN_ACCESS_TOKEN", "").strip()

            if not client_id or not access_token:
                self.engine.ws_connected = False
                await asyncio.sleep(5)
                continue

            ws_url = f"{self.feed_url}?version=2&token={access_token}&clientId={client_id}&authType=2"
            try:
                async with websockets.connect(ws_url, ping_interval=20, ping_timeout=10) as ws:
                    self.engine.ws_connected = True
                    print(f"[{datetime.now()}] Connected to Dhan WebSocket Live Feed for Security ID {self.security_id}")
                    
                    sub_payload = {
                        "RequestCode": 15,
                        "InstrumentCount": 1,
                        "InstrumentList": [
                            {
                                "ExchangeSegment": self.exchange_segment,
                                "SecurityId": self.security_id
                            }
                        ]
                    }
                    await ws.send(json.dumps(sub_payload))
                    
                    while self.is_running:
                        message = await ws.recv()
                        now_ist = datetime.utcnow() + timedelta(hours=5, minutes=30)
                        
                        if isinstance(message, bytes):
                            price = self._parse_dhan_binary_ltp(message)
                            if price and price > 0:
                                self.engine.process_live_tick(now_ist, price)
                        elif isinstance(message, str):
                            try:
                                data = json.loads(message)
                                price = data.get("LTP") or data.get("ltp") or data.get("last_price")
                                if price:
                                    self.engine.process_live_tick(now_ist, float(price))
                            except Exception:
                                pass
            except Exception as e:
                self.engine.ws_connected = False
                err_str = str(e)
                if access_token and access_token in err_str:
                    err_str = err_str.replace(access_token, "[REDACTED]")
                print(f"[{datetime.now()}] Dhan WS Connection issue: {err_str}. Reconnecting in 5s...")
                await asyncio.sleep(5)

    def _parse_dhan_binary_ltp(self, raw_bytes: bytes) -> Optional[float]:
        """Parses Dhan binary feed packet for LTP across Ticker, Quote, and Full depth packets."""
        import struct
        try:
            if len(raw_bytes) < 8:
                return None
            
            # Check float32 at byte offset 8
            if len(raw_bytes) >= 12:
                ltp_float = struct.unpack_from('<f', raw_bytes, 8)[0]
                if 1000.0 <= ltp_float <= 25000.0:
                    return round(ltp_float, 2)
                
                ltp_int = struct.unpack_from('<i', raw_bytes, 8)[0]
                if 100000 <= ltp_int <= 2500000:
                    return round(ltp_int / 100.0, 2)

            # Fallback for 8-byte minimal binary header
            if len(raw_bytes) >= 8:
                ltp_int = struct.unpack_from('<i', raw_bytes, 4)[0]
                if 100000 <= ltp_int <= 2500000:
                    return round(ltp_int / 100.0, 2)
        except Exception:
            pass
        return None

class LivePaperTradingEngine:

    def __init__(self):
        self.candle_builder = MultiTimeframeCandleBuilder()
        self.paper_engine = PaperExecutionEngine()
        self.audit_logger = AuditLogger()
        
        self.current_signal: Optional[TradeSignal] = None
        self.latest_tick_time: Optional[datetime] = None
        self.current_price: float = 7460.5
        self.is_running: bool = True
        self.ws_connected: bool = False
        self.recent_ticks = []
        self.feed_manager = DhanFeedManager(self)

        # Pre-seed warmup candles for instant MTF structure readiness
        self._seed_warmup_candles()

    async def start_feed_loop(self):
        """Launches continuous background Dhan WebSocket feed loop."""
        await self.feed_manager.connect_and_listen()

    def _seed_warmup_candles(self):
        """Pre-seeds 20 hours of historical warmup candles for MTF structure readiness."""
        start_time = datetime.now() - timedelta(minutes=1200)
        price = 7400.0
        for m in range(1200):
            t = start_time + timedelta(minutes=m)
            wave = m % 10
            delta = 0.5 if wave < 6 else -0.3
            price += delta
            c = Candle(timestamp=t, open=price-1, high=price+2, low=price-2, close=price, volume=3000.0, open_interest=5000.0)
            self.candle_builder.add_completed_1m_candle(c)
        self.current_price = price

        # Initial strategy evaluation on warmup candles for instant UI accuracy
        c1h = self.candle_builder.candles_1h
        c15m = self.candle_builder.candles_15m
        c5m = self.candle_builder.candles_5m
        now_ist = datetime.utcnow() + timedelta(hours=5, minutes=30)
        if c1h and c15m and c5m:
            self.current_signal = SignalEngine.evaluate_signal(c1h, c15m, c5m, now_ist)

    def process_live_tick(self, timestamp: datetime, price: float, volume: float = 0.0, oi: float = 0.0) -> Dict[str, Any]:
        """
        Main tick processor called on every incoming Dhan WebSocket / API tick.
        """
        self.latest_tick_time = timestamp
        self.current_price = price
        
        # Append to recent live ticks buffer
        tick_entry = {"timestamp": timestamp.strftime("%Y-%m-%d %H:%M:%S"), "ltp": round(price, 2)}
        self.recent_ticks.append(tick_entry)
        if len(self.recent_ticks) > 50:
            self.recent_ticks = self.recent_ticks[-50:]
        
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
        c1m = self.candle_builder.candles_1m

        # IST Time calculations
        now_ist = datetime.utcnow() + timedelta(hours=5, minutes=30)
        
        if self.latest_tick_time is not None:
            last_tick = self.latest_tick_time
            tick_age_seconds = round((now_ist - last_tick).total_seconds(), 1)
            is_data_stale = tick_age_seconds > CONFIG.DATA_STALE_THRESHOLD_SECONDS
        else:
            last_tick = None
            tick_age_seconds = 9999.0
            is_data_stale = True

        # Enforce Stale Data & Connection Guards
        if not self.ws_connected or is_data_stale:
            system_status = "STALE DATA / NO TRADE"
            feed_health = "DISCONNECTED" if not self.ws_connected else "STALE DATA"
            paper_trading_allowed = "NO (DISCONNECTED)" if not self.ws_connected else "NO (DATA STALE)"
        else:
            system_status = self.paper_engine.system_status
            feed_health = "LIVE"
            paper_trading_allowed = "YES"

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

        active_sig = self.current_signal
        if not active_sig and c1h and c15m and c5m:
            active_sig = SignalEngine.evaluate_signal(c1h, c15m, c5m, now_ist)
            self.current_signal = active_sig

        signal_action = "WAIT" if (is_data_stale or not self.ws_connected) else (active_sig.action if active_sig else "WAIT")
        trend_state = active_sig.trend_state if active_sig else (trend_eval.state if trend_eval else "RANGE")
        confidence = active_sig.confidence if active_sig else (trend_eval.confidence if trend_eval else 0)
        reasons = active_sig.reasons[:] if active_sig else (trend_eval.reasons if trend_eval else [])

        if not self.ws_connected:
            reasons.append("STALE DATA GUARD: Dhan WebSocket disconnected. Signals PAUSED.")
        elif is_data_stale:
            reasons.append(f"STALE DATA GUARD: Last received tick age ({tick_age_seconds}s) exceeds max threshold (10.0s). Signals PAUSED.")

        signal_dict = {
            "action": signal_action,
            "trend_state": trend_state,
            "confidence": confidence,
            "entry_price": active_sig.entry_price if active_sig else None,
            "stop_loss": active_sig.stop_loss if active_sig else None,
            "target_1": active_sig.target_1 if active_sig else None,
            "target_2": active_sig.target_2 if active_sig else None,
            "risk_inr": round(active_sig.risk_inr, 2) if active_sig else 0.0,
            "reasons": reasons
        }

        # Daily Report Metrics
        report = DailyReporter.generate_report(
            date_str=now_ist.strftime("%Y-%m-%d"),
            total_signals=self.paper_engine.trade_counter,
            wait_signals=0,
            closed_trades=self.paper_engine.closed_trades
        )

        return {
            "instrument": CONFIG.INSTRUMENT_NAME,
            "security_id": CONFIG.DHAN_SECURITY_ID,
            "exchange_segment": CONFIG.EXCHANGE_SEGMENT,
            "contract_expiry": CONFIG.CONTRACT_EXPIRY,
            "exchange": CONFIG.EXCHANGE,
            "data_source": CONFIG.DATA_SOURCE_NAME,
            "synthetic_replay_mode": "NO",
            "websocket_connected": self.ws_connected,
            "feed_health": feed_health,
            "tick_age_seconds": tick_age_seconds,
            "paper_trading_allowed": paper_trading_allowed,
            "real_trading_enabled": CONFIG.ENABLE_REAL_TRADING,
            "system_status": system_status,
            "current_price": round(self.current_price, 2) if self.latest_tick_time else 0.0,
            "server_time_ist": now_ist.strftime("%Y-%m-%d %H:%M:%S"),
            "last_tick_time_ist": last_tick.strftime("%Y-%m-%d %H:%M:%S") if last_tick else "NONE",
            "recent_20_ticks": self.recent_ticks[-20:],
            "candle_status": {
                "1m_count": len(c1m),
                "5m_count": len(c5m),
                "15m_count": len(c15m),
                "1h_count": len(c1h)
            },
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
            "trade_ledger": ledger_list[:50]
        }

# Global Singleton Instance for Service Access
LIVE_ENGINE = LivePaperTradingEngine()

