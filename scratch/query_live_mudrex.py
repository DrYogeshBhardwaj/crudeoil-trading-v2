import requests
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

PROD_URL = "https://crudeoil-trading-v2-production.up.railway.app"

def query_endpoint(endpoint):
    url = f"{PROD_URL}{endpoint}"
    print(f"\n==========================================")
    print(f"QUERYING: {url}")
    print(f"==========================================")
    try:
        resp = requests.get(url, timeout=15)
        print(f"Status Code: {resp.status_code}")
        try:
            data = resp.json()
            print(json.dumps(data, indent=2))
            return data
        except Exception:
            print(resp.text)
            return resp.text
    except Exception as e:
        print(f"Error querying {url}: {e}")
        return None

def main():
    # 1. Check Mudrex test/diagnostic endpoint
    mudrex_diag = query_endpoint("/api/debug/test-mudrex")
    
    # 2. Check Bitcoin Live State (dashboard state)
    live_state = query_endpoint("/api/bitcoin/live/state")
    
    # 3. Check Bitcoin Live Preflight
    preflight = query_endpoint("/api/bitcoin/live/preflight")

if __name__ == "__main__":
    main()
