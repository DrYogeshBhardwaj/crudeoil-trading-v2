"""
Price Action & Market Structure Analyzer.
Determines Higher High (HH), Higher Low (HL), Lower High (LH), Lower Low (LL),
Support/Resistance boundaries, and identifies Range vs Directional structures.
"""

from typing import List, Dict, Tuple, Optional
from dataclasses import dataclass
from data_engine import Candle

@dataclass
class SwingPoint:
    index: int
    timestamp: object
    price: float
    is_high: bool  # True for Swing High, False for Swing Low

class StructureAnalyzer:
    """Analyzes raw candle price action structure prioritizing Price Action over indicators."""

    @staticmethod
    def find_swing_points(candles: List[Candle], swing_length: Optional[int] = None) -> List[SwingPoint]:
        """Identifies pivot highs and pivot lows dynamically based on candle count."""
        swings = []
        n = len(candles)
        if n < 5:
            return swings

        if swing_length is None:
            swing_length = 1 if n < 30 else 2

        for i in range(swing_length, n - swing_length):
            current_high = candles[i].high
            current_low = candles[i].low

            # Check Swing High
            is_sh = all(candles[i - k].high < current_high and candles[i + k].high <= current_high for k in range(1, swing_length + 1))
            if is_sh:
                swings.append(SwingPoint(index=i, timestamp=candles[i].timestamp, price=current_high, is_high=True))

            # Check Swing Low
            is_sl = all(candles[i - k].low > current_low and candles[i + k].low >= current_low for k in range(1, swing_length + 1))
            if is_sl:
                swings.append(SwingPoint(index=i, timestamp=candles[i].timestamp, price=current_low, is_high=False))

        return swings

    @staticmethod
    def analyze_structure(candles: List[Candle]) -> Tuple[str, Dict]:
        """
        Determines overall structure state for a given timeframe.
        Returns:
            structure_state: 'BULLISH', 'BEARISH', or 'RANGE'
            metadata: dict with swing points, resistance, support, and structural reason
        """
        if len(candles) < 5:
            return "RANGE", {"reason": "Insufficient candles for structure analysis"}

        swings = StructureAnalyzer.find_swing_points(candles)
        swing_highs = [s for s in swings if s.is_high]
        swing_lows = [s for s in swings if not s.is_high]

        # Recent high/low bounds for Range & Support/Resistance check
        recent_highs = [c.high for c in candles[-15:]]
        recent_lows = [c.low for c in candles[-15:]]
        max_recent = max(recent_highs)
        min_recent = min(recent_lows)

        # Fallback if fewer pivot points formed: compare candle halves / extremes
        if len(swing_highs) < 2 or len(swing_lows) < 2:
            first_half_close = sum(c.close for c in candles[:len(candles)//2]) / (len(candles)//2)
            second_half_close = sum(c.close for c in candles[len(candles)//2:]) / (len(candles) - len(candles)//2)

            if second_half_close > first_half_close * 1.002:
                return "BULLISH", {
                    "reason": f"Sustained High-Low expansion ({second_half_close:.1f} > {first_half_close:.1f})",
                    "support": min_recent,
                    "resistance": max_recent
                }
            elif second_half_close < first_half_close * 0.998:
                return "BEARISH", {
                    "reason": f"Sustained Low-High contraction ({second_half_close:.1f} < {first_half_close:.1f})",
                    "support": min_recent,
                    "resistance": max_recent
                }
            else:
                return "RANGE", {
                    "reason": "Oscillating price without pivot trend formation",
                    "support": min_recent,
                    "resistance": max_recent
                }

        # Last 2 Swing Highs and Lows
        last_sh = swing_highs[-1]
        prev_sh = swing_highs[-2]
        
        last_sl = swing_lows[-1]
        prev_sl = swing_lows[-2]

        is_higher_high = last_sh.price > prev_sh.price
        is_higher_low = last_sl.price > prev_sl.price

        is_lower_high = last_sh.price < prev_sh.price
        is_lower_low = last_sl.price < prev_sl.price

        if is_higher_high and is_lower_low:
            return "RANGE", {
                "reason": f"Conflicting structure: Higher High ({last_sh.price:.1f}) with Lower Low ({last_sl.price:.1f})",
                "support": min_recent,
                "resistance": max_recent
            }

        if is_higher_high and is_higher_low:
            return "BULLISH", {
                "reason": f"Higher High ({last_sh.price:.1f} > {prev_sh.price:.1f}) & Higher Low ({last_sl.price:.1f} > {prev_sl.price:.1f})",
                "support": last_sl.price,
                "resistance": last_sh.price
            }

        if is_lower_high and is_lower_low:
            return "BEARISH", {
                "reason": f"Lower High ({last_sh.price:.1f} < {prev_sh.price:.1f}) & Lower Low ({last_sl.price:.1f} < {prev_sl.price:.1f})",
                "support": last_sl.price,
                "resistance": last_sh.price
            }

        return "RANGE", {
            "reason": f"Non-directional structure oscillating between {min_recent:.1f} and {max_recent:.1f}",
            "support": min_recent,
            "resistance": max_recent
        }
