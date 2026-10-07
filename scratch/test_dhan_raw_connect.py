import asyncio
import websockets
import json
import struct

cid = "1113639152"
token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTQ5NjY5LCJpYXQiOjE3OTA4NjMyNjksInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.59QPu_FIyTS6Kh7E0j42pZ8vGdP4cjit2_wZ-7kh8PKX0UyWX54SiM-1A-jJ-WTaOTRhTYDFd6VxRQdNxPjCrw"

async def test_just_listen():
    url = f"wss://api-feed.dhan.co?version=2&token={token}&clientId={cid}&authType=2"
    print("\n--- Testing Connection Without Any Packets ---")
    try:
        async with websockets.connect(url, ping_interval=20, ping_timeout=10) as ws:
            print("Connected! Listening for 10s without sending anything...")
            for i in range(5):
                res = await asyncio.wait_for(ws.recv(), timeout=2.0)
                print(f"Recv #{i}: type={type(res)}, len={len(res)}")
    except Exception as e:
        print("WS Error:", type(e).__name__, "-", e)

async def test_binary_sub():
    url = f"wss://api-feed.dhan.co?version=2&token={token}&clientId={cid}&authType=2"
    print("\n--- Testing Binary Sub Request (ReqCode 15) ---")
    try:
        async with websockets.connect(url, ping_interval=20, ping_timeout=10) as ws:
            print("Connected!")
            # Dhan API v2 binary subscription packet
            # RequestCode: 15 (1 byte int)
            # InstrumentCount: 1 (2 bytes int) -> Total Msg length?
            # Dhan v2 spec: RequestCode (1B, int 15), MsgLength (2B int = 83), ClientId (30B char), Token (50B char), InstrumentCount (4B int), ExchangeSegment (1B int), SecurityId (20B char)
            
            # Header: RequestCode 15 (1B), msg_len 83+4+21=108 (2B), ClientId (30B), Token/Reserved (50B)
            num_inst = 1
            msg_len = 83 + 4 + (num_inst * 21)
            hdr = struct.pack('<bH30s50s', 15, msg_len, cid.encode('utf-8')[:30].ljust(30, b'\0'), b'\0' * 50)
            n_inst = struct.pack('<I', num_inst)
            # ExchangeSegment: 5 (MCX)
            sec_id = "569901"
            inst = struct.pack('<B20s', 5, sec_id.encode('utf-8')[:20].ljust(20, b'\0'))
            
            packet = hdr + n_inst + inst
            print(f"Sending binary packet len={len(packet)} hex={packet.hex()[:60]}...")
            await ws.send(packet)
            
            for i in range(10):
                res = await asyncio.wait_for(ws.recv(), timeout=5.0)
                print(f"Recv #{i}: type={type(res)}, len={len(res)}")
                if isinstance(res, bytes):
                    print("Bytes hex:", res.hex())
    except Exception as e:
        print("Binary Sub Error:", type(e).__name__, "-", e)

if __name__ == "__main__":
    asyncio.run(test_just_listen())
    asyncio.run(test_binary_sub())
