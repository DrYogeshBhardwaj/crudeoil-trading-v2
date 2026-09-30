"""
Audit Logger and Daily Performance Reporter Engine.
Logs all decisions with full AI reasons to JSON Lines.
Generates comprehensive EOD Daily Reports including P/L BY TREND STATE.
"""

import json
import os
from datetime import datetime
from typing import List, Dict, Any
from paper_engine import PaperPosition
from signal_engine import TradeSignal
from config import CONFIG

class AuditLogger:

    def __init__(self, log_dir: str = "logs"):
        self.log_dir = log_dir
        os.makedirs(self.log_dir, exist_ok=True)
        date_str = datetime.now().strftime("%Y%m%d")
        self.jsonl_file = os.path.join(self.log_dir, f"decisions_{date_str}.jsonl")

    def log_decision(self, timestamp: datetime, price: float, signal: TradeSignal, position_status: str):
        record = {
            "timestamp": timestamp.isoformat(),
            "instrument": CONFIG.INSTRUMENT_NAME,
            "price": price,
            "action": signal.action,
            "trend_state": signal.trend_state,
            "confidence": signal.confidence,
            "reasons": signal.reasons,
            "entry_price": signal.entry_price,
            "stop_loss": signal.stop_loss,
            "target_1": signal.target_1,
            "target_2": signal.target_2,
            "risk_inr": signal.risk_inr,
            "position_status": position_status
        }
        with open(self.jsonl_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")


class DailyReporter:

    @staticmethod
    def generate_report(
        date_str: str,
        total_signals: int,
        wait_signals: int,
        closed_trades: List[PaperPosition]
    ) -> Dict[str, Any]:
        """
        Generates comprehensive EOD Daily Report with P/L by Trend State breakdown.
        """
        buy_trades = [t for t in closed_trades if t.direction == "BUY"]
        sell_trades = [t for t in closed_trades if t.direction == "SELL"]
        
        winning_trades = [t for t in closed_trades if t.pnl_result and t.pnl_result.net_pnl > 0]
        losing_trades = [t for t in closed_trades if t.pnl_result and t.pnl_result.net_pnl <= 0]

        total_trades_count = len(closed_trades)
        win_rate = (len(winning_trades) / total_trades_count * 100) if total_trades_count > 0 else 0.0

        gross_profit = sum(t.pnl_result.gross_pnl for t in winning_trades if t.pnl_result)
        gross_loss = sum(abs(t.pnl_result.gross_pnl) for t in losing_trades if t.pnl_result)
        gross_pnl = gross_profit - gross_loss

        total_charges = sum(t.pnl_result.charges.total_deductions - t.pnl_result.charges.slippage for t in closed_trades if t.pnl_result)
        total_slippage = sum(t.pnl_result.charges.slippage for t in closed_trades if t.pnl_result)
        net_pnl = sum(t.pnl_result.net_pnl for t in closed_trades if t.pnl_result)

        avg_win = (gross_profit / len(winning_trades)) if winning_trades else 0.0
        avg_loss = (gross_loss / len(losing_trades)) if losing_trades else 0.0

        largest_win = max([t.pnl_result.net_pnl for t in closed_trades if t.pnl_result], default=0.0)
        largest_loss = min([t.pnl_result.net_pnl for t in closed_trades if t.pnl_result], default=0.0)

        profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else (gross_profit if gross_profit > 0 else 1.0)
        expectancy = (net_pnl / total_trades_count) if total_trades_count > 0 else 0.0

        # Maximum Drawdown calculation
        peak = 0.0
        cum_pnl = 0.0
        max_dd = 0.0
        for t in closed_trades:
            if t.pnl_result:
                cum_pnl += t.pnl_result.net_pnl
                if cum_pnl > peak:
                    peak = cum_pnl
                dd = peak - cum_pnl
                if dd > max_dd:
                    max_dd = dd

        # P/L BY TREND STATE BREAKDOWN
        trend_states = ["STRONG UP", "UP", "RANGE", "DOWN", "STRONG DOWN"]
        trend_performance = {}
        for state in trend_states:
            state_trades = [t for t in closed_trades if t.trend_state == state]
            state_net_pnl = sum(t.pnl_result.net_pnl for t in state_trades if t.pnl_result)
            state_wins = len([t for t in state_trades if t.pnl_result and t.pnl_result.net_pnl > 0])
            trend_performance[state] = {
                "trades": len(state_trades),
                "wins": state_wins,
                "net_pnl": round(state_net_pnl, 2)
            }

        report = {
            "date": date_str,
            "instrument": CONFIG.INSTRUMENT_NAME,
            "total_signals_generated": total_signals,
            "trades_taken": total_trades_count,
            "buy_trades": len(buy_trades),
            "sell_trades": len(sell_trades),
            "wait_signals": wait_signals,
            "winning_trades": len(winning_trades),
            "losing_trades": len(losing_trades),
            "win_rate_percent": round(win_rate, 2),
            "gross_profit": round(gross_profit, 2),
            "gross_loss": round(gross_loss, 2),
            "gross_pnl": round(gross_pnl, 2),
            "estimated_charges": round(total_charges, 2),
            "estimated_slippage": round(total_slippage, 2),
            "net_pnl": round(net_pnl, 2),
            "average_win": round(avg_win, 2),
            "average_loss": round(avg_loss, 2),
            "largest_win": round(largest_win, 2),
            "largest_loss": round(largest_loss, 2),
            "max_drawdown": round(max_dd, 2),
            "profit_factor": round(profit_factor, 2),
            "expectancy": round(expectancy, 2),
            "trend_performance": trend_performance
        }
        return report

    @staticmethod
    def print_markdown_report(report: Dict[str, Any]) -> str:
        """Formats report as clean ASCII markdown string."""
        md = []
        md.append(f"## AI PAPER TRADING DAILY REPORT ({report['date']})")
        md.append(f"Instrument: {report['instrument']} | Real Trading: DISABLED (PAPER TRADING ONLY)")
        md.append("")
        md.append("### Summary Metrics")
        md.append(f"- Total Signals: {report['total_signals_generated']} | WAIT Signals: {report['wait_signals']}")
        md.append(f"- Trades Taken: {report['trades_taken']} (BUY: {report['buy_trades']} | SELL: {report['sell_trades']})")
        md.append(f"- Win Rate: {report['win_rate_percent']}% ({report['winning_trades']} Win / {report['losing_trades']} Loss)")
        md.append(f"- Gross P/L: Rs.{report['gross_pnl']:,.2f} (Profit: Rs.{report['gross_profit']:,.2f} | Loss: Rs.{report['gross_loss']:,.2f})")
        md.append(f"- Estimated Charges: Rs.{report['estimated_charges']:,.2f} | Estimated Slippage: Rs.{report['estimated_slippage']:,.2f}")
        md.append(f"- NET P/L: Rs.{report['net_pnl']:,.2f}")
        md.append(f"- Profit Factor: {report['profit_factor']} | Max Drawdown: Rs.{report['max_drawdown']:,.2f} | Expectancy: Rs.{report['expectancy']:,.2f}")
        md.append("")
        md.append("### Trend Performance Breakdown (P/L by Trend State)")
        md.append("| Trend State | Trades | Wins | Net P/L |")
        md.append("| :--- | :---: | :---: | :--- |")
        for state, perf in report['trend_performance'].items():
            pnl_str = f"Rs.{perf['net_pnl']:,.2f}"
            md.append(f"| {state} | {perf['trades']} | {perf['wins']} | {pnl_str} |")
        return "\n".join(md)
