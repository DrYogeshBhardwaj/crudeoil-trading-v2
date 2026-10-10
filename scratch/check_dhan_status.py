import sys
import os
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__) + "/.."))

import json
import requests
from mcx_silver_paper_engine import MCX_SILVER_ENGINE, calculate_dhan_mcx_silver_charges

print("--- 1. ENVIRONMENT & CONFIGURATION ---")
print("ENABLE_LIVE_TRADING_SILVER:", os.environ.get("ENABLE_LIVE_TRADING_SILVER"))
print("ENABLE_LIVE_TRADING:", os.environ.get("ENABLE_LIVE_TRADING"))
print("Engine ENABLE_LIVE_TRADING property:", MCX_SILVER_ENGINE.ENABLE_LIVE_TRADING)

client_id, access_token = MCX_SILVER_ENGINE._get_dhan_credentials()
print("Dhan Client ID:", repr(client_id))
print("Dhan Access Token Present:", bool(access_token))
if access_token:
    print("Dhan Access Token Length:", len(access_token))
    print("Dhan Access Token Snippet:", access_token[:8] + "..." if len(access_token) > 8 else access_token)

print("\n--- 2. DHAN API READ-ONLY MARGIN / FUNDLIMIT CHECK ---")
margin, margin_status = MCX_SILVER_ENGINE.fetch_dhan_live_margin()
print("Fetched Dhan Margin:", margin)
print("Dhan Margin Status:", margin_status)

print("\n--- 3. PRICE FEED CHECK ---")
price = MCX_SILVER_ENGINE.fetch_market_price()
print("Current Price (INR):", price)
print("Price Source:", MCX_SILVER_ENGINE.price_source)
print("Is Synthetic Feed:", MCX_SILVER_ENGINE.is_synthetic_feed)
print("Price Feed Quality:", MCX_SILVER_ENGINE.price_feed_quality)
print("Is Price Stale:", MCX_SILVER_ENGINE.is_price_stale)
print("Is Real MCX Price Valid for Live Execution:", MCX_SILVER_ENGINE.is_real_mcx_price_valid_for_live_execution())

print("\n--- 4. DASHBOARD STATE SUMMARY ---")
state = MCX_SILVER_ENGINE.get_dashboard_state()
keys_to_show = [
    "timestamp", "instrument", "enable_live_trading", "auto_paper_trading_enabled",
    "is_synthetic_feed", "price_feed_quality", "is_real_mcx_price_valid_for_live_execution",
    "price_source", "dhan_margin_balance_inr", "dhan_margin_status", "market_open",
    "current_price_inr", "starting_capital_inr", "account_capital_inr", "system_status"
]
for k in keys_to_show:
    print(f"  {k}: {state.get(k)}")

print("\n--- 5. ACTIVE POSITION IN ENGINE ---")
print("Active Position:", json.dumps(state.get("active_position"), indent=2))

print("\n--- 6. TRADE HISTORY COUNT ---")
print("Trade History Count:", len(state.get("trade_history", [])))
if state.get("trade_history"):
    print("Trade History Sample:", json.dumps(state.get("trade_history")[:3], indent=2))
