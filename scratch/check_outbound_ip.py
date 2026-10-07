import requests
import time

url = "https://crudeoil-trading-v2-production.up.railway.app/api/debug/outbound-ip"

print("Waiting for Railway deployment to complete...")
for attempt in range(1, 20):
    try:
        r = requests.get(url, timeout=5)
        if r.status_code == 200:
            data = r.json()
            print(f"Attempt {attempt} SUCCESS:")
            print(f"Timestamp: {data.get('timestamp_ist')}")
            print(f"Outbound IP (ifconfig): {data.get('outbound_ip_ifconfig')}")
            print(f"Outbound IP (ipify): {data.get('outbound_ip_ipify')}")
            print(f"Deployment ID: {data.get('railway_deployment_id')}")
            break
        else:
            print(f"Attempt {attempt}: HTTP status {r.status_code}")
    except Exception as e:
        print(f"Attempt {attempt}: Waiting... ({e})")
    time.sleep(5)
