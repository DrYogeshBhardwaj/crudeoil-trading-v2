"""
Bitcoin (BTC-INR) Paper Trading Execution & State Engine.
Manages Bitcoin virtual capital (₹2,00,000 INR default), contract sizing,
virtual trade entry/exit, SL/Target risk management, P&L calculations in INR, and SQLite persistence.
STRICTLY PAPER TRADING ONLY - NO REAL MONEY / BROKER APIS.
"""

import asyncio
import time
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional

from bitcoin_feed import BITCOIN_FEED
from bitcoin_strategy import BITCOIN_STRATEGY
from database import DB

class BitcoinPaperEngine:
    """
    Independent Paper Trading Engine for Bitcoin Perpetual / Futures (BTC-INR).
    """

    def __init__(self):
        self.symbol = "BTC-INR"
        self.instrument_name = "BITCOIN PERPETUAL / FUTURES (BTC-INR)"
        self.contract_multiplier = 1.0 # 1 contract = 1 BTC multiplier
        self.default_capital = 200000.0 # ₹2,00,000 INR initial paper capital
        self.charge_per_contract_side = 50.00 # ₹50 per side (₹100 round trip per contract)

        # Load persisted settings or initialize defaults
        saved_capital = DB.load_bitcoin_setting("virtual_capital")
        self.virtual_capital = float(saved_capital) if saved_capital else self.default_capital

        saved_contract_qty = DB.load_bitcoin_setting("contract_quantity")
        self.contract_quantity = float(saved_contract_qty) if saved_contract_qty else 1.0

        self.active_position: Optional[Dict[str, Any]] = DB.load_active_bitcoin_position()
        self.trade_ledger: List[Dict[str, Any]] = DB.load_all_bitcoin_trades()

        self.last_tick: Dict[str, Any] = {}
        self.last_evaluation: Dict[str, Any] = {}
        self.evaluation_stream: List[Dict[str, Any]] = DB.load_recent_bitcoin_evaluations(50)

        self.is_running = False
        self.loop_task: Optional[asyncio.Task] = None

        # Pre-populate last tick on engine startup
        try:
            self.last_tick = BITCOIN_FEED.fetch_latest_tick()
        except Exception as err:
            print(f"[BITCOIN ENGINE INIT NOTICE] Could not fetch initial tick on init: {err}")

    def calculate_pnl_tallies(self) -> Dict[str, Any]:
        """Calculates total realized P&L, trade count, win/loss count, and net equity in INR."""
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

    SAFETY_BANNER = "BITCOIN PAPER TRADING — NO REAL MONEY"

    def process_tick(self, custom_price: Optional[float] = None, custom_eval: Optional[Dict[str, Any]] = None):
        """Processes a single live tick update for BTC-INR or custom test tick."""
        if custom_price is not None:
            tick = {
                "symbol": self.symbol,
                "price": custom_price,
                "data_source": "Test Feed",
                "connection_status": "CONNECTED"
            }
        else:
            tick = BITCOIN_FEED.fetch_latest_tick()

        self.last_tick = tick
        curr_price = tick.get("price", 0.0)

        if curr_price <= 0:
            return

        if custom_eval is not None:
            eval_res = custom_eval
        else:
            candles = BITCOIN_FEED.fetch_historical_candles("5m", "5d")
            eval_res = BITCOIN_STRATEGY.evaluate_market(candles, curr_price)
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

        self.evaluation_stream.insert(0, eval_log_entry)
        if len(self.evaluation_stream) > 100:
            self.evaluation_stream = self.evaluation_stream[:100]

        DB.save_bitcoin_evaluation(
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

            # Calculate running unrealized P&L in INR
            if direction == "BUY":
                unrealized_gross = (curr_price - entry_p) * qty * self.contract_multiplier
            else:
                unrealized_gross = (entry_p - curr_price) * qty * self.contract_multiplier

            estimated_roundtrip_charges = self.charge_per_contract_side * 2.0 * qty
            pos["unrealized_pnl"] = round(unrealized_gross - estimated_roundtrip_charges, 2)

            # Check exit conditions
            exit_triggered = False
            exit_price = curr_price
            exit_reason = ""

            if direction == "BUY":
                if curr_price <= sl:
                    exit_triggered = True
                    exit_price = sl
                    exit_reason = "STOP LOSS HIT"
                elif curr_price >= target:
                    exit_triggered = True
                    exit_price = target
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
        elif tick.get("connection_status") == "CONNECTED":
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

        return self.active_position

    def _open_position(self, direction: str, entry_price: float, sl_price: float, target_price: float,
                       trend_state: str, confidence: int, reasons: List[str], timestamp_str: str):
        """Creates virtual open position and persists to database."""
        trade_id = f"BTC-{datetime.now().strftime('%Y%m%d%H%M%S')}"

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
        DB.save_bitcoin_trade(pos)
        self.trade_ledger.insert(0, pos)
        print(f"[BITCOIN ENGINE] VIRTUAL {direction} POSITION OPENED: Trade {trade_id} @ INR {entry_price:,.2f} (SL: {sl_price:,.2f}, Target: {target_price:,.2f})")

    def _close_position(self, exit_price: float, exit_reason: str, timestamp_str: str):
        """Closes active virtual position, calculates final P&L, updates DB."""
        if not self.active_position:
            return

        pos = self.active_position
        direction = pos["direction"]
        entry_price = pos["entry_price"]
        qty = pos["quantity"]

        if direction == "BUY":
            gross_pnl = (exit_price - entry_price) * qty * self.contract_multiplier
        else:
            gross_pnl = (entry_price - exit_price) * qty * self.contract_multiplier

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

        DB.save_bitcoin_trade(pos)

        for idx, t in enumerate(self.trade_ledger):
            if t.get("trade_id") == pos["trade_id"]:
                self.trade_ledger[idx] = pos
                break

        print(f"[BITCOIN ENGINE] VIRTUAL POSITION CLOSED: Trade {pos['trade_id']} @ INR {exit_price:,.2f} ({exit_reason}). Net P&L: INR {net_pnl:+,.2f}")
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
        """Resets virtual capital to ₹2,00,000 INR and clears Bitcoin database tables."""
        DB.reset_bitcoin_database()
        self.virtual_capital = self.default_capital
        DB.save_bitcoin_setting("virtual_capital", str(self.default_capital))
        DB.save_bitcoin_setting("contract_quantity", str(self.contract_quantity))
        self.active_position = None
        self.trade_ledger = []
        self.evaluation_stream = []

    def set_virtual_capital(self, capital: float):
        """Updates virtual capital amount."""
        self.virtual_capital = float(capital)
        DB.save_bitcoin_setting("virtual_capital", str(capital))

    def get_dashboard_state(self) -> Dict[str, Any]:
        """Returns complete JSON state for the /bitcoin paper trading dashboard."""
        tallies = self.calculate_pnl_tallies()

        return {
            "instrument": self.instrument_name,
            "symbol": self.symbol,
            "currency": "INR",
            "server_mode": "BITCOIN PAPER TRADING ONLY",
            "real_money": False,
            "disclaimer": "BITCOIN PAPER TRADING — NO REAL MONEY",
            "data_status_label": "DATA: REAL-TIME 24x7 CRYPTO FEED",
            "data_feed_type": "REAL-TIME 24x7 FEED",
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
        """Background continuous feed loop for Bitcoin paper engine."""
        self.is_running = True
        print("[BITCOIN ENGINE] Continuous 24x7 Bitcoin Paper Feed Loop Started.")
        while self.is_running:
            try:
                self.process_tick()
            except Exception as e:
                print(f"[BITCOIN ENGINE LOOP ERROR] {e}")
            await asyncio.sleep(5) # Poll every 5 seconds

    def stop_feed_loop(self):
        self.is_running = False

BITCOIN_ENGINE = BitcoinPaperEngine()
