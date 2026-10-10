import requests
import json

def reset_railway_mcx_silver():
    url = "https://crudeoil-trading-v2-production.up.railway.app/api/mcx-silver/reset"
    print(f"Calling POST {url} to clear old pre-deployment active position...")
    try:
        r = requests.post(url, timeout=10)
        print(f"HTTP Status: {r.status_code}")
        print(f"Response: {r.text}")
    except Exception as e:
        print(f"Exception: {e}")

if __name__ == "__main__":
    reset_railway_mcx_silver()
