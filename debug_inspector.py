"""
Debug inspector for 5M signal evaluation.
"""

from replay_test import generate_warmup_and_session_data
from data_engine import MultiTimeframeCandleBuilder
from signal_engine import SignalEngine
from trend_detector import TrendDetector

all_candles = generate_warmup_and_session_data()
builder = MultiTimeframeCandleBuilder()

for c in all_candles[:1200]:
    builder.add_completed_1m_candle(c)

for idx, c in enumerate(all_candles[1200:1230]):
    builder.add_completed_1m_candle(c)
    if c.timestamp.minute % 5 == 4:
        eval_res = TrendDetector.evaluate(builder.candles_1h, builder.candles_15m, builder.candles_5m)
        sig = SignalEngine.evaluate_signal(builder.candles_1h, builder.candles_15m, builder.candles_5m, c.timestamp)
        print(f"[{c.timestamp.strftime('%H:%M')}] Price: {c.close:.1f} | State: {eval_res.state} | Action: {sig.action}")
        print("Reasons:", sig.reasons)
        print("=" * 80)
