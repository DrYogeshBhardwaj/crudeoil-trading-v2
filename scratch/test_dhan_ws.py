import asyncio
import websockets
import json
import struct

cid = "1113639152"
token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTQ5NjY5LCJpYXQiOjE3OTA4NjMyNjksInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.59QPu_FIyTS6Kh7E0j42pZ8vGdP4cjit2_wZ-7kh8PKX0UyWX54SiM-1A-jJ-WTaOTRhTYDFd6VxRQdNxPjCrw"

# Test different URL versions / auth params
urls = [
    f"wss://api-feed.dhan.co?version=2&token={token}&clientId={cid}&authType=2",
    f"wss://api-feed.dhan.co",
]

async def test_sub_format(ex_seg):
    url = f"wss://api-feed.dhan.co?version=2&token={token}&clientId={cid}&authType=2"
    print(f"\n--- Testing ExchangeSegment: {ex_seg} ---")
    try:
        async with websockets.connect(url, ping_interval=20, ping_timeout=10) as ws:
            print("Connected to WS successfully!")
            
            # Check if initial connection message arrives
            try:
                initial_msg = await asyncio.wait_for(ws.recv(), timeout=2.0)
                print("Initial message on connect:", type(initial_msg), len(initial_msg), initial_msg[:50] if isinstance(initial_msg, bytes) else initial_msg)
            except asyncio.TimeoutError:
                print("No initial msg received on connect, proceeding to subscribe...")

            sub = {
                "RequestCode": 15,
                "InstrumentCount": 1,
                "InstrumentList": [
                    {
                        "ExchangeSegment": ex_seg,
                        "SecurityId": "545802"
                    }
                ]
            }
            print(f"Sending sub payload for {ex_seg}:", json.dumps(sub))
            await ws.send(json.dumps(sub))
            
            for i in range(3):
                msg = await asyncio.wait_for(ws.recv(), timeout=5.0)
                print(f"Received msg #{i+1}: type={type(msg)}, len={len(msg)}")
                if isinstance(msg, bytes):
                    print("Hex bytes:", msg.hex())
                    print("Header Code (byte 0):", msg[0])
                    if len(msg) >= 8:
                        f4 = struct.unpack_from("<f", msg, 4)[0]
                        i4 = struct.unpack_from("<i", msg, 4)[0]
                        print(f"Byte 4..8 -> float32: {f4}, int32: {i4}")
                    if len(msg) >= 12:
                        f8 = struct.unpack_from("<f", msg, 8)[0]
                        i8 = struct.unpack_from("<i", msg, 8)[0]
                        print(f"Byte 8..12 -> float32: {f8}, int32: {i8}")
                else:
                    print("Text msg:", msg)
    except Exception as e:
        print(f"Error for {ex_seg}: {type(e).__name__} - {e}")

async def main():
    segments = ["MCX_COMM", "MCX_FO", "MCX", 5, 8]
    for seg in segments:
        await test_sub_format(seg)
        await asyncio.sleep(1)

if __name__ == "__main__":
    asyncio.run(main())
