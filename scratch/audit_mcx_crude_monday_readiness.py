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

def fetch_html(endpoint):
    url = f"{BASE_URL}{endpoint}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, len(resp.read())
    except Exception as e:
        return 500, str(e)

print("=== 1. HTML ROUTE CHECK (/live) ===")
status_live, len_live = fetch_html("/live")
print(f"GET /live -> HTTP {status_live} (Length: {len_live} bytes)")

print("\n=== 2. READINESS REPORT (/api/live/readiness) ===")
status_ready, data_ready = fetch_json("/api/live/readiness")
print(f"GET /api/live/readiness -> HTTP {status_ready}")
print(json.dumps(data_ready, indent=2))

print("\n=== 3. LIVE STATE REPORT (/api/live/state) ===")
status_state, data_state = fetch_json("/api/live/state")
print(f"GET /api/live/state -> HTTP {status_state}")
print(json.dumps(data_state, indent=2))

print("\n=== 4. HEALTH CHECK (/health) ===")
status_health, data_health = fetch_json("/health")
print(f"GET /health -> HTTP {status_health}")
print(json.dumps(data_health, indent=2))
