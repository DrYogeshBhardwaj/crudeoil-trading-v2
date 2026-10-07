import urllib.request
import json
import time

BASE_URL = "https://crudeoil-trading-v2-production.up.railway.app"

def fetch_json(endpoint):
    url = f"{BASE_URL}{endpoint}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        return 500, {"error": str(e)}

print("=== 1. READINESS REPORT (/api/live/readiness) ===")
status_ready, data_ready = fetch_json("/api/live/readiness")
print(f"HTTP {status_ready}")
print(json.dumps(data_ready, indent=2))

print("\n=== 2. LIVE STATE REPORT (/api/live/state) ===")
status_state, data_state = fetch_json("/api/live/state")
print(f"HTTP {status_state}")
print(json.dumps(data_state, indent=2))
