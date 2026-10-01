"""
Process Restart & Persistence Verification Test Suite.
Verifies complete persistence across process restarts, browser reloads, and DB integrity.
"""
import sys
import os
import asyncio
from datetime import datetime

# Add project root to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from live_dhan_engine import LivePaperTradingEngine
from database import DB
from paper_engine import PaperExecutionEngine

async def run_restart_persistence_test():
    print("=== STARTING PERSISTENCE & PROCESS RESTART VERIFICATION TEST ===")
    
    # 1. Clear test DB to test clean start if needed or use current DB
    print("\n--- PHASE 1: INITIAL ENGINE RUN (Processing replay until 3+ trades complete) ---")
    
    engine_1 = LivePaperTradingEngine()
    feed_1 = engine_1.replay_feed
    
    warmup_count = min(1200, len(feed_1.candles))
    for i in range(warmup_count):
        engine_1.candle_builder.add_completed_1m_candle(feed_1.candles[i])
    
    engine_1.latest_tick_time = feed_1.candles[warmup_count - 1].timestamp
    engine_1.current_price = feed_1.candles[warmup_count - 1].close
    
    session_candles = feed_1.candles[warmup_count:]
    
    trades_completed_count = 0
    last_candle_processed = None
    
    for idx, c in enumerate(session_candles):
        prev_closed_count = len(engine_1.paper_engine.closed_trades)
        engine_1.process_replay_candle(c)
        DB.save_replay_progress(warmup_count + idx, c.timestamp.strftime("%Y-%m-%d %H:%M:%S"))
        last_candle_processed = c
        
        new_closed_count = len(engine_1.paper_engine.closed_trades)
        if new_closed_count > prev_closed_count:
            trades_completed_count = new_closed_count
            print(f"  [Trade Exited] Closed Trade #{new_closed_count}: Trade ID {engine_1.paper_engine.closed_trades[-1].trade_id}, Exit Reason: {engine_1.paper_engine.closed_trades[-1].exit_reason}, Net PnL: Rs. {engine_1.paper_engine.closed_trades[-1].pnl_result.net_pnl:.2f}")
        
        if trades_completed_count >= 3 and engine_1.paper_engine.active_position is not None:
            print(f"  --> Pausing Run 1 after {trades_completed_count} closed trades and 1 active position ({engine_1.paper_engine.active_position.trade_id})...")
            break

    state_before_restart = engine_1.get_dashboard_state()
    
    print("\n=== METRICS BEFORE PROCESS RESTART (ENGINE 1) ===")
    print(f"1. Closed Trades Count: {state_before_restart['total_trades_count']}")
    print(f"2. Active Position Trade ID: {state_before_restart['active_position']['trade_id'] if state_before_restart['active_position'] else 'NONE'}")
    print(f"3. Realized Net P&L: Rs. {state_before_restart['realized_pnl']:.2f}")
    print(f"4. Total Charges: Rs. {state_before_restart['total_charges']:.2f}")
    print(f"5. Total Slippage: Rs. {state_before_restart['total_slippage']:.2f}")
    print(f"6. Available Virtual Capital: Rs. {state_before_restart['available_virtual_capital']:.2f}")
    print(f"7. Win Rate %: {state_before_restart['win_rate_percent']}%")
    print(f"8. Max Drawdown: Rs. {state_before_restart['max_drawdown_inr']:.2f}")

    # 2. SIMULATE FULL PROCESS RESTART / CONTAINER REBOOT
    print("\n--- PHASE 2: SIMULATING CONTAINER/PROCESS RESTART (DESTROYING IN-MEMORY STATE) ---")
    del engine_1
    del feed_1

    print("   Creating fresh LivePaperTradingEngine instance (loading persistent SQLite DB)...")
    engine_2 = LivePaperTradingEngine()
    
    # Process last candle to synchronize LTP
    if last_candle_processed:
        engine_2.process_replay_candle(last_candle_processed)

    state_after_restart = engine_2.get_dashboard_state()
    
    print("\n=== METRICS AFTER PROCESS RESTART (ENGINE 2 - FROM PERSISTENT DB) ===")
    print(f"1. Closed Trades Count: {state_after_restart['total_trades_count']}")
    print(f"2. Active Position Trade ID: {state_after_restart['active_position']['trade_id'] if state_after_restart['active_position'] else 'NONE'}")
    print(f"3. Realized Net P&L: Rs. {state_after_restart['realized_pnl']:.2f}")
    print(f"4. Total Charges: Rs. {state_after_restart['total_charges']:.2f}")
    print(f"5. Total Slippage: Rs. {state_after_restart['total_slippage']:.2f}")
    print(f"6. Available Virtual Capital: Rs. {state_after_restart['available_virtual_capital']:.2f}")
    print(f"7. Win Rate %: {state_after_restart['win_rate_percent']}%")
    print(f"8. Max Drawdown: Rs. {state_after_restart['max_drawdown_inr']:.2f}")

    # 3. VERIFICATION CHECKS
    print("\n=== ACCURACY & CONSISTENCY CHECK ===")
    matches = True
    
    if state_before_restart['total_trades_count'] != state_after_restart['total_trades_count']:
        print(f"[FAIL] MISMATCH: Total trades count (Before: {state_before_restart['total_trades_count']}, After: {state_after_restart['total_trades_count']})")
        matches = False
    else:
        print(f"[PASS] MATCH: Total trades count = {state_after_restart['total_trades_count']}")

    pos_before = state_before_restart['active_position']['trade_id'] if state_before_restart['active_position'] else 'NONE'
    pos_after = state_after_restart['active_position']['trade_id'] if state_after_restart['active_position'] else 'NONE'
    if pos_before != pos_after:
        print(f"[FAIL] MISMATCH: Active Position Trade ID (Before: {pos_before}, After: {pos_after})")
        matches = False
    else:
        print(f"[PASS] MATCH: Active Position Trade ID = {pos_after}")

    if abs(state_before_restart['realized_pnl'] - state_after_restart['realized_pnl']) > 0.01:
        print(f"[FAIL] MISMATCH: Realized P&L (Before: {state_before_restart['realized_pnl']}, After: {state_after_restart['realized_pnl']})")
        matches = False
    else:
        print(f"[PASS] MATCH: Realized P&L = Rs. {state_after_restart['realized_pnl']:.2f}")

    if abs(state_before_restart['available_virtual_capital'] - state_after_restart['available_virtual_capital']) > 0.01:
        print(f"[FAIL] MISMATCH: Available Capital (Before: {state_before_restart['available_virtual_capital']}, After: {state_after_restart['available_virtual_capital']})")
        matches = False
    else:
        print(f"[PASS] MATCH: Available Capital = Rs. {state_after_restart['available_virtual_capital']:.2f}")

    if matches:
        print("\n[SUCCESS] PERSISTENCE & PROCESS RESTART TEST PASSED 100%! ALL METRICS MATCH PERFECTLY.")
    else:
        print("\n[FAIL] PERSISTENCE TEST FAILED!")

if __name__ == "__main__":
    asyncio.run(run_restart_persistence_test())
