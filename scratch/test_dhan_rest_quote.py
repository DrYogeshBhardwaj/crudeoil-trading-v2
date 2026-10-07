import urllib.request
import json

client_id = "1113639152"
access_token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTY0MTg4LCJpYXQiOjE3OTA4Nzc3ODgsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.BW4iAl5ZEdLaKiev71YsjAY4mQcNMWTbLctUz4mJ8ou1hUGT-uyCRJChqL-idTqZrJIivJFtI2mv3L2I4hZJpQ"

headers = {
    "access-token": access_token,
    "client-id": client_id,
    "Content-Type": "application/json"
}

# Test REST Quote API for Security ID 569901 (CRUDEOILM)
url = "https://api.dhan.co/v2/marketfeed/ltp"
payload = {
    "MCX_COMM": ["569901"]
}

print(f"Testing Dhan REST LTP endpoint: {url}...")
try:
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers, method='POST')
    with urllib.request.urlopen(req) as resp:
        res = json.loads(resp.read().decode('utf-8'))
        print("REST LTP RESPONSE:", json.dumps(res, indent=2))
except Exception as e:
    print("REST LTP ERROR:", e)

# Test REST Quote API with different segment keys
for seg in ["MCX_COMM", "MCX_FO", "MCX"]:
    url_quote = "https://api.dhan.co/v2/marketfeed/quote"
    p_q = {seg: ["569901"]}
    try:
        req = urllib.request.Request(url_quote, data=json.dumps(p_q).encode('utf-8'), headers=headers, method='POST')
        with urllib.request.urlopen(req) as resp:
            res = json.loads(resp.read().decode('utf-8'))
            print(f"REST QUOTE RESPONSE ({seg}):", json.dumps(res, indent=2))
    except Exception as e:
        print(f"REST QUOTE ERROR ({seg}):", e)
