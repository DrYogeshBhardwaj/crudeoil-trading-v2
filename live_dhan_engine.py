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
        self.last_error = None

    async def connect_and_listen(self):
        """
        Main continuous WebSocket listener loop with auto-reconnection and token sanitization.
        """
        import websockets
        import struct
        
        retry_delay = 5
        while self.is_running:
            client_id = os.environ.get("DHAN_CLIENT_ID", "").strip()
            access_token = os.environ.get("DHAN_ACCESS_TOKEN", "").strip()

            if not client_id or not access_token:
                self.engine.ws_connected = False
                missing_list = []
                if not client_id: missing_list.append("DHAN_CLIENT_ID")
                if not access_token: missing_list.append("DHAN_ACCESS_TOKEN")
                self.last_error = f"Missing environment variable(s): {', '.join(missing_list)}"
                await asyncio.sleep(5)
                continue

            ws_url = f"{self.feed_url}?version=2&token={access_token}&clientId={client_id}&authType=2"
            try:
                async with websockets.connect(ws_url, ping_interval=20, ping_timeout=10) as ws:
                    self.engine.ws_connected = True
                    self.last_error = None
                    retry_delay = 5  # Reset retry delay on successful connection
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
                if client_id and client_id in err_str:
                    err_str = err_str.replace(client_id, "[REDACTED]")
                self.last_error = err_str
                
                # Dynamic backoff for Dhan HTTP 429 Rate Limit
                if "429" in err_str:
                    retry_delay = min(retry_delay * 2 + 5, 30)
                else:
                    retry_delay = 5

                print(f"[{datetime.now()}] Dhan WS Connection issue: {err_str}. Reconnecting in {retry_delay}s...")
                await asyncio.sleep(retry_delay)

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

from replay_test import generate_multiday_session_data

class ServerSideReplayFeed:
    """
    Continuous 24x7 Server-Side Historical Replay Feed Manager.
    Streams 5,400 CRUDEOILM candles (1,200 warmup + 4,200 multi-day session candles)
    second-by-second directly into the trading engine 24x7 without Dhan WS dependency.
    """
    def __init__(self, engine: "LivePaperTradingEngine"):
        self.engine = engine
        self.is_running = True
        self.candles = generate_multiday_session_data()
        self.current_index = 0
        self.total_candles = len(self.candles)
        self.is_completed = False

    async def start_replay_loop(self):
        """
        Main 24x7 server-side replay loop running continuously on Railway.
        """
        print(f"[{datetime.now()}] Starting Server-Side Replay Feed with {self.total_candles} candles...")
        
        # 1. Feed initial 1,200 warmup candles instantly for structure readiness
        warmup_count = min(1200, self.total_candles)
        for i in range(warmup_count):
            c = self.candles[i]
            self.engine.candle_builder.add_completed_1m_candle(c)
        self.current_index = warmup_count

        c1h = self.engine.candle_builder.candles_1h
        c15m = self.engine.candle_builder.candles_15m
        c5m = self.engine.candle_builder.candles_5m
        if c1h and c15m and c5m:
            self.engine.current_signal = SignalEngine.evaluate_signal(c1h, c15m, c5m, self.candles[warmup_count-1].timestamp)

        # 2. Step through session candles second-by-second
        while self.is_running:
            if self.current_index >= self.total_candles:
                self.is_completed = True
                self.engine.replay_ended = True
                await asyncio.sleep(2)
                continue

            c = self.candles[self.current_index]
            self.engine.process_replay_candle(c)
            self.current_index += 1
            await asyncio.sleep(1.0)  # 1-second step per candle

