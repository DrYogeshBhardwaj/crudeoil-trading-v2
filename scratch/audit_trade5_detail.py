import json
import sqlite3
import os
import requests

def get_db_path():
    if os.environ.get("DATABASE_PATH"):
        return os.environ["DATABASE_PATH"]
    if os.path.exists("/data/trading.db"):
        return "/data/trading.db"
    return "trading.db"

# Query local database or production audit endpoint
url = "https://crudeoil-trading-v2-production.up.railway.app/api/debug/audit-mudrex-full"

print("Fetching full production audit data...")
r = requests.get(url, timeout=15)
if r.status_code == 200:
    audit_data = r.json()
    with open("scratch/mudrex_full_audit_response.json", "w", encoding="utf-8") as f:
        json.dump(audit_data, f, indent=2)

mudrex = audit_data.get("mudrex_responses", {})
db = audit_data.get("db_trades", {})

live_trades = db.get("bitcoin_live_trades") or []
print(f"Total DB Live Trades Count: {len(live_trades)}")

print("\n=== LATEST DB LIVE TRADES ===")
for idx, t in enumerate(live_trades[:5], 1):
    print(f"[{idx}] Trade ID: {t.get('trade_id')} | PosID: {t.get('mudrex_position_id')} | Status: {t.get('status')} | Reason: {t.get('exit_reason') or t.get('reason')} | Entry: ${t.get('entry_price_usd') or t.get('entry_price')} | Exit: ${t.get('exit_price_usd') or t.get('exit_price')} | Gross: Rs.{t.get('gross_pnl')} | Net: Rs.{t.get('net_pnl')}")

