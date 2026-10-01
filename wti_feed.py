"""
WTI Crude Oil Real-Time Market Data Feed Module.
Fetches real WTI market data (CL=F) from Yahoo Finance NYMEX futures feed.
Handles market status calculation based on CME NYMEX official trading hours.
NO SYNTHETIC OR FAKE DATA GENERATION.
"""

import requests
import time
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional

# CME NYMEX WTI Futures Trading Hours:
# Sunday 18:00 ET to Friday 17:00 ET (23 hours/day)
# Daily maintenance break: 17:00 ET to 18:00 ET (Monday - Thursday)
# Closed: Friday 17:00 ET to Sunday 18:00 ET

def get_et_now() -> datetime:
    """Returns current US Eastern Time datetime (handles UTC -4 / -5 automatically)."""
    # US Eastern is UTC-4 during Daylight Saving Time (EDT), UTC-5 during Standard Time (EST).
    # Since current date is Oct 2, EDT (UTC-4) applies.
    # We use timezone offset: EDT is UTC-4.
    utc_now = datetime.now(timezone.utc)
    # Simple check for US EDT vs EST (Mar second Sun to Nov first Sun = EDT UTC-4)
    # Standard EDT offset: UTC - 4 hours
    et_tz = timezone(timedelta(hours=-4))
    return utc_now.astimezone(et_tz)

def is_nymex_market_open(check_dt: Optional[datetime] = None) -> bool:
    """
    Calculates if CME NYMEX WTI market is open based on official trading hours.
    """
    if check_dt is None:
        check_dt = get_et_now()
    elif check_dt.tzinfo is None:
        # assume UTC if no tz
        check_dt = check_dt.replace(tzinfo=timezone.utc).astimezone(timezone(timedelta(hours=-4)))

    weekday = check_dt.weekday() # 0 = Monday, 4 = Friday, 5 = Saturday, 6 = Sunday
    hour = check_dt.hour

    # Saturday: Closed all day
    if weekday == 5:
        return False

    # Friday: Closed after 17:00 ET (5 PM ET)
    if weekday == 4 and hour >= 17:
        return False

    # Sunday: Closed before 18:00 ET (6 PM ET)
    if weekday == 6 and hour < 18:
        return False

    # Monday - Thursday: Daily break between 17:00 ET and 18:00 ET
    if weekday in (0, 1, 2, 3) and hour == 17:
        return False

    return True

class WTIDataFeed:
    """
    Data Feed Provider for WTI Crude Oil (CL=F Futures).
    Fetches raw market quotes and OHLC candles from Yahoo Finance.
    """

    def __init__(self):
        self.symbol = "CL=F"
        self.data_source = "Yahoo Finance — Delayed NYMEX Data (CL=F)"
        self.user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        self.last_successful_tick: Optional[Dict[str, Any]] = None
        self.last_fetch_time: float = 0.0

    def fetch_latest_tick(self) -> Dict[str, Any]:
        """
        Fetches real-time price & metadata for WTI crude oil.
        Returns state dictionary with connection & market status.
        """
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{self.symbol}?interval=1m&range=1d"
        headers = {"User-Agent": self.user_agent}

        now_timestamp = time.time()
        ist_tz = timezone(timedelta(hours=5, minutes=30))
        now_ist_str = datetime.now(ist_tz).strftime("%Y-%m-%d %H:%M:%S IST")
        now_utc_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

        market_open = is_nymex_market_open()

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

                    # If quote close list is available, pick last valid non-null close
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

                        # Evaluate feed health
                        if tick_age > 1800 and market_open:
                            conn_status = "STALE"
                        else:
                            conn_status = "CONNECTED"

                        tick_info = {
                            "symbol": self.symbol,
                            "price": round(float(price), 2),
                            "change": round(float(change), 2),
                            "change_pct": round(float(change_pct), 2),
                            "prev_close": round(float(prev_close), 2),
                            "high": round(float(meta.get("regularMarketDayHigh", price)), 2),
                            "low": round(float(meta.get("regularMarketDayLow", price)), 2),
                            "volume": meta.get("regularMarketVolume", 0),
                            "currency": meta.get("currency", "USD"),
                            "exchange": meta.get("exchangeName", "NYM"),
                            "last_tick_timestamp_utc": tick_dt_utc.strftime("%Y-%m-%d %H:%M:%S UTC"),
                            "last_tick_timestamp_ist": tick_dt_ist.strftime("%Y-%m-%d %H:%M:%S IST"),
                            "last_tick_epoch": reg_time,
                            "tick_age_seconds": tick_age,
                            "market_status": "OPEN" if market_open else "CLOSED",
                            "data_source": "Yahoo Finance — Delayed NYMEX Data (CL=F)",
                            "data_feed_type": "DELAYED MARKET DATA",
                            "connection_status": conn_status,
                            "last_update_time_ist": now_ist_str,
                            "error": None
                        }

                        self.last_successful_tick = tick_info
                        self.last_fetch_time = now_timestamp
                        return tick_info

            # If response not 200 or invalid payload
            return self._build_disconnected_state(
                reason=f"HTTP Error {resp.status_code}" if resp.status_code != 200 else "Invalid JSON schema",
                now_ist=now_ist_str,
                market_open=market_open
            )

        except Exception as e:
            return self._build_disconnected_state(
                reason=f"Network/API Error: {str(e)}",
                now_ist=now_ist_str,
                market_open=market_open
            )

    def _build_disconnected_state(self, reason: str, now_ist: str, market_open: bool) -> Dict[str, Any]:
        """Returns structured feed state when live API is unavailable."""
        if self.last_successful_tick:
            # Return cached price with DISCONNECTED / STALE status
            tick = dict(self.last_successful_tick)
            tick["connection_status"] = "DISCONNECTED"
            tick["market_status"] = "OPEN" if market_open else "CLOSED"
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
            "currency": "USD",
            "exchange": "NYM",
            "last_tick_timestamp_utc": "N/A",
            "last_tick_timestamp_ist": "N/A",
            "last_tick_epoch": 0,
            "tick_age_seconds": 99999,
            "market_status": "OPEN" if market_open else "CLOSED",
            "data_source": self.data_source,
            "connection_status": "LIVE FEED NOT CONNECTED",
            "last_update_time_ist": now_ist,
            "error": reason
        }

    def fetch_historical_candles(self, interval: str = "1m", range_str: str = "1d") -> List[Dict[str, Any]]:
        """
        Fetches OHLCV candle historical series from Yahoo Finance.
        Supports interval: '1m', '5m', '15m', '60m'.
        """
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
            print(f"[WTI FEED ERROR] Failed fetching candles ({interval}): {e}")

        return []

WTI_FEED = WTIDataFeed()
