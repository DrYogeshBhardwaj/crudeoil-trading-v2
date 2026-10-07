"""
Comprehensive Mudrex API & Local DB Audit & Reconciliation Script.
Fetches all orders, positions, and trades from Mudrex API for the last 24 hours
and reconciles them against local database tables.
DOES NOT PLACE ANY ORDERS OR MODIFY ANY TRADING POSITIONS.
"""

import os
import json
import sqlite3
import requests
from datetime import datetime, timezone, timedelta

def get_db_path():
    if os.environ.get("DATABASE_PATH"):
        return os.environ["DATABASE_PATH"]
    if os.path.exists("/data/trading.db"):
        return "/data/trading.db"
    return "trading.db"

def run_audit():
    print("=" * 80)
    print(f"MUDREX & ENGINE DB RECONCILIATION AUDIT — {datetime.now()}")
    print("=" * 80)

    # 1. Setup Mudrex headers
    api_secret = (
        os.environ.get("MUDREX_API_SECRET") or 
        os.environ.get("MUDREX_SECRET") or 
        os.environ.get("MUDREX_SECRET_KEY") or ""
    ).strip()
    
    api_key = (
        os.environ.get("MUDREX_API_KEY") or 
        os.environ.get("MUDREX_KEY") or ""
    ).strip()

    headers = {
        "X-Authentication": api_secret,
        "Content-Type": "application/json",
        "User-Agent": "Bitcoin-Live-Engine/1.0"
    }
    if api_key:
        headers["X-Api-Key"] = api_key

    base_url = "https://trade.mudrex.com/fapi/v1"

    print(f"API Secret present: {bool(api_secret)}")
    print(f"API Key present:    {bool(api_key)}")
    print("-" * 80)

    # 2. Fetch Mudrex Orders
    all_mudrex_orders = []

    # Endpoint A: /futures/orders?trade_currency=INR
    try:
        url = f"{base_url}/futures/orders?trade_currency=INR"
        r = requests.get(url, headers=headers, timeout=8)
        print(f"Fetch Orders (INR): HTTP {r.status_code}")
        if r.status_code in (200, 201):
            data = r.json()
            items = data.get("data") if isinstance(data, dict) else data
            if isinstance(items, list):
                all_mudrex_orders.extend(items)
                print(f"-> Found {len(items)} orders via /futures/orders?trade_currency=INR")
    except Exception as e:
        print(f"Error fetching orders (INR): {e}")

    # Endpoint B: /futures/orders
    try:
        url = f"{base_url}/futures/orders"
        r = requests.get(url, headers=headers, timeout=8)
        print(f"Fetch Orders (All): HTTP {r.status_code}")
        if r.status_code in (200, 201):
            data = r.json()
            items = data.get("data") if isinstance(data, dict) else data
            if isinstance(items, list):
                seen_ids = set(o.get("order_id") or o.get("id") for o in all_mudrex_orders if o.get("order_id") or o.get("id"))
                added = 0
                for item in items:
                    oid = item.get("order_id") or item.get("id")
                    if oid not in seen_ids:
                        all_mudrex_orders.append(item)
                        seen_ids.add(oid)
                        added += 1
                print(f"-> Added {added} additional unique orders via /futures/orders")
    except Exception as e:
        print(f"Error fetching orders (All): {e}")

    # Endpoint C: /futures/positions (Open)
    mudrex_positions = []
    try:
        url = f"{base_url}/futures/positions?trade_currency=INR"
        r = requests.get(url, headers=headers, timeout=8)
        print(f"Fetch Positions (Open): HTTP {r.status_code}")
        if r.status_code in (200, 201):
            data = r.json()
            items = data.get("data") if isinstance(data, dict) else data
            if isinstance(items, list):
                mudrex_positions = items
                print(f"-> Found {len(items)} open positions via /futures/positions")
    except Exception as e:
        print(f"Error fetching positions: {e}")

    # Endpoint D: /futures/positions/history or completed positions
    mudrex_position_history = []
    for endpoint in ["/futures/positions/history", "/futures/positions/closed", "/futures/trades", "/futures/orders/history"]:
        try:
            url = f"{base_url}{endpoint}?trade_currency=INR"
            r = requests.get(url, headers=headers, timeout=8)
            if r.status_code in (200, 201):
                data = r.json()
                items = data.get("data") if isinstance(data, dict) else data
                if isinstance(items, list) and items:
                    print(f"-> Found {len(items)} entries via {endpoint}")
                    mudrex_position_history.extend(items)
        except Exception:
            pass

    print("-" * 80)
    print(f"TOTAL MUDREX ORDERS FETCHED: {len(all_mudrex_orders)}")
    print(f"TOTAL MUDREX OPEN POSITIONS:  {len(mudrex_positions)}")
    print("-" * 80)

    # 3. Read Local Database Tables
    db_path = get_db_path()
    print(f"Reading Local DB from: {db_path}")
    
    live_trades_db = []
    live5_trades_db = []
    updown10_trades_db = []

    if os.path.exists(db_path):
        with sqlite3.connect(db_path) as conn:
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()

            try:
                cur.execute("SELECT * FROM bitcoin_live_trades ORDER BY entry_timestamp DESC")
                live_trades_db = [dict(r) for r in cur.fetchall()]
            except Exception as e:
                print(f"Notice bitcoin_live_trades: {e}")

            try:
                cur.execute("SELECT * FROM bitcoin_live5_trades ORDER BY entry_timestamp DESC")
                live5_trades_db = [dict(r) for r in cur.fetchall()]
            except Exception as e:
                print(f"Notice bitcoin_live5_trades: {e}")

            try:
                cur.execute("SELECT * FROM bitcoin_updown10_trades ORDER BY entry_timestamp DESC")
                updown10_trades_db = [dict(r) for r in cur.fetchall()]
            except Exception as e:
                print(f"Notice bitcoin_updown10_trades: {e}")

    print(f"DB bitcoin_live_trades records:   {len(live_trades_db)}")
    print(f"DB bitcoin_live5_trades records:  {len(live5_trades_db)}")
    print(f"DB bitcoin_updown10_trades records: {len(updown10_trades_db)}")
    print("=" * 80)

    # 4. Print DB Live Trades Breakdown
    print("\n--- ENGINE DB: bitcoin_live_trades ---")
    for t in live_trades_db:
        print(f"Trade ID: {t.get('trade_id')} | Mudrex Pos ID: {t.get('mudrex_position_id')} | Dir: {t.get('direction')} | Status: {t.get('status')} | Entry: {t.get('entry_timestamp')} | Exit: {t.get('exit_timestamp')} | Net PnL: Rs.{t.get('net_pnl')}")

    # 5. Reconcile Every Mudrex Order against DB
    print("\n--- MUDREX ORDERS DETAILED RECONCILIATION ---")
    
    known_pos_ids = set()
    known_order_ids = set()

    for t in live_trades_db:
        if t.get("mudrex_position_id"):
            known_pos_ids.add(str(t["mudrex_position_id"]).lower())
        if t.get("stoploss_order_id"):
            known_order_ids.add(str(t["stoploss_order_id"]).lower())

    matched_orders = []
    unmatched_orders = []

    for idx, ord_item in enumerate(all_mudrex_orders, 1):
        oid = str(ord_item.get("order_id") or ord_item.get("id") or "").lower()
        pid = str(ord_item.get("position_id") or ord_item.get("positionId") or "").lower()
        sym = ord_item.get("symbol") or ord_item.get("asset_symbol")
        side = ord_item.get("order_type") or ord_item.get("side") or ord_item.get("direction")
        qty = ord_item.get("quantity") or ord_item.get("qty")
        price = ord_item.get("price") or ord_item.get("avg_price") or ord_item.get("fill_price")
        created_at = ord_item.get("created_at") or ord_item.get("timestamp") or ord_item.get("time")
        status = ord_item.get("status")
        fee = ord_item.get("fee") or ord_item.get("commission") or 0.0

        is_matched = False
        matched_engine = ""

        if pid and pid in known_pos_ids:
            is_matched = True
            matched_engine = "bitcoin_live_engine (Position ID Match)"
        elif oid and oid in known_order_ids:
            is_matched = True
            matched_engine = "bitcoin_live_engine (Order ID Match)"
        else:
            # Check if any db trade timestamp / price matches
            for t in live_trades_db:
                if str(t.get("mudrex_position_id")).lower() in (pid, oid):
                    is_matched = True
                    matched_engine = "bitcoin_live_engine"
                    break

        item_summary = {
            "index": idx,
            "order_id": ord_item.get("order_id") or ord_item.get("id"),
            "position_id": ord_item.get("position_id"),
            "symbol": sym,
            "side": side,
            "qty": qty,
            "price": price,
            "time": created_at,
            "status": status,
            "fee": fee,
            "is_matched": is_matched,
            "matched_engine": matched_engine,
            "raw": ord_item
        }

        if is_matched:
            matched_orders.append(item_summary)
        else:
            unmatched_orders.append(item_summary)

        print(f"Order #{idx:02d} | ID: {item_summary['order_id']} | PosID: {item_summary['position_id']} | Side: {side} | Qty: {qty} | Price: {price} | Time: {created_at} | Status: {status} | Match: {is_matched} ({matched_engine})")

    print("\n" + "=" * 80)
    print("RECONCILIATION SUMMARY")
    print("=" * 80)
    print(f"Total Mudrex Orders:           {len(all_mudrex_orders)}")
    print(f"Matched Engine Orders:         {len(matched_orders)}")
    print(f"Unmatched / External Orders:   {len(unmatched_orders)}")
    print(f"Engine DB Recorded Trades:     {len(live_trades_db)}")
    print("=" * 80)

    if unmatched_orders:
        print("\n=== UNMATCHED ORDERS DETAILED DUMP ===")
        for u in unmatched_orders:
            print(json.dumps(u["raw"], indent=2))

if __name__ == "__main__":
    run_audit()
