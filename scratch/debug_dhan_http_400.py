import requests
import json
import os

def debug_dhan_endpoints():
    print("=== DHAN API HTTP 400 DEBUGGER ===")
    
    # Try reading credentials from dhan_credentials.json or environment
    client_id = os.environ.get("DHAN_CLIENT_ID", "").strip()
    access_token = os.environ.get("DHAN_ACCESS_TOKEN", "").strip()
    
    if not client_id or not access_token:
        if os.path.exists("dhan_credentials.json"):
            try:
                with open("dhan_credentials.json", "r") as f:
                    ddata = json.load(f)
                    client_id = client_id or ddata.get("DHAN_CLIENT_ID", "").strip()
                    access_token = access_token or ddata.get("DHAN_ACCESS_TOKEN", "").strip()
            except Exception as e:
                print(f"Error reading local credentials: {e}")

    print(f"Client ID length: {len(client_id)}")
    print(f"Access Token length: {len(access_token)}")

    if not client_id or not access_token:
        print("Credentials missing locally!")
        return

    # Test Header Variations
    headers_v1 = {
        "access-token": access_token,
        "client-id": client_id,
        "Content-Type": "application/json"
    }
    
    headers_v2 = {
        "access-token": access_token,
        "client-id": client_id,
        "Accept": "application/json",
        "Content-Type": "application/json"
    }

    endpoints = [
        ("GET", "https://api.dhan.co/v2/fundlimit"),
        ("GET", "https://api.dhan.co/fundlimit"),
        ("POST", "https://api.dhan.co/v2/marketfeed/quote"),
        ("GET", "https://api.dhan.co/v2/positions"),
        ("GET", "https://api.dhan.co/v2/orders")
    ]

    for method, url in endpoints:
        try:
            if method == "GET":
                r = requests.get(url, headers=headers_v1, timeout=5)
            else:
                r = requests.post(url, headers=headers_v1, json={"MCX_COMM": [483080]}, timeout=5)
            print(f"\nEndpoint: {method} {url}")
            print(f"Status Code: {r.status_code}")
            print(f"Response: {r.text[:300]}")
        except Exception as e:
            print(f"Exception for {url}: {e}")

if __name__ == "__main__":
    debug_dhan_endpoints()
