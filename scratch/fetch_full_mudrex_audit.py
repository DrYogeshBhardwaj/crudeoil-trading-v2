import requests
import json
import time

url = "https://crudeoil-trading-v2-production.up.railway.app/api/debug/audit-mudrex-full"

print(f"Polling {url}...")
for attempt in range(1, 10):
    try:
        r = requests.get(url, timeout=15)
        print(f"Attempt {attempt}: Status {r.status_code}")
        if r.status_code == 200:
            data = r.json()
            with open("scratch/mudrex_full_audit_response.json", "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            print("Successfully saved scratch/mudrex_full_audit_response.json")
            break
    except Exception as e:
        print(f"Attempt {attempt} error: {e}")
    time.sleep(5)
