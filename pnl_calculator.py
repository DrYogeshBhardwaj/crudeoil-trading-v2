"""
P&L and Statutory Charges Calculator for MCX CRUDEOILM.
Calculates Gross P/L, Realistic Slippage, Brokerage, CTT, Exchange Fees, GST, Stamp Duty, and Net P/L.
Supports Dual P&L Tracking (Paper P&L vs Benchmark Market P&L).
"""

from dataclasses import dataclass
from config import CONFIG

@dataclass
class ChargesBreakdown:
    brokerage: float
    ctt: float
    exchange_fee: float
    gst: float
    stamp_duty: float
    slippage: float
    total_deductions: float

@dataclass
class PnLResult:
    direction: str
    quantity: int
    entry_price: float
    exit_price: float
    gross_pnl: float
    net_pnl: float
    market_movement_pnl: float   # Benchmark underlying asset price movement
    charges: ChargesBreakdown

class PnLCalculator:

    @staticmethod
    def calculate_trade_pnl(
        direction: str,
        entry_price: float,
        exit_price: float,
        quantity: int = 1
    ) -> PnLResult:
        """
        Calculates complete P/L for a closed paper trade with MCX fee breakdown.
        """
        lot_multiplier = CONFIG.LOT_SIZE * quantity

        # Gross P/L
        if direction.upper() == "BUY":
            gross_pnl = (exit_price - entry_price) * lot_multiplier
            market_movement_pnl = (exit_price - entry_price) * lot_multiplier
        else:
            gross_pnl = (entry_price - exit_price) * lot_multiplier
            market_movement_pnl = (entry_price - exit_price) * lot_multiplier

        # Turnovers
        buy_price = entry_price if direction.upper() == "BUY" else exit_price
        sell_price = exit_price if direction.upper() == "BUY" else entry_price

        buy_turnover = buy_price * lot_multiplier
        sell_turnover = sell_price * lot_multiplier
        total_turnover = buy_turnover + sell_turnover

        # 1. Brokerage (₹20 buy + ₹20 sell)
        brokerage = CONFIG.ESTIMATED_BROKERAGE_PER_ORDER * 2 * quantity

        # 2. CTT (Commodity Transaction Tax) - 0.01% on Sell Side Turnover
        ctt = sell_turnover * CONFIG.ESTIMATED_STT_CTT_PERCENT

        # 3. Exchange Turnover Fee (~0.026% on total turnover)
        exchange_fee = total_turnover * CONFIG.ESTIMATED_EXCHANGE_FEE_PERCENT

        # 4. GST (18% on Brokerage + Exchange Fee)
        gst = (brokerage + exchange_fee) * CONFIG.ESTIMATED_GST_PERCENT

        # 5. Stamp Duty (0.002% on Buy Side Turnover)
        stamp_duty = buy_turnover * CONFIG.ESTIMATED_STAMP_DUTY_PERCENT

        # 6. Realistic Slippage Estimate (2 ticks entry + 2 ticks exit = 4 ticks total)
        slippage_per_side = CONFIG.ESTIMATED_SLIPPAGE_TICKS * CONFIG.TICK_SIZE * lot_multiplier
        total_slippage = slippage_per_side * 2

        total_deductions = brokerage + ctt + exchange_fee + gst + stamp_duty + total_slippage
        net_pnl = gross_pnl - total_deductions

        charges = ChargesBreakdown(
            brokerage=round(brokerage, 2),
            ctt=round(ctt, 2),
            exchange_fee=round(exchange_fee, 2),
            gst=round(gst, 2),
            stamp_duty=round(stamp_duty, 2),
            slippage=round(total_slippage, 2),
            total_deductions=round(total_deductions, 2)
        )

        return PnLResult(
            direction=direction.upper(),
            quantity=quantity,
            entry_price=entry_price,
            exit_price=exit_price,
            gross_pnl=round(gross_pnl, 2),
            net_pnl=round(net_pnl, 2),
            market_movement_pnl=round(market_movement_pnl, 2),
            charges=charges
        )
