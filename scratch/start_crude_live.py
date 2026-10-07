import requests
import json

url = "https://crudeoil-trading-v2-production.up.railway.app/api/live/start_test"

try:
    r = requests.post(url, timeout=10)
    print(f"HTTP Status: {r.status_code}")
    print(r.text)
except Exception as e:
    print(f"Error starting MCX Crude live test: {e}")

