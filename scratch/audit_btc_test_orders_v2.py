import requests
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

prod_url = "https://crudeoil-trading-v2-production.up.railway.app"

print("=== BITCOIN LIVE ENGINE PRODUCTION STATE ===")
try:
    resp = requests.get(f"{prod_url}/api/bitcoin/live/state", timeout=10)
    print(f"Status Code: {resp.status_code}")
    data = resp.json()
    print("Live Trading Enabled:", data.get("live_trading_enabled"))
    print("Active Position:", json.dumps(data.get("active_position"), indent=2))
    print("Today Realized PnL:", data.get("today_realized_pnl"))
    print("Total Net Realized PnL:", data.get("total_net_realized_pnl"))
    print("Trade History Count:", len(data.get("trade_history", [])))
    print("\nRecent 10 Trades in History:")
    for t in data.get("trade_history", [])[:10]:
        print(f"  ID: {t.get('trade_id') or t.get('id')} | Side: {t.get('side') or t.get('direction')} | Entry: {t.get('entry_price')} | Exit: {t.get('exit_price')} | Net PnL: {t.get('net_pnl')} | Status: {t.get('status')} | Time: {t.get('entry_timestamp') or t.get('timestamp')}")
except Exception as e:
    print("Error fetching bitcoin live state:", e)
