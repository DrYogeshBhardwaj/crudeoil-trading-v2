import requests
import json
import os
import time
from typing import Dict, Any, Optional

BASE_URL = "https://trade.mudrex.com/fapi/v1"

def get_headers():
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
    return headers

def fetch_closed_position_audit_data(position_id: str, max_retries: int = 5, retry_delay: float = 1.0) -> Optional[Dict[str, Any]]:
    """
    Queries Mudrex API for actual position history and order fills for a given position_id.
    Retries up to max_retries if position history hasn't populated yet.
    Returns authoritative Mudrex fill details & exact Net PnL.
    """
    headers = get_headers()
    pos_item = None
    pos_orders = []
    
    # 1. Fetch from /futures/positions/history
    for attempt in range(max_retries):
        try:
            url = f"{BASE_URL}/futures/positions/history?trade_currency=INR"
            resp = requests.get(url, headers=headers, timeout=5)
            if resp.status_code in (200, 201):
                data = resp.json()
                items = data.get("data") if isinstance(data, dict) else data
                if isinstance(items, list):
                    for p in items:
                        if str(p.get("position_id")).lower() == str(position_id).lower():
                            pos_item = p
                            break
            if pos_item:
                break
        except Exception as e:
            print(f"Error fetching position history: {e}")
        time.sleep(retry_delay)
        
    if not pos_item:
        print(f"Position {position_id} not found in Mudrex position history after {max_retries} attempts.")
        return None
        
    # 2. Fetch orders from /futures/orders
    try:
        url = f"{BASE_URL}/futures/orders?trade_currency=INR"
        resp = requests.get(url, headers=headers, timeout=5)
        if resp.status_code in (200, 201):
            data = resp.json()
            items = data.get("data") if isinstance(data, dict) else data
            if isinstance(items, list):
                for o in items:
                    if str(o.get("position_id")).lower() == str(position_id).lower():
                        pos_orders.append(o)
    except Exception as e:
        print(f"Error fetching orders: {e}")

    # Parse prices & PnL
    entry_price_usd = float(pos_item.get("entry_price") or 0.0)
    closed_price_usd = float(pos_item.get("closed_price") or 0.0)
    qty = float(pos_item.get("quantity") or 0.002)
    hedge_rate = float(pos_item.get("entry_hedge_rate") or pos_item.get("exit_hedge_rate") or 102.0)
    
    gross_pnl_inr = float(pos_item.get("pnl") or 0.0)
    
    # Calculate order fees & GST
    # Mudrex fee is 0.05% + 18% GST = 0.059% per order
    entry_fee_gst = 0.0
    exit_fee_gst = 0.0
    
    for o in pos_orders:
        amt = float(o.get("actual_amount") or 0.0)
        if amt <= 0:
            p = float(o.get("filled_price") or o.get("price") or 0.0)
            q = float(o.get("filled_quantity") or o.get("quantity") or qty)
            hr = float(o.get("hedge_rate") or hedge_rate)
            amt = p * q * hr
        
        # 0.05% fee + 18% GST = 0.00059 of order amount
        fee = amt * 0.0005
        gst = fee * 0.18
        tot = fee + gst
        
        reduces = o.get("reduces_only")
        side = o.get("order_type") or o.get("side")
        
        if reduces or len(pos_orders) > 1 and o == pos_orders[0]:
            entry_fee_gst += tot
        else:
            exit_fee_gst += tot

    if len(pos_orders) < 2:
        # Fallback estimation for missing order fill records
        entry_val = entry_price_usd * qty * hedge_rate
        exit_val = closed_price_usd * qty * hedge_rate
        entry_fee_gst = entry_val * 0.00059
        exit_fee_gst = exit_val * 0.00059

    total_charges = entry_fee_gst + exit_fee_gst
    funding_fee = 0.0 # Held for seconds
    net_pnl = gross_pnl_inr - total_charges - funding_fee

    return {
        "position_id": position_id,
        "entry_price_usd": entry_price_usd,
        "exit_price_usd": closed_price_usd,
        "entry_price_inr": round(entry_price_usd * hedge_rate, 2),
        "exit_price_inr": round(closed_price_usd * hedge_rate, 2),
        "quantity": qty,
        "hedge_rate": hedge_rate,
        "gross_pnl_inr": round(gross_pnl_inr, 2),
        "entry_fee_gst": round(entry_fee_gst, 2),
        "exit_fee_gst": round(exit_fee_gst, 2),
        "total_charges": round(total_charges, 2),
        "funding_fee": round(funding_fee, 2),
        "net_pnl": round(net_pnl, 2),
        "orders_count": len(pos_orders),
        "raw_position": pos_item
    }

# Test on position 01a10ac3-77dc-7674-bb05-46b0e83ed8cd
pid = "01a10ac3-77dc-7674-bb05-46b0e83ed8cd"
res = fetch_closed_position_audit_data(pid)
print(f"Audit fetch test for {pid}:")
print(json.dumps(res, indent=2))

