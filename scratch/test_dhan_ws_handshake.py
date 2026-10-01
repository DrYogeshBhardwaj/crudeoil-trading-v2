import asyncio
import websockets
import json
import struct

cid = "1113639152"
token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTQ5NjY5LCJpYXQiOjE3OTA4NjMyNjksInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.59QPu_FIyTS6Kh7E0j42pZ8vGdP4cjit2_wZ-7kh8PKX0UyWX54SiM-1A-jJ-WTaOTRhTYDFd6VxRQdNxPjCrw"

async def test_handshake():
    url = f"wss://api-feed.dhan.co?version=2&token={token}&clientId={cid}&authType=2"
    print("\n--- Testing Login Handshake & Subscription ---")
    try:
        async with websockets.connect(url, ping_interval=20, ping_timeout=10) as ws:
            print("Connected to WS successfully!")

            # Test RequestCode 11 (Login/Handshake)
            login_req = {
                "RequestCode": 11,
                "ClientId": cid,
                "Token": token
            }
            print("Sending Login Req (Code 11):", json.dumps(login_req))
            await ws.send(json.dumps(login_req))
            
            try:
                res1 = await asyncio.wait_for(ws.recv(), timeout=3.0)
                print("Response to Login:", type(res1), len(res1), res1)
            except Exception as e1:
                print("Login response error:", e1)

            # Test RequestCode 15 with String / Int ExchangeSegment
            sub_req = {
                "RequestCode": 15,
                "InstrumentCount": 1,
                "InstrumentList": [
                    {
                        "ExchangeSegment": "MCX_FO",
                        "SecurityId": "545802"
                    }
                ]
            }
            print("Sending Sub Req (Code 15):", json.dumps(sub_req))
            await ws.send(json.dumps(sub_req))

            for i in range(5):
                res = await asyncio.wait_for(ws.recv(), timeout=5.0)
                print(f"Sub Recv #{i}: type={type(res)}, len={len(res)}")
                if isinstance(res, bytes):
                    print("Hex bytes:", res.hex())
                    print("Byte 0:", res[0])
    except Exception as e:
        print("WS Error:", type(e).__name__, "-", e)

if __name__ == "__main__":
    asyncio.run(test_handshake())
