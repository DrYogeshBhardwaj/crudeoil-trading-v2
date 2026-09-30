"""
Data Ingestion, Candle Builder, and Session Management Engine.
Supports Live Ticks, Replay Simulation, Gap-filling, and Stale Data Detection.
Optimized for high-speed tick & candle processing.
"""

from dataclasses import dataclass
from datetime import datetime, time, timedelta
from typing import List, Dict, Optional

from config import CONFIG

@dataclass
class Candle:
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0
    open_interest: float = 0.0

    def to_dict(self) -> dict:
        return {
            "timestamp": self.timestamp,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
            "open_interest": self.open_interest,
        }

class SessionValidator:
    """Validates MCX market session timings and intraday exit triggers."""
    
    @staticmethod
    def is_market_open(dt: datetime) -> bool:
        if dt.weekday() >= 5:  # Saturday = 5, Sunday = 6
            return False
        
        t = dt.time()
        open_t = time.fromisoformat(CONFIG.MARKET_OPEN_TIME)
        close_t = time.fromisoformat(CONFIG.MARKET_CLOSE_TIME)
        return open_t <= t <= close_t

    @staticmethod
    def is_new_entry_allowed(dt: datetime) -> bool:
        if not SessionValidator.is_market_open(dt):
            return False
        t = dt.time()
        no_new_t = time.fromisoformat(CONFIG.NO_NEW_ENTRY_TIME)
        return t < no_new_t

    @staticmethod
    def is_eod_squareoff_time(dt: datetime) -> bool:
        t = dt.time()
        eod_t = time.fromisoformat(CONFIG.EOD_SQUAREOFF_TIME)
        return t >= eod_t

class MultiTimeframeCandleBuilder:
    """
    Constructs 5M, 15M, and 1H candles incrementally from 1M ticks/candles
    with zero lookahead bias. Optimized for performance.
    """
    def __init__(self):
        self.candles_1m: List[Candle] = []
        self.candles_5m: List[Candle] = []
        self.candles_15m: List[Candle] = []
        self.candles_1h: List[Candle] = []
        
        self.last_tick_time: Optional[datetime] = None
        self.is_connected: bool = True

    def process_tick(self, timestamp: datetime, price: float, volume: float = 0.0, oi: float = 0.0):
        """Processes a single price tick or 1M bar snapshot."""
        self.last_tick_time = timestamp
        minute_bucket = timestamp.replace(second=0, microsecond=0)
        
        if not self.candles_1m or self.candles_1m[-1].timestamp != minute_bucket:
            new_c = Candle(timestamp=minute_bucket, open=price, high=price, low=price, close=price, volume=volume, open_interest=oi)
            self.candles_1m.append(new_c)
        else:
            c = self.candles_1m[-1]
            c.high = max(c.high, price)
            c.low = min(c.low, price)
            c.close = price
            c.volume += volume
            c.open_interest = oi if oi > 0 else c.open_interest

        self._update_higher_tf(self.candles_1m[-1], 5, self.candles_5m)
        self._update_higher_tf(self.candles_1m[-1], 15, self.candles_15m)
        self._update_higher_tf(self.candles_1m[-1], 60, self.candles_1h)

    def add_completed_1m_candle(self, candle: Candle):
        """Processes a pre-formed 1M candle with zero lookahead bias."""
        self.last_tick_time = candle.timestamp
        self.candles_1m.append(candle)
        self._update_higher_tf(candle, 5, self.candles_5m)
        self._update_higher_tf(candle, 15, self.candles_15m)
        self._update_higher_tf(candle, 60, self.candles_1h)

    def gap_fill(self, missing_1m_candles: List[Candle]):
        """Fills missing historical candles after a reconnection event before resuming strategy."""
        for c in missing_1m_candles:
            self.add_completed_1m_candle(c)

    def is_data_stale(self, current_time: datetime) -> bool:
        if self.last_tick_time is None:
            return True
        elapsed = (current_time - self.last_tick_time).total_seconds()
        return elapsed > CONFIG.DATA_STALE_THRESHOLD_SECONDS

    def _update_higher_tf(self, candle_1m: Candle, tf_minutes: int, target_list: List[Candle]):
        """Fast O(1) aggregation of 1M candle into higher timeframe bucket."""
        ts = candle_1m.timestamp
        
        # Calculate start of interval bucket
        minute_offset = (ts.minute % tf_minutes)
        bucket_ts = ts.replace(second=0, microsecond=0) - timedelta(minutes=minute_offset)

        if not target_list or target_list[-1].timestamp != bucket_ts:
            # Create new higher-timeframe candle
            target_list.append(Candle(
                timestamp=bucket_ts,
                open=candle_1m.open,
                high=candle_1m.high,
                low=candle_1m.low,
                close=candle_1m.close,
                volume=candle_1m.volume,
                open_interest=candle_1m.open_interest
            ))
        else:
            # Update existing developing candle
            c = target_list[-1]
            c.high = max(c.high, candle_1m.high)
            c.low = min(c.low, candle_1m.low)
            c.close = candle_1m.close
            c.volume += candle_1m.volume
            c.open_interest = candle_1m.open_interest if candle_1m.open_interest > 0 else c.open_interest
