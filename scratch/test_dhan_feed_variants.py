import asyncio
import websockets
import json
import struct

cid = "1113639152"
token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTY0MTg4LCJpYXQiOjE3OTA4Nzc3ODgsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.BW4iAl5ZEdLaKiev71YsjAY4mQcNMWTbLctUz4mJ8ou1hUGT-uyCRJChqL-idTqZrJIivJFtI2mv3L2I4hZJpQ"

async def test_sub_variant_1():
    url = f"wss://api-feed.dhan.co?version=2&token={token}&clientId={cid}&authType=2"
    print("\n--- Variant 1: Binary Sub Packet ExchangeSegment=5 (MCX_COMM) ---")
    try:
        async with websockets.connect(url, ping_interval=20, ping_timeout=10) as ws:
            print("Connected to WS!")
            sec_id = "569901"
            num_inst = 1
            msg_len = 83 + 4 + (num_inst * 21)
            hdr = struct.pack('<bH30s50s', 15, msg_len, cid.encode('utf-8')[:30].ljust(30, b'\0'), b'\0' * 50)
            n_inst = struct.pack('<I', num_inst)
            inst = struct.pack('<B20s', 5, sec_id.encode('utf-8')[:20].ljust(20, b'\0'))
            packet = hdr + n_inst + inst
            await ws.send(packet)
            print("Sent binary sub packet. Waiting for ticks...")
            for i in range(5):
                res = await asyncio.wait_for(ws.recv(), timeout=5.0)
                print(f"Recv #{i}: type={type(res)}, len={len(res)}")
                if isinstance(res, bytes):
                    print("Hex:", res.hex()[:40])
    except Exception as e:
        print("Variant 1 Error:", type(e).__name__, "-", e)

async def test_sub_variant_2():
    url = f"wss://api-feed.dhan.co?version=2&token={token}&clientId={cid}&authType=2"
    print("\n--- Variant 2: JSON Sub Packet Code 15 ---")
    try:
        async with websockets.connect(url, ping_interval=20, ping_timeout=10) as ws:
            print("Connected to WS!")
            sub_payload = {
                "RequestCode": 15,
                "InstrumentCount": 1,
                "InstrumentList": [
                    {
                        "ExchangeSegment": "MCX_COMM",
                        "SecurityId": "569901"
                    }
                ]
            }
            await ws.send(json.dumps(sub_payload))
            print("Sent JSON sub packet. Waiting for ticks...")
            for i in range(5):
                res = await asyncio.wait_for(ws.recv(), timeout=5.0)
                print(f"Recv #{i}: type={type(res)}, len={len(res)}")
    except Exception as e:
        print("Variant 2 Error:", type(e).__name__, "-", e)

async def test_sub_variant_3():
    url = f"wss://api-feed.dhan.co?version=2&token={token}&clientId={cid}&authType=2"
    print("\n--- Variant 3: Binary Feed Code 17 (Ticker Data) ---")
    try:
        async with websockets.connect(url, ping_interval=20, ping_timeout=10) as ws:
            print("Connected to WS!")
            sec_id = "569901"
            num_inst = 1
            msg_len = 83 + 4 + (num_inst * 21)
            hdr = struct.pack('<bH30s50s', 17, msg_len, cid.encode('utf-8')[:30].ljust(30, b'\0'), b'\0' * 50)
            n_inst = struct.pack('<I', num_inst)
            inst = struct.pack('<B20s', 5, sec_id.encode('utf-8')[:20].ljust(20, b'\0'))
            packet = hdr + n_inst + inst
            await ws.send(packet)
            print("Sent binary code 17 sub packet. Waiting for ticks...")
            for i in range(5):
                res = await asyncio.wait_for(ws.recv(), timeout=5.0)
                print(f"Recv #{i}: type={type(res)}, len={len(res)}")
                if isinstance(res, bytes):
                    print("Hex:", res.hex()[:40])
    except Exception as e:
        print("Variant 3 Error:", type(e).__name__, "-", e)

if __name__ == "__main__":
    asyncio.run(test_sub_variant_1())
    asyncio.run(test_sub_variant_2())
    asyncio.run(test_sub_variant_3())
