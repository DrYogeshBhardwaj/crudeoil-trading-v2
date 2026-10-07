import urllib.request
import json
import time

url_state = "https://crudeoil-trading-v2-production.up.railway.app/api/live/state"
url_diag = "https://crudeoil-trading-v2-production.up.railway.app/api/debug/db_diagnostic"

print("Polling Railway production deployment for commit 7735ee2...")

for attempt in range(1, 25):
    try:
        req_diag = urllib.request.Request(url_diag, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req_diag, timeout=10) as resp:
            data_diag = json.loads(resp.read().decode("utf-8"))
            commit = data_diag.get("git_commit", "UNKNOWN")
            print(f"[{attempt}] Railway running git commit: {commit}")
            if "7735ee2" in commit or "7735e" in commit:
                print(">>> Commit 7735ee2 is LIVE on Railway!")
                break
    except Exception as e:
        print(f"[{attempt}] Error checking diagnostic: {e}")
    time.sleep(5)

print("\n--- Fetching Live State from Production ---")
try:
    req_state = urllib.request.Request(url_state, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req_state, timeout=10) as resp:
        data_state = json.loads(resp.read().decode("utf-8"))
        print(json.dumps(data_state, indent=2))
except Exception as e:
    print(f"Error checking live state: {e}")
