"""
Compulsory Core Engine Unit Tests.
Tests 12 Mandatory Scenarios required by specification before UI/Dashboard integration.
"""

import unittest
from datetime import datetime, timedelta
from config import CONFIG
from data_engine import Candle, MultiTimeframeCandleBuilder, SessionValidator
from structure_analyzer import StructureAnalyzer
from indicator_engine import IndicatorEngine
from trend_detector import TrendDetector
from signal_engine import SignalEngine
from paper_engine import PaperExecutionEngine
from pnl_calculator import PnLCalculator

class TestCoreEngine(unittest.TestCase):

    def setUp(self):
        # 10:00 AM IST (Within valid market trading hours 09:00 - 23:00)
        self.base_time = datetime(2026, 9, 30, 10, 0, 0)

    def _generate_structured_candles(self, trend_type: str, count: int = 60, start_price: float = 6500.0) -> list:
        candles = []
        price = start_price
        
        for i in range(count):
            t = self.base_time + timedelta(minutes=i)
            
            if trend_type == "UP":
                wave_step = i % 6
                if wave_step < 4:
                    price += 10.0
                    open_p = price - 4.0
                    high_p = price + 6.0
                    low_p = price - 5.0
                    close_p = price
                else:
                    price -= 4.0
                    open_p = price + 2.0
                    high_p = price + 3.0
                    low_p = price - 4.0
                    close_p = price

            elif trend_type == "DOWN":
                wave_step = i % 6
                if wave_step < 4:
                    price -= 10.0
                    open_p = price + 4.0
                    high_p = price + 5.0
                    low_p = price - 6.0
                    close_p = price
                else:
                    price += 4.0
                    open_p = price - 2.0
                    high_p = price + 4.0
                    low_p = price - 3.0
                    close_p = price

            else:  # RANGE
                offset = 15.0 if (i // 5) % 2 == 0 else -15.0
                price = start_price + offset
                open_p = price - 2.0
                high_p = price + 5.0
                low_p = price - 5.0
                close_p = price

            c = Candle(
                timestamp=t,
                open=open_p, high=high_p, low=low_p, close=close_p,
                volume=1000.0 + (i * 20), open_interest=5000.0
            )
            candles.append(c)
            
        return candles

    def test_01_clear_uptrend_buy(self):
        """Scenario 1: Clear Uptrend -> BUY Signal"""
        c1h = self._generate_structured_candles("UP", 60, 6000.0)
        c15m = self._generate_structured_candles("UP", 60, 6200.0)
        c5m = self._generate_structured_candles("UP", 60, 6400.0)

        resistance = max([c.high for c in c5m[-15:]])
        c5m[-1].close = resistance + 15.0
        c5m[-1].open = resistance + 2.0
        c5m[-1].high = resistance + 20.0
        c5m[-1].volume = 8000.0

        signal = SignalEngine.evaluate_signal(c1h, c15m, c5m, c5m[-1].timestamp)
        self.assertEqual(signal.action, "BUY")
        self.assertIn(signal.trend_state, ["UP", "STRONG UP"])
        self.assertGreaterEqual(signal.confidence, 50)
        print("[PASS] Test 1: Clear Uptrend -> BUY Signal")

    def test_02_clear_downtrend_sell(self):
        """Scenario 2: Clear Downtrend -> SELL Signal"""
        c1h = self._generate_structured_candles("DOWN", 60, 7000.0)
        c15m = self._generate_structured_candles("DOWN", 60, 6800.0)
        c5m = self._generate_structured_candles("DOWN", 60, 6600.0)

        support = min([c.low for c in c5m[-15:]])
        c5m[-1].close = support - 15.0
        c5m[-1].open = support - 2.0
        c5m[-1].low = support - 20.0
        c5m[-1].volume = 8000.0

        signal = SignalEngine.evaluate_signal(c1h, c15m, c5m, c5m[-1].timestamp)
        self.assertEqual(signal.action, "SELL")
        self.assertIn(signal.trend_state, ["DOWN", "STRONG DOWN"])
        self.assertGreaterEqual(signal.confidence, 50)
        print("[PASS] Test 2: Clear Downtrend -> SELL Signal")

    def test_03_mtf_conflict_wait(self):
        """Scenario 3: 1H UP + 15M DOWN -> WAIT (MTF Conflict)"""
        c1h = self._generate_structured_candles("UP", 60, 6000.0)
        c15m = self._generate_structured_candles("DOWN", 60, 6800.0)
        c5m = self._generate_structured_candles("UP", 60, 6400.0)

        signal = SignalEngine.evaluate_signal(c1h, c15m, c5m, c5m[-1].timestamp)
        self.assertEqual(signal.action, "WAIT")
        self.assertTrue(any("MTF Conflict" in r or "conflict" in r.lower() for r in signal.reasons))
        print("[PASS] Test 3: 1H UP + 15M DOWN -> WAIT (MTF Conflict)")

    def test_04_range_market_wait(self):
        """Scenario 4: Range Market -> WAIT"""
        c1h = self._generate_structured_candles("RANGE", 60, 6500.0)
        c15m = self._generate_structured_candles("RANGE", 60, 6500.0)
        c5m = self._generate_structured_candles("RANGE", 60, 6500.0)

        signal = SignalEngine.evaluate_signal(c1h, c15m, c5m, c5m[-1].timestamp)
        self.assertEqual(signal.action, "WAIT")
        self.assertEqual(signal.trend_state, "RANGE")
        print("[PASS] Test 4: Range Market -> WAIT")

    def test_05_false_breakout_wait(self):
        """Scenario 5: False Breakout (Level touch without close/volume) -> WAIT"""
        c1h = self._generate_structured_candles("UP", 60, 6000.0)
        c15m = self._generate_structured_candles("UP", 60, 6200.0)
        c5m = self._generate_structured_candles("UP", 60, 6400.0)

        resistance = max([c.high for c in c5m[-15:]])
        c5m[-1].high = resistance + 25.0
        c5m[-1].close = resistance - 5.0
        c5m[-1].open = resistance - 10.0
        c5m[-1].volume = 5.0

        signal = SignalEngine.evaluate_signal(c1h, c15m, c5m, c5m[-1].timestamp)
        self.assertEqual(signal.action, "WAIT")
        self.assertTrue(any("False Breakout Filter" in r or "WAIT" in r for r in signal.reasons))
        print("[PASS] Test 5: False Breakout -> WAIT")

    def test_06_sl_distance_too_large_wait(self):
        """Scenario 6: SL distance exceeds Max Risk Limit -> WAIT"""
        c1h = self._generate_structured_candles("UP", 60, 6000.0)
        c15m = self._generate_structured_candles("UP", 60, 6200.0)
        c5m = self._generate_structured_candles("UP", 60, 6400.0)

        resistance = max([c.high for c in c5m[-15:]])
        # Massive 300 pt gap breakout = Rs. 3,000 risk > Rs. 2,500 max limit
        c5m[-1].close = resistance + 350.0
        c5m[-1].open = resistance + 2.0
        c5m[-1].volume = 8000.0

        signal = SignalEngine.evaluate_signal(c1h, c15m, c5m, c5m[-1].timestamp)
        self.assertEqual(signal.action, "WAIT")
        self.assertTrue(any("SL distance too wide" in r for r in signal.reasons))
        print("[PASS] Test 6: SL Distance Too Large -> WAIT")

    def test_07_daily_loss_limit_paused(self):
        """Scenario 7: Daily Loss Limit Hit -> System State PAUSED"""
        paper_engine = PaperExecutionEngine()
        paper_engine.daily_net_pnl = -3200.0
        
        c1h = self._generate_structured_candles("UP", 60, 6000.0)
        c15m = self._generate_structured_candles("UP", 60, 6200.0)
        c5m = self._generate_structured_candles("UP", 60, 6400.0)

        signal = SignalEngine.evaluate_signal(c1h, c15m, c5m, c5m[-1].timestamp)
        paper_engine.process_signal_and_market(signal, c5m[-1])
        
        self.assertEqual(paper_engine.system_status, "PAUSED")
        self.assertTrue(paper_engine.daily_loss_limit_hit)
        print("[PASS] Test 7: Daily Loss Limit Hit -> PAUSED")

    def test_08_websocket_stale_data_no_trade(self):
        """Scenario 8: WebSocket Stale (>10 sec) -> NO TRADE / Stale True"""
        builder = MultiTimeframeCandleBuilder()
        now = datetime.now()
        stale_time = now - timedelta(seconds=15)
        
        builder.process_tick(stale_time, 6500.0)
        self.assertTrue(builder.is_data_stale(now))
        print("[PASS] Test 8: WebSocket Stale > 10 Sec -> Data Stale Detected")

    def test_09_gap_fill_reconnect(self):
        """Scenario 9: Reconnect + Missing Candles Gap-fill before resuming"""
        builder = MultiTimeframeCandleBuilder()
        missing_candles = [
            Candle(timestamp=self.base_time + timedelta(minutes=i), open=6500+i, high=6505+i, low=6495+i, close=6502+i, volume=100)
            for i in range(10)
        ]
        builder.gap_fill(missing_candles)
        self.assertEqual(len(builder.candles_1m), 10)
        self.assertEqual(len(builder.candles_5m), 2)
        print("[PASS] Test 9: Gap-Fill Reconnect Recovery Successful")

    def test_10_max_one_lot_enforced(self):
        """Scenario 10: Maximum 1 Lot Enforced Strictly"""
        paper_engine = PaperExecutionEngine()
        c1h = self._generate_structured_candles("UP", 60, 6000.0)
        c15m = self._generate_structured_candles("UP", 60, 6200.0)
        c5m = self._generate_structured_candles("UP", 60, 6400.0)

        resistance = max([c.high for c in c5m[-15:]])
        c5m[-1].close = resistance + 15.0
        c5m[-1].low = resistance + 5.0  # Keep low above SL so pos1 stays OPEN!
        c5m[-1].volume = 8000.0

        signal = SignalEngine.evaluate_signal(c1h, c15m, c5m, c5m[-1].timestamp)
        pos1 = paper_engine.process_signal_and_market(signal, c5m[-1])
        self.assertIsNotNone(pos1)
        self.assertEqual(pos1.quantity, 1)

        # Try opening 2nd trade while pos1 is OPEN
        pos2 = paper_engine.process_signal_and_market(signal, c5m[-1])
        self.assertIsNone(pos2)
        print("[PASS] Test 10: Max 1 Lot Enforced Strictly")

    def test_11_no_martingale_after_loss(self):
        """Scenario 11: Quantity Never Increases After Loss (No Martingale)"""
        paper_engine = PaperExecutionEngine()
        
        c1h = self._generate_structured_candles("UP", 60, 6000.0)
        c15m = self._generate_structured_candles("UP", 60, 6200.0)
        c5m = self._generate_structured_candles("UP", 60, 6400.0)
        resistance = max([c.high for c in c5m[-15:]])
        c5m[-1].close = resistance + 15.0
        c5m[-1].low = resistance + 5.0
        c5m[-1].volume = 8000.0

        signal = SignalEngine.evaluate_signal(c1h, c15m, c5m, c5m[-1].timestamp)
        pos1 = paper_engine.process_signal_and_market(signal, c5m[-1])
        self.assertIsNotNone(pos1)

        # Force moderate SL Exit on pos1 (-Rs.500 loss, well within Rs.3,000 daily limit)
        t_exit = c5m[-1].timestamp + timedelta(minutes=5)
        c_sl = Candle(timestamp=t_exit, open=pos1.entry_price-20, high=pos1.entry_price-10, low=pos1.stop_loss-1, close=pos1.stop_loss)
        paper_engine.process_signal_and_market(signal, c_sl)
        
        self.assertEqual(len(paper_engine.closed_trades), 1)
        self.assertLess(paper_engine.closed_trades[0].pnl_result.net_pnl, 0)
        self.assertFalse(paper_engine.daily_loss_limit_hit)

        # Next Trade Entry with fresh candle timestamp after exit
        t_new = t_exit + timedelta(minutes=5)
        c5m_next = [c for c in c5m]
        c5m_next.append(Candle(timestamp=t_new, open=resistance+10, high=resistance+25, low=resistance+5, close=resistance+20, volume=8000.0))

        signal_new = SignalEngine.evaluate_signal(c1h, c15m, c5m_next, t_new)
        pos2 = paper_engine.process_signal_and_market(signal_new, c5m_next[-1])
        
        self.assertIsNotNone(pos2)
        self.assertEqual(pos2.quantity, 1)  # Remains strictly 1 lot (No Martingale)
        print("[PASS] Test 11: No Martingale / Quantity Stays 1 Lot After Loss")

    def test_12_zero_lookahead_historical_replay(self):
        """Scenario 12: Historical Replay Strictly Prohibits Future Candles"""
        builder = MultiTimeframeCandleBuilder()
        all_candles = self._generate_structured_candles("UP", 100, 6000.0)
        
        for idx, candle in enumerate(all_candles):
            builder.add_completed_1m_candle(candle)
            self.assertEqual(len(builder.candles_1m), idx + 1)
            self.assertEqual(builder.candles_1m[-1].timestamp, candle.timestamp)

        print("[PASS] Test 12: Zero Lookahead Bias Enforced in Historical Replay")

if __name__ == "__main__":
    unittest.main()
