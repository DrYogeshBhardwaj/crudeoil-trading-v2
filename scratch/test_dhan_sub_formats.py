import asyncio
import websockets
import json
import struct
from datetime import datetime

cid = "1113639152"
token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTY0MTg4LCJpYXQiOjE3OTA4Nzc3ODgsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.BW4iAl5ZEdLaKiev71YsjAY4mQcNMWTbLctUz4mJ8ou1hUGT-uyCRJChqL-idTqZrJIivJFtI2mv3L2I4hZJpQ"
sec_id = "569901"

async def test_format_1_json():
    """Test 1: Dhan HQ v2 standard JSON subscription packet"""
    ws_url = f"wss://api-feed.dhan.co?version=2&token={token}&clientId={cid}&authType=2"
    print("\n--- TEST 1: JSON Subscription Format ---")
    try:
        async with websockets.connect(ws_url, ping_interval=20, ping_timeout=10) as ws:
            print("Connected to WS! Testing JSON payload...")
            json_sub = {
                "RequestCode": 15,
                "InstrumentCount": 1,
                "InstrumentList": [
                    {
                        "ExchangeSegment": "MCX_FO",
                        "SecurityId": sec_id
                    }
                ]
            }
            await ws.send(json.dumps(json_sub))
            print(f"Sent JSON sub: {json.dumps(json_sub)}")
            
            # Read for 5 seconds
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=5.0)
                print(f"RECEIVED MSG FROM JSON SUB: {msg[:100]}")
            except asyncio.TimeoutError:
                print("No msg received in 5s, but socket STAYED OPEN cleanly!")
    except Exception as e:
        print(f"JSON SUB ERROR / DISCONNECT: {e}")

async def test_format_2_official_sdk_packet():
    """Test 2: DhanHQ Official SDK Binary Packet Structure"""
    ws_url = f"wss://api-feed.dhan.co?version=2&token={token}&clientId={cid}&authType=2"
    print("\n--- TEST 2: Official SDK Binary Header ---")
    try:
        async with websockets.connect(ws_url, ping_interval=20, ping_timeout=10) as ws:
            print("Connected to WS! Testing binary sub format...")
            # Official dhanhq format: 83 bytes total
            # Header Code 15 (Ticker) / 21 (Quote)
            # Feed Request Header (83 bytes):
            # <b (1B code), H (2B msg len), 30s (client_id 30B), 50s (token 50B) -> Wait, total header = 83B
            # instrument_count (4B int)
            # instrument: <B (1B seg), 20s (sec_id 20B) -> 21B per inst
            num_inst = 1
            header = struct.pack('<bH30s50s', 15, 83 + 4 + 21, cid.encode('utf-8')[:30].ljust(30, b'\0'), b'\0' * 50)
            num_inst_bytes = struct.pack('<I', num_inst)
            # ExchangeSegment: MCX_FO in Dhan is 5 for Ticker, or segment code
            inst_bytes = struct.pack('<B20s', 5, sec_id.encode('utf-8')[:20].ljust(20, b'\0'))
            
            pkt = header + num_inst_bytes + inst_bytes
            print(f"Sending Pkt Len: {len(pkt)}")
            await ws.send(pkt)
            
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=5.0)
                print(f"RECEIVED MSG FROM BINARY SUB: {msg[:100]}")
            except asyncio.TimeoutError:
                print("No msg received in 5s, but socket STAYED OPEN cleanly!")
    except Exception as e:
        print(f"BINARY SUB ERROR / DISCONNECT: {e}")

async def main():
    await test_format_1_json()
    await asyncio.sleep(2)
    await test_format_2_official_sdk_packet()

if __name__ == "__main__":
    asyncio.run(main())
