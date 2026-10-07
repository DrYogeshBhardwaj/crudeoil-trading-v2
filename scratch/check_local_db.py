import os
import sqlite3
import json
import requests

def main():
    print("=== ENVIRONMENT CHECK ===")
    print("MUDREX_API_SECRET set:", bool(os.environ.get("MUDREX_API_SECRET") or os.environ.get("MUDREX_SECRET") or os.environ.get("MUDREX_SECRET_KEY")))
    print("MUDREX_API_KEY set:", bool(os.environ.get("MUDREX_API_KEY") or os.environ.get("MUDREX_KEY")))
    
    print("\n=== TRADING.DB CHECK ===")
    db_paths = ["trading.db", "seed_trading.db", "test_bitcoin_live_trading.db"]
    for db_path in db_paths:
        if os.path.exists(db_path):
            print(f"\n--- Checking {db_path} ---")
            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()
            tables = [row[0] for row in cursor.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
            print("Tables:", tables)
            
            for table in tables:
                try:
                    count = cursor.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                    print(f"Table {table}: {count} rows")
                    if count > 0:
                        rows = cursor.execute(f"SELECT * FROM {table} ORDER BY rowid DESC LIMIT 5").fetchall()
                        col_names = [description[0] for description in cursor.description]
                        print(f"  Columns: {col_names}")
                        for r in rows:
                            print(f"  Row: {r}")
                except Exception as e:
                    print(f"Error querying {table}: {e}")
            conn.close()

if __name__ == "__main__":
    main()
