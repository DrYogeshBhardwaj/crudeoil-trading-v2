"""
Bitcoin (BTC-INR) Strategy Evaluator Engine.
Calculates EMA 9/21/50, RSI 14, and ATR 14 indicators specifically for BTC-INR crypto market structure.
Generates BUY / SELL / WAIT signals with confidence level (%) and actionable stop loss / target levels in INR.
"""

from typing import List, Dict, Any, Tuple, Optional

def calculate_ema(prices: List[float], period: int) -> List[float]:
    """Calculates Exponential Moving Average (EMA) for a price series."""
    if len(prices) < period:
        return [prices[-1]] if prices else [0.0]

    multiplier = 2.0 / (period + 1)
    sma = sum(prices[:period]) / period
    ema_list = [sma]

    for price in prices[period:]:
        new_ema = (price - ema_list[-1]) * multiplier + ema_list[-1]
        ema_list.append(new_ema)

    return ema_list

def calculate_rsi(prices: List[float], period: int = 14) -> float:
    """Calculates Relative Strength Index (RSI)."""
    if len(prices) < period + 1:
        return 50.0

    gains = []
    losses = []

    for i in range(1, len(prices)):
        change = prices[i] - prices[i - 1]
        if change >= 0:
            gains.append(change)
            losses.append(0.0)
        else:
            gains.append(0.0)
            losses.append(abs(change))

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

    if avg_loss == 0:
        return 100.0

    rs = avg_gain / avg_loss
    rsi = 100.0 - (100.0 / (1.0 + rs))
    return round(rsi, 2)

def calculate_atr(candles: List[Dict[str, Any]], period: int = 14) -> float:
    """Calculates Average True Range (ATR) in INR for BTC volatility sizing."""
    if len(candles) < 2:
        return 25000.0 # default ₹25,000 ATR floor for BTC-INR

    tr_list = []
    for i in range(1, len(candles)):
        h = candles[i]["high"]
        l = candles[i]["low"]
        pc = candles[i - 1]["close"]
        tr = max(h - l, abs(h - pc), abs(l - pc))
        tr_list.append(tr)

    if not tr_list:
        return 25000.0

    if len(tr_list) <= period:
        return round(sum(tr_list) / len(tr_list), 2)

    atr = sum(tr_list[:period]) / period
    for i in range(period, len(tr_list)):
        atr = (atr * (period - 1) + tr_list[i]) / period

    return round(atr, 2)

class BitcoinStrategyEvaluator:
    """
    Evaluates live market indicators for BTC-INR.
    """

    def evaluate_market(self, candles: List[Dict[str, Any]], current_price: float) -> Dict[str, Any]:
        """
        Evaluates candles and current live price to determine signal, trend, confidence, SL, and Target in INR.
        """
        if not candles or len(candles) < 10 or current_price <= 0:
            return {
                "action": "WAIT",
                "trend": "NEUTRAL",
                "confidence": 50,
                "reasons": ["Insufficient candle history for analysis"],
                "sl_price": 0.0,
                "target_price": 0.0,
                "ema9": current_price,
                "ema21": current_price,
                "ema50": current_price,
                "rsi": 50.0,
                "atr": 25000.0
            }

        closes = [c["close"] for c in candles]
        if current_price != closes[-1]:
            closes.append(current_price)

        ema9_series = calculate_ema(closes, 9)
        ema21_series = calculate_ema(closes, 21)
        ema50_series = calculate_ema(closes, 50)

        ema9 = round(ema9_series[-1], 2)
        ema21 = round(ema21_series[-1], 2)
        ema50 = round(ema50_series[-1], 2)

        rsi = calculate_rsi(closes, 14)
        atr = calculate_atr(candles, 14)

        if atr < 10000.0:
            atr = 15000.0 # minimum sensible ATR floor for BTC-INR (₹15,000)

        reasons = []
        score = 0 # range -10 to +10

        # 1. EMA Alignment
        if ema9 > ema21 > ema50:
            score += 4
            reasons.append(f"Bullish EMA alignment (EMA9 ₹{ema9:,.0f} > EMA21 ₹{ema21:,.0f} > EMA50 ₹{ema50:,.0f})")
        elif ema9 < ema21 < ema50:
            score -= 4
            reasons.append(f"Bearish EMA alignment (EMA9 ₹{ema9:,.0f} < EMA21 ₹{ema21:,.0f} < EMA50 ₹{ema50:,.0f})")
        elif ema9 > ema21:
            score += 2
            reasons.append(f"EMA9 (₹{ema9:,.0f}) above EMA21 (₹{ema21:,.0f})")
        elif ema9 < ema21:
            score -= 2
            reasons.append(f"EMA9 (₹{ema9:,.0f}) below EMA21 (₹{ema21:,.0f})")

        # 2. Price Position relative to EMA9 & EMA21
        if current_price > ema9:
            score += 2
            reasons.append(f"BTC Price (₹{current_price:,.0f}) trading above EMA9 (₹{ema9:,.0f})")
        elif current_price < ema9:
            score -= 2
            reasons.append(f"BTC Price (₹{current_price:,.0f}) trading below EMA9 (₹{ema9:,.0f})")

        # 3. RSI Momentum
        if 50 < rsi <= 68:
            score += 2
            reasons.append(f"RSI ({rsi:.1f}) in strong bullish momentum zone")
        elif rsi > 70:
            score += 0 # Overbought warning
            reasons.append(f"RSI ({rsi:.1f}) overbought zone - caution")
        elif 32 <= rsi < 50:
            score -= 2
            reasons.append(f"RSI ({rsi:.1f}) in bearish momentum zone")
        elif rsi < 30:
            score -= 0 # Oversold warning
            reasons.append(f"RSI ({rsi:.1f}) oversold zone - caution")

        # Determine Trend & Action
        action = "WAIT"
        trend = "NEUTRAL"
        confidence = 50
        sl_price = 0.0
        target_price = 0.0

        if score >= 4:
            trend = "BULLISH"
            action = "BUY"
            confidence = min(95, 65 + (score * 4))
            sl_distance = max(15000.0, round(1.5 * atr, 2))
            target_distance = max(30000.0, round(3.0 * atr, 2))
            sl_price = round(current_price - sl_distance, 2)
            target_price = round(current_price + target_distance, 2)
        elif score <= -4:
            trend = "BEARISH"
            action = "SELL"
            confidence = min(95, 65 + (abs(score) * 4))
            sl_distance = max(15000.0, round(1.5 * atr, 2))
            target_distance = max(30000.0, round(3.0 * atr, 2))
            sl_price = round(current_price + sl_distance, 2)
            target_price = round(current_price - target_distance, 2)
        else:
            trend = "BULLISH" if score > 0 else ("BEARISH" if score < 0 else "NEUTRAL")
            action = "WAIT"
            confidence = 50 + (abs(score) * 3)
            reasons.append("Crypto market in consolidation / low signal clarity")

        return {
            "action": action,
            "trend": trend,
            "confidence": int(confidence),
            "reasons": reasons,
            "sl_price": sl_price,
            "target_price": target_price,
            "ema9": ema9,
            "ema21": ema21,
            "ema50": ema50,
            "rsi": rsi,
            "atr": atr
        }

BITCOIN_STRATEGY = BitcoinStrategyEvaluator()
