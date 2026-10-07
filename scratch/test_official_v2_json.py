import asyncio
import websockets
import json
from datetime import datetime, timezone, timedelta

cid = "1113639152"
token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTY0MTg4LCJpYXQiOjE3OTA4Nzc3ODgsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.BW4iAl5ZEdLaKiev71YsjAY4mQcNMWTbLctUz4mJ8ou1hUGT-uyCRJChqL-idTqZrJIivJFtI2mv3L2I4hZJpQ"
sec_id = "569901"

async def test_v2_json_subscription():
    ws_url = f"wss://api-feed.dhan.co?version=2&token={token}&clientId={cid}&authType=2"
    now_ist = datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d %H:%M:%S IST")
    print(f"[{now_ist}] Connecting to Dhan WebSocket v2...")
    
    try:
        async with websockets.connect(ws_url, ping_interval=20, ping_timeout=10) as ws:
            print("CONNECTED! Sending official DhanHQ v2 JSON subscription message...")
            
            # RequestCode 15 = Ticker Data, 17 = Quote Data, 21 = Full Data
            sub_msg = {
                "RequestCode": 15,
                "InstrumentCount": 1,
                "InstrumentList": [
                    {
                        "ExchangeSegment": "MCX_COMM",
                        "SecurityId": sec_id
                    }
                ]
            }
            await ws.send(json.dumps(sub_msg))
            print(f"Sent v2 JSON Subscription: {json.dumps(sub_msg)}")
            
            # Wait for 10 seconds to see if socket stays open cleanly
            print("Listening for messages...")
            for i in range(5):
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=2.0)
                    now_str = datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime("%H:%M:%S IST")
                    if isinstance(msg, bytes):
                        print(f"[{now_str}] Received Binary Tick (Len={len(msg)} bytes): {msg[:32].hex()}")
                    else:
                        print(f"[{now_str}] Received Text Msg: {msg}")
                except asyncio.TimeoutError:
                    now_str = datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime("%H:%M:%S IST")
                    print(f"[{now_str}] (No tick in 2s interval — socket STABLE & OPEN)")
                    
            print("SUCCESS! Dhan WebSocket v2 JSON subscription processed without disconnection.")
    except Exception as e:
        print(f"WebSocket Error: {e}")

if __name__ == "__main__":
    asyncio.run(test_v2_json_subscription())
