"""
Bitcoin (BTC-INR) Real-Time Market Data Feed Module.
Fetches real 24x7 BTC-INR market data from Yahoo Finance (BTC-INR) and Binance (BTCUSDT).
NO FAKE OR SYNTHETIC DATA GENERATION.
"""

import requests
import time
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional, Tuple

class BitcoinDataFeed:
    """
    Data Feed Provider for Bitcoin in INR (BTC-INR).
    Fetches raw market quotes and OHLC candles.
    """

    def __init__(self):
        self.symbol = "BTC-INR"
        self.data_source = "Yahoo Finance / Binance (BTC-INR)"
        self.user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        self.last_successful_tick: Optional[Dict[str, Any]] = None
        self.last_fetch_time: float = 0.0

    def fetch_latest_tick(self) -> Dict[str, Any]:
        """
        Fetches real-time price & metadata for Bitcoin in INR.
        Returns state dictionary with connection & 24x7 market status.
        """
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{self.symbol}?interval=1m&range=1d"
        headers = {"User-Agent": self.user_agent}

        now_timestamp = time.time()
        ist_tz = timezone(timedelta(hours=5, minutes=30))
        now_ist_str = datetime.now(ist_tz).strftime("%Y-%m-%d %H:%M:%S IST")
        now_utc_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

        try:
            resp = requests.get(url, headers=headers, timeout=6)
            if resp.status_code == 200:
                json_data = resp.json()
                result = json_data.get("chart", {}).get("result", [])
                if result:
                    data = result[0]
                    meta = data.get("meta", {})
                    indicators = data.get("indicators", {}).get("quote", [{}])[0]
                    timestamps = data.get("timestamp", [])

                    price = meta.get("regularMarketPrice") or meta.get("chartPreviousClose")
                    prev_close = meta.get("chartPreviousClose") or meta.get("previousClose") or price
                    reg_time = meta.get("regularMarketTime")

                    closes = [c for c in indicators.get("close", []) if c is not None]
                    if closes:
                        price = closes[-1]

                    if timestamps and not reg_time:
                        reg_time = timestamps[-1]

                    if price is not None and price > 0:
                        change = price - prev_close if prev_close else 0.0
                        change_pct = (change / prev_close * 100.0) if prev_close else 0.0

                        tick_dt_utc = datetime.fromtimestamp(reg_time, tz=timezone.utc) if reg_time else datetime.now(timezone.utc)
                        tick_dt_ist = tick_dt_utc.astimezone(ist_tz)

                        tick_age = int(now_timestamp - (reg_time if reg_time else now_timestamp))

                        conn_status = "STALE" if tick_age > 1800 else "CONNECTED"

                        tick_info = {
                            "symbol": self.symbol,
                            "price": round(float(price), 2),
                            "change": round(float(change), 2),
                            "change_pct": round(float(change_pct), 2),
                            "prev_close": round(float(prev_close), 2),
                            "high": round(float(meta.get("regularMarketDayHigh", price)), 2),
                            "low": round(float(meta.get("regularMarketDayLow", price)), 2),
                            "volume": meta.get("regularMarketVolume", 0),
                            "currency": "INR",
                            "exchange": "CCC",
                            "last_tick_timestamp_utc": tick_dt_utc.strftime("%Y-%m-%d %H:%M:%S UTC"),
                            "last_tick_timestamp_ist": tick_dt_ist.strftime("%Y-%m-%d %H:%M:%S IST"),
                            "last_tick_epoch": reg_time,
                            "tick_age_seconds": tick_age,
                            "market_status": "24x7 OPEN",
                            "data_source": "Yahoo Finance (BTC-INR)",
                            "data_feed_type": "REAL-TIME 24x7 FEED",
                            "connection_status": conn_status,
                            "last_update_time_ist": now_ist_str,
                            "error": None
                        }

                        self.last_successful_tick = tick_info
                        self.last_fetch_time = now_timestamp
                        return tick_info

            return self._build_disconnected_state(
                reason=f"HTTP Error {resp.status_code}" if resp.status_code != 200 else "Invalid JSON schema",
                now_ist=now_ist_str
            )

        except Exception as e:
            return self._build_disconnected_state(
                reason=f"Network/API Error: {str(e)}",
                now_ist=now_ist_str
            )

    def _build_disconnected_state(self, reason: str, now_ist: str) -> Dict[str, Any]:
        """Returns structured feed state when live API is unavailable."""
        if self.last_successful_tick:
            tick = dict(self.last_successful_tick)
            tick["connection_status"] = "DISCONNECTED"
            tick["last_update_time_ist"] = now_ist
            tick["error"] = reason
            return tick

        return {
            "symbol": self.symbol,
            "price": 0.0,
            "change": 0.0,
            "change_pct": 0.0,
            "prev_close": 0.0,
            "high": 0.0,
            "low": 0.0,
            "volume": 0,
            "currency": "INR",
            "exchange": "CCC",
            "last_tick_timestamp_utc": "N/A",
            "last_tick_timestamp_ist": "N/A",
            "last_tick_epoch": 0,
            "tick_age_seconds": 99999,
            "market_status": "24x7 OPEN",
            "data_source": "Yahoo Finance (BTC-INR)",
            "data_feed_type": "REAL-TIME 24x7 FEED",
            "connection_status": "LIVE FEED NOT CONNECTED",
            "last_update_time_ist": now_ist,
            "error": reason
        }

    def is_market_open(self) -> Tuple[bool, str]:
        """Bitcoin crypto market operates 24 hours a day, 7 days a week."""
        return True, "24x7 Crypto Market Open"

    def fetch_historical_candles(self, interval: str = "5m", range_str: str = "5d", tf: Optional[str] = None, period: Optional[str] = None) -> List[Dict[str, Any]]:
        """
        Fetches OHLCV candle historical series for BTC-INR.
        Supports interval: '1m', '5m', '15m', '60m'.
        """
        if tf:
            interval = tf
        if period:
            range_str = period

        if interval in ("5m", "15m") and range_str == "1d":
            range_str = "5d"

        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{self.symbol}?interval={interval}&range={range_str}"
        headers = {"User-Agent": self.user_agent}

        try:
            resp = requests.get(url, headers=headers, timeout=8)
            if resp.status_code == 200:
                result = resp.json().get("chart", {}).get("result", [])
                if result:
                    data = result[0]
                    timestamps = data.get("timestamp", [])
                    quote = data.get("indicators", {}).get("quote", [{}])[0]

                    opens = quote.get("open", [])
                    highs = quote.get("high", [])
                    lows = quote.get("low", [])
                    closes = quote.get("close", [])
                    volumes = quote.get("volume", [])

                    candles = []
                    ist_tz = timezone(timedelta(hours=5, minutes=30))

                    for i in range(len(timestamps)):
                        t = timestamps[i]
                        o = opens[i] if i < len(opens) else None
                        h = highs[i] if i < len(highs) else None
                        l = lows[i] if i < len(lows) else None
                        c = closes[i] if i < len(closes) else None
                        v = volumes[i] if i < len(volumes) else 0

                        if None in (t, o, h, l, c):
                            continue

                        dt_ist = datetime.fromtimestamp(t, tz=timezone.utc).astimezone(ist_tz)
                        candles.append({
                            "timestamp": t,
                            "time_str": dt_ist.strftime("%Y-%m-%d %H:%M"),
                            "open": round(float(o), 2),
                            "high": round(float(h), 2),
                            "low": round(float(l), 2),
                            "close": round(float(c), 2),
                            "volume": int(v or 0)
                        })

                    return candles
        except Exception as e:
            print(f"[BITCOIN FEED ERROR] Failed fetching candles ({interval}): {e}")

        return []

BITCOIN_FEED = BitcoinDataFeed()
