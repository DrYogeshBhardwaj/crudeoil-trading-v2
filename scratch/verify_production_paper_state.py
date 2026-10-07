import requests
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

prod_url = "https://crudeoil-trading-v2-production.up.railway.app"

print("=== SILVER PAPER ENGINE PRODUCTION STATE ===")
try:
    resp = requests.get(f"{prod_url}/api/silver/state", timeout=10)
    print(f"Status Code: {resp.status_code}")
    data = resp.json()
    print("Paper Mode:", data.get("paper_mode"))
    print("Live Trading Enabled:", data.get("live_trading_enabled"))
    print("Current Price USD:", data.get("silver_price_usd"))
    print("Scanner Status:", data.get("scanner_status"))
    print("Latest Evaluation:", json.dumps(data.get("latest_evaluation"), indent=2))
except Exception as e:
    print("Error fetching Silver state:", e)

print("\n=== MUDREX CRUDE PAPER ENGINE PRODUCTION STATE ===")
try:
    resp = requests.get(f"{prod_url}/api/mudrex-crude/state", timeout=10)
    print(f"Status Code: {resp.status_code}")
    data = resp.json()
    print("Paper Mode:", data.get("paper_mode"))
    print("Live Trading Enabled:", data.get("live_trading_enabled"))
    print("Current Price USD:", data.get("crude_price_usd"))
    print("Scanner Status:", data.get("scanner_status"))
    print("Latest Evaluation:", json.dumps(data.get("latest_evaluation"), indent=2))
except Exception as e:
    print("Error fetching Crude state:", e)
