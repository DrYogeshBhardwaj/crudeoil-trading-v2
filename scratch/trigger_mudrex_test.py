import requests
import time
import json
import sys

url = "https://crudeoil-trading-v2-production.up.railway.app/api/debug/test-mudrex"

print("Triggering Server-Side Mudrex Read-Only Auth Test using Railway Environment Variables...", flush=True)

for attempt in range(1, 12):
    try:
        r = requests.post(url, json={}, timeout=30)
        if r.status_code == 200:
            print("SUCCESS! Server-side Mudrex Test Response:", flush=True)
            data = r.json()
            print(json.dumps(data, indent=2), flush=True)
            break
        else:
            print(f"Attempt {attempt}: HTTP status {r.status_code} - {r.text[:200]}", flush=True)
    except Exception as e:
        print(f"Attempt {attempt}: Waiting... ({e})", flush=True)
    time.sleep(4)
