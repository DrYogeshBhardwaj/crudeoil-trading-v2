"""
WTI Crude Oil Paper Trading Execution & State Engine.
Manages WTI virtual capital ($100,000 default), 1000-barrel contract multiplier,
virtual trade entry/exit, SL/Target risk management, P&L calculations, and SQLite persistence.
STRICTLY PAPER TRADING ONLY - NO REAL MONEY / BROKER APIS.
"""

import asyncio
import time
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional

from wti_feed import WTI_FEED
from wti_strategy import WTI_STRATEGY
from database import DB

class WTIPaperEngine:
    """
    Independent Paper Trading Engine for WTI Crude Oil (CL=F).
    """

    def __init__(self):
        self.symbol = "CL=F"
        self.instrument_name = "WTI CRUDE OIL FUTURES (CL=F)"
        
        # Supported Contract Types for Phase-1 and Phase-2 Transition
        self.supported_contracts = {
            "CL": {"code": "CL", "name": "Standard WTI Futures (CL)", "barrels": 1000, "multiplier": 1000.0, "charge_per_side": 2.50},
            "MCL": {"code": "MCL", "name": "Micro WTI Futures (MCL)", "barrels": 100, "multiplier": 100.0, "charge_per_side": 0.50}
        }

        saved_contract_type = DB.load_wti_setting("contract_type", "MCL")
        self.contract_type = saved_contract_type if saved_contract_type in self.supported_contracts else "MCL"
        self.barrel_multiplier = self.supported_contracts[self.contract_type]["multiplier"]
        self.charge_per_contract_side = self.supported_contracts[self.contract_type]["charge_per_side"]

        self.default_capital = 100000.0 # $100,000 USD initial paper capital

        # Load persisted settings or initialize defaults
        saved_capital = DB.load_wti_setting("virtual_capital")
        self.virtual_capital = float(saved_capital) if saved_capital else self.default_capital

        saved_contract_qty = DB.load_wti_setting("contract_quantity")
        self.contract_quantity = int(saved_contract_qty) if saved_contract_qty else 1

        self.active_position: Optional[Dict[str, Any]] = DB.load_active_wti_position()
        self.trade_ledger: List[Dict[str, Any]] = DB.load_all_wti_trades()

        self.last_tick: Dict[str, Any] = {}
        self.last_evaluation: Dict[str, Any] = {}
        self.evaluation_stream: List[Dict[str, Any]] = DB.load_recent_wti_evaluations(50)

        self.is_running = False
        self.loop_task: Optional[asyncio.Task] = None

    def calculate_pnl_tallies(self) -> Dict[str, Any]:
        """Calculates total realized P&L, trade count, win/loss count, and net equity."""
        closed_trades = [t for t in self.trade_ledger if t.get("status") == "CLOSED"]
        total_trades = len(closed_trades)
        winning_trades = sum(1 for t in closed_trades if (t.get("net_pnl") or 0.0) > 0)
        losing_trades = sum(1 for t in closed_trades if (t.get("net_pnl") or 0.0) < 0)
        realized_net_pnl = sum((t.get("net_pnl") or 0.0) for t in closed_trades)
        realized_gross_pnl = sum((t.get("gross_pnl") or 0.0) for t in closed_trades)
        total_charges = sum((t.get("charges") or 0.0) for t in closed_trades)

        win_rate = (winning_trades / total_trades * 100.0) if total_trades > 0 else 0.0
        current_equity = self.virtual_capital + realized_net_pnl

        return {
            "total_trades": total_trades,
            "winning_trades": winning_trades,
            "losing_trades": losing_trades,
            "win_rate": round(win_rate, 1),
            "realized_gross_pnl": round(realized_gross_pnl, 2),
            "total_charges": round(total_charges, 2),
            "realized_net_pnl": round(realized_net_pnl, 2),
            "current_equity": round(current_equity, 2)
        }

    def process_tick(self):
        """Processes a single live tick update from data feed."""
        tick = WTI_FEED.fetch_latest_tick()
        self.last_tick = tick
        curr_price = tick.get("price", 0.0)

        if curr_price <= 0:
            return

        candles = WTI_FEED.fetch_historical_candles("5m", "1d")
        eval_res = WTI_STRATEGY.evaluate_market(candles, curr_price)
        self.last_evaluation = eval_res

        ist_tz = timezone(timedelta(hours=5, minutes=30))
        now_ist_str = datetime.now(ist_tz).strftime("%Y-%m-%d %H:%M:%S")

        # 1. Log evaluation to stream list and DB
        reasons_str = " | ".join(eval_res.get("reasons", []))
        eval_log_entry = {
            "timestamp": now_ist_str,
            "price": curr_price,
            "action": eval_res.get("action", "WAIT"),
            "trend_state": eval_res.get("trend", "NEUTRAL"),
            "confidence": eval_res.get("confidence", 50),
            "reason": reasons_str
        }

        # Add to in-memory evaluation stream
        self.evaluation_stream.insert(0, eval_log_entry)
        if len(self.evaluation_stream) > 100:
            self.evaluation_stream = self.evaluation_stream[:100]

        # Save to DB
        DB.save_wti_evaluation(
            now_ist_str,
            curr_price,
            eval_res.get("action", "WAIT"),
            eval_res.get("trend", "NEUTRAL"),
            eval_res.get("confidence", 50),
            reasons_str
        )

        # 2. Update active position unrealized P&L and check exit triggers
        if self.active_position and self.active_position.get("status") == "OPEN":
            pos = self.active_position
            entry_p = pos["entry_price"]
            direction = pos["direction"]
            qty = pos["quantity"]
            sl = pos["stop_loss"]
            target = pos["target"]

            # Calculate running unrealized P&L
            if direction == "BUY":
                unrealized_gross = (curr_price - entry_p) * qty * self.barrel_multiplier
            else:
                unrealized_gross = (entry_p - curr_price) * qty * self.barrel_multiplier

            estimated_roundtrip_charges = self.charge_per_contract_side * 2.0 * qty
            pos["unrealized_pnl"] = round(unrealized_gross - estimated_roundtrip_charges, 2)

            # Check exit conditions
            exit_triggered = False
            exit_price = curr_price
            exit_reason = ""

            if direction == "BUY":
                if curr_price <= sl:
                    exit_triggered = True
                    exit_price = sl # fill at SL level or curr_price
                    exit_reason = "STOP LOSS HIT"
                elif curr_price >= target:
                    exit_triggered = True
                    exit_price = target # fill at Target level or curr_price
                    exit_reason = "TARGET HIT"
                elif eval_res.get("action") == "SELL" and eval_res.get("confidence", 0) >= 70:
                    exit_triggered = True
                    exit_price = curr_price
                    exit_reason = "STRATEGY SIGNAL REVERSAL (SELL)"
            elif direction == "SELL":
                if curr_price >= sl:
                    exit_triggered = True
                    exit_price = sl
                    exit_reason = "STOP LOSS HIT"
                elif curr_price <= target:
                    exit_triggered = True
                    exit_price = target
                    exit_reason = "TARGET HIT"
                elif eval_res.get("action") == "BUY" and eval_res.get("confidence", 0) >= 70:
                    exit_triggered = True
                    exit_price = curr_price
                    exit_reason = "STRATEGY SIGNAL REVERSAL (BUY)"

            if exit_triggered:
                self._close_position(exit_price=exit_price, exit_reason=exit_reason, timestamp_str=now_ist_str)

        # 3. Check entry triggers if flat and market open
        elif tick.get("market_status") == "OPEN" and tick.get("connection_status") == "CONNECTED":
            action = eval_res.get("action")
            confidence = eval_res.get("confidence", 0)

            if action in ("BUY", "SELL") and confidence >= 65:
                self._open_position(
                    direction=action,
                    entry_price=curr_price,
                    sl_price=eval_res.get("sl_price", curr_price * 0.99 if action=="BUY" else curr_price * 1.01),
                    target_price=eval_res.get("target_price", curr_price * 1.02 if action=="BUY" else curr_price * 0.98),
                    trend_state=eval_res.get("trend", "NEUTRAL"),
                    confidence=confidence,
                    reasons=eval_res.get("reasons", []),
                    timestamp_str=now_ist_str
                )

    def _open_position(self, direction: str, entry_price: float, sl_price: float, target_price: float,
                       trend_state: str, confidence: int, reasons: List[str], timestamp_str: str):
        """Creates virtual open position and persists to database."""
        trade_id = f"WTI-{datetime.now().strftime('%Y%m%d%H%M%S')}"

        pos = {
            "trade_id": trade_id,
            "entry_timestamp": timestamp_str,
            "symbol": self.symbol,
            "direction": direction,
            "quantity": self.contract_quantity,
            "entry_price": round(entry_price, 2),
            "stop_loss": round(sl_price, 2),
            "target": round(target_price, 2),
            "trend_state": trend_state,
            "confidence": confidence,
            "reasons": reasons,
            "status": "OPEN",
            "exit_timestamp": None,
            "exit_price": None,
            "exit_reason": None,
            "gross_pnl": 0.0,
            "charges": round(self.charge_per_contract_side * 2.0 * self.contract_quantity, 2),
            "net_pnl": 0.0,
            "unrealized_pnl": 0.0
        }

        self.active_position = pos
        DB.save_wti_trade(pos)
        # Add to top of trade ledger
        self.trade_ledger.insert(0, pos)
        print(f"[WTI ENGINE] VIRTUAL {direction} POSITION OPENED: Trade {trade_id} @ ${entry_price:.2f} (SL: ${sl_price:.2f}, Target: ${target_price:.2f})")

    def _close_position(self, exit_price: float, exit_reason: str, timestamp_str: str):
        """Closes active virtual position, calculates final P&L, updates DB."""
        if not self.active_position:
            return

        pos = self.active_position
        direction = pos["direction"]
        entry_price = pos["entry_price"]
        qty = pos["quantity"]

        if direction == "BUY":
            gross_pnl = (exit_price - entry_price) * qty * self.barrel_multiplier
        else:
            gross_pnl = (entry_price - exit_price) * qty * self.barrel_multiplier

        charges = self.charge_per_contract_side * 2.0 * qty
        net_pnl = gross_pnl - charges

        pos["status"] = "CLOSED"
        pos["exit_timestamp"] = timestamp_str
        pos["exit_price"] = round(exit_price, 2)
        pos["exit_reason"] = exit_reason
        pos["gross_pnl"] = round(gross_pnl, 2)
        pos["charges"] = round(charges, 2)
        pos["net_pnl"] = round(net_pnl, 2)
        pos["unrealized_pnl"] = 0.0

        DB.save_wti_trade(pos)

        # Update in trade_ledger
        for idx, t in enumerate(self.trade_ledger):
            if t.get("trade_id") == pos["trade_id"]:
                self.trade_ledger[idx] = pos
                break

        print(f"[WTI ENGINE] VIRTUAL POSITION CLOSED: Trade {pos['trade_id']} @ ${exit_price:.2f} ({exit_reason}). Net P&L: ${net_pnl:+.2f}")
        self.active_position = None

    def emergency_exit_position(self) -> Optional[Dict[str, Any]]:
        """Triggers manual emergency exit for active position."""
        if not self.active_position:
            return None

        ist_tz = timezone(timedelta(hours=5, minutes=30))
        now_ist_str = datetime.now(ist_tz).strftime("%Y-%m-%d %H:%M:%S")

        curr_p = self.last_tick.get("price", self.active_position["entry_price"])
        closed_pos = dict(self.active_position)
        self._close_position(exit_price=curr_p, exit_reason="MANUAL EMERGENCY EXIT", timestamp_str=now_ist_str)
        return closed_pos

    def reset_paper_account(self):
        """Resets virtual capital and clears WTI database tables."""
        DB.reset_wti_database()
        self.virtual_capital = self.default_capital
        DB.save_wti_setting("virtual_capital", str(self.default_capital))
        DB.save_wti_setting("contract_quantity", str(self.contract_quantity))
        self.active_position = None
        self.trade_ledger = []
        self.evaluation_stream = []

    def set_virtual_capital(self, capital: float):
        """Updates virtual capital amount."""
        self.virtual_capital = float(capital)
        DB.save_wti_setting("virtual_capital", str(capital))

    def set_contract_type(self, contract_type: str):
        """Updates contract type ('CL' for 1,000 bbls or 'MCL' for 100 bbls)."""
        if contract_type in self.supported_contracts:
            self.contract_type = contract_type
            self.barrel_multiplier = self.supported_contracts[contract_type]["multiplier"]
            self.charge_per_contract_side = self.supported_contracts[contract_type]["charge_per_side"]
            DB.save_wti_setting("contract_type", contract_type)
            print(f"[WTI ENGINE] Contract type updated to {contract_type} ({self.supported_contracts[contract_type]['name']})")

    def get_dashboard_state(self) -> Dict[str, Any]:
        """Returns complete JSON state for the /wti paper trading dashboard."""
        tallies = self.calculate_pnl_tallies()

        return {
            "instrument": self.instrument_name,
            "symbol": self.symbol,
            "server_mode": "WTI PAPER TRADING ONLY",
            "real_money": False,
            "disclaimer": "PAPER TRADING — NO REAL MONEY",
            "data_status_label": "DATA: DELAYED NYMEX DATA",
            "data_feed_type": "DELAYED MARKET DATA",
            "contract_display": f"CONTRACT: {self.contract_type} — {int(self.barrel_multiplier)} BARRELS ($0.01 MOVE = ${self.barrel_multiplier/100:.2f})",
            "contract_config": {
                "active_contract": self.contract_type,
                "active_name": self.supported_contracts[self.contract_type]["name"],
                "active_barrels": self.supported_contracts[self.contract_type]["barrels"],
                "multiplier": self.barrel_multiplier,
                "supported_contracts": [
                    {"code": "MCL", "name": "MCL = 100 Barrels (Micro)"},
                    {"code": "CL", "name": "CL = 1,000 Barrels (Standard)"}
                ]
            },
            "last_tick": self.last_tick,
            "last_evaluation": self.last_evaluation,
            "active_position": self.active_position,
            "financial_summary": {
                "initial_capital": self.virtual_capital,
                "current_equity": tallies["current_equity"],
                "realized_net_pnl": tallies["realized_net_pnl"],
                "realized_gross_pnl": tallies["realized_gross_pnl"],
                "total_charges": tallies["total_charges"],
                "unrealized_pnl": self.active_position.get("unrealized_pnl", 0.0) if self.active_position else 0.0,
                "total_trades": tallies["total_trades"],
                "winning_trades": tallies["winning_trades"],
                "losing_trades": tallies["losing_trades"],
                "win_rate": tallies["win_rate"]
            },
            "evaluation_stream": self.evaluation_stream[:50],
            "trade_ledger": self.trade_ledger[:100]
        }

    async def start_feed_loop(self):
        """Background continuous feed loop for WTI paper engine."""
        self.is_running = True
        print("[WTI ENGINE] Continuous 24x7 WTI Paper Feed Loop Started.")
        while self.is_running:
            try:
                self.process_tick()
            except Exception as e:
                print(f"[WTI ENGINE LOOP ERROR] {e}")
            await asyncio.sleep(5) # Poll every 5 seconds

    def stop_feed_loop(self):
        self.is_running = False

WTI_ENGINE = WTIPaperEngine()
