import json
import requests

url = "https://crudeoil-trading-v2-production.up.railway.app/api/debug/audit-mudrex-full"
r = requests.get(url, timeout=15)
if r.status_code == 200:
    data = r.json()
    db = data.get("db_trades", {})
    trades = db.get("bitcoin_live_trades") or []
    print(f"Total Trades in DB: {len(trades)}")
    for t in trades[:6]:
        print(json.dumps(t, indent=2))

