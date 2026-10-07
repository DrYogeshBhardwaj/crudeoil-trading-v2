import urllib.request
import json
import ssl
import sys

client_id = "1113639152"
access_token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTQ5NjY5LCJpYXQiOjE3OTA4NjMyNjksInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.59QPu_FIyTS6Kh7E0j42pZ8vGdP4cjit2_wZ-7kh8PKX0UyWX54SiM-1A-jJ-WTaOTRhTYDFd6VxRQdNxPjCrw"

print("--- 1. Testing Dhan REST API (Fund Limit) ---")
endpoints = [
    "https://api.dhan.co/v2/fundlimit",
    "https://api.dhan.co/fundlimit",
    "https://api.dhan.co/user/fundlimit"
]

for url in endpoints:
    try:
        headers = {
            "client-id": client_id,
            "access-token": access_token,
            "Content-Type": "application/json"
        }
        req = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8")
            print(f"[SUCCESS] {url} -> Response code {resp.status}")
            print(body[:300])
    except urllib.error.HTTPError as he:
        err_body = ""
        try:
            err_body = he.read().decode("utf-8")
        except Exception:
            pass
        print(f"[HTTP {he.code}] {url} -> {he.reason}: {err_body}")
    except Exception as e:
        print(f"[ERROR] {url} -> {e}")

print("\n--- 2. Checking Expiry of JWT Access Token ---")
import base64
try:
    parts = access_token.split(".")
    if len(parts) == 3:
        payload_b64 = parts[1] + "=="
        payload_json = json.loads(base64.b64decode(payload_b64).decode("utf-8"))
        exp_ts = payload_json.get("exp")
        iat_ts = payload_json.get("iat")
        print("Token payload:", payload_json)
        import datetime
        if exp_ts:
            exp_dt = datetime.datetime.fromtimestamp(exp_ts, tz=datetime.timezone.utc)
            now_dt = datetime.datetime.now(tz=datetime.timezone.utc)
            print(f"Token Issued At: {datetime.datetime.fromtimestamp(iat_ts, tz=datetime.timezone.utc) if iat_ts else 'N/A'}")
            print(f"Token Expires At: {exp_dt}")
            print(f"Current UTC Time: {now_dt}")
            print(f"Is Token Expired? {now_dt > exp_dt}")
except Exception as e:
    print("Error decoding JWT:", e)
