"""
SQLite Persistent Database Engine for Paper Trades, Daily P&L, Signals, and Audit Logs.
Ensures Crash Recovery and Duplicate Trade Prevention on Service Restarts.
"""

import sqlite3
import json
import os
from datetime import datetime
from typing import List, Dict, Optional, Any, Tuple

def get_db_path() -> str:
    if os.environ.get("DATABASE_PATH"):
        return os.environ["DATABASE_PATH"]
    if os.path.exists("/data"):
        return "/data/trading.db"
    return "/tmp/trading.db" if os.name != "nt" else "trading.db"

DB_FILE = get_db_path()

class DatabaseEngine:

    def __init__(self, db_path: str = DB_FILE):
        self.db_path = db_path
        self._init_db()

    def _get_connection(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            
            # Paper Trades Table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS paper_trades (
                    trade_id TEXT PRIMARY KEY,
                    entry_timestamp TEXT NOT NULL,
                    instrument TEXT NOT NULL,
                    direction TEXT NOT NULL,
                    quantity INTEGER NOT NULL,
                    entry_price REAL NOT NULL,
                    stop_loss REAL NOT NULL,
                    original_stop_loss REAL NOT NULL,
                    target_1 REAL NOT NULL,
                    target_2 REAL NOT NULL,
                    trend_state TEXT NOT NULL,
                    confidence INTEGER NOT NULL,
                    reasons TEXT,
                    status TEXT NOT NULL,
                    exit_timestamp TEXT,
                    exit_price REAL,
                    exit_reason TEXT,
                    gross_pnl REAL,
                    charges REAL,
                    slippage REAL,
                    net_pnl REAL
                )
            """)

            # Replay Progress State Table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS replay_state (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            """)

            # Daily PnL Summary Table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS daily_pnl (
                    date TEXT PRIMARY KEY,
                    total_trades INTEGER,
                    winning_trades INTEGER,
                    losing_trades INTEGER,
                    gross_pnl REAL,
                    charges REAL,
                    slippage REAL,
                    net_pnl REAL,
                    max_drawdown REAL
                )
            """)

            # Audit Logs Table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS audit_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    price REAL NOT NULL,
                    action TEXT NOT NULL,
                    trend_state TEXT NOT NULL,
                    confidence INTEGER NOT NULL,
                    reasons TEXT,
                    position_status TEXT NOT NULL
                )
            """)

            conn.commit()

    def save_paper_trade(self, pos_dict: Dict[str, Any]):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            reasons_json = json.dumps(pos_dict.get("reasons", []))
            cursor.execute("""
                INSERT OR REPLACE INTO paper_trades (
                    trade_id, entry_timestamp, instrument, direction, quantity,
                    entry_price, stop_loss, original_stop_loss, target_1, target_2,
                    trend_state, confidence, reasons, status, exit_timestamp, exit_price,
                    exit_reason, gross_pnl, charges, slippage, net_pnl
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                pos_dict["trade_id"],
                pos_dict["entry_timestamp"],
                pos_dict["instrument"],
                pos_dict["direction"],
                pos_dict["quantity"],
                pos_dict["entry_price"],
                pos_dict["stop_loss"],
                pos_dict["original_stop_loss"],
                pos_dict["target_1"],
                pos_dict["target_2"],
                pos_dict["trend_state"],
                pos_dict["confidence"],
                reasons_json,
                pos_dict["status"],
                pos_dict.get("exit_timestamp"),
                pos_dict.get("exit_price"),
                pos_dict.get("exit_reason"),
                pos_dict.get("gross_pnl"),
                pos_dict.get("charges"),
                pos_dict.get("slippage"),
                pos_dict.get("net_pnl")
            ))
            conn.commit()

    def load_active_position(self) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM paper_trades WHERE status = 'OPEN' LIMIT 1")
            row = cursor.fetchone()
            if row:
                d = dict(row)
                d["reasons"] = json.loads(d["reasons"]) if d["reasons"] else []
                return d
            return None

    def load_all_trades(self) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM paper_trades ORDER BY entry_timestamp ASC")
            rows = cursor.fetchall()
            trades = []
            for r in rows:
                t = dict(r)
                t["reasons"] = json.loads(t["reasons"]) if t["reasons"] else []
                trades.append(t)
            return trades

    def save_replay_progress(self, index: int, timestamp_str: str):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("INSERT OR REPLACE INTO replay_state (key, value) VALUES ('last_index', ?)", (str(index),))
            cursor.execute("INSERT OR REPLACE INTO replay_state (key, value) VALUES ('last_timestamp', ?)", (timestamp_str,))
            conn.commit()

    def load_replay_progress(self) -> Tuple[Optional[int], Optional[str]]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT key, value FROM replay_state WHERE key IN ('last_index', 'last_timestamp')")
            rows = cursor.fetchall()
            d = {r["key"]: r["value"] for r in rows}
            idx = int(d["last_index"]) if "last_index" in d else None
            ts = d.get("last_timestamp")
            return idx, ts

    def save_heartbeat(self, timestamp_str: str, uptime_seconds: int):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS server_heartbeat (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    last_heartbeat TEXT NOT NULL,
                    uptime_seconds INTEGER NOT NULL
                )
            """)
            cursor.execute("""
                INSERT OR REPLACE INTO server_heartbeat (id, last_heartbeat, uptime_seconds)
                VALUES (1, ?, ?)
            """, (timestamp_str, uptime_seconds))
            conn.commit()

    def load_last_heartbeat(self) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM server_heartbeat WHERE id = 1")
            row = cursor.fetchone()
            return dict(row) if row else None

DB = DatabaseEngine()
