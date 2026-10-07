import sqlite3
import glob
import json

print("=== DB INSPECTION ===")
for db_file in glob.glob("*.db"):
    print(f"\n--- Checking DB: {db_file} ---")
    try:
        conn = sqlite3.connect(db_file)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()
        tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        print("Tables:", tables)
        for t in tables:
            try:
                rows = c.execute(f"SELECT * FROM {t}").fetchall()
                print(f"Table {t} ({len(rows)} rows)")
                for r in rows:
                    row_dict = dict(r)
                    if row_dict.get("status") == "OPEN" or "trade" in t or "setting" in t:
                        print(f"   {t} row:", row_dict)
            except Exception as e:
                print(f"   Error querying {t}: {e}")
    except Exception as e:
        print(f" Error connecting to {db_file}: {e}")
