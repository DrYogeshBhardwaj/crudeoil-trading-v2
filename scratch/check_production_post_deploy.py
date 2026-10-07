import urllib.request
import json
import time

url_state = "https://crudeoil-trading-v2-production.up.railway.app/api/bitcoin/live/state"

print("Waiting for Railway deployment to update...")
for attempt in range(1, 12):
    try:
        req = urllib.request.Request(url_state, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            print(f"\n--- ATTEMPT #{attempt} RESPONSE ---")
            print(f"Price Source: {data.get('price_source')}")
            print(f"BTC USD Price: ${data.get('mudrex_btc_usd_price')}")
            print(f"Hedge Rate: {data.get('mudrex_hedge_rate')} INR/USDT")
            print(f"BTC INR Price: Rs.{data.get('btc_price'):,.2f}" if data.get('btc_price') else "None")
            pos = data.get('active_position')
            if pos:
                print(f"Active Pos ID: {pos.get('trade_id')}")
                print(f"Mudrex Pos ID: {pos.get('mudrex_position_id')}")
                print(f"Direction: {pos.get('direction')}")
                print(f"Quantity: {pos.get('quantity')} BTC")
                print(f"Entry USD: ${pos.get('entry_price_usd')}")
                print(f"Hedge Rate: {pos.get('hedge_rate')}")
                print(f"Target USD: ${pos.get('target_usd')}")
                print(f"Stop Loss USD: ${pos.get('stop_loss_usd')}")
                print(f"Target INR: Rs.{pos.get('target'):,.2f}" if pos.get('target') else "None")
                print(f"Stop Loss INR: Rs.{pos.get('stop_loss'):,.2f}" if pos.get('stop_loss') else "None")
                print(f"Current Net PnL: Rs.{data.get('unrealized_net_pnl'):,.2f}" if data.get('unrealized_net_pnl') is not None else "None")
                print(f"Status: {pos.get('status')}")
            else:
                print("Active Position: NONE")
            
            if data.get('price_source') and 'Mudrex' in str(data.get('price_source')):
                print("\n[SUCCESS] Railway production is running the corrected Mudrex Futures code!")
                break
    except Exception as e:
        print(f"Attempt #{attempt} error: {e}")
    time.sleep(5)
