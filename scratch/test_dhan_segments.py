import asyncio
import websockets
import json
from datetime import datetime

cid = "1113639152"
token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTY0MTg4LCJpYXQiOjE3OTA4Nzc3ODgsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.BW4iAl5ZEdLaKiev71YsjAY4mQcNMWTbLctUz4mJ8ou1hUGT-uyCRJChqL-idTqZrJIivJFtI2mv3L2I4hZJpQ"
sec_id = "569901"

async def test_segment(segment_name):
    ws_url = f"wss://api-feed.dhan.co?version=2&token={token}&clientId={cid}&authType=2"
    print(f"\nTesting Segment Name: '{segment_name}'...")
    try:
        async with websockets.connect(ws_url, ping_interval=20, ping_timeout=10) as ws:
            sub_json = {
                "RequestCode": 15,
                "InstrumentCount": 1,
                "InstrumentList": [
                    {
                        "ExchangeSegment": segment_name,
                        "SecurityId": sec_id
                    }
                ]
            }
            await ws.send(json.dumps(sub_json))
            print(f"Sent sub for {segment_name}...")
            
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=3.0)
                print(f"[{segment_name}] RECEIVED MSG: {msg[:60]}")
            except asyncio.TimeoutError:
                print(f"[{segment_name}] SUCCESS — Socket stayed open cleanly!")
    except Exception as e:
        print(f"[{segment_name}] DISCONNECTED / ERROR: {e}")

async def main():
    for seg in ["MCX_FO", "MCX_COMM", "MCX", "5"]:
        await test_segment(seg)
        await asyncio.sleep(2)

if __name__ == "__main__":
    asyncio.run(main())
