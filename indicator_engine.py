"""
Quantitative Indicator Engine.
Calculates EMA 20, EMA 50, ADX 14 (+DI/-DI), ATR 14, and Volume SMA.
Used strictly for confirmation of Price Action and Structure.
"""

from typing import List, Dict
import pandas as pd
import numpy as np
from data_engine import Candle
from config import CONFIG

class IndicatorEngine:
    
    @staticmethod
    def calculate_indicators(candles: List[Candle]) -> Dict:
        """
        Computes all technical indicators for the provided candle series.
        Returns a dictionary containing latest indicator values and slopes.
        """
        if len(candles) < 20:
            return {
                "ema20": None, "ema50": None, "adx": None,
                "plus_di": None, "minus_di": None, "atr": None,
                "volume_sma": None, "ema_slope": "FLAT"
            }

        df = pd.DataFrame([c.to_dict() for c in candles])
        
        # 1. EMAs
        df["ema20"] = df["close"].ewm(span=CONFIG.EMA_FAST, adjust=False).mean()
        df["ema50"] = df["close"].ewm(span=CONFIG.EMA_SLOW, adjust=False).mean()
        
        # EMA Slope
        ema20_curr = df["ema20"].iloc[-1]
        ema20_prev = df["ema20"].iloc[-2] if len(df) >= 2 else ema20_curr
        ema_slope = "UP" if ema20_curr > ema20_prev else ("DOWN" if ema20_curr < ema20_prev else "FLAT")

        # 2. Volume SMA
        df["vol_sma"] = df["volume"].rolling(window=20, min_periods=1).mean()

        # 3. ATR (Average True Range)
        high = df["high"]
        low = df["low"]
        close = df["close"]
        prev_close = close.shift(1)
        
        tr1 = high - low
        tr2 = (high - prev_close).abs()
        tr3 = (low - prev_close).abs()
        tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
        df["atr"] = tr.rolling(window=CONFIG.ATR_PERIOD, min_periods=1).mean()

        # 4. ADX & Directional Indicators (+DI / -DI)
        up_move = high - high.shift(1)
        down_move = low.shift(1) - low
        
        plus_dm = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
        minus_dm = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)

        plus_dm_s = pd.Series(plus_dm, index=df.index).rolling(window=CONFIG.ADX_PERIOD, min_periods=1).mean()
        minus_dm_s = pd.Series(minus_dm, index=df.index).rolling(window=CONFIG.ADX_PERIOD, min_periods=1).mean()
        
        atr_series = df["atr"].replace(0, np.nan)
        plus_di = 100 * (plus_dm_s / atr_series)
        minus_di = 100 * (minus_dm_s / atr_series)
        
        di_diff = (plus_di - minus_di).abs()
        di_sum = (plus_di + minus_di).replace(0, np.nan)
        dx = 100 * (di_diff / di_sum)
        adx = dx.rolling(window=CONFIG.ADX_PERIOD, min_periods=1).mean().fillna(0)

        df["plus_di"] = plus_di.fillna(0)
        df["minus_di"] = minus_di.fillna(0)
        df["adx"] = adx

        last_row = df.iloc[-1]
        
        return {
            "ema20": float(last_row["ema20"]),
            "ema50": float(last_row["ema50"]),
            "adx": float(last_row["adx"]),
            "plus_di": float(last_row["plus_di"]),
            "minus_di": float(last_row["minus_di"]),
            "atr": float(last_row["atr"]),
            "volume_sma": float(last_row["vol_sma"]),
            "latest_volume": float(last_row["volume"]),
            "latest_oi": float(last_row["open_interest"]),
            "ema_slope": ema_slope
        }
