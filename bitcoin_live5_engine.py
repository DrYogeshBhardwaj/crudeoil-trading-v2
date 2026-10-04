"""
BITCOIN 5-LIVE MULTI-POSITION AUTOMATED TRADING ENGINE
======================================================
Dedicated multi-position execution engine supporting up to 5 independent simultaneous BTCUSDT futures positions.
Uses Mudrex REST API with 5x leverage, INR margin balance, dynamic taker fees, and authoritative position reconciliation.

STRICT ISOLATION:
Does NOT modify, share state with, or affect the single-position engine (/bitcoin/live).
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
    """Dedicated engine managing up to 5 simultaneous independent BTC live trading positions."""

    TAKER_FEE_RATE = 0.0005 # 0.05% taker fee per side

    def __init__(self):
        self.adapter = MudrexLiveAdapter()
        self.load_settings()
        self.active_positions: List[Dict[str, Any]] = []
        self.is_running = False
        self.last_api_status = "INITIALIZED"
        self.last_signal_time = 0.0
        self.last_signal_action = ""

    def load_settings(self):
        """Loads persistent 5-live risk, margin, and position limits from SQLite DB."""
        saved_enable = DB.load_bitcoin_live5_setting("live_trading_enabled", "FALSE")
        # SAFETY LOCK: Real 5-live execution disabled by default until user explicit approval
        self.live_trading_enabled = (saved_enable.upper() == "TRUE")

        self.today_date = datetime.now().strftime("%Y-%m-%d")
        saved_date = DB.load_bitcoin_live5_setting("today_date", self.today_date)
        
        if saved_date != self.today_date:
            DB.save_bitcoin_live5_setting("today_date", self.today_date)
            DB.save_bitcoin_live5_setting("daily_loss_limit_hit", "FALSE")
            DB.save_bitcoin_live5_setting("today_realized_pnl", "0.0")

        self.max_positions = int(DB.load_bitcoin_live5_setting("max_positions", "5"))
        self.default_quantity = float(DB.load_bitcoin_live5_setting("default_quantity", "0.002"))
        self.default_leverage = float(DB.load_bitcoin_live5_setting("default_leverage", "5.0"))
        
        self.per_trade_profit_target_inr = float(DB.load_bitcoin_live5_setting("per_trade_profit_target_inr", "100.0"))
        self.per_trade_loss_limit_inr = float(DB.load_bitcoin_live5_setting("per_trade_loss_limit_inr", "200.0"))
        self.daily_loss_limit_inr = float(DB.load_bitcoin_live5_setting("daily_loss_limit_inr", "1000.0"))

        DB.save_bitcoin_live5_setting("max_positions", str(self.max_positions))
        DB.save_bitcoin_live5_setting("default_quantity", str(self.default_quantity))
        DB.save_bitcoin_live5_setting("default_leverage", str(self.default_leverage))
        DB.save_bitcoin_live5_setting("per_trade_profit_target_inr", str(self.per_trade_profit_target_inr))
        DB.save_bitcoin_live5_setting("per_trade_loss_limit_inr", str(self.per_trade_loss_limit_inr))

        self.circuit_breaker_tripped = DB.load_bitcoin_live5_setting("circuit_breaker_tripped", "FALSE").upper() == "TRUE"
        self.circuit_breaker_reason = DB.load_bitcoin_live5_setting("circuit_breaker_reason", "")
        self.daily_loss_limit_hit = DB.load_bitcoin_live5_setting("daily_loss_limit_hit", "FALSE").upper() == "TRUE"
        self.today_realized_pnl = float(DB.load_bitcoin_live5_setting("today_realized_pnl", "0.0"))

        self.consecutive_api_failures = 0
        self.last_evaluation = {}
        self.evaluation_stream = []

    def save_settings(self):
        """Persists current 5-live settings to SQLite DB."""
        DB.save_bitcoin_live5_setting("live_trading_enabled", "TRUE" if self.live_trading_enabled else "FALSE")
        DB.save_bitcoin_live5_setting("max_positions", str(self.max_positions))
        DB.save_bitcoin_live5_setting("default_quantity", str(self.default_quantity))
        DB.save_bitcoin_live5_setting("default_leverage", str(self.default_leverage))
        DB.save_bitcoin_live5_setting("per_trade_profit_target_inr", str(self.per_trade_profit_target_inr))
        DB.save_bitcoin_live5_setting("per_trade_loss_limit_inr", str(self.per_trade_loss_limit_inr))
        DB.save_bitcoin_live5_setting("daily_loss_limit_inr", str(self.daily_loss_limit_inr))
        DB.save_bitcoin_live5_setting("today_realized_pnl", str(round(self.today_realized_pnl, 2)))
        DB.save_bitcoin_live5_setting("circuit_breaker_tripped", "TRUE" if self.circuit_breaker_tripped else "FALSE")
        DB.save_bitcoin_live5_setting("circuit_breaker_reason", self.circuit_breaker_reason)
        DB.save_bitcoin_live5_setting("daily_loss_limit_hit", "TRUE" if self.daily_loss_limit_hit else "FALSE")

    def fetch_mudrex_futures_market_data(self) -> Tuple[Optional[float], Optional[float], str]:
        """Fetches authoritative BTCUSDT price feed from Mudrex/Binance Futures."""
        try:
            url = "https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT"
            resp = requests.get(url, timeout=4)
            if resp.status_code == 200:
                data = resp.json()
                price_usd = float(data["price"])
                self.consecutive_api_failures = 0
                return price_usd, 102.0, "Binance Futures/Spot API (BTCUSDT USD)"
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
        """
        Calculates exact target_usd, stop_loss_usd, target_inr, stop_loss_inr for a 5-live position.
        Uses per-position net profit target and loss limit.
        """
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

    def auto_reconcile_active_positions(self) -> List[Dict[str, Any]]:
        """
        Queries local DB and Mudrex open positions for 5-live.
        Ensures all open positions have unique slot_index (1 to 5) and valid trade records.
        """
        db_positions = DB.load_active_bitcoin_live5_positions()
        
        # If DB already has active positions, map them
        active_map = {p["mudrex_position_id"]: p for p in db_positions if p.get("mudrex_position_id")}
        
        # Fetch open positions from exchange
        m_positions = self.adapter.fetch_open_positions()
        if not isinstance(m_positions, list):
            m_positions = []

        reconciled_list = []
        used_slots = set()

        for p in db_positions:
            used_slots.add(p.get("slot_index", 1))
            reconciled_list.append(p)

        for m_pos in m_positions:
            pos_id = m_pos.get("position_id") or m_pos.get("id")
            if not pos_id:
                continue

            if pos_id in active_map:
                continue

            # Assign first available slot_index (1 to 5)
            avail_slot = 1
            for s in range(1, self.max_positions + 1):
                if s not in used_slots:
                    avail_slot = s
                    break

            pos_id_clean = str(pos_id).replace("-", "")
            trade_id = f"BTC_LIVE5_{pos_id_clean[:8]}"
            entry_usd = float(m_pos.get("entry_price") or m_pos.get("avg_price") or 85866.40)
            qty = float(m_pos.get("quantity") or m_pos.get("size") or self.default_quantity)
            direction = "BUY" if str(m_pos.get("side") or m_pos.get("order_type") or m_pos.get("direction") or "LONG").upper() in ("BUY", "LONG") else "SELL"
            pos_hr = float(m_pos.get("hedge_rate") or 102.0)
            lev = float(m_pos.get("leverage") or self.default_leverage)

            tp_usd, sl_usd, tp_inr, sl_inr, est_chg = self.calculate_sl_and_target_prices(direction, entry_usd, qty, pos_hr)
            init_margin = round((entry_usd * pos_hr * qty) / lev, 2)

            rec = {
                "trade_id": trade_id,
                "mudrex_position_id": pos_id,
                "slot_index": avail_slot,
                "entry_timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "symbol": "BTCUSDT",
                "direction": direction,
                "quantity": qty,
                "entry_price": round(entry_usd * pos_hr, 2),
                "entry_price_usd": entry_usd,
                "hedge_rate": pos_hr,
                "target_usd": tp_usd,
                "stop_loss_usd": sl_usd,
                "target": tp_inr,
                "stop_loss": sl_inr,
                "trend_state": "BULLISH" if direction == "BUY" else "BEARISH",
                "confidence": 85,
                "reasons": ["Reconciled Live Mudrex Position"],
                "status": "OPEN",
                "charges": est_chg,
                "leverage": lev,
                "initial_margin": init_margin
            }
            DB.save_bitcoin_live5_trade(rec)
            used_slots.add(avail_slot)
            reconciled_list.append(rec)

        self.active_positions = sorted(reconciled_list, key=lambda x: x.get("slot_index", 1))
        return self.active_positions

    def get_dashboard_state(self) -> Dict[str, Any]:
        """Prepares comprehensive JSON state payload for /bitcoin/live5 dashboard."""
        curr_price_usd, hedge_rate, price_source = self.fetch_mudrex_futures_market_data()
        
        active_pos_list = self.auto_reconcile_active_positions()
        spot_bal = self.adapter.fetch_spot_balance()
        fut_bal = self.adapter.fetch_futures_balance()

        total_gross_pnl = 0.0
        total_estimated_fees = 0.0
        total_net_pnl = 0.0
        total_used_margin = 0.0

        # Map active positions to 5 slots
        slots = []
        pos_by_slot = {p.get("slot_index", i+1): p for i, p in enumerate(active_pos_list)}

        btc_inr_val = round((curr_price_usd * hedge_rate), 2) if (curr_price_usd and curr_price_usd > 0) else 0.0

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
                    "current_price_inr": btc_inr_val
                })
            else:
                slots.append({
                    "slot_index": slot_idx,
                    "status": "EMPTY",
                    "position": None,
                    "gross_pnl": 0.0,
                    "charges": 0.0,
                    "net_pnl": 0.0,
                    "initial_margin": 0.0
                })

        free_margin = round(fut_bal, 2)
        total_capital = round(fut_bal + total_used_margin, 2)

        all_trades = DB.load_all_bitcoin_live5_trades()

        return {
            "btc_price": btc_inr_val,
            "mudrex_btc_usd_price": round(curr_price_usd, 2) if curr_price_usd else 0.0,
            "mudrex_hedge_rate": round(hedge_rate, 2) if hedge_rate else 102.0,
            "price_source": price_source,
            "scanner_status": "SCANNING FOR SIGNALS" if self.live_trading_enabled else "SAFETY LOCK ENABLED — REAL TRADING DISABLED",
            "total_capital": total_capital,
            "used_margin": round(total_used_margin, 2),
            "free_margin": free_margin,
            "active_positions_count": len([s for s in slots if s["status"] == "OPEN"]),
            "max_positions": self.max_positions,
            "total_unrealized_gross_pnl": round(total_gross_pnl, 2),
            "total_estimated_fees": round(total_estimated_fees, 2),
            "total_unrealized_net_pnl": round(total_net_pnl, 2),
            "today_realized_pnl": round(self.today_realized_pnl, 2),
            "per_trade_profit_target_inr": self.per_trade_profit_target_inr,
            "per_trade_loss_limit_inr": self.per_trade_loss_limit_inr,
            "default_quantity": self.default_quantity,
            "default_leverage": self.default_leverage,
            "live_trading_enabled": self.live_trading_enabled,
            "circuit_breaker": "TRIPPED" if self.circuit_breaker_tripped else "NORMAL",
            "circuit_breaker_reason": self.circuit_breaker_reason if self.circuit_breaker_tripped else None,
            "mudrex_api_status": "AUTHENTICATED" if self.adapter.test_authentication().get("success") else "DISCONNECTED",
            "slots": slots,
            "trade_history": all_trades,
            "evaluation_stream": self.evaluation_stream[:25],
            "latest_evaluation": self.last_evaluation
        }

    def close_single_position(self, pos: Dict[str, Any], exit_reason: str = "MANUAL EXIT") -> Dict[str, Any]:
        """
        Safely closes a single open 5-live position on Mudrex and updates DB.
        """
        pos_id = pos.get("mudrex_position_id")
        trade_id = pos.get("trade_id")
        direction = pos.get("direction", "BUY")
        qty = float(pos.get("quantity", self.default_quantity))

        if not pos_id:
            return {"success": False, "error": "Missing mudrex_position_id"}

        close_res = self.adapter.close_position_safely(
            position_id=pos_id,
            symbol="BTCUSDT",
            quantity=qty,
            direction=direction
        )

        if not close_res.get("success"):
            err_msg = close_res.get("error", "Failed to close on Mudrex")
            print(f"[{datetime.now()}] [MUDREX CLOSE FAILED 5-LIVE] Position {pos_id} failed to close: {err_msg}")
            return {"success": False, "error": err_msg}

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

        # Remove from active positions list
        self.active_positions = [p for p in self.active_positions if p.get("trade_id") != trade_id]

        print(f"[{datetime.now()}] [BITCOIN 5-LIVE ENGINE] Position {trade_id} (Slot {pos.get('slot_index')}) CLOSED ({exit_reason})! NET P&L: Rs.{net_pnl:,.2f}")
        return {"success": True, "trade": pos, "mudrex_response": close_res}

    def emergency_close_all_positions(self) -> Dict[str, Any]:
        """Master Emergency Control: Closes ALL active 5-live open positions cleanly."""
        active = DB.load_active_bitcoin_live5_positions()
        results = []
        for pos in active:
            res = self.close_single_position(pos, exit_reason="EMERGENCY CLOSE ALL")
            results.append(res)
        return {"success": True, "closed_count": len(results), "details": results}

    def update_risk_settings(
        self,
        per_trade_limit: Optional[float] = None,
        profit_target: Optional[float] = None,
        max_positions: Optional[int] = None,
        quantity: Optional[float] = None,
        leverage: Optional[float] = None
    ):
        """Updates user-configurable risk & position parameters."""
        if per_trade_limit is not None and per_trade_limit > 0:
            self.per_trade_loss_limit_inr = float(per_trade_limit)
        if profit_target is not None and profit_target > 0:
            self.per_trade_profit_target_inr = float(profit_target)
        if max_positions is not None and 1 <= max_positions <= 5:
            self.max_positions = int(max_positions)
        if quantity is not None and quantity >= 0.001:
            self.default_quantity = float(quantity)
        if leverage is not None and 1.0 <= leverage <= 20.0:
            self.default_leverage = float(leverage)
            
        self.save_settings()

    def process_tick(self):
        """Main 5-live engine evaluation tick."""
        try:
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
            for pos in active_list:
                g_usd, g_inr, ef, xf, total_chg, net_pnl = self.calculate_live_position_pnl(pos, curr_price_usd, hedge_rate)
                tp_usd = float(pos.get("target_usd") or 0.0)
                sl_usd = float(pos.get("stop_loss_usd") or 0.0)
                direction = pos.get("direction", "BUY")

                tp_hit = (net_pnl >= self.per_trade_profit_target_inr) or ((curr_price_usd >= tp_usd) if (direction == "BUY" and tp_usd > 0) else (curr_price_usd <= tp_usd if tp_usd > 0 else False))
                sl_hit = (net_pnl <= -self.per_trade_loss_limit_inr) or ((curr_price_usd <= sl_usd) if (direction == "BUY" and sl_usd > 0) else (curr_price_usd >= sl_usd if sl_usd > 0 else False))

                if tp_hit:
                    reason = f"PROFIT TARGET +Rs.{int(self.per_trade_profit_target_inr)} NET"
                    print(f"[{datetime.now()}] [5-LIVE EXIT TRIGGER] Position Slot {pos.get('slot_index')} Net P&L Rs.{net_pnl:,.2f} >= Target +Rs.{self.per_trade_profit_target_inr:,.2f}! Executing close.")
                    self.close_single_position(pos, exit_reason=reason)
                elif sl_hit:
                    reason = f"LOSS LIMIT -Rs.{int(self.per_trade_loss_limit_inr)} NET"
                    print(f"[{datetime.now()}] [5-LIVE EXIT TRIGGER] Position Slot {pos.get('slot_index')} Net P&L Rs.{net_pnl:,.2f} <= Loss Limit -Rs.{self.per_trade_loss_limit_inr:,.2f}! Executing close.")
                    self.close_single_position(pos, exit_reason=reason)

            # 2. EVALUATE NEW POSITION ENTRY (IF ACTIVE POSITIONS < MAX POSITIONS)
            current_active_count = len(DB.load_active_bitcoin_live5_positions())
            if current_active_count >= self.max_positions:
                return

            action = eval_res.get("action", "WAIT")
            if action in ("BUY", "SELL"):
                now_ts = time.time()
                # Anti-duplicate entry filter: Prevent immediate repeated entries on same tick/signal
                if action == self.last_signal_action and (now_ts - self.last_signal_time) < 180:
                    return

                # CAPITAL SAFETY CHECK: Verify free margin from Mudrex
                fut_bal = self.adapter.fetch_futures_balance()
                effective_bal = fut_bal if fut_bal > 0 else 5000.0
                qty = self.default_quantity
                lev = self.default_leverage

                required_margin = (qty * curr_price_inr) / lev
                if fut_bal < required_margin and self.live_trading_enabled:
                    err_msg = f"INSUFFICIENT MARGIN: Available Rs.{fut_bal:,.2f} < Required Rs.{required_margin:,.2f} for {qty} BTC"
                    print(f"[{datetime.now()}] [MUDREX 5-LIVE ENTRY ABORTED] {err_msg}")
                    self.last_api_status = err_msg
                    return

                if not self.live_trading_enabled:
                    return

                tp_usd, sl_usd, tp_val, sl_val, est_chg = self.calculate_sl_and_target_prices(action, curr_price_usd, qty, hedge_rate)

                order_res = self.adapter.place_futures_order(
                    symbol="BTCUSDT",
                    side=action,
                    quantity=qty,
                    order_type="MARKET",
                    stoploss_price=sl_val
                )

                if not order_res.get("success"):
                    err_msg = order_res.get("error", "API error")
                    print(f"[{datetime.now()}] [MUDREX 5-LIVE ORDER REJECTED] {err_msg}")
                    self.last_api_status = f"ORDER REJECTED: {err_msg}"
                    return

                mudrex_data = order_res.get("data", {})
                if isinstance(mudrex_data, dict) and "data" in mudrex_data:
                    mudrex_data = mudrex_data["data"]

                order_id = str(mudrex_data.get("order_id") or mudrex_data.get("id") or "").strip()
                pos_id = str(mudrex_data.get("position_id") or mudrex_data.get("mudrex_position_id") or "").strip()

                if not order_id or not pos_id:
                    print(f"[{datetime.now()}] [MUDREX 5-LIVE ORDER REJECTED] Missing broker IDs!")
                    return

                # Assign slot_index
                active_pos_list = DB.load_active_bitcoin_live5_positions()
                used_slots = {p.get("slot_index", 1) for p in active_pos_list}
                avail_slot = 1
                for s in range(1, self.max_positions + 1):
                    if s not in used_slots:
                        avail_slot = s
                        break

                trade_id = f"BTC_LIVE5_{int(time.time())}"
                now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

                pos_dict = {
                    "trade_id": trade_id,
                    "mudrex_position_id": pos_id,
                    "slot_index": avail_slot,
                    "entry_timestamp": now_str,
                    "symbol": "BTCUSDT",
                    "direction": action,
                    "quantity": qty,
                    "entry_price": curr_price_inr,
                    "stop_loss": sl_val,
                    "stoploss_order_id": None,
                    "target": tp_val,
                    "trend_state": eval_res.get("trend", "NEUTRAL"),
                    "confidence": eval_res.get("confidence", 50),
                    "reasons": eval_res.get("reasons", []),
                    "status": "OPEN",
                    "exit_timestamp": None,
                    "exit_price": None,
                    "exit_reason": None,
                    "gross_pnl": 0.0,
                    "entry_charges": round(curr_price_inr * qty * self.TAKER_FEE_RATE, 2),
                    "exit_charges": 0.0,
                    "charges": round(est_chg, 2),
                    "net_pnl": 0.0,
                    "entry_price_usd": curr_price_usd,
                    "hedge_rate": hedge_rate,
                    "target_usd": tp_usd,
                    "stop_loss_usd": sl_usd,
                    "leverage": lev,
                    "initial_margin": round(required_margin, 2)
                }

                DB.save_bitcoin_live5_trade(pos_dict)
                self.last_signal_time = now_ts
                self.last_signal_action = action
                self.last_api_status = f"SLOT {avail_slot} ORDER EXECUTED"
                print(f"[{datetime.now()}] [MUDREX 5-LIVE REAL ORDER EXECUTED] Slot {avail_slot}: {action} {qty} BTC @ Rs.{curr_price_inr:,.2f}")

        except Exception as e:
            print(f"[{datetime.now()}] [BITCOIN 5-LIVE ENGINE TICK ERROR] {e}")

    async def start_feed_loop(self):
        """Continuous background loop for 5-live engine."""
        self.is_running = True
        print(f"[{datetime.now()}] [BITCOIN 5-LIVE ENGINE] Background loop started.")
        while self.is_running:
            try:
                self.process_tick()
            except Exception as e:
                print(f"[{datetime.now()}] [BITCOIN 5-LIVE LOOP ERROR] {e}")
            await asyncio.sleep(5)

# Global Instance for 5-Live Engine
BITCOIN_LIVE5_ENGINE = BitcoinLive5Engine()
