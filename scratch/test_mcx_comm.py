import asyncio
import websockets
import json
import struct
from datetime import datetime

cid = "1113639152"
token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTQ5NjY5LCJpYXQiOjE3OTA4NjMyNjksInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.59QPu_FIyTS6Kh7E0j42pZ8vGdP4cjit2_wZ-7kh8PKX0UyWX54SiM-1A-jJ-WTaOTRhTYDFd6VxRQdNxPjCrw"

async def test_mcx_comm():
    url = f"wss://api-feed.dhan.co?version=2&token={token}&clientId={cid}&authType=2"
    print(f"[{datetime.now()}] Connecting to Dhan WebSocket v2...")
    
    async with websockets.connect(url, ping_interval=20, ping_timeout=10) as ws:
        print(f"[{datetime.now()}] CONNECTED! Sending subscription for MCX_COMM / 545802...")
        
        # Test RequestCode 15 with ExchangeSegment MCX_COMM
        sub_msg = {
            "RequestCode": 15,
            "InstrumentCount": 1,
            "InstrumentList": [
                {
                    "ExchangeSegment": "MCX_COMM",
                    "SecurityId": "545802"
                }
            ]
        }
        await ws.send(json.dumps(sub_msg))
        print("Sent JSON sub:", json.dumps(sub_msg))
        
        for i in range(5):
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=5.0)
                now_ist = datetime.now().strftime("%H:%M:%S IST")
                print(f"[{now_ist}] Recv #{i+1}: type={type(msg)}, len={len(msg)}")
                if isinstance(msg, bytes):
                    print("Hex bytes:", msg[:32].hex())
                    if len(msg) >= 16:
                        code, msg_len, ex_seg, sec_id, ltp, ltt = struct.unpack_from('<BHBIfI', msg, 0)
                        print(f"--> PARSED TICK: SecID={sec_id}, LTP=₹{ltp}, LTT={ltt}")
            except asyncio.TimeoutError:
                print("Timeout waiting for message")

if __name__ == "__main__":
    asyncio.run(test_mcx_comm())
