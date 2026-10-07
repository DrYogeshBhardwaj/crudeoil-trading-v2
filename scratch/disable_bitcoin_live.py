import sqlite3
import os

db_path = "trading.db"
if os.path.exists(db_path):
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute("CREATE TABLE IF NOT EXISTS bitcoin_live_settings (key TEXT PRIMARY KEY, value TEXT)")
    cur.execute("INSERT OR REPLACE INTO bitcoin_live_settings (key, value) VALUES ('live_trading_enabled', 'FALSE')")
    cur.execute("INSERT OR REPLACE INTO bitcoin_live_settings (key, value) VALUES ('entry_lock', 'BLOCKED')")
    conn.commit()
    conn.close()
    print("SUCCESS: Bitcoin Live Trading has been set to DISABLED (FALSE) in trading.db!")
else:
    print(f"Error: {db_path} not found.")
