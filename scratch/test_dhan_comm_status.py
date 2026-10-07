import requests
import json

url = "https://crudeoil-trading-v2-production.up.railway.app/api/debug/dhan-quote"

try:
    r = requests.get(url, timeout=10)
    print(f"HTTP Status: {r.status_code}")
    print(r.text)
except Exception as e:
    print(f"Error fetching Dhan quote debug: {e}")

