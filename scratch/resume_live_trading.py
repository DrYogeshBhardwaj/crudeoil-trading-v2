import requests
import time

base_url = "https://crudeoil-trading-v2-production.up.railway.app"

print("Enabling Live Trading on production...")
time.sleep(10)

# Enable BTC Live Trading
try:
    r = requests.post(f"{base_url}/api/bitcoin/live/toggle-trading", json={"enable": True}, timeout=10)
    print(f"BTC Live Trading Toggle ON Response (HTTP {r.status_code}): {r.text}")
except Exception as e:
    print(f"Error enabling BTC Live: {e}")

# Enable Crude Live Engine
try:
    r = requests.post(f"{base_url}/api/live/start_test", timeout=10)
    print(f"Crude Live Engine Start Response (HTTP {r.status_code}): {r.text}")
except Exception as e:
    print(f"Error starting Crude Live: {e}")

