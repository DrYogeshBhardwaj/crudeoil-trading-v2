import asyncio
import websockets
import json

cid = "1113639152"
token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTY0MTg4LCJpYXQiOjE3OTA4Nzc3ODgsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.BW4iAl5ZEdLaKiev71YsjAY4mQcNMWTbLctUz4mJ8ou1hUGT-uyCRJChqL-idTqZrJIivJFtI2mv3L2I4hZJpQ"

async def test_instrument(seg, sec_id):
    ws_url = f"wss://api-feed.dhan.co?version=2&token={token}&clientId={cid}&authType=2"
    print(f"\nTesting Instrument: Segment='{seg}', SecID='{sec_id}'...")
    try:
        async with websockets.connect(ws_url, ping_interval=20, ping_timeout=10) as ws:
            sub_json = {
                "RequestCode": 15,
                "InstrumentCount": 1,
                "InstrumentList": [
                    {
                        "ExchangeSegment": seg,
                        "SecurityId": str(sec_id)
                    }
                ]
            }
            await ws.send(json.dumps(sub_json))
            print(f"Sent sub payload for {seg}:{sec_id}...")
            
            for i in range(3):
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=2.0)
                    print(f"[{seg}:{sec_id}] RECEIVED MSG: {msg}")
                except asyncio.TimeoutError:
                    print(f"[{seg}:{sec_id}] (No tick in 2s — socket STAYED OPEN!)")
    except Exception as e:
        print(f"[{seg}:{sec_id}] DISCONNECTED / ERROR: {e}")

async def main():
    # Test NSE_EQ (HDFCBANK 1333), IDX_I (Nifty 13), MCX_COMM (569901)
    await test_instrument("NSE_EQ", "1333")
    await asyncio.sleep(60)

if __name__ == "__main__":
    asyncio.run(main())
