import urllib.request
import json

url = "https://crudeoil-trading-v2-production.up.railway.app/api/live/state"
print(f"Fetching live engine state from production: {url}...")

try:
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode('utf-8'))
        print("\n=== PRODUCTION LIVE ENGINE STATE ===")
        print(f"Engine Status:       {data.get('engine_status')}")
        print(f"Market Status:       {data.get('market_status')}")
        print(f"Market Session:      {data.get('market_session')}")
        print(f"Dhan Connection:     {data.get('dhan_connection')}")
        print(f"Dhan Client ID:      {data.get('dhan_client_id')}")
        print(f"Available Margin:    Rs. {data.get('available_margin_inr')}")
        print(f"Current Price (LTP): {data.get('current_price')}")
        print(f"Last Tick Time:      {data.get('last_tick_time_ist')}")
        print(f"Feed Status Text:    {data.get('feed_status_text')}")
        print(f"Evaluation Count:    {data.get('evaluation_count')}")
        print(f"Order Placement:     {data.get('order_placement_status')}")
        print(f"Live Test Flag:      {data.get('live_test_enable_flag')}")
        print(f"Candle Status:       {data.get('candle_status')}")
        
        ws_logs = data.get("dhan_ws_logs", [])
        print("\n=== RECENT DHAN WEBSOCKET LOGS (PROD) ===")
        for log in ws_logs[-15:]:
            print(log)
            
        eval_logs = data.get("latest_evaluation_logs", [])
        print("\n=== RECENT STRATEGY EVALUATION LOGS (PROD) ===")
        for log in eval_logs[-15:]:
            print(log)
except Exception as e:
    print(f"Error fetching production state: {e}")
