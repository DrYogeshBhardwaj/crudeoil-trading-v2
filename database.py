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

def migrate_if_needed(target_db_path: str):
    """
    Auto-migrates trade history & replay state from candidate DBs (/data/trading.db, /tmp/trading.db, trading.db)
    into target_db_path (/data/trading.db) if target DB has fewer trades than candidate DB.
    Preserves all trade IDs, timestamps, status, P&L, and replay progress without duplication.
    """
    candidate_paths = [
        "/data/trading.db",
        "/tmp/trading.db",
        "trading.db",
        "seed_trading.db",
        os.path.join(os.path.dirname(__file__), "trading.db"),
        os.path.join(os.path.dirname(__file__), "seed_trading.db")
    ]
    
    target_abs = os.path.abspath(target_db_path)
    valid_candidates = []
    
    for cand in candidate_paths:
        cand_abs = os.path.abspath(cand)
        if cand_abs == target_abs:
            continue
        if os.path.exists(cand_abs) and os.path.getsize(cand_abs) > 0:
            valid_candidates.append(cand_abs)

    if not valid_candidates:
        return

    target_trade_count = 0
    try:
        if os.path.exists(target_abs):
            with sqlite3.connect(target_abs) as target_conn:
                cur = target_conn.cursor()
                cur.execute("SELECT COUNT(*) FROM paper_trades")
                target_trade_count = cur.fetchone()[0]
    except Exception:
        target_trade_count = 0

    best_candidate = None
    best_count = 0
    
    for cand_path in valid_candidates:
        try:
            with sqlite3.connect(cand_path) as cand_conn:
                cur = cand_conn.cursor()
                cur.execute("SELECT COUNT(*) FROM paper_trades")
                count = cur.fetchone()[0]
                if count > best_count:
                    best_count = count
                    best_candidate = cand_path
        except Exception:
            continue

    if not best_candidate or best_count <= target_trade_count:
        return

    print(f"[{datetime.now()}] MIGRATION: Migrating {best_count} paper trades from candidate DB '{best_candidate}' to target DB '{target_abs}'...")

    try:
        os.makedirs(os.path.dirname(target_abs), exist_ok=True)
        
        with sqlite3.connect(best_candidate) as cand_conn, sqlite3.connect(target_abs) as target_conn:
            cand_cur = cand_conn.cursor()
            target_cur = target_conn.cursor()
            
            tables = ["paper_trades", "replay_state", "daily_pnl", "audit_logs", "server_heartbeat"]
            for table in tables:
                try:
                    cand_cur.execute(f"SELECT * FROM {table}")
                    rows = cand_cur.fetchall()
                    if rows:
                        col_names = [description[0] for description in cand_cur.description]
                        placeholders = ", ".join(["?"] * len(col_names))
                        cols_str = ", ".join(col_names)
                        
                        for row in rows:
                            target_cur.execute(f"INSERT OR REPLACE INTO {table} ({cols_str}) VALUES ({placeholders})", tuple(row))
                except Exception as table_err:
                    print(f"Table migration notice for {table}: {table_err}")
                    
            target_conn.commit()
            print(f"[{datetime.now()}] MIGRATION SUCCESS: Migrated {best_count} trades into '{target_abs}'.")
    except Exception as e:
        print(f"[{datetime.now()}] MIGRATION ERROR: {e}")

