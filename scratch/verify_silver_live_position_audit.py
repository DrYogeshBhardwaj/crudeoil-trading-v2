import requests
import json

def verify_live_position_audit():
    print("==================================================")
    print("  MCX SILVER MINI - READ-ONLY POSITION AUDIT")
    print("==================================================")
    
    url = "https://crudeoil-trading-v2-production.up.railway.app/api/mcx-silver/state"
    print(f"Fetching state from {url}...")
    
    try:
        r = requests.get(url, timeout=10)
        print(f"HTTP Status: {r.status_code}")
        if r.status_code == 200:
            data = r.json()
            print("\n1. Active Position Object:")
            pos = data.get("active_position")
            print(json.dumps(pos, indent=2))
            
            print("\n2. Engine Meta State:")
            print(f"  Enable Live Trading: {data.get('enable_live_trading')}")
            print(f"  Dhan Margin Status: {data.get('dhan_margin_status')}")
            print(f"  Price Source: {data.get('price_source')}")
            print(f"  Is Synthetic Feed: {data.get('is_synthetic_feed')}")
            print(f"  Price Feed Quality: {data.get('price_feed_quality')}")
            print(f"  Is Price Valid for Live: {data.get('is_real_mcx_price_valid_for_live_execution')}")
        else:
            print(f"Error Code: {r.status_code}")
    except Exception as e:
        print(f"Exception: {e}")

if __name__ == "__main__":
    verify_live_position_audit()
