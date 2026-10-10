import requests
import json
import time

def verify_post_deploy():
    url = "https://crudeoil-trading-v2-production.up.railway.app/api/mcx-silver/state"
    print("Checking Railway Server Post-Deployment State...")
    try:
        r = requests.get(url, timeout=10)
        if r.status_code == 200:
            data = r.json()
            print("\nRailway Response:")
            print(f"Timestamp: {data.get('timestamp')}")
            print(f"Enable Live Trading: {data.get('enable_live_trading')}")
            print(f"Is Synthetic Feed: {data.get('is_synthetic_feed')}")
            print(f"Price Feed Quality: {data.get('price_feed_quality')}")
            print(f"Is Price Valid For Live: {data.get('is_real_mcx_price_valid_for_live_execution')}")
            print(f"Current Price INR: {data.get('current_price_inr')}")
        else:
            print(f"Status Code: {r.status_code}")
    except Exception as e:
        print(f"Exception: {e}")

if __name__ == "__main__":
    verify_post_deploy()
