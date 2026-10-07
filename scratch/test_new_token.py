import urllib.request
import json

client_id = "1113639152"
new_token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTY0MTg4LCJpYXQiOjE3OTA4Nzc3ODgsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.BW4iAl5ZEdLaKiev71YsjAY4mQcNMWTbLctUz4mJ8ou1hUGT-uyCRJChqL-idTqZrJIivJFtI2mv3L2I4hZJpQ"

print("--- Testing New Token on Dhan REST API ---")
url = "https://api.dhan.co/v2/fundlimit"
headers = {
    "client-id": client_id,
    "access-token": new_token,
    "Content-Type": "application/json"
}

try:
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=10) as resp:
        body = resp.read().decode("utf-8")
        print(f"[SUCCESS {resp.status}] Fund Limit Response:")
        print(json.dumps(json.loads(body), indent=2))
except Exception as e:
        print("[ERROR]", e)
