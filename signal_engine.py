"""
Trade Signal Generation Engine & Risk Validator.
Implements Action Selection (BUY / SELL / WAIT), False Breakout Filters,
Dynamic Structure + ATR Stop Loss, Target 1 & 2 Calculation, and Risk Verification.
"""

from typing import List, Dict, Optional
from dataclasses import dataclass
from data_engine import Candle, SessionValidator
from trend_detector import TrendDetector, TrendEvaluation
from structure_analyzer import StructureAnalyzer
from indicator_engine import IndicatorEngine
from config import CONFIG

@dataclass
class TradeSignal:
    action: str               # 'BUY', 'SELL', 'WAIT'
    trend_state: str          # 'STRONG UP', 'UP', 'RANGE', 'DOWN', 'STRONG DOWN'
    confidence: int           # 0 - 100 Signal Quality Score
    current_price: float
    entry_price: Optional[float]
    stop_loss: Optional[float]
    target_1: Optional[float]
    target_2: Optional[float]
    risk_inr: float
    rr_ratio: float
    reasons: List[str]        # 3 - 5 Factual Reasons (WHY BUY / WHY SELL / WHY WAIT)

class SignalEngine:

    @staticmethod
    def evaluate_signal(
        candles_1h: List[Candle],
        candles_15m: List[Candle],
        candles_5m: List[Candle],
        current_time: object
    ) -> TradeSignal:
        """
        Evaluates current market state and generates BUY, SELL, or WAIT signal.
        Enforces all safety rules, MTF alignment, breakout verification, and risk limits.
        """
        reasons = []

        if not candles_5m or not candles_15m or not candles_1h:
            return TradeSignal(
                action="WAIT", trend_state="RANGE", confidence=0, current_price=0.0,
                entry_price=None, stop_loss=None, target_1=None, target_2=None,
                risk_inr=0.0, rr_ratio=0.0, reasons=["WAIT: Insufficient market data."]
            )

        current_price = candles_5m[-1].close

        # 1. Session Timing Check
        if not SessionValidator.is_new_entry_allowed(current_time):
            return TradeSignal(
                action="WAIT", trend_state="RANGE", confidence=0, current_price=current_price,
                entry_price=None, stop_loss=None, target_1=None, target_2=None,
                risk_inr=0.0, rr_ratio=0.0,
                reasons=[f"WAIT: Outside allowed entry window (Current IST: {current_time})."]
            )

        # 2. Multi-Timeframe Trend & Confidence Evaluation
        trend_eval = TrendDetector.evaluate(candles_1h, candles_15m, candles_5m)
        reasons.extend(trend_eval.reasons)

        # RULE: If timeframes conflict or market is in RANGE => AUTOMATIC WAIT
        if not trend_eval.is_mtf_aligned or trend_eval.state == "RANGE":
            reasons.append("WAIT Triggered: Multi-timeframe structure conflict or Range market detected.")
            return TradeSignal(
                action="WAIT", trend_state="RANGE", confidence=trend_eval.confidence,
                current_price=current_price, entry_price=None, stop_loss=None,
                target_1=None, target_2=None, risk_inr=0.0, rr_ratio=0.0,
                reasons=reasons
            )

        # Compute 5M Indicators for Breakout & ATR validation
        ind_5m = IndicatorEngine.calculate_indicators(candles_5m)
        atr_5m = ind_5m.get("atr") or 10.0
        vol_curr = ind_5m.get("latest_volume") or 0.0
        vol_sma = ind_5m.get("volume_sma") or 1.0

        # Calculate Support and Resistance from PREVIOUS candles (candles_5m[:-1])
        prior_5m_candles = candles_5m[:-1] if len(candles_5m) > 1 else candles_5m
        _, meta_5m_prior = StructureAnalyzer.analyze_structure(prior_5m_candles)
        
        support = meta_5m_prior.get("support", current_price - (2 * atr_5m))
        resistance = meta_5m_prior.get("resistance", current_price + (2 * atr_5m))

        # 3. FALSE BREAKOUT FILTER
        # Requires: Candle CLOSE at/beyond prior level + Volume Confirmation + Follow-through
        if trend_eval.state in ["STRONG UP", "UP"]:
            candle_close_beyond = (candles_5m[-1].close >= resistance - 2.0)
            volume_confirmed = (vol_curr >= vol_sma * 0.8)
            follow_through = (candles_5m[-1].close >= candles_5m[-1].open)

            if candle_close_beyond and volume_confirmed and follow_through:
                reasons.append(f"Breakout Confirmed: Candle closed ({candles_5m[-1].close:.1f}) at/above resistance ({resistance:.1f}) with volume.")
            else:
                reasons.append("WAIT Triggered (False Breakout Filter): Multi-Timeframe is Bullish but Breakout Confirmation is Pending.")
                reasons.append(f"• 1H Structure: {trend_eval.tf_1h_state} ✓")
                reasons.append(f"• 15M Structure: {trend_eval.tf_15m_state} ✓")
                reasons.append(f"• 5M Structure: {trend_eval.tf_5m_state} ✓")
                reasons.append(f"• 5M Resistance Breakout ({candles_5m[-1].close:.1f} >= {resistance:.1f}): {'✓' if candle_close_beyond else '✗ (Pending)'}")
                reasons.append(f"• Volume Confirmation ({vol_curr:.0f} >= {vol_sma * 0.8:.0f}): {'✓' if volume_confirmed else '✗ (Pending)'}")
                reasons.append(f"• Bullish Candle Close (Close >= Open): {'✓' if follow_through else '✗ (Pending)'}")
                reasons.append("• Risk Check: Pending Breakout Confirmation")
                return TradeSignal(
                    action="WAIT", trend_state=trend_eval.state, confidence=trend_eval.confidence,
                    current_price=current_price, entry_price=None, stop_loss=None,
                    target_1=None, target_2=None, risk_inr=0.0, rr_ratio=0.0,
                    reasons=reasons
                )

        elif trend_eval.state in ["STRONG DOWN", "DOWN"]:
            candle_close_beyond = (candles_5m[-1].close <= support + 2.0)
            volume_confirmed = (vol_curr >= vol_sma * 0.8)
            follow_through = (candles_5m[-1].close <= candles_5m[-1].open)

            if candle_close_beyond and volume_confirmed and follow_through:
                reasons.append(f"Breakdown Confirmed: Candle closed ({candles_5m[-1].close:.1f}) at/below support ({support:.1f}) with volume.")
            else:
                reasons.append("WAIT Triggered (False Breakout Filter): Multi-Timeframe is Bearish but Breakdown Confirmation is Pending.")
                reasons.append(f"• 1H Structure: {trend_eval.tf_1h_state} ✓")
                reasons.append(f"• 15M Structure: {trend_eval.tf_15m_state} ✓")
                reasons.append(f"• 5M Structure: {trend_eval.tf_5m_state} ✓")
                reasons.append(f"• 5M Support Breakdown ({candles_5m[-1].close:.1f} <= {support:.1f}): {'✓' if candle_close_beyond else '✗ (Pending)'}")
                reasons.append(f"• Volume Confirmation ({vol_curr:.0f} >= {vol_sma * 0.8:.0f}): {'✓' if volume_confirmed else '✗ (Pending)'}")
                reasons.append(f"• Bearish Candle Close (Close <= Open): {'✓' if follow_through else '✗ (Pending)'}")
                reasons.append("• Risk Check: Pending Breakdown Confirmation")
                return TradeSignal(
                    action="WAIT", trend_state=trend_eval.state, confidence=trend_eval.confidence,
                    current_price=current_price, entry_price=None, stop_loss=None,
                    target_1=None, target_2=None, risk_inr=0.0, rr_ratio=0.0,
                    reasons=reasons
                )

        # 4. DYNAMIC STOP LOSS & TARGET CALCULATIONS
        entry_price = current_price
        
        if trend_eval.state in ["STRONG UP", "UP"]:
            calculated_sl = min(support, entry_price - (CONFIG.ATR_SL_MULTIPLIER * atr_5m))
            sl_distance = entry_price - calculated_sl
            risk_inr = sl_distance * CONFIG.LOT_SIZE
            
            if risk_inr > CONFIG.MAX_RISK_PER_TRADE_INR:
                reasons.append(f"WAIT Triggered: SL distance too wide ({sl_distance:.1f} pts). Max Risk Rs.{risk_inr:.1f} > Limit Rs.{CONFIG.MAX_RISK_PER_TRADE_INR}.")
                return TradeSignal(
                    action="WAIT", trend_state=trend_eval.state, confidence=trend_eval.confidence,
                    current_price=current_price, entry_price=None, stop_loss=None,
                    target_1=None, target_2=None, risk_inr=risk_inr, rr_ratio=0.0,
                    reasons=reasons
                )
            
            t1 = entry_price + (1.5 * sl_distance)
            t2 = entry_price + (2.5 * sl_distance)
            rr_ratio = 1.5

            reasons.append(f"Action BUY Confirmed: Entry {entry_price:.1f}, SL {calculated_sl:.1f}, T1 {t1:.1f}, Risk Rs.{risk_inr:.1f}.")
            return TradeSignal(
                action="BUY", trend_state=trend_eval.state, confidence=trend_eval.confidence,
                current_price=current_price, entry_price=entry_price, stop_loss=calculated_sl,
                target_1=t1, target_2=t2, risk_inr=risk_inr, rr_ratio=rr_ratio,
                reasons=reasons
            )

        elif trend_eval.state in ["STRONG DOWN", "DOWN"]:
            calculated_sl = max(resistance, entry_price + (CONFIG.ATR_SL_MULTIPLIER * atr_5m))
            sl_distance = calculated_sl - entry_price
            risk_inr = sl_distance * CONFIG.LOT_SIZE

            if risk_inr > CONFIG.MAX_RISK_PER_TRADE_INR:
                reasons.append(f"WAIT Triggered: SL distance too wide ({sl_distance:.1f} pts). Max Risk Rs.{risk_inr:.1f} > Limit Rs.{CONFIG.MAX_RISK_PER_TRADE_INR}.")
                return TradeSignal(
                    action="WAIT", trend_state=trend_eval.state, confidence=trend_eval.confidence,
                    current_price=current_price, entry_price=None, stop_loss=None,
                    target_1=None, target_2=None, risk_inr=risk_inr, rr_ratio=0.0,
                    reasons=reasons
                )

            t1 = entry_price - (1.5 * sl_distance)
            t2 = entry_price - (2.5 * sl_distance)
            rr_ratio = 1.5

            reasons.append(f"Action SELL Confirmed: Entry {entry_price:.1f}, SL {calculated_sl:.1f}, T1 {t1:.1f}, Risk Rs.{risk_inr:.1f}.")
            return TradeSignal(
                action="SELL", trend_state=trend_eval.state, confidence=trend_eval.confidence,
                current_price=current_price, entry_price=entry_price, stop_loss=calculated_sl,
                target_1=t1, target_2=t2, risk_inr=risk_inr, rr_ratio=rr_ratio,
                reasons=reasons
            )

        return TradeSignal(
            action="WAIT", trend_state="RANGE", confidence=trend_eval.confidence,
            current_price=current_price, entry_price=None, stop_loss=None,
            target_1=None, target_2=None, risk_inr=0.0, rr_ratio=0.0,
            reasons=reasons
        )
