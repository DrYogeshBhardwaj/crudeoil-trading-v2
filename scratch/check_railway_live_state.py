import requests
import json

def check_railway_deployed_state():
    print("==================================================")
    print("  RAILWAY DEPLOYED SERVER LIVE AUDIT CHECK")
    print("==================================================")
    
    url = "https://crudeoil-trading-v2-production.up.railway.app/api/mcx-silver/state"
    print(f"Querying Railway endpoint: {url}...")
    
    try:
        r = requests.get(url, timeout=10)
        print(f"HTTP Status: {r.status_code}")
        if r.status_code == 200:
            data = r.json()
            print("\nRailway MCX Silver State Response:")
            print(json.dumps(data, indent=2))
        else:
            print(f"Error Response: {r.text[:300]}")
    except Exception as e:
        print(f"Connection Exception: {e}")

if __name__ == "__main__":
    check_railway_deployed_state()
