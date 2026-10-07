import requests
import json

url = "https://crudeoil-trading-v2-production.up.railway.app/api/bitcoin-live-status"

try:
    r = requests.get(url, timeout=10)
    print(f"HTTP Status: {r.status_code}")
    if r.status_code == 200:
        data = r.json()
        print("=== BITCOIN LIVE ENGINE STATUS ===")
        print(json.dumps(data, indent=2))
    else:
        print(r.text)
except Exception as e:
    print(f"Error checking Bitcoin status: {e}")

