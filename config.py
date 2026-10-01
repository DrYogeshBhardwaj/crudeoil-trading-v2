"""
Configuration settings for AI Trend Detector & Paper Trading Engine V1 (CRUDEOILM).
STRICTLY PAPER TRADING ONLY. REAL TRADING EXECUTION IS HARDCODED TO DISABLED.
"""

from dataclasses import dataclass

@dataclass(frozen=True)
class TradingConfig:
    # Instrument Details
    INSTRUMENT_NAME: str = "CRUDEOILM"
    EXCHANGE: str = "MCX"
    EXCHANGE_SEGMENT: str = "MCX_FO"
    DHAN_SECURITY_ID: str = "545802"
    CONTRACT_EXPIRY: str = "19-OCT-2026"
    DATA_SOURCE_NAME: str = "Dhan HQ Live Market Feed WebSocket (wss://api-feed.dhan.co)"
    LOT_SIZE: int = 10  # 1 lot CRUDEOILM = 10 barrels
    TICK_SIZE: float = 1.0
    
    # SAFETY LOCK: REAL TRADING EXECUTION IS STRICTLY DISABLED
    ENABLE_REAL_TRADING: bool = False
    
    # Virtual Capital Account
    STARTING_VIRTUAL_CAPITAL_INR: float = 200000.0  # Rs. 2,00,000 Starting Virtual Capital
    
    # Risk Management Rules
    MAX_RISK_PER_TRADE_INR: float = 2500.0  # Max Rs.2,500 risk per trade
    DAILY_LOSS_LIMIT_INR: float = 3000.0     # Max Rs.3,000 daily loss -> Auto PAUSE
    PROFIT_CAP_MODE: str = "OPTIONAL"        # Configurable optional profit cap
    MAX_LOTS: int = 1                        # Max 1 lot at any time
    ALLOW_AVERAGING: bool = False             # No averaging
    ALLOW_MARTINGALE: bool = False            # No martingale
    
    # Execution & Charges Estimation
    ESTIMATED_SLIPPAGE_TICKS: int = 2        # 2 ticks (Rs.2.0 per barrel = Rs.20 per lot)
    ESTIMATED_BROKERAGE_PER_ORDER: float = 20.0 # Rs.20 per order (Rs.40 roundtrip)
    ESTIMATED_STT_CTT_PERCENT: float = 0.0001 # 0.01% CTT on sell side
    ESTIMATED_EXCHANGE_FEE_PERCENT: float = 0.00026 # ~0.026% exchange charges
    ESTIMATED_GST_PERCENT: float = 0.18      # 18% GST on brokerage + exchange fee
    ESTIMATED_STAMP_DUTY_PERCENT: float = 0.00002 # 0.002% stamp duty on buy side
    
    # Technical Parameters
    EMA_FAST: int = 20
    EMA_SLOW: int = 50
    ADX_PERIOD: int = 14
    ADX_TREND_THRESHOLD: float = 25.0
    ATR_PERIOD: int = 14
    ATR_SL_MULTIPLIER: float = 1.2
    MIN_RR_RATIO: float = 1.5
    
    # Session & Timing Rules (IST)
    MARKET_OPEN_TIME: str = "09:00:00"
    MARKET_CLOSE_TIME: str = "23:30:00"      # Standard MCX Close (23:55 in DST)
    NO_NEW_ENTRY_TIME: str = "23:00:00"
    EOD_SQUAREOFF_TIME: str = "23:15:00"
    DATA_STALE_THRESHOLD_SECONDS: float = 10.0

CONFIG = TradingConfig()
