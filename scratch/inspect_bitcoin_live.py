import sqlite3, glob, json

for db_file in glob.glob("*.db"):
    conn = sqlite3.connect(db_file)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
    if "bitcoin_live_trades" in tables:
        print(f"=== {db_file}: bitcoin_live_trades ===")
        rows = c.execute("SELECT * FROM bitcoin_live_trades").fetchall()
        for r in rows:
            print(dict(r))
    if "bitcoin_live_settings" in tables:
        print(f"=== {db_file}: bitcoin_live_settings ===")
        rows = c.execute("SELECT * FROM bitcoin_live_settings").fetchall()
        for r in rows:
            print(dict(r))
