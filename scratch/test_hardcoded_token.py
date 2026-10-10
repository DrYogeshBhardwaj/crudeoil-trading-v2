import sys
import os
import json
import requests

sys.path.insert(0, os.path.abspath("."))

from live_trading_engine import LIVE_TEST_ENGINE

def test_engine_token():
    LIVE_TEST_ENGINE.adapter.reload_credentials()
    cid = LIVE_TEST_ENGINE.adapter.client_id
    tok = LIVE_TEST_ENGINE.adapter.access_token

    print(f"Testing LIVE_TEST_ENGINE Token...")
    print(f"Client ID present: {bool(cid)}")
    print(f"Token Length: {len(tok)}")

    headers = {
        "access-token": tok,
        "client-id": cid,
        "Content-Type": "application/json"
    }

    try:
        r = requests.get("https://api.dhan.co/v2/fundlimit", headers=headers, timeout=5)
        print(f"Fund Limit Status: HTTP {r.status_code}")
        print(f"Response: {r.text[:300]}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    test_engine_token()
