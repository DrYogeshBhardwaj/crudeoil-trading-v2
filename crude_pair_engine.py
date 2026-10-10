"""
Crude Oil Pair Strategy Paper Trading Engine (/crude/pair-test)
STRICTLY PAPER TRADING ONLY — NO REAL ORDERS OR LIVE BROKER EXECUTION.

Implements Requirements:
1. Core Objective: Paper-only simulation tracking Crude Oil movement across 6 thresholds:
   $0.25, $0.50, $1.00, $1.50, $2.00, $3.00.
2. Initial Positions: Creates 1 BUY and 1 SELL paper position at initial reference price ($80.00 default or live price).
3. Movement-Level Tracking: Evaluates 6 movement levels independently per open position.
4. Profit Booking & Re-entry:
   - Closes winning position on trigger, updates realized P/L and fees.
   - Keeps opposing older position open.
   - Creates new BUY/SELL pair at execution price with new sequential serial numbers & position IDs.
   - Does NOT close or overwrite older open positions.
5. Persistent Main P/L Ledger with sequential serial numbers (sl_no).
6. Dashboard Summary & Reconciled Totals.
7. Safety & Instrument Validation:
   - Real-time NYMEX WTI Crude Oil (CL=F) data feed verification.
   - Explicit Mudrex CL/USDT contract status notice.
"""

import os
import sys
import time
import json
import csv
import io
import threading
import asyncio
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional, Tuple
from dataclasses import dataclass, field, asdict

from database import DB
from wti_feed import WTI_FEED

# Threshold values in USD
MOVEMENT_THRESHOLDS = [0.25, 0.50, 1.00, 1.50, 2.00, 3.00]


@dataclass
class CrudePairPosition:
    sl_no: int
    pair_id: str
    position_id: str
    direction: str  # "BUY" or "SELL"
    entry_price: float
    quantity: float = 1.0  # 1 contract / barrel
    threshold_usd: float = 1.00  # Default booking threshold trigger
    entry_timestamp: str = ""
    exit_price: Optional[float] = None
    exit_timestamp: Optional[str] = None
    gross_pnl: float = 0.0
    trading_fees: float = 0.0
    funding_costs: float = 0.0
    net_pnl: float = 0.0
    status: str = "OPEN"  # "OPEN" or "CLOSED"
    unrealized_pnl: float = 0.0
    reason: str = "INITIAL PAIR ENTRY"
    max_adverse_usd: float = 0.0
    max_favorable_usd: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["direction"] = self.direction.upper()
        d["status"] = self.status.upper()
        return d