class DatabaseEngine:

    def __init__(self, db_path: str = DB_FILE):
        self.db_path = db_path
        self._init_db()
        migrate_if_needed(self.db_path)

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

            # Server Heartbeat Table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS server_heartbeat (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    last_heartbeat TEXT NOT NULL,
                    uptime_seconds INTEGER NOT NULL
                )
            """)

            # Live Test Trades Table (Separate Namespace for LIVE Mode)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS live_trades (
                    trade_id TEXT PRIMARY KEY,
                    dhan_order_id TEXT,
                    entry_timestamp TEXT NOT NULL,
                    instrument TEXT NOT NULL,
                    direction TEXT NOT NULL,
                    quantity INTEGER NOT NULL,
                    entry_price REAL NOT NULL,
                    fill_price REAL,
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

            # WTI Paper Trades Table (Dedicated Namespace for WTI Crude Oil)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS wti_paper_trades (
                    trade_id TEXT PRIMARY KEY,
                    entry_timestamp TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    direction TEXT NOT NULL,
                    quantity INTEGER NOT NULL,
                    entry_price REAL NOT NULL,
                    stop_loss REAL NOT NULL,
                    target REAL NOT NULL,
                    trend_state TEXT NOT NULL,
                    confidence INTEGER NOT NULL,
                    reasons TEXT,
                    status TEXT NOT NULL,
                    exit_timestamp TEXT,
                    exit_price REAL,
                    exit_reason TEXT,
                    gross_pnl REAL,
                    charges REAL,
                    net_pnl REAL
                )
            """)

            # WTI System Settings Table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS wti_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            """)

            # WTI Evaluation Logs Stream Table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS wti_evaluations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    price REAL NOT NULL,
                    action TEXT NOT NULL,
                    trend_state TEXT NOT NULL,
                    confidence INTEGER NOT NULL,
                    reason TEXT NOT NULL
                )
            """)

            # Bitcoin Paper Trades Table (Dedicated Namespace for BTC-INR)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS bitcoin_paper_trades (
                    trade_id TEXT PRIMARY KEY,
                    entry_timestamp TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    direction TEXT NOT NULL,
                    quantity REAL NOT NULL,
                    entry_price REAL NOT NULL,
                    stop_loss REAL NOT NULL,
                    target REAL NOT NULL,
                    trend_state TEXT NOT NULL,
                    confidence INTEGER NOT NULL,
                    reasons TEXT,
                    status TEXT NOT NULL,
                    exit_timestamp TEXT,
                    exit_price REAL,
                    exit_reason TEXT,
                    gross_pnl REAL,
                    charges REAL,
                    net_pnl REAL
                )
            """)

            # Bitcoin System Settings Table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS bitcoin_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            """)

            # Bitcoin Evaluation Logs Stream Table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS bitcoin_evaluations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    price REAL NOT NULL,
                    action TEXT NOT NULL,
                    trend_state TEXT NOT NULL,
                    confidence INTEGER NOT NULL,
                    reason TEXT NOT NULL
                )
            """)

            # Bitcoin Live Trades Table (Dedicated Namespace for Live Mudrex Execution)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS bitcoin_live_trades (
                    trade_id TEXT PRIMARY KEY,
                    mudrex_position_id TEXT,
                    entry_timestamp TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    direction TEXT NOT NULL,
                    quantity REAL NOT NULL,
                    entry_price REAL NOT NULL,
                    stop_loss REAL NOT NULL,
                    stoploss_order_id TEXT,
                    target REAL NOT NULL,
                    trend_state TEXT NOT NULL,
                    confidence INTEGER NOT NULL,
                    reasons TEXT,
                    status TEXT NOT NULL,
                    exit_timestamp TEXT,
                    exit_price REAL,
                    exit_reason TEXT,
                    gross_pnl REAL,
                    entry_charges REAL,
                    exit_charges REAL,
                    charges REAL,
                    net_pnl REAL
                )
            """)

            # Migration for existing bitcoin_live_trades tables
            for col in ["entry_charges", "exit_charges", "entry_price_usd", "hedge_rate", "target_usd", "stop_loss_usd", "exit_price_usd"]:
                try:
                    cursor.execute(f"ALTER TABLE bitcoin_live_trades ADD COLUMN {col} REAL")
                except Exception:
                    pass

            # Bitcoin Live System Settings Table (Survives Restarts)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS bitcoin_live_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            """)

            # Bitcoin Live 5 Engine Tables (Dedicated Namespace for 5-Position Live Execution)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS bitcoin_live5_trades (
                    trade_id TEXT PRIMARY KEY,
                    mudrex_position_id TEXT,
                    slot_index INTEGER NOT NULL DEFAULT 1,
                    entry_timestamp TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    direction TEXT NOT NULL,
                    quantity REAL NOT NULL,
                    entry_price REAL NOT NULL,
                    stop_loss REAL NOT NULL,
                    stoploss_order_id TEXT,
                    target REAL NOT NULL,
                    trend_state TEXT NOT NULL,
                    confidence INTEGER NOT NULL,
                    reasons TEXT,
                    status TEXT NOT NULL,
                    exit_timestamp TEXT,
                    exit_price REAL,
                    exit_reason TEXT,
                    gross_pnl REAL,
                    entry_charges REAL,
                    exit_charges REAL,
                    charges REAL,
                    net_pnl REAL,
                    entry_price_usd REAL,
                    hedge_rate REAL,
                    target_usd REAL,
                    stop_loss_usd REAL,
                    exit_price_usd REAL,
                    leverage REAL DEFAULT 5.0,
                    initial_margin REAL
                )
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS bitcoin_live5_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            """)

            conn.commit()

        self.seed_historical_bitcoin_live_trades()

    def seed_historical_bitcoin_live_trades(self):
        """Ensures authoritative completed live trades are preserved across Railway redeployments."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("UPDATE bitcoin_live_settings SET value = '200.0' WHERE key = 'per_trade_loss_limit_inr' AND value = '400.0'")
            reasons_json = json.dumps(["Authoritative Closed Live Position (Mudrex History)"])
            cursor.execute("""
                INSERT OR REPLACE INTO bitcoin_live_trades (
                    trade_id, mudrex_position_id, entry_timestamp, symbol, direction, quantity,
                    entry_price, stop_loss, target, trend_state, confidence,
                    reasons, status, exit_timestamp, exit_price, exit_reason,
                    gross_pnl, entry_charges, exit_charges, charges, net_pnl,
                    entry_price_usd, hedge_rate, target_usd, stop_loss_usd, exit_price_usd
                ) VALUES (
                    'BTC_LIVE_01a1067d', '01a1067d-f252-7e89-91da-9b03be176bfe', '2026-10-04 20:30:00',
                    'BTCUSDT', 'BUY', 0.002, 8696520.0, 8676120.0, 8706720.0, 'BULLISH', 85,
                    ?, 'CLOSED', '2026-10-05 03:27:00', 8758587.0, 'PROFIT TARGET EXIT',
                    124.13, 8.70, 8.76, 17.46, 124.13,
                    85260.0, 102.0, 85360.0, 85060.0, 85868.50
                )
            """, (reasons_json,))
            conn.commit()

    def save_live_trade(self, pos_dict: Dict[str, Any]):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            reasons_json = json.dumps(pos_dict.get("reasons", []))
            cursor.execute("""
                INSERT OR REPLACE INTO live_trades (
                    trade_id, dhan_order_id, entry_timestamp, instrument, direction, quantity,
                    entry_price, fill_price, stop_loss, original_stop_loss, target_1, target_2,
                    trend_state, confidence, reasons, status, exit_timestamp, exit_price,
                    exit_reason, gross_pnl, charges, slippage, net_pnl
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                pos_dict["trade_id"],
                pos_dict.get("dhan_order_id", "LIVE-MOCK"),
                pos_dict["entry_timestamp"],
                pos_dict["instrument"],
                pos_dict["direction"],
                pos_dict["quantity"],
                pos_dict["entry_price"],
                pos_dict.get("fill_price", pos_dict["entry_price"]),
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

    def load_active_live_position(self) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM live_trades WHERE status = 'OPEN' LIMIT 1")
            row = cursor.fetchone()
            if row:
                d = dict(row)
                d["reasons"] = json.loads(d["reasons"]) if d["reasons"] else []
                return d
            return None

    def load_all_live_trades(self) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM live_trades ORDER BY entry_timestamp ASC")
            rows = cursor.fetchall()
            trades = []
            for r in rows:
                t = dict(r)
                t["reasons"] = json.loads(t["reasons"]) if t["reasons"] else []
                trades.append(t)
            return trades

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

    # --- WTI PAPER TRADING DATABASE METHODS ---

    def save_wti_trade(self, pos_dict: Dict[str, Any]):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            reasons_json = json.dumps(pos_dict.get("reasons", []))
            cursor.execute("""
                INSERT OR REPLACE INTO wti_paper_trades (
                    trade_id, entry_timestamp, symbol, direction, quantity,
                    entry_price, stop_loss, target, trend_state, confidence,
                    reasons, status, exit_timestamp, exit_price, exit_reason,
                    gross_pnl, charges, net_pnl
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                pos_dict["trade_id"],
                pos_dict["entry_timestamp"],
                pos_dict.get("symbol", "CL=F"),
                pos_dict["direction"],
                pos_dict["quantity"],
                pos_dict["entry_price"],
                pos_dict["stop_loss"],
                pos_dict["target"],
                pos_dict["trend_state"],
                pos_dict["confidence"],
                reasons_json,
                pos_dict["status"],
                pos_dict.get("exit_timestamp"),
                pos_dict.get("exit_price"),
                pos_dict.get("exit_reason"),
                pos_dict.get("gross_pnl"),
                pos_dict.get("charges"),
                pos_dict.get("net_pnl")
            ))
            conn.commit()

    def load_active_wti_position(self) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM wti_paper_trades WHERE status = 'OPEN' LIMIT 1")
            row = cursor.fetchone()
            if row:
                d = dict(row)
                d["reasons"] = json.loads(d["reasons"]) if d["reasons"] else []
                return d
            return None

    def load_all_wti_trades(self) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM wti_paper_trades ORDER BY entry_timestamp DESC")
            rows = cursor.fetchall()
            trades = []
            for r in rows:
                t = dict(r)
                t["reasons"] = json.loads(t["reasons"]) if t["reasons"] else []
                trades.append(t)
            return trades

    def save_wti_setting(self, key: str, value: str):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("INSERT OR REPLACE INTO wti_settings (key, value) VALUES (?, ?)", (key, str(value)))
            conn.commit()

    def load_wti_setting(self, key: str, default: Optional[str] = None) -> Optional[str]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT value FROM wti_settings WHERE key = ?", (key,))
            row = cursor.fetchone()
            return row["value"] if row else default

    def save_wti_evaluation(self, timestamp: str, price: float, action: str, trend_state: str, confidence: int, reason: str):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO wti_evaluations (timestamp, price, action, trend_state, confidence, reason)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (timestamp, price, action, trend_state, confidence, reason))
            # Keep only latest 200 evaluation logs
            cursor.execute("DELETE FROM wti_evaluations WHERE id NOT IN (SELECT id FROM wti_evaluations ORDER BY id DESC LIMIT 200)")
            conn.commit()

    def load_recent_wti_evaluations(self, limit: int = 50) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM wti_evaluations ORDER BY id DESC LIMIT ?", (limit,))
            rows = cursor.fetchall()
            return [dict(r) for r in rows]

    def reset_wti_database(self):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM wti_paper_trades")
            cursor.execute("DELETE FROM wti_settings")
            cursor.execute("DELETE FROM wti_evaluations")
            conn.commit()

    # --- BITCOIN PAPER TRADING DATABASE METHODS ---

    def save_bitcoin_trade(self, pos_dict: Dict[str, Any]):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            reasons_json = json.dumps(pos_dict.get("reasons", []))
            cursor.execute("""
                INSERT OR REPLACE INTO bitcoin_paper_trades (
                    trade_id, entry_timestamp, symbol, direction, quantity,
                    entry_price, stop_loss, target, trend_state, confidence,
                    reasons, status, exit_timestamp, exit_price, exit_reason,
                    gross_pnl, charges, net_pnl
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                pos_dict["trade_id"],
                pos_dict["entry_timestamp"],
                pos_dict.get("symbol", "BTC-INR"),
                pos_dict["direction"],
                pos_dict["quantity"],
                pos_dict["entry_price"],
                pos_dict["stop_loss"],
                pos_dict["target"],
                pos_dict["trend_state"],
                pos_dict["confidence"],
                reasons_json,
                pos_dict["status"],
                pos_dict.get("exit_timestamp"),
                pos_dict.get("exit_price"),
                pos_dict.get("exit_reason"),
                pos_dict.get("gross_pnl"),
                pos_dict.get("charges"),
                pos_dict.get("net_pnl")
            ))
            conn.commit()

    def load_active_bitcoin_position(self) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM bitcoin_paper_trades WHERE status = 'OPEN' LIMIT 1")
            row = cursor.fetchone()
            if row:
                d = dict(row)
                d["reasons"] = json.loads(d["reasons"]) if d["reasons"] else []
                return d
            return None

    def load_all_bitcoin_trades(self) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM bitcoin_paper_trades ORDER BY entry_timestamp DESC")
            rows = cursor.fetchall()
            trades = []
            for r in rows:
                t = dict(r)
                t["reasons"] = json.loads(t["reasons"]) if t["reasons"] else []
                trades.append(t)
            return trades

    def save_bitcoin_setting(self, key: str, value: str):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("INSERT OR REPLACE INTO bitcoin_settings (key, value) VALUES (?, ?)", (key, str(value)))
            conn.commit()

    def load_bitcoin_setting(self, key: str, default: Optional[str] = None) -> Optional[str]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT value FROM bitcoin_settings WHERE key = ?", (key,))
            row = cursor.fetchone()
            return row["value"] if row else default

    def save_bitcoin_evaluation(self, timestamp: str, price: float, action: str, trend_state: str, confidence: int, reason: str):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO bitcoin_evaluations (timestamp, price, action, trend_state, confidence, reason)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (timestamp, price, action, trend_state, confidence, reason))
            cursor.execute("DELETE FROM bitcoin_evaluations WHERE id NOT IN (SELECT id FROM bitcoin_evaluations ORDER BY id DESC LIMIT 200)")
            conn.commit()

    def load_recent_bitcoin_evaluations(self, limit: int = 50) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM bitcoin_evaluations ORDER BY id DESC LIMIT ?", (limit,))
            rows = cursor.fetchall()
            return [dict(r) for r in rows]

    def reset_bitcoin_database(self):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM bitcoin_paper_trades")
            cursor.execute("DELETE FROM bitcoin_settings")
            cursor.execute("DELETE FROM bitcoin_evaluations")
            conn.commit()

    # --- BITCOIN LIVE TRADING DATABASE METHODS (MUDREX) ---

    def save_bitcoin_live_setting(self, key: str, value: str):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("INSERT OR REPLACE INTO bitcoin_live_settings (key, value) VALUES (?, ?)", (key, str(value)))
            conn.commit()

    def load_bitcoin_live_setting(self, key: str, default: Optional[str] = None) -> Optional[str]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT value FROM bitcoin_live_settings WHERE key = ?", (key,))
            row = cursor.fetchone()
            return row["value"] if row else default

    def save_bitcoin_live_trade(self, pos_dict: Dict[str, Any]):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            reasons_json = json.dumps(pos_dict.get("reasons", []))
            cursor.execute("""
                INSERT OR REPLACE INTO bitcoin_live_trades (
                    trade_id, mudrex_position_id, entry_timestamp, symbol, direction, quantity,
                    entry_price, stop_loss, stoploss_order_id, target, trend_state, confidence,
                    reasons, status, exit_timestamp, exit_price, exit_reason,
                    gross_pnl, entry_charges, exit_charges, charges, net_pnl,
                    entry_price_usd, hedge_rate, target_usd, stop_loss_usd, exit_price_usd
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                pos_dict["trade_id"],
                pos_dict.get("mudrex_position_id"),
                pos_dict["entry_timestamp"],
                pos_dict.get("symbol", "BTCUSDT"),
                pos_dict["direction"],
                pos_dict["quantity"],
                pos_dict["entry_price"],
                pos_dict["stop_loss"],
                pos_dict.get("stoploss_order_id"),
                pos_dict["target"],
                pos_dict["trend_state"],
                pos_dict["confidence"],
                reasons_json,
                pos_dict["status"],
                pos_dict.get("exit_timestamp"),
                pos_dict.get("exit_price"),
                pos_dict.get("exit_reason"),
                pos_dict.get("gross_pnl"),
                pos_dict.get("entry_charges"),
                pos_dict.get("exit_charges"),
                pos_dict.get("charges"),
                pos_dict.get("net_pnl"),
                pos_dict.get("entry_price_usd"),
                pos_dict.get("hedge_rate"),
                pos_dict.get("target_usd"),
                pos_dict.get("stop_loss_usd"),
                pos_dict.get("exit_price_usd")
            ))
            conn.commit()

    def load_active_bitcoin_live_position(self) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM bitcoin_live_trades WHERE status = 'OPEN' ORDER BY entry_timestamp DESC LIMIT 1")
            row = cursor.fetchone()
            if row:
                d = dict(row)
                d["reasons"] = json.loads(d["reasons"]) if d["reasons"] else []
                return d
            return None

    def save_bitcoin_live5_setting(self, key: str, value: str):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("INSERT OR REPLACE INTO bitcoin_live5_settings (key, value) VALUES (?, ?)", (key, str(value)))
            conn.commit()

    def load_bitcoin_live5_setting(self, key: str, default: str = "") -> str:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT value FROM bitcoin_live5_settings WHERE key = ?", (key,))
            row = cursor.fetchone()
            return row["value"] if row else default

    def save_bitcoin_live5_trade(self, pos_dict: Dict[str, Any]):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            reasons_json = json.dumps(pos_dict.get("reasons", []))
            cursor.execute("""
                INSERT OR REPLACE INTO bitcoin_live5_trades (
                    trade_id, mudrex_position_id, slot_index, entry_timestamp, symbol, direction, quantity,
                    entry_price, stop_loss, stoploss_order_id, target, trend_state, confidence,
                    reasons, status, exit_timestamp, exit_price, exit_reason,
                    gross_pnl, entry_charges, exit_charges, charges, net_pnl,
                    entry_price_usd, hedge_rate, target_usd, stop_loss_usd, exit_price_usd,
                    leverage, initial_margin
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                pos_dict["trade_id"],
                pos_dict.get("mudrex_position_id"),
                pos_dict.get("slot_index", 1),
                pos_dict["entry_timestamp"],
                pos_dict.get("symbol", "BTCUSDT"),
                pos_dict["direction"],
                pos_dict["quantity"],
                pos_dict.get("entry_price", 0.0),
                pos_dict.get("stop_loss", 0.0),
                pos_dict.get("stoploss_order_id"),
                pos_dict.get("target", 0.0),
                pos_dict.get("trend_state", "NEUTRAL"),
                pos_dict.get("confidence", 50),
                reasons_json,
                pos_dict["status"],
                pos_dict.get("exit_timestamp"),
                pos_dict.get("exit_price"),
                pos_dict.get("exit_reason"),
                pos_dict.get("gross_pnl"),
                pos_dict.get("entry_charges"),
                pos_dict.get("exit_charges"),
                pos_dict.get("charges"),
                pos_dict.get("net_pnl"),
                pos_dict.get("entry_price_usd"),
                pos_dict.get("hedge_rate"),
                pos_dict.get("target_usd"),
                pos_dict.get("stop_loss_usd"),
                pos_dict.get("exit_price_usd"),
                pos_dict.get("leverage", 5.0),
                pos_dict.get("initial_margin")
            ))
            conn.commit()

    def load_active_bitcoin_live5_positions(self) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM bitcoin_live5_trades WHERE status = 'OPEN' ORDER BY slot_index ASC, entry_timestamp ASC")
            rows = cursor.fetchall()
            positions = []
            for r in rows:
                d = dict(r)
                d["reasons"] = json.loads(d["reasons"]) if d["reasons"] else []
                positions.append(d)
            return positions

    def load_all_bitcoin_live5_trades(self) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM bitcoin_live5_trades ORDER BY entry_timestamp DESC")
            rows = cursor.fetchall()
            trades = []
            for r in rows:
                t = dict(r)
                t["reasons"] = json.loads(t["reasons"]) if t["reasons"] else []
                trades.append(t)
            return trades

DB = DatabaseEngine()
