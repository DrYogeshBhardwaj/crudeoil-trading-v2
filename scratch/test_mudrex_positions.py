import sys
import os
sys.path.insert(0, os.path.abspath("."))
import requests
import json
from bitcoin_live_engine import MudrexLiveAdapter

adapter = MudrexLiveAdapter()
positions = adapter.fetch_open_positions()
print("Direct adapter.fetch_open_positions() result:")
print(json.dumps(positions, indent=2))

headers = adapter._get_headers()
url = f"{adapter.BASE_URL}/futures/positions?trade_currency=INR"
resp = requests.get(url, headers=headers, timeout=10)
print("\nRaw GET /futures/positions?trade_currency=INR response:")
print(f"Status: {resp.status_code}")
print(resp.text)
