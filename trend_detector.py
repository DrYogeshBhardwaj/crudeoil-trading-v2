"""
Multi-Timeframe Trend Detector & Confidence Engine.
Evaluates Price Structure (1H, 15M, 5M) and Indicators in strict priority order.
Calculates Signal-Quality Confidence Score (0-100).
"""

from typing import List, Dict, Tuple
from dataclasses import dataclass
from data_engine import Candle
from structure_analyzer import StructureAnalyzer
from indicator_engine import IndicatorEngine
from config import CONFIG

@dataclass
class TrendEvaluation:
    state: str                 # 'STRONG UP', 'UP', 'RANGE', 'DOWN', 'STRONG DOWN'
    confidence: int            # Signal Quality Index 0 - 100
    tf_1h_state: str           # 'BULLISH', 'BEARISH', 'RANGE'
    tf_15m_state: str          # 'BULLISH', 'BEARISH', 'RANGE'
    tf_5m_state: str           # 'BULLISH', 'BEARISH', 'RANGE'
    is_mtf_aligned: bool
    reasons: List[str]         # 3 - 5 factual AI reasons

class TrendDetector:

    @staticmethod
    def evaluate(candles_1h: List[Candle], candles_15m: List[Candle], candles_5m: List[Candle]) -> TrendEvaluation:
        """
        Main multi-timeframe evaluation.
        Priority:
        1. Price Structure (1H, 15M, 5M)
        2. MTF Alignment
        3. ADX & Momentum
        4. Volume & Indicator Confirmation
        """
        reasons = []

        # Analyze structure on all timeframes
        tf_1h_state, meta_1h = StructureAnalyzer.analyze_structure(candles_1h)
        tf_15m_state, meta_15m = StructureAnalyzer.analyze_structure(candles_15m)
        tf_5m_state, meta_5m = StructureAnalyzer.analyze_structure(candles_5m)

        reasons.append(f"1H Structure: {tf_1h_state} ({meta_1h.get('reason', '')})")
        reasons.append(f"15M Structure: {tf_15m_state} ({meta_15m.get('reason', '')})")
        reasons.append(f"5M Structure: {tf_5m_state} ({meta_5m.get('reason', '')})")

        # Compute Indicators on 5M (entry TF) and 15M
        ind_5m = IndicatorEngine.calculate_indicators(candles_5m)
        ind_15m = IndicatorEngine.calculate_indicators(candles_15m)

        # Check MTF Alignment
        is_bullish_alignment = (tf_1h_state == "BULLISH" and tf_15m_state == "BULLISH" and tf_5m_state == "BULLISH")
        is_bearish_alignment = (tf_1h_state == "BEARISH" and tf_15m_state == "BEARISH" and tf_5m_state == "BEARISH")
        is_mtf_aligned = is_bullish_alignment or is_bearish_alignment

        # Indicator confirmation factors
        ema20_5m = ind_5m.get("ema20")
        ema50_5m = ind_5m.get("ema50")
        adx_5m = ind_5m.get("adx") or 0.0
        plus_di_5m = ind_5m.get("plus_di") or 0.0
        minus_di_5m = ind_5m.get("minus_di") or 0.0
        vol_curr = ind_5m.get("latest_volume") or 0.0
        vol_sma = ind_5m.get("volume_sma") or 1.0

        ema_bullish = (ema20_5m is not None and ema50_5m is not None and ema20_5m > ema50_5m)
        ema_bearish = (ema20_5m is not None and ema50_5m is not None and ema20_5m < ema50_5m)

        # Calculate Confidence (Signal Quality Index 0 - 100)
        confidence = 0

        # Base structure alignment points (Max 50)
        if is_bullish_alignment or is_bearish_alignment:
            confidence += 50
            reasons.append("Multi-timeframe structure (1H, 15M, 5M) is 100% aligned.")
        elif (tf_1h_state == tf_15m_state) and (tf_1h_state != "RANGE"):
            confidence += 30
            reasons.append(f"Partial MTF alignment: 1H & 15M aligned in {tf_1h_state} state.")
        else:
            confidence += 10
            reasons.append("MTF Conflict: 1H, 15M, and 5M structures are not in alignment.")

        # ADX & Trend strength points (Max 20)
        if adx_5m >= 35.0:
            confidence += 20
            reasons.append(f"Strong Trend Strength: 5M ADX at {adx_5m:.1f} (>35).")
        elif adx_5m >= 25.0:
            confidence += 15
            reasons.append(f"Moderate Trend Strength: 5M ADX at {adx_5m:.1f} (>25).")
        else:
            reasons.append(f"Weak Trend Strength: 5M ADX at {adx_5m:.1f} (<25).")

        # Indicator & Directional Movement points (Max 15)
        if is_bullish_alignment:
            if ema_bullish and plus_di_5m > minus_di_5m:
                confidence += 15
                reasons.append("EMA (20 > 50) & +DI > -DI confirm bullish alignment.")
        elif is_bearish_alignment:
            if ema_bearish and minus_di_5m > plus_di_5m:
                confidence += 15
                reasons.append("EMA (20 < 50) & -DI > +DI confirm bearish alignment.")

        # Volume Confirmation points (Max 15)
        if vol_curr > vol_sma:
            confidence += 15
            reasons.append("Volume Confirmation: Recent volume is above 20-period SMA.")

        # Determine Final Trend State
        if is_bullish_alignment:
            state = "STRONG UP" if confidence >= 80 else "UP"
        elif is_bearish_alignment:
            state = "STRONG DOWN" if confidence >= 80 else "DOWN"
        else:
            state = "RANGE"

        return TrendEvaluation(
            state=state,
            confidence=min(100, max(0, confidence)),
            tf_1h_state=tf_1h_state,
            tf_15m_state=tf_15m_state,
            tf_5m_state=tf_5m_state,
            is_mtf_aligned=is_mtf_aligned,
            reasons=reasons
        )
