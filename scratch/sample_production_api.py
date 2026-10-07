import urllib.request
import json
import time
import datetime

url = "https://crudeoil-trading-v2-production.up.railway.app/api/bitcoin/live/state"

print("=== 6 CONSECUTIVE PRODUCTION API SAMPLES (3s interval) ===", flush=True)
for i in range(6):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    t = datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            d = json.loads(resp.read().decode('utf-8'))
            pos = d.get("active_position") or {}
            print(f"[{t}] Sample #{i+1}:", flush=True)
            print(f"  Mudrex USD Price: ${d.get('mudrex_btc_usd_price')}", flush=True)
            print(f"  BTC INR Equiv:   Rs.{d.get('btc_price')}", flush=True)
            print(f"  Gross PnL:       Rs.{d.get('current_unrealized_gross_pnl')}", flush=True)
            print(f"  Net PnL:         Rs.{d.get('current_unrealized_net_pnl')}", flush=True)
            print(f"  Est Charges:     Rs.{d.get('current_estimated_charges')}", flush=True)
            print(f"  Entry Price:     Rs.{pos.get('entry_price')} (${pos.get('entry_price_usd')})", flush=True)
            print(f"  Target INR:      Rs.{pos.get('target')}", flush=True)
            print(f"  Stop Loss INR:   Rs.{pos.get('stop_loss')}", flush=True)
    except Exception as e:
        print(f"[{t}] Error: {e}", flush=True)
    time.sleep(3)
