import sqlite3
import os
import json

db_path = "trading.db"
print("DB Exists:", os.path.exists(db_path))

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
cursor = conn.cursor()

cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
tables = [r[0] for r in cursor.fetchall()]
print("Tables in trading.db:", tables)

for tbl in tables:
    cursor.execute(f"SELECT COUNT(*) FROM {tbl}")
    count = cursor.fetchone()[0]
    print(f"Table '{tbl}': {count} rows")
    if "silver" in tbl or "trade" in tbl or "position" in tbl or "setting" in tbl:
        cursor.execute(f"SELECT * FROM {tbl} LIMIT 5")
        rows = [dict(r) for r in cursor.fetchall()]
        print(f"  Sample from '{tbl}':", json.dumps(rows, indent=2, default=str))

conn.close()
