import asyncio
import websockets
import struct
from datetime import datetime, timezone, timedelta

cid = "1113639152"
token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTY0MTg4LCJpYXQiOjE3OTA4Nzc3ODgsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.BW4iAl5ZEdLaKiev71YsjAY4mQcNMWTbLctUz4mJ8ou1hUGT-uyCRJChqL-idTqZrJIivJFtI2mv3L2I4hZJpQ"
sec_id = "569901"

def create_padded_binary_sub_packet(client_id: str, target_sec_id: str = "569901", feed_code: int = 15) -> bytes:
    num_inst = 1
    # 83-byte header
    header = struct.pack('<bH30s50s', feed_code, 83 + 4 + (1 * 21), client_id.encode('utf-8')[:30].ljust(30, b'\0'), b'\0' * 50)
    num_inst_bytes = struct.pack('<I', num_inst)
    
    # Target instrument: Exchange 5 (MCX), SecID 569901
    inst_info = struct.pack('<B20s', 5, target_sec_id.encode('utf-8')[:20].ljust(20, b'\0'))
    
    # Pad remaining 99 slots with 0s (21 bytes each)
    for _ in range(99):
        inst_info += struct.pack('<B20s', 0, b'\0' * 20)
        
    return header + num_inst_bytes + inst_info

async def test_padded_binary():
    ws_url = f"wss://api-feed.dhan.co?version=2&token={token}&clientId={cid}&authType=2"
    now_ist = datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m-%d %H:%M:%S IST")
    print(f"[{now_ist}] Connecting to Dhan WebSocket v2...")
    
    try:
        async with websockets.connect(ws_url, ping_interval=20, ping_timeout=10) as ws:
            print("CONNECTED! Sending 2187-byte padded binary subscription packet...")
            
            sub_pkt = create_padded_binary_sub_packet(cid, sec_id, 15)
            print(f"Sub Packet Size: {len(sub_pkt)} bytes")
            await ws.send(sub_pkt)
            print("Padded Sub Packet Sent!")
            
            # Listen for 10 seconds
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
                    print(f"[{now_str}] (No tick received — socket STAYED OPEN & STABLE!)")
                    
            print("SUCCESS! Padded binary subscription kept WebSocket open without disconnect.")
    except Exception as e:
        print(f"WebSocket Error: {e}")

if __name__ == "__main__":
    asyncio.run(test_padded_binary())
