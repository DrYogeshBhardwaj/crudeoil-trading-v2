"""
BTC UP-DOWN CAPTURE 10 — DEDICATED PAPER TEST ENGINE
=====================================================
10-Slot Directional Capture Paper Trading Engine for Bitcoin (BTCUSDT / BTC-INR).

KEY SPECIFICATIONS:
- 100% PAPER / TEST MODE ONLY — Real Mudrex orders hardcoded OFF.
- Total slots: 10 simultaneous positions.
- Notional position per slot: Rs. 17,500.
- Leverage: 5x.
- Margin per slot: Rs. 3,500.
- Total Reference Capital: Rs. 35,000.
- Signal Logic: 3 completed 1-minute candles net movement.
  • Net UP movement  -> Next available slot opens LONG position.
  • Net DOWN movement -> Next available slot opens SHORT position.
  • Flat / Noisy      -> NO NEW ENTRY.
- Exit Rules:
  • Target NET Profit: +Rs. 100 per slot (configurable).
  • Max Loss NET:     -Rs. 60 per slot (configurable).
  • NET calculation includes realistic Mudrex Futures taker fee (0.05% entry + 0.05% exit).
  • No forced time exit. Closed slots return to AVAILABLE status for re-entry.

STRICT ISOLATION:
Does NOT touch or share state with existing single-live engine or 6-basket live5 engine.
"""

import os
import json
import time
import asyncio
import requests
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional, Tuple

from database import DB
from bitcoin_feed import BITCOIN_FEED