class LivePaperTradingEngine:

    def __init__(self):
        self.candle_builder = MultiTimeframeCandleBuilder()
        self.paper_engine = PaperExecutionEngine()
        self.audit_logger = AuditLogger()
        
        self.current_signal: Optional[TradeSignal] = None
        self.latest_tick_time: Optional[datetime] = None
        self.current_price: float = 6500.0
        self.is_running: bool = True
        self.ws_connected: bool = False
        self.replay_ended: bool = False
        self.recent_ticks = []
        self.feed_manager = DhanFeedManager(self)
        self.replay_feed = ServerSideReplayFeed(self)

    async def start_feed_loop(self):
        """Launches continuous server-side 24x7 historical replay feed loop."""
        await self.replay_feed.start_replay_loop()

    def process_replay_candle(self, candle: Candle) -> Dict[str, Any]:
        """
        Processes a continuous server-side replay candle through structure, trend, signal, and paper engine.
        """
        self.latest_tick_time = candle.timestamp
        self.current_price = candle.close
        
        tick_entry = {"timestamp": candle.timestamp.strftime("%Y-%m-%d %H:%M:%S"), "ltp": round(candle.close, 2)}
        self.recent_ticks.append(tick_entry)
        if len(self.recent_ticks) > 50:
            self.recent_ticks = self.recent_ticks[-50:]

        self.candle_builder.add_completed_1m_candle(candle)

        c1h = self.candle_builder.candles_1h
        c15m = self.candle_builder.candles_15m
        c5m = self.candle_builder.candles_5m

        signal = SignalEngine.evaluate_signal(c1h, c15m, c5m, candle.timestamp)
        self.current_signal = signal

        current_candle = c5m[-1] if c5m else candle
        pos_event = self.paper_engine.process_signal_and_market(signal, current_candle)
        self.audit_logger.log_decision(candle.timestamp, candle.close, signal, self.paper_engine.system_status)

        return self.get_dashboard_state()

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

        # Replay Mode & Status Calculations
        if self.replay_ended:
            system_status = "REPLAY DATA ENDED / WAITING"
            feed_health = "REPLAY ENDED"
            paper_trading_allowed = "NO (REPLAY ENDED)"
        else:
            system_status = self.paper_engine.system_status
            feed_health = "ACTIVE REPLAY"
            paper_trading_allowed = "YES (PAPER REPLAY)"

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

        if self.replay_ended:
            signal_action = "WAIT"
            reasons = ["REPLAY DATA ENDED / WAITING: All 5,400 multi-day historical candles executed. System WAITING."]
        else:
            signal_action = active_sig.action if active_sig else "WAIT"
            reasons = active_sig.reasons[:] if active_sig else (trend_eval.reasons if trend_eval else [])

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

        # Calculate performance metrics for virtual account
        closed = self.paper_engine.closed_trades
        total_trades = len(closed)
        winning_trades = [t for t in closed if t.pnl_result and t.pnl_result.net_pnl > 0]
        losing_trades = [t for t in closed if t.pnl_result and t.pnl_result.net_pnl <= 0]
        win_rate = round((len(winning_trades) / total_trades * 100), 1) if total_trades > 0 else 0.0

        gross_profit = sum(t.pnl_result.gross_pnl for t in winning_trades if t.pnl_result)
        gross_loss = sum(abs(t.pnl_result.gross_pnl) for t in losing_trades if t.pnl_result)
        if gross_loss > 0:
            pf_str = f"{gross_profit / gross_loss:.2f}"
        else:
            pf_str = "UNDEFINED (Gross Loss = 0)" if gross_profit > 0 else "0.00"

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

        starting_cap = self.paper_engine.starting_capital
        realized_pnl = self.paper_engine.total_realized_pnl
        current_cap = starting_cap + realized_pnl
        available_cap = current_cap + unrealized_pnl

        feed_mode_label = "LIVE DHAN FEED" if (self.ws_connected and not is_data_stale) else "PAPER REPLAY / NO LIVE FEED"

        return {
            "instrument": CONFIG.INSTRUMENT_NAME,
            "security_id": CONFIG.DHAN_SECURITY_ID,
            "exchange_segment": CONFIG.EXCHANGE_SEGMENT,
            "contract_expiry": CONFIG.CONTRACT_EXPIRY,
            "exchange": CONFIG.EXCHANGE,
            "data_source": CONFIG.DATA_SOURCE_NAME,
            "synthetic_replay_mode": "NO",
            "feed_mode_label": feed_mode_label,
            "websocket_connected": self.ws_connected,
            "dhan_client_id": "PRESENT" if bool(os.environ.get("DHAN_CLIENT_ID", "").strip()) else "MISSING",
            "dhan_access_token": "PRESENT" if bool(os.environ.get("DHAN_ACCESS_TOKEN", "").strip()) else "MISSING",
            "last_ws_error": self.feed_manager.last_error if hasattr(self.feed_manager, "last_error") else None,
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
            
            # Virtual Account Capital Metrics (Rs. 2,00,000 Mode)
            "starting_virtual_capital": starting_cap,
            "current_virtual_capital": round(current_cap, 2),
            "available_virtual_capital": round(available_cap, 2),
            "realized_pnl": round(realized_pnl, 2),
            "unrealized_pnl": round(unrealized_pnl, 2),
            "daily_realized_pnl": round(self.paper_engine.daily_net_pnl, 2),
            "total_charges": round(self.paper_engine.total_charges, 2),
            "total_slippage": round(self.paper_engine.total_slippage, 2),
            "daily_loss_limit": CONFIG.DAILY_LOSS_LIMIT_INR,
            "daily_loss_limit_hit": self.paper_engine.daily_loss_limit_hit,
            "total_trades_count": total_trades,
            "winning_trades_count": len(winning_trades),
            "losing_trades_count": len(losing_trades),
            "win_rate_percent": win_rate,
            "profit_factor_str": pf_str,
            "max_drawdown_inr": round(max_dd, 2),
            
            "report_summary": report,
            "trade_ledger": ledger_list[:50]
        }

# Global Singleton Instance for Service Access
LIVE_ENGINE = LivePaperTradingEngine()

