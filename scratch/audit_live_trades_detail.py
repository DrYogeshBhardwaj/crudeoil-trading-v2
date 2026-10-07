import sqlite3
import json

conn = sqlite3.connect("trading.db")
conn.row_factory = sqlite3.Row
cur = conn.cursor()

cur.execute("SELECT * FROM bitcoin_live_trades ORDER BY entry_timestamp ASC")
rows = [dict(r) for r in cur.fetchall()]

print("=" * 80)
print(f"DATABASE TABLE: bitcoin_live_trades ({len(rows)} records)")
print("=" * 80)

for idx, r in enumerate(rows, 1):
    print(f"\nRecord #{idx}:")
    for k, v in r.items():
        print(f"  {k}: {v}")

conn.close()