class BitcoinUpDown10Engine:
    """Dedicated 10-Slot UP-DOWN Capture Paper Test Engine for BTC."""

    TOTAL_SLOTS = 10
    SLOT_NOTIONAL_INR = 17500.0
    LEVERAGE = 5.0
    SLOT_MARGIN_INR = 3500.0
    REFERENCE_CAPITAL_INR = 35000.0
    TAKER_FEE_RATE = 0.0005 # 0.05% taker fee per side

    def __init__(self):
        self.is_running = False
        self.test_mode_enabled = True # 100% PAPER/TEST MODE
        self.last_api_status = "INITIALIZED"
        self.last_direction_signal = "FLAT"
        self.last_entry_reason = "System initialized. Waiting for 3-minute candle signal."
        self.last_evaluation_time = 0.0
        
        self.load_settings()
        self.load_state_from_db()

    def load_settings(self):
        """Loads configurable settings from database or applies defaults."""
        self.target_net_inr = float(DB.load_bitcoin_updown10_setting("target_net_inr", "100.0"))
        self.max_loss_net_inr = float(DB.load_bitcoin_updown10_setting("max_loss_net_inr", "60.0"))
        self.min_movement_pct = float(DB.load_bitcoin_updown10_setting("min_movement_pct", "0.03"))
        
        # Ensure persistent defaults in DB
        DB.save_bitcoin_updown10_setting("target_net_inr", str(self.target_net_inr))
        DB.save_bitcoin_updown10_setting("max_loss_net_inr", str(self.max_loss_net_inr))
        DB.save_bitcoin_updown10_setting("min_movement_pct", str(self.min_movement_pct))

    def update_settings(self, target_net_inr: Optional[float] = None, max_loss_net_inr: Optional[float] = None, min_movement_pct: Optional[float] = None):
        """Updates configurable settings dynamically."""
        if target_net_inr is not None and target_net_inr > 0:
            self.target_net_inr = float(target_net_inr)
            DB.save_bitcoin_updown10_setting("target_net_inr", str(self.target_net_inr))
        if max_loss_net_inr is not None and max_loss_net_inr > 0:
            self.max_loss_net_inr = float(max_loss_net_inr)
            DB.save_bitcoin_updown10_setting("max_loss_net_inr", str(self.max_loss_net_inr))
        if min_movement_pct is not None and min_movement_pct >= 0:
            self.min_movement_pct = float(min_movement_pct)
            DB.save_bitcoin_updown10_setting("min_movement_pct", str(self.min_movement_pct))

    def load_state_from_db(self):
        """Restores open slot positions and historical trade stats from DB on startup."""
        self.active_slots: Dict[int, Optional[Dict[str, Any]]] = {i: None for i in range(1, self.TOTAL_SLOTS + 1)}
        open_positions = DB.load_active_bitcoin_updown10_positions()
        
        for pos in open_positions:
            slot_idx = int(pos.get("slot_index", 1))
            if 1 <= slot_idx <= self.TOTAL_SLOTS:
                self.active_slots[slot_idx] = pos

    def fetch_current_btc_prices(self) -> Tuple[Optional[float], Optional[float], float]:
        """
        Fetches current BTC price in USD and INR.
        Returns: (price_usd, price_inr, hedge_rate)
        """
        # Try Binance Futures API for live BTCUSDT price
        price_usd = None
        hedge_rate = 102.0

        try:
            resp = requests.get("https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT", timeout=4)
            if resp.status_code == 200:
                price_usd = float(resp.json()["price"])
        except Exception:
            pass

        if not price_usd:
            try:
                resp = requests.get("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", timeout=4)
                if resp.status_code == 200:
                    price_usd = float(resp.json()["price"])
            except Exception:
                pass

        # Fallback to Yahoo feed if Binance is unreachable
        if not price_usd:
            tick = BITCOIN_FEED.fetch_latest_tick()
            if tick and tick.get("price", 0) > 0:
                price_inr = float(tick["price"])
                price_usd = round(price_inr / hedge_rate, 2)
                return price_usd, price_inr, hedge_rate

        if price_usd:
            price_inr = round(price_usd * hedge_rate, 2)
            return price_usd, price_inr, hedge_rate

        return None, None, hedge_rate

    def calculate_taker_charges(self, entry_price_inr: float, current_price_inr: float, quantity: float) -> Tuple[float, float, float]:
        """
        Calculates entry taker fee, exit taker fee, and total charges in INR.
        Taker Fee Rate = 0.05% per side.
        """
        entry_val = entry_price_inr * quantity
        exit_val = current_price_inr * quantity
        entry_fee = round(entry_val * self.TAKER_FEE_RATE, 2)
        exit_fee = round(exit_val * self.TAKER_FEE_RATE, 2)
        total_fee = round(entry_fee + exit_fee, 2)
        return entry_fee, exit_fee, total_fee

    def evaluate_direction_signal(self, candles: Optional[List[Dict[str, Any]]] = None) -> Tuple[str, float, str]:
        """
        Evaluates last 3 completed 1-minute candles for directional momentum.
        Returns: (signal, change_pct_3m, reason)
        - signal: 'UP', 'DOWN', or 'FLAT'
        """
        if candles is None or len(candles) < 3:
            candles = BITCOIN_FEED.fetch_historical_candles(tf="1m", period="1d")

        if not candles or len(candles) < 3:
            return "FLAT", 0.0, "Insufficient 1-minute candle history available."

        # Take last 3 completed candles
        # If last candle is ongoing, candles[-4:-1] or candles[-3:] depending on timestamp
        last_3 = candles[-3:]
        open_3m = last_3[0]["open"]
        close_3m = last_3[-1]["close"]

        if open_3m <= 0:
            return "FLAT", 0.0, "Invalid zero candle open price."

        change_pct = round(((close_3m - open_3m) / open_3m) * 100.0, 4)

        if change_pct >= self.min_movement_pct:
            signal = "UP"
            reason = f"3m Momentum UP (+{change_pct:.3f}% >= min threshold {self.min_movement_pct}%). Open={open_3m}, Close={close_3m}"
        elif change_pct <= -self.min_movement_pct:
            signal = "DOWN"
            reason = f"3m Momentum DOWN ({change_pct:.3f}% <= -min threshold -{self.min_movement_pct}%). Open={open_3m}, Close={close_3m}"
        else:
            signal = "FLAT"
            reason = f"3m Movement FLAT/NOISY ({change_pct:.3f}% within noise band ±{self.min_movement_pct}%). Open={open_3m}, Close={close_3m}"

        return signal, change_pct, reason

    def get_first_available_slot(self) -> Optional[int]:
        """Finds the lowest empty slot index (1 to 10)."""
        for slot_idx in range(1, self.TOTAL_SLOTS + 1):
            if self.active_slots[slot_idx] is None:
                return slot_idx
        return None

    def open_position_in_slot(self, slot_idx: int, direction: str, price_usd: float, price_inr: float, hedge_rate: float, reason: str) -> Dict[str, Any]:
        """Opens a new paper position in the designated slot index."""
        # Calculate quantity in BTC for fixed Rs. 17,500 notional
        quantity_btc = round(self.SLOT_NOTIONAL_INR / price_inr, 6)
        entry_ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        trade_id = f"BTC_UPDOWN10_{int(time.time()*1000)}_{slot_idx}"

        entry_fee, exit_fee, est_charges = self.calculate_taker_charges(price_inr, price_inr, quantity_btc)

        position = {
            "trade_id": trade_id,
            "slot_index": slot_idx,
            "entry_timestamp": entry_ts,
            "symbol": "BTCUSDT",
            "direction": "BUY" if direction == "UP" else "SELL",
            "quantity": quantity_btc,
            "notional_inr": self.SLOT_NOTIONAL_INR,
            "leverage": self.LEVERAGE,
            "margin_inr": self.SLOT_MARGIN_INR,
            "entry_price": price_inr,
            "entry_price_usd": price_usd,
            "hedge_rate": hedge_rate,
            "target_net_inr": self.target_net_inr,
            "max_loss_net_inr": self.max_loss_net_inr,
            "status": "OPEN",
            "exit_timestamp": None,
            "exit_price": None,
            "exit_price_usd": None,
            "exit_reason": None,
            "gross_pnl": 0.0,
            "entry_charges": entry_fee,
            "exit_charges": exit_fee,
            "charges": est_charges,
            "funding_fee": 0.0,
            "net_pnl": -est_charges
        }

        self.active_slots[slot_idx] = position
        DB.save_bitcoin_updown10_trade(position)
        self.last_entry_reason = f"Slot #{slot_idx} opened {position['direction']} @ Rs.{price_inr:,.2f} ($ {price_usd:,.2f}). Signal: {reason}"
        return position

    def close_position_in_slot(self, slot_idx: int, exit_price_usd: float, exit_price_inr: float, exit_reason: str) -> Optional[Dict[str, Any]]:
        """Closes the active paper position in a slot and frees the slot."""
        pos = self.active_slots.get(slot_idx)
        if not pos or pos["status"] != "OPEN":
            return None

        dir_multiplier = 1.0 if pos["direction"] == "BUY" else -1.0
        gross_pnl = round((exit_price_inr - pos["entry_price"]) * pos["quantity"] * dir_multiplier, 2)
        entry_fee, exit_fee, total_charges = self.calculate_taker_charges(pos["entry_price"], exit_price_inr, pos["quantity"])
        funding_fee = pos.get("funding_fee", 0.0)
        net_pnl = round(gross_pnl - total_charges - funding_fee, 2)

        pos["status"] = "CLOSED"
        pos["exit_timestamp"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        pos["exit_price"] = exit_price_inr
        pos["exit_price_usd"] = exit_price_usd
        pos["exit_reason"] = exit_reason
        pos["gross_pnl"] = gross_pnl
        pos["entry_charges"] = entry_fee
        pos["exit_charges"] = exit_fee
        pos["charges"] = total_charges
        pos["net_pnl"] = net_pnl

        DB.save_bitcoin_updown10_trade(pos)
        self.active_slots[slot_idx] = None
        return pos

    def evaluate_tick(self, price_usd: Optional[float] = None, price_inr: Optional[float] = None, hedge_rate: float = 102.0) -> Dict[str, Any]:
        """
        Core evaluation cycle for active positions & entry signals.
        Evaluates target/loss hits on active positions first, then checks for new entries if slots are available.
        """
        if price_usd is None or price_inr is None:
            price_usd, price_inr, hedge_rate = self.fetch_current_btc_prices()

        if not price_usd or not price_inr:
            self.last_api_status = "FEED UNREACHABLE"
            return {"status": "FEED_UNREACHABLE"}

        self.last_api_status = f"LIVE FEED OK (${price_usd:,.2f} / Rs.{price_inr:,.2f})"

        # 1. Evaluate Target / Loss exits for all active slots
        for slot_idx in range(1, self.TOTAL_SLOTS + 1):
            pos = self.active_slots[slot_idx]
            if pos and pos["status"] == "OPEN":
                dir_mult = 1.0 if pos["direction"] == "BUY" else -1.0
                gross_pnl = round((price_inr - pos["entry_price"]) * pos["quantity"] * dir_mult, 2)
                entry_fee, exit_fee, total_charges = self.calculate_taker_charges(pos["entry_price"], price_inr, pos["quantity"])
                funding_fee = pos.get("funding_fee", 0.0)
                net_pnl = round(gross_pnl - total_charges - funding_fee, 2)

                pos["gross_pnl"] = gross_pnl
                pos["charges"] = total_charges
                pos["net_pnl"] = net_pnl

                # Target Hit (+Rs. 100 NET)
                if net_pnl >= self.target_net_inr:
                    self.close_position_in_slot(slot_idx, price_usd, price_inr, f"TARGET HIT (+Rs. {net_pnl:.2f} NET)")
                # Max Loss Hit (-Rs. 60 NET)
                elif net_pnl <= -abs(self.max_loss_net_inr):
                    self.close_position_in_slot(slot_idx, price_usd, price_inr, f"MAX LOSS HIT ({net_pnl:.2f} NET)")

        # 2. Check direction signal & open next available slot if available
        available_slot = self.get_first_available_slot()
        signal, change_pct, reason = self.evaluate_direction_signal()
        self.last_direction_signal = signal

        if available_slot is not None and signal in ("UP", "DOWN"):
            self.open_position_in_slot(available_slot, signal, price_usd, price_inr, hedge_rate, reason)
            DB.log_bitcoin_updown10_evaluation(price_inr, signal, change_pct, f"Opened Slot #{available_slot} {signal}")
        else:
            log_reason = f"No open slot needed (Signal: {signal})" if available_slot is None else reason
            DB.log_bitcoin_updown10_evaluation(price_inr, signal, change_pct, log_reason)

        return self.get_dashboard_state()

    def emergency_exit_slot(self, slot_idx: int) -> Optional[Dict[str, Any]]:
        """Manually closes an active slot position."""
        if 1 <= slot_idx <= self.TOTAL_SLOTS:
            price_usd, price_inr, _ = self.fetch_current_btc_prices()
            if price_usd and price_inr:
                return self.close_position_in_slot(slot_idx, price_usd, price_inr, "MANUAL EMERGENCY EXIT")
        return None

    def emergency_exit_all(self) -> List[Dict[str, Any]]:
        """Manually closes all active slot positions."""
        closed = []
        price_usd, price_inr, _ = self.fetch_current_btc_prices()
        if price_usd and price_inr:
            for slot_idx in range(1, self.TOTAL_SLOTS + 1):
                res = self.close_position_in_slot(slot_idx, price_usd, price_inr, "MANUAL EMERGENCY EXIT ALL")
                if res:
                    closed.append(res)
        return closed

    def reset_account(self):
        """Resets paper account, clears trades and restores all slots to AVAILABLE."""
        DB.reset_bitcoin_updown10_paper_account()
        self.load_settings()
        self.load_state_from_db()
        self.last_entry_reason = "Paper account reset. All slots restored to AVAILABLE."

    def get_dashboard_state(self) -> Dict[str, Any]:
        """Calculates comprehensive state dictionary for the web dashboard."""
        price_usd, price_inr, hedge_rate = self.fetch_current_btc_prices()

        # Build slot grid status (1 to 10)
        slots_grid = []
        active_count = 0
        total_open_net_pnl = 0.0

        for slot_idx in range(1, self.TOTAL_SLOTS + 1):
            pos = self.active_slots.get(slot_idx)
            if pos and pos["status"] == "OPEN":
                active_count += 1
                cur_inr = price_inr or pos["entry_price"]
                cur_usd = price_usd or pos.get("entry_price_usd", 0.0)

                dir_mult = 1.0 if pos["direction"] == "BUY" else -1.0
                gross_pnl = round((cur_inr - pos["entry_price"]) * pos["quantity"] * dir_mult, 2)
                entry_fee, exit_fee, total_charges = self.calculate_taker_charges(pos["entry_price"], cur_inr, pos["quantity"])
                funding_fee = pos.get("funding_fee", 0.0)
                net_pnl = round(gross_pnl - total_charges - funding_fee, 2)
                total_open_net_pnl += net_pnl

                slots_grid.append({
                    "slot_index": slot_idx,
                    "status": "LONG" if pos["direction"] == "BUY" else "SHORT",
                    "trade_id": pos["trade_id"],
                    "direction": pos["direction"],
                    "entry_timestamp": pos["entry_timestamp"],
                    "entry_price": pos["entry_price"],
                    "entry_price_usd": pos.get("entry_price_usd"),
                    "current_price": cur_inr,
                    "current_price_usd": cur_usd,
                    "quantity": pos["quantity"],
                    "notional_inr": pos.get("notional_inr", self.SLOT_NOTIONAL_INR),
                    "margin_inr": pos.get("margin_inr", self.SLOT_MARGIN_INR),
                    "gross_pnl": gross_pnl,
                    "charges": total_charges,
                    "funding_fee": funding_fee,
                    "net_pnl": net_pnl,
                    "target_net_inr": self.target_net_inr,
                    "max_loss_net_inr": self.max_loss_net_inr
                })
            else:
                slots_grid.append({
                    "slot_index": slot_idx,
                    "status": "AVAILABLE",
                    "trade_id": None,
                    "direction": None,
                    "entry_timestamp": None,
                    "entry_price": None,
                    "entry_price_usd": None,
                    "current_price": price_inr,
                    "current_price_usd": price_usd,
                    "quantity": 0.0,
                    "notional_inr": self.SLOT_NOTIONAL_INR,
                    "margin_inr": self.SLOT_MARGIN_INR,
                    "gross_pnl": 0.0,
                    "charges": 0.0,
                    "funding_fee": 0.0,
                    "net_pnl": 0.0,
                    "target_net_inr": self.target_net_inr,
                    "max_loss_net_inr": self.max_loss_net_inr
                })

        # Calculate analytics from completed trades
        all_trades = DB.load_all_bitcoin_updown10_trades()
        closed_trades = [t for t in all_trades if t["status"] == "CLOSED"]

        completed_count = len(closed_trades)
        realized_net_pnl = sum(t.get("net_pnl", 0.0) for t in closed_trades)
        total_net_pnl = round(realized_net_pnl + total_open_net_pnl, 2)

        target_hits = sum(1 for t in closed_trades if "TARGET" in str(t.get("exit_reason", "")))
        max_loss_hits = sum(1 for t in closed_trades if "MAX LOSS" in str(t.get("exit_reason", "")))

        long_trades = [t for t in closed_trades if t.get("direction") == "BUY"]
        short_trades = [t for t in closed_trades if t.get("direction") == "SELL"]

        long_wins = sum(1 for t in long_trades if t.get("net_pnl", 0.0) > 0)
        long_losses = sum(1 for t in long_trades if t.get("net_pnl", 0.0) <= 0)

        short_wins = sum(1 for t in short_trades if t.get("net_pnl", 0.0) > 0)
        short_losses = sum(1 for t in short_trades if t.get("net_pnl", 0.0) <= 0)

        winning_trades = [t for t in closed_trades if t.get("net_pnl", 0.0) > 0]
        losing_trades = [t for t in closed_trades if t.get("net_pnl", 0.0) <= 0]

        avg_winning_net = round(sum(t.get("net_pnl", 0.0) for t in winning_trades) / len(winning_trades), 2) if winning_trades else 0.0
        avg_losing_net = round(sum(t.get("net_pnl", 0.0) for t in losing_trades) / len(losing_trades), 2) if losing_trades else 0.0

        # Holding times
        holding_times = []
        for t in closed_trades:
            try:
                dt_in = datetime.strptime(t["entry_timestamp"], "%Y-%m-%d %H:%M:%S")
                dt_out = datetime.strptime(t["exit_timestamp"], "%Y-%m-%d %H:%M:%S")
                holding_times.append((dt_out - dt_in).total_seconds())
            except Exception:
                pass

        avg_holding_sec = round(sum(holding_times) / len(holding_times), 1) if holding_times else 0.0
        avg_holding_str = f"{int(avg_holding_sec // 60)}m {int(avg_holding_sec % 60)}s" if avg_holding_sec > 0 else "0m 0s"

        recent_logs = DB.get_recent_bitcoin_updown10_evaluations(30)

        return {
            "title": "BTC UP-DOWN CAPTURE 10",
            "mode": "PAPER/TEST MODE — REAL ORDERS OFF",
            "reference_capital_inr": self.REFERENCE_CAPITAL_INR,
            "reference_margin_capital_inr": self.REFERENCE_CAPITAL_INR,
            "total_market_exposure_inr": self.TOTAL_SLOTS * self.SLOT_NOTIONAL_INR,
            "per_slot_market_position_inr": self.SLOT_NOTIONAL_INR,
            "per_slot_margin_inr": self.SLOT_MARGIN_INR,
            "leverage": self.LEVERAGE,
            "total_slots": self.TOTAL_SLOTS,
            "active_slots_count": active_count,
            "available_slots_count": self.TOTAL_SLOTS - active_count,
            "slots": slots_grid,
            "total_open_net_pnl": round(total_open_net_pnl, 2),
            "realized_test_pnl": round(realized_net_pnl, 2),
            "total_test_pnl": total_net_pnl,
            "completed_trades_count": completed_count,
            "target_hits_count": target_hits,
            "max_loss_hits_count": max_loss_hits,
            "long_wins": long_wins,
            "long_losses": long_losses,
            "short_wins": short_wins,
            "short_losses": short_losses,
            "avg_net_profit_winning_trade": avg_winning_net,
            "avg_net_loss_losing_trade": avg_losing_net,
            "avg_holding_time_seconds": avg_holding_sec,
            "avg_holding_time_str": avg_holding_str,
            "current_btc_price_inr": price_inr or 0.0,
            "current_btc_price_usd": price_usd or 0.0,
            "last_direction_signal": self.last_direction_signal,
            "last_entry_reason": self.last_entry_reason,
            "settings": {
                "target_net_inr": self.target_net_inr,
                "max_loss_net_inr": self.max_loss_net_inr,
                "min_movement_pct": self.min_movement_pct,
                "notional_inr": self.SLOT_NOTIONAL_INR,
                "leverage": self.LEVERAGE,
                "margin_inr": self.SLOT_MARGIN_INR
            },
            "trade_history": closed_trades[:100],
            "recent_evaluations": recent_logs,
            "last_update_time_ist": datetime.now().strftime("%Y-%m-%d %H:%M:%S IST")
        }

    async def start_feed_loop(self):
        """Background continuous evaluation loop."""
        self.is_running = True
        print(f"[{datetime.now()}] BITCOIN UP-DOWN CAPTURE 10 PAPER ENGINE STARTED (100% PAPER MODE).")
        while self.is_running:
            try:
                self.evaluate_tick()
            except Exception as e:
                print(f"[BITCOIN UPDOWN10 LOOP ERROR] {e}")
            await asyncio.sleep(5)

BITCOIN_UPDOWN10_ENGINE = BitcoinUpDown10Engine()
