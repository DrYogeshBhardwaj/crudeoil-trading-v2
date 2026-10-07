import requests
import json

url = "https://crudeoil-trading-v2-production.up.railway.app/api/bitcoin/live/state"

try:
    r = requests.get(url, timeout=10)
    print(f"HTTP Status: {r.status_code}")
    if r.status_code == 200:
        data = r.json()
        print("=== PRODUCTION BITCOIN LIVE STATE JSON ===")
        print(json.dumps(data, indent=2))
except Exception as e:
    print(f"Error checking state: {e}")

