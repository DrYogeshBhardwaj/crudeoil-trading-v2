import urllib.request
import json
import time

client_id = "1113639152"
access_token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTY0MTg4LCJpYXQiOjE3OTA4Nzc3ODgsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.BW4iAl5ZEdLaKiev71YsjAY4mQcNMWTbLctUz4mJ8ou1hUGT-uyCRJChqL-idTqZrJIivJFtI2mv3L2I4hZJpQ"

headers = {
    "client-id": client_id,
    "access-token": access_token,
    "Content-Type": "application/json"
}

url = "https://api.dhan.co/v2/marketfeed/ltp"
payload = {
    "MCX_COMM": ["569901"]
}

print("Testing Dhan REST LTP API (v2)...")
try:
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers, method='POST')
    with urllib.request.urlopen(req) as resp:
        res = json.loads(resp.read().decode('utf-8'))
        print("REST LTP SUCCESS:", json.dumps(res, indent=2))
except Exception as e:
    print("REST LTP ERROR:", e)

# Test Market Quote API
time.sleep(1)
url_quote = "https://api.dhan.co/v2/marketfeed/quote"
payload_quote = {
    "MCX_COMM": ["569901"]
}

print("\nTesting Dhan REST Quote API (v2)...")
try:
    req = urllib.request.Request(url_quote, data=json.dumps(payload_quote).encode('utf-8'), headers=headers, method='POST')
    with urllib.request.urlopen(req) as resp:
        res = json.loads(resp.read().decode('utf-8'))
        print("REST QUOTE SUCCESS:", json.dumps(res, indent=2))
except Exception as e:
    print("REST QUOTE ERROR:", e)
