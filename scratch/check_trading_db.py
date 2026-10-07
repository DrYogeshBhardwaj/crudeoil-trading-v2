import sqlite3
import sys

sys.stdout.reconfigure(encoding='utf-8')

def check_trading_db():
    conn = sqlite3.connect("trading.db")
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = [r[0] for r in cursor.fetchall()]
    print("Tables in trading.db:", tables)
    for table in tables:
        if "bitcoin" in table or "live" in table:
            cursor.execute(f"SELECT * FROM {table}")
            rows = cursor.fetchall()
            cols = [d[0] for d in cursor.description]
            print(f"\nTable {table} ({len(rows)} rows):")
            print("Columns:", cols)
            for r in rows:
                print("Row:", r)
    conn.close()

if __name__ == "__main__":
    check_trading_db()