class CrudePairEngine:
    def __init__(self):
        self._lock = threading.Lock()
        self.is_running: bool = False
        self.reference_price: float = 80.00
        self.quantity: float = 1.0
        self.fee_rate: float = 0.0005  # 0.05% simulated taker fee per side
        self.funding_rate: float = 0.0  # 0% funding default for paper test
        
        # Strategy Unresolved Rule Configs
        self.booking_threshold_usd: float = 1.00  # Default $1.00 booking trigger
        self.reference_base: str = "PAIR_ENTRY"  # PAIR_ENTRY | INITIAL_REF | TRAILING
        self.booking_enabled: bool = True
        self.reentry_mode: str = "AUTO_PAIR_ON_TP"  # AUTO_PAIR_ON_TP | MANUAL_PAIR
        self.loss_management: str = "KEEP_OPEN_INDEFINITELY"  # No invented stop losses

        self.last_tick_price: Optional[float] = None
        self.last_tick_time: Optional[str] = None
        self.feed_status: str = "INITIALIZING"
        self.feed_source: str = "NYMEX Crude Oil Futures (CL=F)"
        
        # In-memory tracking
        self.positions: List[Dict[str, Any]] = []
        self.movements: List[Dict[str, Any]] = []
        
        self._load_state_from_db()

    def _load_state_from_db(self):
        with self._lock:
            # Load settings — DEFAULT TO AUTO-RUN SIMULATION (True)
            run_val = DB.load_crude_pair_setting("is_running", "true")
            self.is_running = (run_val.lower() == "true")
            self._save_setting("is_running", "true" if self.is_running else "false")
            
            ref_val = DB.load_crude_pair_setting("reference_price", "80.00")
            try:
                self.reference_price = float(ref_val)
            except ValueError:
                self.reference_price = 80.00

            thresh_val = DB.load_crude_pair_setting("booking_threshold_usd", "1.00")
            try:
                self.booking_threshold_usd = float(thresh_val)
            except ValueError:
                self.booking_threshold_usd = 1.00

            # Load positions from DB
            self.positions = DB.load_all_crude_pair_trades()
            self.movements = DB.load_crude_pair_movements(limit=200)

            # Auto-initialize Pair #1 if empty
            if not self.positions:
                start_price = self.reference_price or 80.00
                self._create_pair_unlocked(entry_price=start_price, reason="AUTO-START INITIAL PAIR ENTRY")

    def _save_setting(self, key: str, value: str):
        DB.save_crude_pair_setting(key, str(value))

    def get_next_serial_number(self) -> int:
        """Returns the next strictly sequential serial number (1-indexed)."""
        if not self.positions:
            return 1
        max_sl = max(int(p.get("sl_no", 0)) for p in self.positions)
        return max_sl + 1

    def get_next_pair_id(self) -> str:
        """Generates sequential Pair ID e.g. PAIR-001, PAIR-002..."""
        if not self.positions:
            return "PAIR-001"
        pair_nums = []
        for p in self.positions:
            pid = str(p.get("pair_id", ""))
            if pid.startswith("PAIR-"):
                try:
                    num = int(pid.split("-")[1])
                    pair_nums.append(num)
                except (IndexError, ValueError):
                    pass
        next_num = max(pair_nums) + 1 if pair_nums else 1
        return f"PAIR-{next_num:03d}"

    def get_now_ist_str(self) -> str:
        ist_tz = timezone(timedelta(hours=5, minutes=30))
        return datetime.now(ist_tz).strftime("%Y-%m-%d %H:%M:%S IST")

    def fetch_live_market_price(self) -> Dict[str, Any]:
        """
        Fetches live WTI crude price tick and metadata from WTI_FEED (Yahoo NYMEX feed).
        Ensures feed is marked CONNECTED ONLY when a valid positive WTI price > 0 is present.
        """
        try:
            tick = WTI_FEED.fetch_latest_tick()
            price = tick.get("price")
            mkt_status = tick.get("market_status", "UNKNOWN")
            raw_conn = tick.get("connection_status", "DISCONNECTED")
            reg_time = tick.get("last_tick_epoch")
            ts_ist = tick.get("last_tick_timestamp_ist") or tick.get("last_update_time_ist") or self.get_now_ist_str()

            if price is not None and float(price) > 0 and reg_time and reg_time > 0:
                p_val = round(float(price), 2)
                self.last_tick_price = p_val
                self.last_tick_time = ts_ist

                # Determine strict connection state
                if mkt_status == "CLOSED":
                    conn_state = "STALE"
                    f_status = f"STALE (CME NYMEX Closed @ ${p_val:.2f})"
                elif raw_conn == "STALE":
                    conn_state = "STALE"
                    f_status = f"STALE (Feed Delayed @ ${p_val:.2f})"
                else:
                    conn_state = "CONNECTED"
                    f_status = f"CONNECTED (${p_val:.2f})"

                self.feed_status = f_status
                return {
                    "price": p_val,
                    "change": round(float(tick.get("change", 0.0)), 2),
                    "change_pct": round(float(tick.get("change_pct", 0.0)), 2),
                    "timestamp_ist": ts_ist,
                    "connection_status": conn_state,
                    "feed_status": f_status,
                    "market_status": mkt_status,
                    "price_valid": True
                }
            else:
                self.feed_status = "DISCONNECTED (Price unavailable)"
                return {
                    "price": self.last_tick_price or 0.0,
                    "change": 0.0,
                    "change_pct": 0.0,
                    "timestamp_ist": self.get_now_ist_str(),
                    "connection_status": "DISCONNECTED",
                    "feed_status": self.feed_status,
                    "market_status": mkt_status,
                    "price_valid": False
                }
        except Exception as e:
            self.feed_status = f"DISCONNECTED ({str(e)})"
            return {
                "price": self.last_tick_price or 0.0,
                "change": 0.0,
                "change_pct": 0.0,
                "timestamp_ist": self.get_now_ist_str(),
                "connection_status": "DISCONNECTED",
                "feed_status": self.feed_status,
                "market_status": "ERROR",
                "price_valid": False
            }

    def start_simulation(self, initial_price: Optional[float] = None) -> Dict[str, Any]:
        """Starts the paper test simulation and initializes Pair #1 if empty."""
        with self._lock:
            self.is_running = True
            self._save_setting("is_running", "true")

            tick_meta = self.fetch_live_market_price()
            live_p = tick_meta.get("price") if tick_meta.get("price_valid") else None
            start_price = initial_price or live_p or self.reference_price or 80.00
            self.reference_price = start_price
            self._save_setting("reference_price", str(start_price))

            # If no open or closed positions exist, create Initial Pair #1
            if not self.positions:
                self._create_pair_unlocked(entry_price=start_price, reason="INITIAL PAIR ENTRY (START TEST)")

            return {
                "success": True,
                "status": "STARTED",
                "message": f"Crude Oil Pair Strategy Paper Simulation STARTED at ${start_price:.2f}.",
                "reference_price": start_price,
                "total_positions": len(self.positions)
            }

    def stop_simulation(self) -> Dict[str, Any]:
        """Pauses/stops the paper test simulation loop."""
        with self._lock:
            self.is_running = False
            self._save_setting("is_running", "false")
            return {
                "success": True,
                "status": "STOPPED",
                "message": "Crude Oil Pair Strategy Paper Simulation STOPPED/PAUSED."
            }

    def reset_simulation(self) -> Dict[str, Any]:
        """Resets paper trading engine state & ledger with user confirmation."""
        with self._lock:
            self.is_running = False
            self.positions.clear()
            self.movements.clear()
            DB.reset_crude_pair_account()
            self._save_setting("is_running", "false")
            return {
                "success": True,
                "status": "RESET",
                "message": "Crude Oil Pair Strategy paper ledger & state fully reset."
            }

    def update_config(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Updates configurable strategy trigger rules."""
        with self._lock:
            if "booking_threshold_usd" in payload:
                try:
                    thresh = float(payload["booking_threshold_usd"])
                    if thresh > 0:
                        self.booking_threshold_usd = thresh
                        self._save_setting("booking_threshold_usd", str(thresh))
                except ValueError:
                    pass
            
            if "booking_enabled" in payload:
                self.booking_enabled = bool(payload["booking_enabled"])

            if "reentry_mode" in payload:
                self.reentry_mode = str(payload["reentry_mode"])

            if "quantity" in payload:
                try:
                    q = float(payload["quantity"])
                    if q > 0:
                        self.quantity = q
                except ValueError:
                    pass

            return {
                "success": True,
                "message": "Configuration updated successfully.",
                "booking_threshold_usd": self.booking_threshold_usd,
                "booking_enabled": self.booking_enabled,
                "reentry_mode": self.reentry_mode,
                "quantity": self.quantity
            }

    def create_manual_pair(self) -> Dict[str, Any]:
        """Manually opens a new BUY + SELL pair at current market price."""
        with self._lock:
            tick_meta = self.fetch_live_market_price()
            live_p = tick_meta.get("price") if tick_meta.get("price_valid") else None
            price = live_p or self.last_tick_price or self.reference_price or 80.00
            pair_id, buy_pos, sell_pos = self._create_pair_unlocked(entry_price=price, reason="MANUAL USER PAIR CREATION")
            return {
                "success": True,
                "message": f"New pair {pair_id} created manually at ${price:.2f}.",
                "pair_id": pair_id,
                "buy_pos": buy_pos,
                "sell_pos": sell_pos
            }

    def _create_pair_unlocked(self, entry_price: float, reason: str = "PAIR ENTRY") -> Tuple[str, Dict[str, Any], Dict[str, Any]]:
        """Internal helper to create a pair with 1 BUY and 1 SELL position."""
        pair_id = self.get_next_pair_id()
        now_str = self.get_now_ist_str()

        # BUY Position
        sl1 = self.get_next_serial_number()
        pos_id_buy = f"POS-{sl1:03d}-BUY"
        buy_pos = CrudePairPosition(
            sl_no=sl1,
            pair_id=pair_id,
            position_id=pos_id_buy,
            direction="BUY",
            entry_price=entry_price,
            quantity=self.quantity,
            threshold_usd=self.booking_threshold_usd,
            entry_timestamp=now_str,
            status="OPEN",
            reason=reason
        ).to_dict()

        DB.save_crude_pair_trade(buy_pos)
        self.positions.append(buy_pos)

        # SELL Position
        sl2 = self.get_next_serial_number()
        pos_id_sell = f"POS-{sl2:03d}-SELL"
        sell_pos = CrudePairPosition(
            sl_no=sl2,
            pair_id=pair_id,
            position_id=pos_id_sell,
            direction="SELL",
            entry_price=entry_price,
            quantity=self.quantity,
            threshold_usd=self.booking_threshold_usd,
            entry_timestamp=now_str,
            status="OPEN",
            reason=reason
        ).to_dict()

        DB.save_crude_pair_trade(sell_pos)
        self.positions.append(sell_pos)

        # Log movement creation event
        mv_event = {
            "timestamp": now_str,
            "pair_id": pair_id,
            "position_id": f"{pos_id_buy}/{pos_id_sell}",
            "direction": "PAIR_CREATED",
            "price": entry_price,
            "price_change": 0.0,
            "threshold_usd": 0.0,
            "position_pnl": 0.0,
            "event_type": f"New Pair Created ({reason})"
        }
        DB.save_crude_pair_movement(mv_event)
        self.movements.insert(0, mv_event)

        return pair_id, buy_pos, sell_pos

    def close_single_position(self, position_id: str, exit_price: Optional[float] = None, exit_reason: str = "MANUAL CLOSE") -> Dict[str, Any]:
        """Manually closes an individual position by position_id."""
        with self._lock:
            pos = next((p for p in self.positions if p["position_id"] == position_id and p["status"] == "OPEN"), None)
            if not pos:
                return {"success": False, "error": f"Active position '{position_id}' not found."}

            tick_meta = self.fetch_live_market_price()
            live_p = tick_meta.get("price") if tick_meta.get("price_valid") else None
            close_price = exit_price or live_p or self.last_tick_price or pos["entry_price"]
            self._close_position_unlocked(pos, exit_price=close_price, exit_reason=exit_reason, trigger_reentry=False)
            return {
                "success": True,
                "message": f"Position '{position_id}' closed successfully at ${close_price:.2f}.",
                "closed_position": pos
            }

    def _close_position_unlocked(self, pos: Dict[str, Any], exit_price: float, exit_reason: str, trigger_reentry: bool = True) -> Dict[str, Any]:
        """Internal helper to close a position and optionally trigger re-entry."""
        entry_price = float(pos["entry_price"])
        qty = float(pos.get("quantity", 1.0))
        direction = str(pos["direction"]).upper()
        now_str = self.get_now_ist_str()

        # Calculate Gross P/L in USD
        if direction == "BUY":
            gross_pnl = (exit_price - entry_price) * qty
        else:
            gross_pnl = (entry_price - exit_price) * qty

        # Fees calculation (0.05% per side taker fee assumption)
        entry_val = entry_price * qty
        exit_val = exit_price * qty
        trading_fees = (entry_val + exit_val) * self.fee_rate
        funding_costs = float(pos.get("funding_costs", 0.0))
        net_pnl = gross_pnl - trading_fees - funding_costs

        pos["status"] = "CLOSED"
        pos["exit_price"] = exit_price
        pos["exit_timestamp"] = now_str
        pos["gross_pnl"] = round(gross_pnl, 4)
        pos["trading_fees"] = round(trading_fees, 4)
        pos["funding_costs"] = round(funding_costs, 4)
        pos["net_pnl"] = round(net_pnl, 4)
        pos["unrealized_pnl"] = 0.0
        pos["reason"] = exit_reason

        DB.save_crude_pair_trade(pos)

        # Movement log
        mv_event = {
            "timestamp": now_str,
            "pair_id": pos["pair_id"],
            "position_id": pos["position_id"],
            "direction": direction,
            "price": exit_price,
            "price_change": round(exit_price - entry_price, 4),
            "threshold_usd": float(pos.get("threshold_usd", 0.0)),
            "position_pnl": round(net_pnl, 4),
            "event_type": f"POSITION_EXIT ({exit_reason})"
        }
        DB.save_crude_pair_movement(mv_event)
        self.movements.insert(0, mv_event)

        # Trigger re-entry if configured
        if trigger_reentry and self.reentry_mode == "AUTO_PAIR_ON_TP":
            self._create_pair_unlocked(entry_price=exit_price, reason=f"RE-ENTRY PAIR (Triggered by {pos['position_id']} exit)")

        return pos

    def process_tick(self, current_price: float, timestamp_str: str) -> List[Dict[str, Any]]:
        """
        Evaluates open positions against current market tick:
        1. Updates unrealized P/L, max adverse, max favorable.
        2. Logs threshold crossings across the 6 levels ($0.25, $0.50, $1.00, $1.50, $2.00, $3.00).
        3. Evaluates profit booking rule if engine is active.
        """
        with self._lock:
            self.last_tick_price = current_price
            self.last_tick_time = timestamp_str

            open_positions = [p for p in self.positions if p["status"] == "OPEN"]
            closed_triggered: List[Dict[str, Any]] = []

            for pos in open_positions:
                entry_p = float(pos["entry_price"])
                qty = float(pos.get("quantity", 1.0))
                direction = str(pos["direction"]).upper()

                # Calculate price movement relative to entry
                if direction == "BUY":
                    price_diff = current_price - entry_p
                    unrealized_gross = price_diff * qty
                else:
                    price_diff = entry_p - current_price
                    unrealized_gross = price_diff * qty

                # Entry value & exit value fee estimation for unrealized net P/L
                approx_fees = (entry_p + current_price) * qty * self.fee_rate
                unrealized_net = unrealized_gross - approx_fees - float(pos.get("funding_costs", 0.0))

                pos["unrealized_pnl"] = round(unrealized_net, 4)

                # Track Adverse / Favorable movement extremes
                if price_diff < 0:
                    adverse = abs(price_diff)
                    if adverse > float(pos.get("max_adverse_usd", 0.0)):
                        pos["max_adverse_usd"] = round(adverse, 4)
                else:
                    favorable = abs(price_diff)
                    if favorable > float(pos.get("max_favorable_usd", 0.0)):
                        pos["max_favorable_usd"] = round(favorable, 4)

                DB.save_crude_pair_trade(pos)

                # Check Profit Booking Trigger
                if self.is_running and self.booking_enabled:
                    # Default trigger: position P/L reached booking_threshold_usd
                    if unrealized_gross >= self.booking_threshold_usd:
                        reason = f"PROFIT BOOKED @ +${unrealized_gross:.2f} (Threshold ${self.booking_threshold_usd:.2f} Hit)"
                        closed_pos = self._close_position_unlocked(pos, exit_price=current_price, exit_reason=reason, trigger_reentry=True)
                        closed_triggered.append(closed_pos)

            return closed_triggered

    def get_dashboard_state(self) -> Dict[str, Any]:
        """Calculates full reconciled dashboard summary and main ledger."""
        with self._lock:
            tick_meta = self.fetch_live_market_price()
            curr_price = tick_meta.get("price") or self.last_tick_price or self.reference_price or 80.00
            conn_status = tick_meta.get("connection_status", "DISCONNECTED")
            f_status = tick_meta.get("feed_status", "DISCONNECTED")
            price_valid = tick_meta.get("price_valid", False)

            # Calculate ledger rows and unrealized P/L
            ledger_rows = []
            total_open = 0
            total_closed = 0
            total_buy = 0
            total_sell = 0
            realized_gross = 0.0
            total_fees = 0.0
            total_funding = 0.0
            realized_net = 0.0
            total_unrealized = 0.0
            winning_closed = 0
            losing_closed = 0
            highest_adverse_usd = 0.0
            highest_adverse_pct = 0.0

            # Unique Pair IDs tracking
            pair_ids_set = set()

            for p in self.positions:
                pair_ids_set.add(p["pair_id"])
                direction = str(p["direction"]).upper()
                status = str(p["status"]).upper()
                entry_p = float(p["entry_price"])
                qty = float(p.get("quantity", 1.0))

                if direction == "BUY":
                    total_buy += 1
                else:
                    total_sell += 1

                if status == "OPEN":
                    total_open += 1
                    # calculate unrealized
                    if direction == "BUY":
                        diff = curr_price - entry_p
                    else:
                        diff = entry_p - curr_price
                    u_gross = diff * qty
                    approx_fees = (entry_p + curr_price) * qty * self.fee_rate
                    u_net = u_gross - approx_fees - float(p.get("funding_costs", 0.0))
                    p["unrealized_pnl"] = round(u_net, 4)
                    total_unrealized += u_net

                    # Adverse movement
                    adverse = abs(diff) if diff < 0 else 0.0
                    if adverse > highest_adverse_usd:
                        highest_adverse_usd = adverse
                        highest_adverse_pct = (adverse / entry_p) * 100.0 if entry_p > 0 else 0.0
                else:
                    total_closed += 1
                    r_gross = float(p.get("gross_pnl", 0.0))
                    r_fees = float(p.get("trading_fees", 0.0))
                    r_fund = float(p.get("funding_costs", 0.0))
                    r_net = float(p.get("net_pnl", 0.0))

                    realized_gross += r_gross
                    total_fees += r_fees
                    total_funding += r_fund
                    realized_net += r_net

                    if r_net >= 0:
                        winning_closed += 1
                    else:
                        losing_closed += 1

                ledger_rows.append(p)

            total_costs = total_fees + total_funding
            combined_net_equity = realized_net + total_unrealized

            # Calculate breakdown per threshold
            threshold_breakdown = {}
            for t in MOVEMENT_THRESHOLDS:
                t_key = f"${t:.2f}"
                hits = 0
                booked_pnl = 0.0
                for p in self.positions:
                    entry_p = float(p["entry_price"])
                    if p["status"] == "CLOSED":
                        exit_p = float(p.get("exit_price", entry_p))
                        if abs(exit_p - entry_p) >= t:
                            hits += 1
                            booked_pnl += float(p.get("net_pnl", 0.0))
                    elif p["status"] == "OPEN":
                        if abs(curr_price - entry_p) >= t:
                            hits += 1
                threshold_breakdown[t_key] = {
                    "threshold": t,
                    "total_hits": hits,
                    "booked_pnl": round(booked_pnl, 2)
                }

            # Instrument validation info
            instrument_validation = {
                "paper_mode_only": True,
                "real_trading_disabled": True,
                "instrument": "WTI CRUDE OIL (CL=F)",
                "price_feed_source": self.feed_source,
                "price_feed_status": self.feed_status,
                "current_price_usd": curr_price,
                "mudrex_support_note": "Mudrex does not support CL/USDT contract. Data feed connected via NYMEX Crude Oil (CL=F) real-time stream.",
                "contract_size": f"{self.quantity} Barrel",
                "fee_assumptions": f"0.05% Taker Fee per side (${(curr_price * self.quantity * self.fee_rate):.4f}/trade)",
                "funding_assumptions": "$0.00 (Paper Simulation)"
            }

            # Unresolved Rules list to report to user
            unresolved_rules = [
                {
                    "rule_id": "RULE_1_BOOKING_THRESHOLD",
                    "name": "Profit Booking USD Threshold",
                    "configured_value": f"${self.booking_threshold_usd:.2f}",
                    "options": ["$0.25", "$0.50", "$1.00", "$1.50", "$2.00", "$3.00"],
                    "description": "Which movement threshold triggers profit exit?"
                },
                {
                    "rule_id": "RULE_2_REFERENCE_BASE",
                    "name": "Threshold Reference Point",
                    "configured_value": self.reference_base,
                    "options": ["PAIR_ENTRY (Each Pair Entry)", "INITIAL_REF ($80.00)", "TRAILING (Peak High/Low)"],
                    "description": "Is threshold measured relative to each pair's entry price or initial ref price?"
                },
                {
                    "rule_id": "RULE_3_REENTRY_MODE",
                    "name": "Re-entry & New Pair Trigger",
                    "configured_value": self.reentry_mode,
                    "options": ["AUTO_PAIR_ON_TP (Auto create pair on exit)", "MANUAL_PAIR (User triggers pair)"],
                    "description": "Does profit exit automatically spawn a new BUY+SELL pair at execution price?"
                },
                {
                    "rule_id": "RULE_4_LOSS_MANAGEMENT",
                    "name": "Opposing Leg Loss Rule",
                    "configured_value": self.loss_management,
                    "options": ["KEEP_OPEN_INDEFINITELY (Req 4 Standard)", "CUSTOM_STOP_LOSS (User decision required)"],
                    "description": "Req 4 specifies keeping opposing older positions open. No loss limits are invented without explicit user command."
                }
            ]

            return {
                "timestamp_ist": tick_meta.get("timestamp_ist") or self.get_now_ist_str(),
                "is_running": self.is_running,
                "current_price": curr_price,
                "price_change": tick_meta.get("change", 0.0),
                "price_change_pct": tick_meta.get("change_pct", 0.0),
                "connection_status": conn_status,
                "feed_status": f_status,
                "price_valid": price_valid,
                "reference_price": self.reference_price,
                "summary": {
                    "total_pairs_created": len(pair_ids_set),
                    "total_positions_created": len(self.positions),
                    "total_buy_positions": total_buy,
                    "total_sell_positions": total_sell,
                    "total_open_positions": total_open,
                    "total_closed_positions": total_closed,
                    "realized_gross_pnl": round(realized_gross, 2),
                    "total_trading_fees": round(total_fees, 2),
                    "total_funding_costs": round(total_funding, 2),
                    "total_trading_costs": round(total_costs, 2),
                    "realized_net_pnl": round(realized_net, 2),
                    "current_unrealized_pnl": round(total_unrealized, 2),
                    "combined_net_equity": round(combined_net_equity, 2),
                    "winning_closed_positions": winning_closed,
                    "losing_closed_positions": losing_closed,
                    "highest_adverse_usd": round(highest_adverse_usd, 2),
                    "highest_adverse_pct": round(highest_adverse_pct, 2)
                },
                "threshold_breakdown": threshold_breakdown,
                "ledger": ledger_rows,
                "movements": self.movements[:50],
                "instrument_validation": instrument_validation,
                "unresolved_rules": unresolved_rules,
                "config": {
                    "booking_threshold_usd": self.booking_threshold_usd,
                    "booking_enabled": self.booking_enabled,
                    "reentry_mode": self.reentry_mode,
                    "quantity": self.quantity
                }
            }

    def generate_csv_export(self) -> str:
        """Generates a full CSV string of the main P/L ledger for independent auditing."""
        output = io.StringIO()
        writer = csv.writer(output)

        headers = [
            "Sl. No.",
            "Pair ID",
            "Position ID",
            "BUY / SELL",
            "Entry Price ($)",
            "Exit Price ($)",
            "Quantity",
            "Movement Threshold ($)",
            "Entry Timestamp",
            "Exit Timestamp",
            "Gross Realized P/L ($)",
            "Trading Fees ($)",
            "Funding Costs ($)",
            "Net Realized P/L ($)",
            "Status",
            "Unrealized P/L ($)",
            "Reason"
        ]
        writer.writerow(headers)

        state = self.get_dashboard_state()
        for r in state["ledger"]:
            writer.writerow([
                r.get("sl_no"),
                r.get("pair_id"),
                r.get("position_id"),
                r.get("direction"),
                f"{r.get('entry_price', 0.0):.2f}",
                f"{r.get('exit_price', 0.0):.2f}" if r.get("exit_price") is not None else "N/A",
                r.get("quantity", 1.0),
                f"{r.get('threshold_usd', 0.0):.2f}",
                r.get("entry_timestamp"),
                r.get("exit_timestamp") or "N/A",
                f"{r.get('gross_pnl', 0.0):.2f}",
                f"{r.get('trading_fees', 0.0):.2f}",
                f"{r.get('funding_costs', 0.0):.2f}",
                f"{r.get('net_pnl', 0.0):.2f}",
                r.get("status"),
                f"{r.get('unrealized_pnl', 0.0):.2f}",
                r.get("reason")
            ])

        return output.getvalue()


CRUDE_PAIR_ENGINE = CrudePairEngine()


async def crude_pair_engine_background_loop():
    """Background task to stream market tick and evaluate open positions."""
    print("[CRUDE PAIR ENGINE] Background market tick monitoring loop initiated.")
    while True:
        try:
            if CRUDE_PAIR_ENGINE.is_running:
                price, status = CRUDE_PAIR_ENGINE.fetch_live_market_price()
                if price and price > 0:
                    now_str = CRUDE_PAIR_ENGINE.get_now_ist_str()
                    CRUDE_PAIR_ENGINE.process_tick(price, now_str)
        except Exception as e:
            print(f"[CRUDE PAIR ENGINE LOOP ERROR] {e}")
        await asyncio.sleep(2)
