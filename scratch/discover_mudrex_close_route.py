import os
import requests
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

def main():
    api_secret = (
        os.environ.get("MUDREX_API_SECRET") or 
        os.environ.get("MUDREX_SECRET") or 
        os.environ.get("MUDREX_SECRET_KEY") or ""
    ).strip()
    
    api_key = (
        os.environ.get("MUDREX_API_KEY") or 
        os.environ.get("MUDREX_KEY") or ""
    ).strip()

    print("MUDREX_API_SECRET present locally:", bool(api_secret))
    print("MUDREX_API_KEY present locally:", bool(api_key))

    headers = {
        "X-Authentication": api_secret,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0"
    }
    if api_key:
        headers["X-Api-Key"] = api_key

    position_id = "01a1067d-f252-7e89-91da-9b03be176bfe"
    base_url = "https://trade.mudrex.com/fapi/v1"

    candidates = [
        ("DELETE", f"{base_url}/futures/positions/{position_id}?trade_currency=INR"),
        ("DELETE", f"{base_url}/futures/positions/{position_id}"),
        ("POST", f"{base_url}/futures/positions/{position_id}/close"),
        ("POST", f"{base_url}/futures/positions/close"),
        ("POST", f"{base_url}/futures/positions/{position_id}/exit"),
        ("DELETE", f"{base_url}/futures/positions?position_id={position_id}&trade_currency=INR"),
        ("DELETE", f"{base_url}/futures/position/{position_id}"),
        ("POST", f"https://trade.mudrex.com/fapi/v2/futures/positions/{position_id}/close"),
        ("DELETE", f"https://trade.mudrex.com/fapi/v2/futures/positions/{position_id}"),
        ("POST", f"https://trade.mudrex.com/fapi/v2/futures/order?symbol=BTCUSDT"),
    ]

    for method, url in candidates:
        try:
            # First send OPTIONS to check path existence without side-effects
            r_opt = requests.options(url, headers=headers, timeout=5)
            print(f"OPTIONS {url} -> {r_opt.status_code} | Allow: {r_opt.headers.get('Allow')}")
        except Exception as e:
            print(f"OPTIONS {url} -> Error: {e}")

if __name__ == "__main__":
    main()
