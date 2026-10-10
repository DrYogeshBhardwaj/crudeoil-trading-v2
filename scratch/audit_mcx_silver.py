import os
import json
import requests

def audit_dhan_api():
    print("=== DHAN API LIVE AUDIT FOR MCX SILVER MINI ===")
    
    # Check credentials
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
                print(f"Error reading dhan_credentials.json: {e}")

    has_client_id = bool(client_id)
    has_access_token = bool(access_token)
    
    print(f"Client ID present: {has_client_id}")
    print(f"Access Token present: {has_access_token}")
    
    if not (has_client_id and has_access_token):
        print("RESULT: Dhan API credentials MISSING or incomplete.")
        return

    headers = {
        "access-token": access_token,
        "client-id": client_id,
        "Content-Type": "application/json"
    }

    # 1. Check Fund Limit / Ledger API
    try:
        r_fund = requests.get("https://api.dhan.co/v2/fundlimit", headers=headers, timeout=5)
        print(f"Fund Limit API status code: {r_fund.status_code}")
        if r_fund.status_code == 200:
            fjson = r_fund.status_code
            fund_data = r_fund.json().get("data", {})
            avail_margin = fund_data.get("availabelBalance") or fund_data.get("availableBalance") or fund_data.get("sodLimit") or 0.0
            print(f"Dhan Account Auth: SUCCESS (Available Margin/Balance: ₹{avail_margin})")
        else:
            print(f"Dhan Account Auth FAILED: HTTP {r_fund.status_code} - {r_fund.text[:200]}")
    except Exception as e:
        print(f"Fund Limit API Error: {e}")

    # 2. Check Quote API for Security ID 483080
    try:
        quote_payload = {"MCX_COMM": [483080]}
        r_quote = requests.post("https://api.dhan.co/v2/marketfeed/quote", headers=headers, json=quote_payload, timeout=5)
        print(f"Quote API (483080) status code: {r_quote.status_code}")
        if r_quote.status_code == 200:
            qdata = r_quote.json()
            print(f"Quote API Response for 483080: {json.dumps(qdata)[:300]}")
        else:
            print(f"Quote API Error: HTTP {r_quote.status_code} - {r_quote.text[:200]}")
    except Exception as e:
        print(f"Quote API Error: {e}")

    # 3. Check Order Book / Tradebook / Positions API endpoints availability (read-only GET)
    try:
        r_pos = requests.get("https://api.dhan.co/v2/positions", headers=headers, timeout=5)
        print(f"Positions API status code: {r_pos.status_code}")
        r_orders = requests.get("https://api.dhan.co/v2/orders", headers=headers, timeout=5)
        print(f"Orders API status code: {r_orders.status_code}")
    except Exception as e:
        print(f"Read-only API error: {e}")

if __name__ == "__main__":
    audit_dhan_api()
