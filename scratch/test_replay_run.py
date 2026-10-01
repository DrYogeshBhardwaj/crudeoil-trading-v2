"""
End-to-End Replay Verification Script.
Executes complete 5,400 candle server-side replay through LivePaperTradingEngine
and collects exact metrics for user verification report.
"""
import sys
import os
import asyncio
from datetime import datetime

# Add project root to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from live_dhan_engine import LivePaperTradingEngine

async def run_full_replay_test():
    print("=== STARTING END-TO-END REPLAY ENGINE VERIFICATION ===")
    
    engine = LivePaperTradingEngine()
    feed = engine.replay_feed
    
    print(f"1. Data Source: replay_test.py -> generate_multiday_session_data()")
    print(f"   Total Candles Loaded: {len(feed.candles)}")
    
    # Process warmup candles (first 1,200 candles)
    warmup_count = min(1200, len(feed.candles))
    for i in range(warmup_count):
        c = feed.candles[i]
        engine.candle_builder.add_completed_1m_candle(c)
    
    engine.latest_tick_time = feed.candles[warmup_count - 1].timestamp
    engine.current_price = feed.candles[warmup_count - 1].close
    
    print(f"2. First Valid Post-Warmup Price: Rs. {engine.current_price:.2f}")
    print(f"3. First Valid Post-Warmup Timestamp: {engine.latest_tick_time}")
    
    # Process session candles (candles 1,200 to 5,400)
    session_candles = feed.candles[warmup_count:]
    print(f"   Streaming {len(session_candles)} session candles through Trend, Signal & Paper Engines...")
    
    signal_actions_count = {"BUY": 0, "SELL": 0, "WAIT": 0}
    
    for idx, c in enumerate(session_candles):
        state = engine.process_replay_candle(c)
        sig_action = state["signal"]["action"]
        signal_actions_count[sig_action] = signal_actions_count.get(sig_action, 0) + 1

    # Replay completion status update
    engine.replay_ended = True
    final_state = engine.get_dashboard_state()
    
    print("\n=== REPLAY ENGINE COMPLETE METRICS REPORT ===")
    print(f"1. Data Source File: replay_test.py (generate_multiday_session_data)")
    print(f"2. First Valid CRUDEOILM Price: Rs. {feed.candles[1200].open:.2f}")
    print(f"3. Replay Start Timestamp: {feed.candles[1200].timestamp.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"   Replay End Timestamp: {feed.candles[-1].timestamp.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"4. Candles Generated:")
    print(f"   - 1M Candles: {final_state['candle_status']['1m_count']}")
    print(f"   - 5M Candles: {final_state['candle_status']['5m_count']}")
    print(f"   - 15M Candles: {final_state['candle_status']['15m_count']}")
    print(f"   - 1H Candles: {final_state['candle_status']['1h_count']}")
    print(f"5. Number of Signals Generated: {sum(signal_actions_count.values())}")
    print(f"   - BUY Signals: {signal_actions_count['BUY']}")
    print(f"   - SELL Signals: {signal_actions_count['SELL']}")
    print(f"   - WAIT Signals: {signal_actions_count['WAIT']}")
    print(f"6. Number of Paper Trades Executed: {final_state['total_trades_count']}")
    print(f"   - Winning Trades: {final_state['winning_trades_count']}")
    print(f"   - Losing Trades: {final_state['losing_trades_count']}")
    print(f"   - Win Rate %: {final_state['win_rate_percent']}%")
    print(f"7. Final Virtual Capital:")
    print(f"   - Starting Virtual Capital: Rs. {final_state['starting_virtual_capital']:.2f}")
    print(f"   - Realized Net P&L: Rs. {final_state['realized_pnl']:.2f}")
    print(f"   - Total Charges: Rs. {final_state['total_charges']:.2f}")
    print(f"   - Total Slippage: Rs. {final_state['total_slippage']:.2f}")
    print(f"   - Final Virtual Capital: Rs. {final_state['current_virtual_capital']:.2f}")
    print(f"8. System Status at Replay End: {final_state['system_status']}")
    print(f"   - Replay Ended Flag: {engine.replay_ended}")
    print("===============================================")

if __name__ == "__main__":
    asyncio.run(run_full_replay_test())
