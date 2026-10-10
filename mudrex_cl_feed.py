"""
Mudrex CL • USDT Futures Live Market Feed Module
Fetches real-time price, 24h ticker, funding rate, and 1m/5m/15m/1h candlestick data for Mudrex CL • USDT (CLUSDT).
"""

import os
import time
import requests
import json
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional, Tuple


class MudrexCLFeed:
    """
    Authoritative Market Feed for Mudrex CL • USDT Futures (CLUSDT).
    """

    def __init__(self):
        self.symbol = "CLUSDT"
        self.display_symbol = "CL • USDT"
        self.base_url = "https://fapi.binance.com/fapi/v1"
        self.mudrex_base_url = "https://trade.mudrex.com/fapi/v1"
        
        self.last_tick_price: Optional[float] = None
        self.last_tick_epoch: Optional[float] = None
        self.last_tick_ist: Optional[str] = None
        self.last_funding_rate: float = 0.0001  # Default 0.01% / 8h
        self.last_mark_price: float = 0.0
        
        # Cache for candles to prevent rate limiting
        self._candle_cache: Dict[str, Tuple[float, List[Dict[str, Any]]]] = {}

    def fetch_latest_tick(self) -> Dict[str, Any]:
        """
        Fetches live Mudrex CL • USDT price, 24h change, funding rate, and timestamp.
        Returns:
            dict containing price, change, change_pct, funding_rate, connection_status, timestamp_ist
        """
        ist_tz = timezone(timedelta(hours=5, minutes=30))
        now_ist = datetime.now(ist_tz).strftime("%Y-%m-%d %H:%M:%S IST")

        price_usd = None
        change = 0.0
        change_pct = 0.0
        funding_rate = 0.0
        feed_source = "Mudrex CL • USDT Market Feed (CLUSDT)"
        conn_status = "DISCONNECTED"
        market_status = "TRADING"

        # 1. Try Mudrex API directly if authenticated
        try:
            api_secret = (os.environ.get("MUDREX_API_SECRET") or os.environ.get("MUDREX_SECRET") or "").strip()
            api_key = (os.environ.get("MUDREX_API_KEY") or os.environ.get("MUDREX_KEY") or "").strip()
            headers = {"User-Agent": "Mudrex-CL-Engine/1.0"}
            if api_secret:
                headers["X-Authentication"] = api_secret
            if api_key:
                headers["X-Api-Key"] = api_key

            if api_secret:
                resp = requests.get(f"{self.mudrex_base_url}/futures/CLUSDT?is_symbol", headers=headers, timeout=3)
                if resp.status_code in (200, 201):
                    data = resp.json()
                    ast = data.get("data") if isinstance(data, dict) and "data" in data else data
                    if isinstance(ast, dict) and "price" in ast:
                        price_usd = float(ast["price"])
                        change_pct = float(ast.get("change_perc", 0.0))
                        feed_source = "Mudrex Direct API (CL • USDT)"
        except Exception:
            pass

        # 2. Query Underlying Binance Futures Stream (CLUSDT) for ticker & funding rate
        try:
            r_ticker = requests.get(f"{self.base_url}/ticker/24hr?symbol=CLUSDT", timeout=3)
            if r_ticker.status_code == 200:
                data_t = r_ticker.json()
                if price_usd is None or price_usd <= 0:
                    price_usd = float(data_t.get("lastPrice", 0.0))
                change = float(data_t.get("priceChange", 0.0))
                change_pct = float(data_t.get("priceChangePercent", 0.0))
                conn_status = "CONNECTED"

            r_prem = requests.get(f"{self.base_url}/premiumIndex?symbol=CLUSDT", timeout=3)
            if r_prem.status_code == 200:
                data_p = r_prem.json()
                funding_rate = float(data_p.get("lastFundingRate", 0.0001))
                self.last_funding_rate = funding_rate
                self.last_mark_price = float(data_p.get("markPrice", price_usd or 0.0))
        except Exception as e:
            pass

        if price_usd is not None and price_usd > 0:
            self.last_tick_price = round(price_usd, 4)
            self.last_tick_epoch = time.time()
            self.last_tick_ist = now_ist

            return {
                "symbol": "CLUSDT",
                "display_symbol": "CL • USDT",
                "price": round(price_usd, 2),
                "price_raw": price_usd,
                "change": round(change, 2),
                "change_pct": round(change_pct, 2),
                "funding_rate": funding_rate,
                "funding_rate_pct": round(funding_rate * 100.0, 4),
                "mark_price": round(self.last_mark_price or price_usd, 2),
                "timestamp_ist": now_ist,
                "last_tick_epoch": time.time(),
                "connection_status": "CONNECTED",
                "feed_status": f"CONNECTED (Mudrex CL•USDT @ ${price_usd:.2f})",
                "feed_source": feed_source,
                "market_status": market_status,
                "price_valid": True
            }

        # Fallback to last known tick or disconnected
        if self.last_tick_price and self.last_tick_price > 0:
            return {
                "symbol": "CLUSDT",
                "display_symbol": "CL • USDT",
                "price": round(self.last_tick_price, 2),
                "price_raw": self.last_tick_price,
                "change": 0.0,
                "change_pct": 0.0,
                "funding_rate": self.last_funding_rate,
                "funding_rate_pct": round(self.last_funding_rate * 100.0, 4),
                "mark_price": round(self.last_mark_price or self.last_tick_price, 2),
                "timestamp_ist": self.last_tick_ist or now_ist,
                "last_tick_epoch": self.last_tick_epoch or time.time(),
                "connection_status": "STALE",
                "feed_status": f"STALE (Mudrex CL•USDT @ ${self.last_tick_price:.2f})",
                "feed_source": feed_source,
                "market_status": "STALE",
                "price_valid": True
            }

        return {
            "symbol": "CLUSDT",
            "display_symbol": "CL • USDT",
            "price": 0.0,
            "price_raw": 0.0,
            "change": 0.0,
            "change_pct": 0.0,
            "funding_rate": 0.0,
            "funding_rate_pct": 0.0,
            "mark_price": 0.0,
            "timestamp_ist": now_ist,
            "last_tick_epoch": 0,
            "connection_status": "DISCONNECTED",
            "feed_status": "DISCONNECTED (Mudrex CL•USDT Feed Unavailable)",
            "feed_source": feed_source,
            "market_status": "OFFLINE",
            "price_valid": False
        }

    def fetch_klines(self, timeframe: str = "1m", limit: int = 500) -> List[Dict[str, Any]]:
        """
        Fetches historical candles for Mudrex CL • USDT (CLUSDT).
        Interval mapping: 1m, 5m, 15m, 1h
        """
        now_ts = time.time()
        cache_key = f"{timeframe}_{limit}"
        if cache_key in self._candle_cache:
            cache_time, cache_data = self._candle_cache[cache_key]
            if now_ts - cache_time < 5.0:  # Cache for 5s
                return cache_data

        interval_map = {"1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h"}
        interval = interval_map.get(timeframe, "1m")

        candles = []
        try:
            url = f"{self.base_url}/klines?symbol=CLUSDT&interval={interval}&limit={limit}"
            resp = requests.get(url, timeout=5)
            if resp.status_code == 200:
                raw_candles = resp.json()
                ist_tz = timezone(timedelta(hours=5, minutes=30))
                for c in raw_candles:
                    # c structure: [open_time, open, high, low, close, volume, ...]
                    open_time_sec = int(c[0] // 1000)
                    dt_ist = datetime.fromtimestamp(open_time_sec, tz=timezone.utc).astimezone(ist_tz)
                    time_str = dt_ist.strftime("%Y-%m-%d %H:%M")

                    o = round(float(c[1]), 2)
                    h = round(float(c[2]), 2)
                    l = round(float(c[3]), 2)
                    cl = round(float(c[4]), 2)
                    vol = round(float(c[5]), 2)

                    candles.append({
                        "timestamp": open_time_sec,
                        "time_str": time_str,
                        "open": o,
                        "high": h,
                        "low": l,
                        "close": cl,
                        "volume": vol
                    })

                self._candle_cache[cache_key] = (now_ts, candles)
                return candles
        except Exception as e:
            print(f"[MUDREX CL FEED ERROR] Failed to fetch klines: {e}")

        return []


MUDREX_CL_FEED = MudrexCLFeed()
