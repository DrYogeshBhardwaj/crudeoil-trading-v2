"""
Fetch September 1-30, 2026 1-minute historical candles for CLUSDT (Mudrex CL • USDT Futures stream).
Batches 1,500 candles per request.
"""
import requests
import time
from datetime import datetime, timezone

def fetch_september_klines():
    symbol = "CLUSDT"
    interval = "1m"
    base_url = "https://fapi.binance.com/fapi/v1/klines"
    
    # 1 Sep 2026 00:00:00 UTC to 30 Sep 2026 23:59:59 UTC
    start_dt = datetime(2026, 9, 1, 0, 0, 0, tzinfo=timezone.utc)
    end_dt = datetime(2026, 9, 30, 23, 59, 59, tzinfo=timezone.utc)
    
    start_ms = int(start_dt.timestamp() * 1000)
    end_ms = int(end_dt.timestamp() * 1000)
    
    print(f"Fetching {symbol} 1m candles from {start_dt} ({start_ms}) to {end_dt} ({end_ms})...")
    
    all_candles = []
    current_start = start_ms
    batch_count = 0
    
    while current_start < end_ms:
        params = {
            "symbol": symbol,
            "interval": interval,
            "startTime": current_start,
            "endTime": end_ms,
            "limit": 1500
        }
        try:
            r = requests.get(base_url, params=params, timeout=10)
            if r.status_code != 200:
                print(f"HTTP Error {r.status_code}: {r.text}")
                break
            data = r.json()
            if not data or not isinstance(data, list):
                print(f"No data returned at start_ms={current_start}")
                break
            
            all_candles.extend(data)
            batch_count += 1
            first_ts = data[0][0]
            last_ts = data[-1][0]
            print(f"Batch {batch_count}: Received {len(data)} candles from {datetime.fromtimestamp(first_ts/1000, tz=timezone.utc)} to {datetime.fromtimestamp(last_ts/1000, tz=timezone.utc)}")
            
            # Next start is last timestamp + 1 min (60,000 ms)
            current_start = last_ts + 60000
            time.sleep(0.2)
        except Exception as e:
            print(f"Exception during fetch: {e}")
            break
            
    print(f"Total candles fetched: {len(all_candles)}")
    return all_candles

if __name__ == "__main__":
    candles = fetch_september_klines()
