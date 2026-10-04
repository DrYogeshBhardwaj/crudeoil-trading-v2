"""
BITCOIN 5-LIVE ROLLING TEST ENGINE — PAPER/TEST MODE ONLY
==========================================================
Dedicated multi-position paper test engine supporting up to 5 simultaneous independent BTCUSDT paper positions.
Features:
- Reference Test Capital: Rs. 20,000
- 2-Minute Entry Interval (earliest opportunity for new paper entry)
- 10-Minute Maximum Holding Time per position (mandatory time exit)
- Target Profit: +Rs. 100 NET per position
- Max Loss: -Rs. 200 NET per position
- Maximum simultaneous open positions: 5
- Paper / Test execution: ZERO real Mudrex orders sent.
- Reuses Mudrex/Binance live market data feed for P&L tracking.

STRICT ISOLATION:
Does NOT modify, share state with, or affect the single-position live engine (/bitcoin/live).
"""

import os
import json
import time
import asyncio
import requests
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional, Tuple

from database import DB
from bitcoin_strategy import BITCOIN_STRATEGY
from bitcoin_feed import BITCOIN_FEED
from bitcoin_live_engine import MudrexLiveAdapter

class BitcoinLive5Engine:
    """Dedicated 5-slot rolling paper test engine for Bitcoin Futures."""

    TAKER_FEE_RATE = 0.0005 # 0.05% taker fee per side

    def __init__(self):
        self.adapter = MudrexLiveAdapter()
        self.test_capital_reference = 25000.0 # Rs. 25,000 test capital
        self.max_holding_time_seconds = 300 # 5 minutes maximum holding time
        self.enable_time_exit = False # Stopwatch time exit disabled as requested by user
        self.entry_interval_seconds = 60 # 1 minute rolling entry interval
        self.load_settings()
        self.active_positions: List[Dict[str, Any]] = []
        self.is_running = False
        self.last_api_status = "PAPER TEST INITIALIZED"
        self.last_entry_time = 0.0
        self.last_signal_action = ""
        self.price_history_1m: List[Tuple[float, float]] = [] # (timestamp, price_usd) buffer
        self.test_mode_enabled = True # Test mode default
        self.test_status = "RUNNING" # RUNNING, PAUSED

    def load_settings(self):
        """Loads persistent 5-live rolling test settings from SQLite DB."""
        # STRICT LOCK: Real orders ALWAYS disabled in paper test engine
        self.live_trading_enabled = False 
        DB.save_bitcoin_live5_setting("live_trading_enabled", "FALSE")

        self.today_date = datetime.now().strftime("%Y-%m-%d")
        saved_date = DB.load_bitcoin_live5_setting("today_date", self.today_date)
        
        if saved_date != self.today_date:
            DB.save_bitcoin_live5_setting("today_date", self.today_date)
            DB.save_bitcoin_live5_setting("today_realized_pnl", "0.0")

        self.test_capital_reference = float(DB.load_bitcoin_live5_setting("test_capital_reference", "25000.0"))
        self.max_positions = int(DB.load_bitcoin_live5_setting("max_positions", "6"))
        self.default_quantity = float(DB.load_bitcoin_live5_setting("default_quantity", "0.002"))
        self.default_leverage = float(DB.load_bitcoin_live5_setting("default_leverage", "5.0"))
        
        self.per_trade_profit_target_inr = float(DB.load_bitcoin_live5_setting("per_trade_profit_target_inr", "25.0"))
        self.per_trade_loss_limit_inr = float(DB.load_bitcoin_live5_setting("per_trade_loss_limit_inr", "50.0"))
        self.daily_loss_limit_inr = float(DB.load_bitcoin_live5_setting("daily_loss_limit_inr", "1000.0"))

        DB.save_bitcoin_live5_setting("test_capital_reference", str(self.test_capital_reference))
        DB.save_bitcoin_live5_setting("max_positions", str(self.max_positions))
        DB.save_bitcoin_live5_setting("default_quantity", str(self.default_quantity))
        DB.save_bitcoin_live5_setting("default_leverage", str(self.default_leverage))
        DB.save_bitcoin_live5_setting("per_trade_profit_target_inr", str(self.per_trade_profit_target_inr))
        DB.save_bitcoin_live5_setting("per_trade_loss_limit_inr", str(self.per_trade_loss_limit_inr))

        self.today_realized_pnl = float(DB.load_bitcoin_live5_setting("today_realized_pnl", "0.0"))
        self.consecutive_api_failures = 0
        self.last_evaluation = {}
        self.evaluation_stream = []

    def save_settings(self):
        """Persists current 5-live settings to SQLite DB."""
        DB.save_bitcoin_live5_setting("live_trading_enabled", "FALSE")
        DB.save_bitcoin_live5_setting("test_capital_reference", str(self.test_capital_reference))
        DB.save_bitcoin_live5_setting("max_positions", str(self.max_positions))
        DB.save_bitcoin_live5_setting("default_quantity", str(self.default_quantity))
        DB.save_bitcoin_live5_setting("default_leverage", str(self.default_leverage))
        DB.save_bitcoin_live5_setting("per_trade_profit_target_inr", str(self.per_trade_profit_target_inr))
        DB.save_bitcoin_live5_setting("per_trade_loss_limit_inr", str(self.per_trade_loss_limit_inr))
        DB.save_bitcoin_live5_setting("today_realized_pnl", str(round(self.today_realized_pnl, 2)))

    def fetch_mudrex_futures_market_data(self) -> Tuple[Optional[float], Optional[float], str]:
        """Fetches authoritative BTCUSDT price feed from Mudrex/Binance Futures."""
        try:
            url = "https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT"
            resp = requests.get(url, timeout=4)
            if resp.status_code == 200:
                data = resp.json()
                price_usd = float(data["price"])
                self.consecutive_api_failures = 0
                return price_usd, 102.0, "Binance Futures API (BTCUSDT USD)"
        except Exception:
            pass

        try:
            url = "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"
            resp = requests.get(url, timeout=4)
            if resp.status_code == 200:
                data = resp.json()
                price_usd = float(data["price"])
                self.consecutive_api_failures = 0
                return price_usd, 102.0, "Binance Spot Fallback API (BTCUSDT USD)"
        except Exception:
            pass

        self.consecutive_api_failures += 1
        return None, 102.0, "API UNREACHABLE"

    def calculate_trade_charges(self, entry_price_inr: float, exit_price_inr: float, quantity: float) -> Tuple[float, float, float]:
        """Calculates dynamic roundtrip taker fees in INR."""
        entry_val = entry_price_inr * quantity
        exit_val = exit_price_inr * quantity
        entry_fee = round(entry_val * self.TAKER_FEE_RATE, 2)
        exit_fee = round(exit_val * self.TAKER_FEE_RATE, 2)
        total_fee = round(entry_fee + exit_fee, 2)
        return entry_fee, exit_fee, total_fee

    def calculate_sl_and_target_prices(
        self,
        direction: str,
        entry_price_usd: float,
        quantity: float,
        hedge_rate: float = 102.0
    ) -> Tuple[float, float, float, float, float]:
        """Calculates target_usd, stop_loss_usd, target_inr, stop_loss_inr for a 5-live position."""
        pos_hr = hedge_rate or 102.0
        entry_price_inr = entry_price_usd * pos_hr
        
        entry_fee, exit_fee, est_charges_inr = self.calculate_trade_charges(entry_price_inr, entry_price_inr, quantity)
        tp_gross_diff_inr = self.per_trade_profit_target_inr + est_charges_inr
        sl_gross_diff_inr = self.per_trade_loss_limit_inr + est_charges_inr

        gross_diff_per_btc_inr_tp = tp_gross_diff_inr / quantity
        gross_diff_per_btc_inr_sl = sl_gross_diff_inr / quantity

        usd_diff_tp = gross_diff_per_btc_inr_tp / pos_hr
        usd_diff_sl = gross_diff_per_btc_inr_sl / pos_hr

        if direction == "BUY":
            tp_usd = round(entry_price_usd + usd_diff_tp, 2)
            sl_usd = round(entry_price_usd - usd_diff_sl, 2)
        else: # SELL
            tp_usd = round(entry_price_usd - usd_diff_tp, 2)
            sl_usd = round(entry_price_usd + usd_diff_sl, 2)

        tp_inr = round(tp_usd * pos_hr, 2)
        sl_inr = round(sl_usd * pos_hr, 2)

        return tp_usd, sl_usd, tp_inr, sl_inr, est_charges_inr

    def calculate_live_position_pnl(
        self,
        pos: Dict[str, Any],
        curr_price_usd: Optional[float],
        hedge_rate: Optional[float]
    ) -> Tuple[float, float, float, float, float, float]:
        """Calculates P&L for a single 5-live position."""
        if not pos or curr_price_usd is None or curr_price_usd <= 0 or not hedge_rate or hedge_rate <= 0:
            return 0.0, 0.0, 0.0, 0.0, 0.0, 0.0

        pos_hr = float(pos.get("hedge_rate") or hedge_rate or 102.0)
        entry_usd = float(pos.get("entry_price_usd") or (pos["entry_price"] / pos_hr))
        qty = float(pos["quantity"])
        direction = pos["direction"]

        if direction == "BUY":
            gross_pnl_usd = (curr_price_usd - entry_usd) * qty
        else:
            gross_pnl_usd = (entry_usd - curr_price_usd) * qty

        gross_pnl_inr = gross_pnl_usd * pos_hr
        entry_fee, exit_fee, total_charges = self.calculate_trade_charges(entry_usd * pos_hr, curr_price_usd * pos_hr, qty)
        net_pnl_inr = gross_pnl_inr - total_charges

        return (
            round(gross_pnl_usd, 4),
            round(gross_pnl_inr, 2),
            round(entry_fee, 2),
            round(exit_fee, 2),
            round(total_charges, 2),
            round(net_pnl_inr, 2)
        )

    def determine_1m_directional_entry(
        self,
        curr_price_usd: float,
        price_history_override: Optional[List[Tuple[float, float]]] = None
    ) -> str:
        """
        Determines entry direction strictly based on previous 1-minute BTC price movement:
        - 1-min BTC price UP -> LONG ('BUY')
        - 1-min BTC price DOWN -> SHORT ('SELL')
        - 1-min BTC price FLAT/UNCHANGED -> 'SKIP' (no entry for this opportunity)
        """
        now_ts = time.time()
        history = price_history_override if price_history_override is not None else self.price_history_1m

        # Look for recorded price closest to ~60 seconds ago (between 45s and 120s ago)
        past_prices = [p for ts, p in history if 45 <= (now_ts - ts) <= 120]
        if past_prices:
            price_60s_ago = past_prices[-1]
            diff = curr_price_usd - price_60s_ago
            if diff > 0.05:
                return "BUY"
            elif diff < -0.05:
                return "SELL"
            else:
                return "SKIP"

        # Fallback if buffer does not have 60s history yet: try fetching 1-minute candle
        try:
            url = "https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=2"
            resp = requests.get(url, timeout=3)
            if resp.status_code == 200:
                klines = resp.json()
                if len(klines) >= 1:
                    last_kline = klines[-1]
                    open_p = float(last_kline[1])
                    close_p = float(last_kline[4])
                    if close_p > open_p:
                        return "BUY"
                    elif close_p < open_p:
                        return "SELL"
                    else:
                        return "SKIP"
        except Exception:
            pass

        return "SKIP"

    def auto_reconcile_active_positions(self) -> List[Dict[str, Any]]:
        """Queries local DB for active paper test positions."""
        db_positions = DB.load_active_bitcoin_live5_positions()
        self.active_positions = sorted(db_positions, key=lambda x: x.get("slot_index", 1))
        return self.active_positions

    def get_dashboard_state(self) -> Dict[str, Any]:
        """Prepares comprehensive JSON state payload for /bitcoin/live5 paper test dashboard."""
        curr_price_usd, hedge_rate, price_source = self.fetch_mudrex_futures_market_data()
        active_pos_list = self.auto_reconcile_active_positions()

        total_gross_pnl = 0.0
        total_estimated_fees = 0.0
        total_net_pnl = 0.0
        total_used_margin = 0.0

        slots = []
        pos_by_slot = {}
        for i, p in enumerate(active_pos_list):
            s_val = p.get("slot_index")
            try:
                s_key = int(s_val) if s_val is not None else (i + 1)
            except Exception:
                s_key = i + 1
            pos_by_slot[s_key] = p

        btc_inr_val = round((curr_price_usd * hedge_rate), 2) if (curr_price_usd and curr_price_usd > 0) else 0.0
        now_ts = time.time()

        for slot_idx in range(1, self.max_positions + 1):
            pos = pos_by_slot.get(slot_idx)
            if pos and pos.get("status") == "OPEN":
                g_usd, g_inr, ef, xf, total_chg, net_inr = self.calculate_live_position_pnl(pos, curr_price_usd, hedge_rate)
                lev = pos.get("leverage", self.default_leverage)
                margin_req = round(((pos["entry_price_usd"] * hedge_rate * pos["quantity"]) / lev), 2)
                
                total_gross_pnl += g_inr
                total_estimated_fees += total_chg
                total_net_pnl += net_inr
                total_used_margin += margin_req

                # Calculate holding age and remaining seconds
                entry_dt_str = pos.get("entry_timestamp", "")
                try:
                    entry_dt = datetime.strptime(entry_dt_str, "%Y-%m-%d %H:%M:%S")
                    holding_seconds = int((datetime.now() - entry_dt).total_seconds())
                except Exception:
                    holding_seconds = 0

                remaining_seconds = max(0, self.max_holding_time_seconds - holding_seconds)
                age_mm = holding_seconds // 60
                age_ss = holding_seconds % 60
                rem_mm = remaining_seconds // 60
                rem_ss = remaining_seconds % 60

                slots.append({
                    "slot_index": slot_idx,
                    "status": "OPEN",
                    "position": pos,
                    "gross_pnl": g_inr,
                    "entry_charges": ef,
                    "exit_charges": xf,
                    "charges": total_chg,
                    "net_pnl": net_inr,
                    "initial_margin": margin_req,
                    "current_price_usd": curr_price_usd,
                    "current_price_inr": btc_inr_val,
                    "holding_time_str": f"{age_mm:02d}:{age_ss:02d} / 05:00",
                    "remaining_time_str": f"{rem_mm:02d}:{rem_ss:02d}",
                    "holding_seconds": holding_seconds
                })
            else:
                slots.append({
                    "slot_index": slot_idx,
                    "status": "EMPTY",
                    "position": None,
                    "gross_pnl": 0.0,
                    "charges": 0.0,
                    "net_pnl": 0.0,
                    "initial_margin": 0.0,
                    "holding_time_str": "00:00 / 05:00",
                    "remaining_time_str": "05:00"
                })

        test_used_margin = round(total_used_margin, 2)
        test_free_buffer = round(self.test_capital_reference - test_used_margin, 2)
        all_trades = DB.load_all_bitcoin_live5_trades()

        # Compute summary test statistics
        closed_trades = [t for t in all_trades if t.get("status") == "CLOSED"]
        total_test_trades = len(closed_trades)
        winning_trades = len([t for t in closed_trades if float(t.get("net_pnl", 0.0)) > 0])
        losing_trades = len([t for t in closed_trades if float(t.get("net_pnl", 0.0)) < 0])
        time_exits = len([t for t in closed_trades if "5-MINUTE TIME EXIT" in str(t.get("exit_reason", "")) or "10-MINUTE TIME EXIT" in str(t.get("exit_reason", ""))])
        win_rate = round((winning_trades / total_test_trades * 100.0), 1) if total_test_trades > 0 else 0.0
        
        realized_pnl = sum([float(t.get("net_pnl", 0.0)) for t in closed_trades])
        total_test_pnl = round(realized_pnl + total_net_pnl, 2)

        return {
            "title": "BTC 6-BASKET SAME-PRICE TEST",
            "btc_price": btc_inr_val,
            "mudrex_btc_usd_price": round(curr_price_usd, 2) if curr_price_usd else 0.0,
            "mudrex_hedge_rate": round(hedge_rate, 2) if hedge_rate else 102.0,
            "price_source": price_source,
            "test_mode": True,
            "real_orders": "DISABLED",
            "test_status": self.test_status,
            "scanner_status": "3-LONG + 3-SHORT BASKET ACTIVE" if self.test_status == "RUNNING" else "TEST PAUSED",
            "test_capital": self.test_capital_reference,
            "used_margin": test_used_margin,
            "free_margin": test_free_buffer,
            "active_positions_count": len([s for s in slots if s["status"] == "OPEN"]),
            "max_positions": self.max_positions,
            "total_unrealized_gross_pnl": round(total_gross_pnl, 2),
            "total_estimated_fees": round(total_estimated_fees, 2),
            "total_unrealized_net_pnl": round(total_net_pnl, 2),
            "realized_test_pnl": round(realized_pnl, 2),
            "total_test_pnl": total_test_pnl,
            "per_trade_profit_target_inr": self.per_trade_profit_target_inr,
            "per_trade_loss_limit_inr": self.per_trade_loss_limit_inr,
            "default_quantity": self.default_quantity,
            "default_leverage": self.default_leverage,
            "live_trading_enabled": False, # ALWAYS FALSE IN PAPER TEST
            "slots": slots,
            "trade_history": all_trades,
            "statistics": {
                "total_trades": total_test_trades,
                "winning_trades": winning_trades,
                "losing_trades": losing_trades,
                "time_exits": time_exits,
                "win_rate": win_rate,
                "realized_pnl": round(realized_pnl, 2),
                "total_test_pnl": total_test_pnl
            },
            "evaluation_stream": self.evaluation_stream[:25],
            "latest_evaluation": self.last_evaluation
        }

    def close_single_position(self, pos: Dict[str, Any], exit_reason: str = "MANUAL EXIT") -> Dict[str, Any]:
        """Safely closes a single paper test position and updates DB."""
        trade_id = pos.get("trade_id")
        if not trade_id:
            return {"success": False, "error": "Missing trade_id"}

        curr_price_usd, hedge_rate, _ = self.fetch_mudrex_futures_market_data()
        pos_hr = float(pos.get("hedge_rate") or hedge_rate or 102.0)
        entry_usd = float(pos.get("entry_price_usd") or (pos["entry_price"] / pos_hr))
        curr_usd = curr_price_usd or entry_usd

        gross_usd, gross_inr, entry_fee, exit_fee, total_chg, net_pnl = self.calculate_live_position_pnl(pos, curr_usd, pos_hr)

        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        pos["status"] = "CLOSED"
        pos["exit_timestamp"] = now_str
        pos["exit_price_usd"] = curr_usd
        pos["exit_price"] = round(curr_usd * pos_hr, 2)
        pos["exit_reason"] = exit_reason
        pos["gross_pnl"] = round(gross_inr, 2)
        pos["entry_charges"] = round(entry_fee, 2)
        pos["exit_charges"] = round(exit_fee, 2)
        pos["charges"] = round(total_chg, 2)
        pos["net_pnl"] = round(net_pnl, 2)

        DB.save_bitcoin_live5_trade(pos)
        self.today_realized_pnl += net_pnl
        self.save_settings()

        self.active_positions = [p for p in self.active_positions if p.get("trade_id") != trade_id]
        print(f"[{datetime.now()}] [5-LIVE PAPER EXIT] Position {trade_id} (Slot {pos.get('slot_index')}) CLOSED ({exit_reason})! NET P&L: Rs.{net_pnl:,.2f}")
        return {"success": True, "trade": pos}

    def emergency_close_all_positions(self) -> Dict[str, Any]:
        """Master Emergency Control: Closes ALL active 5-live paper test positions."""
        active = DB.load_active_bitcoin_live5_positions()
        results = []
        for pos in active:
            res = self.close_single_position(pos, exit_reason="EMERGENCY CLOSE ALL")
            results.append(res)
        return {"success": True, "closed_count": len(results), "details": results}

    def reset_paper_test(self) -> Dict[str, Any]:
        """Resets paper test engine state and trades without affecting existing live engine."""
        with DB._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM bitcoin_live5_trades")
            conn.commit()
        
        self.today_realized_pnl = 0.0
        self.save_settings()
        self.active_positions = []
        self.last_entry_time = 0.0
        self.last_signal_action = ""
        self.last_api_status = "PAPER TEST RESET COMPLETED"
        print(f"[{datetime.now()}] [5-LIVE PAPER TEST RESET] Cleared paper trades DB!")
        return {"success": True, "message": "Paper test state reset successfully"}

    def update_risk_settings(
        self,
        per_trade_limit: Optional[float] = None,
        profit_target: Optional[float] = None,
        max_positions: Optional[int] = None,
        quantity: Optional[float] = None,
        leverage: Optional[float] = None
    ):
        """Updates configurable paper test settings."""
        if per_trade_limit is not None and per_trade_limit > 0:
            self.per_trade_loss_limit_inr = float(per_trade_limit)
        if profit_target is not None and profit_target > 0:
            self.per_trade_profit_target_inr = float(profit_target)
        if max_positions is not None and 1 <= max_positions <= 6:
            self.max_positions = int(max_positions)
        if quantity is not None and quantity >= 0.001:
            self.default_quantity = float(quantity)
        if leverage is not None and 1.0 <= leverage <= 20.0:
            self.default_leverage = float(leverage)
            
        self.save_settings()

    def process_tick(self):
        """Main 5-slot rolling paper test engine tick."""
        try:
            if self.test_status != "RUNNING":
                return

            curr_price_usd, hedge_rate, price_source = self.fetch_mudrex_futures_market_data()
            if curr_price_usd is None or curr_price_usd <= 0:
                return

            curr_price_inr = round(curr_price_usd * hedge_rate, 2)
            candles = BITCOIN_FEED.fetch_historical_candles("5m", "5d")
            eval_res = BITCOIN_STRATEGY.evaluate_market(candles, curr_price_inr)
            self.last_evaluation = eval_res

            # Log evaluation stream
            ist_tz = timezone(timedelta(hours=5, minutes=30))
            now_ist_str = datetime.now(ist_tz).strftime("%Y-%m-%d %H:%M:%S")
            reasons_str = " | ".join(eval_res.get("reasons", [])) if eval_res.get("reasons") else "Scanning market..."
            self.evaluation_stream.insert(0, {
                "timestamp": now_ist_str,
                "price": curr_price_inr,
                "price_usd": curr_price_usd,
                "action": eval_res.get("action", "WAIT"),
                "confidence": eval_res.get("confidence", 50),
                "reasons": reasons_str,
                "ema9": eval_res.get("ema9", curr_price_inr),
                "ema21": eval_res.get("ema21", curr_price_inr),
                "ema50": eval_res.get("ema50", curr_price_inr),
                "rsi": eval_res.get("rsi", 50.0)
            })
            if len(self.evaluation_stream) > 50:
                self.evaluation_stream = self.evaluation_stream[:50]

            # 1. EVALUATE EXITS FOR ALL ACTIVE OPEN POSITIONS INDEPENDENTLY
            active_list = DB.load_active_bitcoin_live5_positions()
            now_dt = datetime.now()

            for pos in active_list:
                g_usd, g_inr, ef, xf, total_chg, net_pnl = self.calculate_live_position_pnl(pos, curr_price_usd, hedge_rate)
                tp_usd = float(pos.get("target_usd") or 0.0)
                sl_usd = float(pos.get("stop_loss_usd") or 0.0)
                direction = pos.get("direction", "BUY")

                tp_hit = (net_pnl >= self.per_trade_profit_target_inr) or ((curr_price_usd >= tp_usd) if (direction == "BUY" and tp_usd > 0) else (curr_price_usd <= tp_usd if tp_usd > 0 else False))
                sl_hit = (net_pnl <= -self.per_trade_loss_limit_inr) or ((curr_price_usd <= sl_usd) if (direction == "BUY" and sl_usd > 0) else (curr_price_usd >= sl_usd if sl_usd > 0 else False))

                # Check 10-Minute Maximum Holding Time Exit
                holding_seconds = 0
                try:
                    entry_dt = datetime.strptime(pos.get("entry_timestamp", ""), "%Y-%m-%d %H:%M:%S")
                    holding_seconds = (now_dt - entry_dt).total_seconds()
                except Exception:
                    holding_seconds = 0

                time_exit_hit = (self.enable_time_exit and holding_seconds >= self.max_holding_time_seconds)

                if tp_hit:
                    reason = f"PROFIT TARGET +Rs.{int(self.per_trade_profit_target_inr)} NET"
                    print(f"[{datetime.now()}] [5-LIVE PAPER EXIT] Slot {pos.get('slot_index')} Net P&L Rs.{net_pnl:,.2f} >= Target +Rs.{self.per_trade_profit_target_inr:,.2f}!")
                    self.close_single_position(pos, exit_reason=reason)
                elif sl_hit:
                    reason = f"MAX LOSS -Rs.{int(self.per_trade_loss_limit_inr)} NET"
                    print(f"[{datetime.now()}] [5-LIVE PAPER EXIT] Slot {pos.get('slot_index')} Net P&L Rs.{net_pnl:,.2f} <= Loss Limit -Rs.{self.per_trade_loss_limit_inr:,.2f}!")
                    self.close_single_position(pos, exit_reason=reason)
                elif time_exit_hit:
                    reason = f"5-MINUTE TIME EXIT ({int(holding_seconds)}s)"
                    print(f"[{datetime.now()}] [5-LIVE PAPER EXIT] Slot {pos.get('slot_index')} time exit triggered.")
                    self.close_single_position(pos, exit_reason=reason)

            # 2. EVALUATE AUTOMATIC PER-SLOT ENTRY & AUTO REPLACEMENT (OPEN NEW BID IMMEDIATELY AS SOON AS ANY BID ENDS)
            active_pos_list = DB.load_active_bitcoin_live5_positions()
            occupied_slots = {p.get("slot_index") for p in active_pos_list}

            qty = self.default_quantity
            lev = self.default_leverage
            single_margin = (qty * curr_price_inr) / lev
            now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

            basket_directions = {
                1: "BUY",
                2: "BUY",
                3: "BUY",
                4: "SELL",
                5: "SELL",
                6: "SELL"
            }

            for slot_idx in range(1, self.max_positions + 1):
                if slot_idx not in occupied_slots:
                    direction = basket_directions.get(slot_idx, "BUY" if slot_idx <= 3 else "SELL")
                    tp_usd, sl_usd, tp_val, sl_val, est_chg = self.calculate_sl_and_target_prices(direction, curr_price_usd, qty, hedge_rate)

                    ts_ms = int(time.time() * 1000)
                    trade_id = f"PAPER_BTC6_POS_{ts_ms}_SLOT_{slot_idx}"
                    pos_dict = {
                        "trade_id": trade_id,
                        "mudrex_position_id": f"PAPER_POS_{ts_ms}_{slot_idx}",
                        "slot_index": slot_idx,
                        "entry_timestamp": now_str,
                        "symbol": "BTCUSDT",
                        "direction": direction,
                        "quantity": qty,
                        "entry_price": curr_price_inr,
                        "entry_price_usd": curr_price_usd,
                        "hedge_rate": hedge_rate,
                        "stop_loss": sl_val,
                        "stop_loss_usd": sl_usd,
                        "target": tp_val,
                        "target_usd": tp_usd,
                        "trend_state": "AUTO_REPLACEMENT",
                        "confidence": 100,
                        "reasons": [f"Auto-replacement on bid end ({direction})"],
                        "status": "OPEN",
                        "exit_timestamp": None,
                        "exit_price": None,
                        "exit_reason": None,
                        "gross_pnl": 0.0,
                        "entry_charges": round(curr_price_inr * qty * self.TAKER_FEE_RATE, 2),
                        "exit_charges": 0.0,
                        "charges": round(est_chg, 2),
                        "net_pnl": 0.0,
                        "leverage": lev,
                        "initial_margin": round(single_margin, 2)
                    }
                    DB.save_bitcoin_live5_trade(pos_dict)
                    print(f"[{datetime.now()}] [6-BASKET AUTO REPLACEMENT] Slot {slot_idx}: {direction} {qty} BTC @ ${curr_price_usd:,.2f} (Rs.{curr_price_inr:,.2f})")

            self.active_positions = DB.load_active_bitcoin_live5_positions()
            self.last_api_status = f"RUNNING • Active Basket: {len(self.active_positions)}/{self.max_positions} slots"

        except Exception as e:
            print(f"[{datetime.now()}] [5-LIVE PAPER ENGINE TICK ERROR] {e}")

    async def start_feed_loop(self):
        """Continuous background loop for 5-live paper test engine."""
        self.is_running = True
        print(f"[{datetime.now()}] [BITCOIN 5-LIVE PAPER TEST ENGINE] Background loop started.")
        while self.is_running:
            try:
                self.process_tick()
            except Exception as e:
                print(f"[{datetime.now()}] [BITCOIN 5-LIVE PAPER LOOP ERROR] {e}")
            await asyncio.sleep(3)

# Global Instance for 5-Live Engine
BITCOIN_LIVE5_ENGINE = BitcoinLive5Engine()
