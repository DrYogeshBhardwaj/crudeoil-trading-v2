import os
import sys
import requests
import json
import time

sys.path.insert(0, os.path.abspath(os.path.dirname(__file__) + "/.."))

print("=== READ-ONLY BTC PRICE DIAGNOSTIC ===")

# 1. Engine Feed (Yahoo Finance BTC-INR)
try:
    r_yf = requests.get("https://query1.finance.yahoo.com/v8/finance/chart/BTC-INR?interval=1m&range=1d", headers={"User-Agent": "Mozilla/5.0"}, timeout=10).json()
    yf_price = r_yf['chart']['result'][0]['meta']['regularMarketPrice']
    print(f"1. Yahoo Finance (BTC-INR) direct quote: INR {yf_price:,.2f}")
except Exception as e:
    print(f"1. Yahoo Finance error: {e}")

# 2. Binance Raw BTCUSDT (USD)
binance_btc_usd = 0.0
try:
    r_bin = requests.get("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", timeout=10).json()
    binance_btc_usd = float(r_bin.get("price", 0))
    print(f"2. Binance BTCUSDT Raw (USD): ${binance_btc_usd:,.2f}")
except Exception as e:
    print(f"2. Binance error: {e}")

# 3. Yahoo Finance USDINR=X rate
usdinr_rate = 0.0
try:
    r_fx = requests.get("https://query1.finance.yahoo.com/v8/finance/chart/USDINR=X?interval=1m&range=1d", headers={"User-Agent": "Mozilla/5.0"}, timeout=10).json()
    usdinr_rate = r_fx['chart']['result'][0]['meta']['regularMarketPrice']
    print(f"3. Yahoo Finance USDINR=X Rate: Rs.{usdinr_rate:.4f}")
except Exception as e:
    print(f"3. USDINR error: {e}")

if binance_btc_usd > 0 and usdinr_rate > 0:
    calc_inr = binance_btc_usd * usdinr_rate
    print(f"4. Calculated (Binance BTCUSDT USD * USDINR rate): Rs.{calc_inr:,.2f}")

# 5. Mudrex API Direct Queries using Adapter headers
from bitcoin_live_engine import MudrexLiveAdapter
adapter = MudrexLiveAdapter()
headers = adapter._get_headers()

# Mudrex Futures Asset Details
try:
    ast_url = f"{adapter.BASE_URL}/futures/BTCUSDT?is_symbol"
    r_ast = requests.get(ast_url, headers=headers, timeout=10).json()
    print("\n--- Mudrex Futures BTCUSDT Asset Details ---")
    print(json.dumps(r_ast, indent=2))
except Exception as e:
    print(f"Mudrex Asset error: {e}")

# Mudrex Futures Open Positions (Real Entry & Mark Price on Mudrex)
try:
    pos_url = f"{adapter.BASE_URL}/futures/positions?trade_currency=INR"
    r_pos = requests.get(pos_url, headers=headers, timeout=10).json()
    print("\n--- Mudrex Futures Open Positions ---")
    print(json.dumps(r_pos, indent=2))
except Exception as e:
    print(f"Mudrex Positions error: {e}")

# 6. Railway Live State Endpoint
try:
    r_rail = requests.get("https://crudeoil-trading-v2-production.up.railway.app/api/bitcoin/live/state", timeout=10).json()
    print("\n--- Railway Live State Engine Output ---")
    print(f"Engine btc_price: INR {r_rail.get('btc_price'):,.2f}")
    if r_rail.get("active_position"):
        print(f"Active Position Entry Price: INR {r_rail.get('active_position').get('entry_price'):,.2f}")
except Exception as e:
    print(f"Railway State error: {e}")
