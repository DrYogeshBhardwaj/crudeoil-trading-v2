import urllib.request
import json

url_state = "https://crudeoil-trading-v2-production.up.railway.app/api/bitcoin/live/state"

try:
    req = urllib.request.Request(url_state, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode('utf-8'))
        print("--- SUMMARY STATE ---")
        print(f"price_source: {data.get('price_source')}")
        print(f"mudrex_btc_usd_price: {data.get('mudrex_btc_usd_price')}")
        print(f"mudrex_hedge_rate: {data.get('mudrex_hedge_rate')}")
        print(f"btc_price (INR): {data.get('btc_price')}")
        print(f"unrealized_gross_pnl: {data.get('unrealized_gross_pnl')}")
        print(f"total_charges: {data.get('total_charges')}")
        print(f"unrealized_net_pnl: {data.get('unrealized_net_pnl')}")
        print("\n--- ACTIVE POSITION ---")
        print(json.dumps(data.get('active_position'), indent=2))
except Exception as e:
    print(f"Error querying state API: {e}")
