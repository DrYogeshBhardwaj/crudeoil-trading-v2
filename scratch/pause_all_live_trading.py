import requests

base_url = "https://crudeoil-trading-v2-production.up.railway.app"

# Stop BTC Live Trading
try:
    r = requests.post(f"{base_url}/api/bitcoin/live/toggle-trading", json={"enable": False}, timeout=10)
    print(f"BTC Live Trading Toggle OFF Response (HTTP {r.status_code}): {r.text}")
except Exception as e:
    print(f"Error pausing BTC Live: {e}")

# Stop Crude Live Trading
try:
    r = requests.post(f"{base_url}/api/live/stop_test", timeout=10)
    print(f"Crude Live Engine Stop Response (HTTP {r.status_code}): {r.text}")
except Exception as e:
    print(f"Error stopping Crude Live: {e}")

