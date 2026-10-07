import os
import requests
import json
import sqlite3

api_secret = (os.environ.get("MUDREX_API_SECRET") or os.environ.get("MUDREX_SECRET") or "").strip()
api_key = (os.environ.get("MUDREX_API_KEY") or os.environ.get("MUDREX_KEY") or "").strip()
headers = {"X-Authentication": api_secret, "User-Agent": "BTC-Audit/1.0"}
if api_key:
    headers["X-Api-Key"] = api_key

print("=== MUDREX ACTIVE POSITIONS ===")
try:
    resp = requests.get("https://trade.mudrex.com/fapi/v1/futures/positions", headers=headers, timeout=5)
    print(f"Status Code: {resp.status_code}")
    print(json.dumps(resp.json(), indent=2))
except Exception as e:
    print("Positions error:", e)

print("\n=== LOCAL DB BITCOIN TABLES ===")
conn = sqlite3.connect("trading.db")
c = conn.cursor()
tables = [row[0] for row in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%btc%' OR name LIKE '%bitcoin%')").fetchall()]
print("Tables found:", tables)
for t in tables:
    count = c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
    print(f"\nTable {t}: {count} rows")
    rows = c.execute(f"SELECT * FROM {t} ORDER BY rowid DESC LIMIT 5").fetchall()
    for r in rows:
        print("  ", r)
