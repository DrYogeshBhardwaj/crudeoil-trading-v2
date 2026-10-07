import asyncio
import websockets
import struct
from datetime import datetime, timedelta

cid = "1113639152"
token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTY0MTg4LCJpYXQiOjE3OTA4Nzc3ODgsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.BW4iAl5ZEdLaKiev71YsjAY4mQcNMWTbLctUz4mJ8ou1hUGT-uyCRJChqL-idTqZrJIivJFtI2mv3L2I4hZJpQ"
sec_id = "569901"

def create_dhan_sub_packet(client_id: str, target_sec_id: str = "569901") -> bytes:
    num_inst = 1
    msg_len = 83 + 4 + (num_inst * 21)
    header = struct.pack('<bH30s50s', 15, msg_len, client_id.encode('utf-8')[:30].ljust(30, b'\0'), b'\0' * 50)
    num_inst_bytes = struct.pack('<I', num_inst)
    # ExchangeSegment = 5 for MCX Commodities in Dhan HQ v2
    inst_bytes = struct.pack('<B20s', 5, target_sec_id.encode('utf-8')[:20].ljust(20, b'\0'))
    return header + num_inst_bytes + inst_bytes

async def run_binary_test():
    ws_url = f"wss://api-feed.dhan.co?version=2&token={token}&clientId={cid}&authType=2"
    now_ist = (datetime.utcnow() + timedelta(hours=5, minutes=30)).strftime("%Y-%m-%d %H:%M:%S IST")
    print(f"[{now_ist}] Connecting to Dhan WebSocket v2...")
    print(f"Server local system time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Calculated IST time: {now_ist}")
    
    try:
        async with websockets.connect(ws_url, ping_interval=20, ping_timeout=10) as ws:
            print("CONNECTED to wss://api-feed.dhan.co!")
            
            sub_packet = create_dhan_sub_packet(cid, sec_id)
            await ws.send(sub_packet)
            print(f"Sent binary sub packet (len={len(sub_packet)}) for Security ID {sec_id}.")
            
            print("Listening for 15 seconds...")
            end_time = asyncio.get_event_loop().time() + 15
            tick_count = 0
            
            while asyncio.get_event_loop().time() < end_time:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=2.0)
                    now_str = (datetime.utcnow() + timedelta(hours=5, minutes=30)).strftime("%H:%M:%S IST")
                    tick_count += 1
                    if isinstance(msg, bytes):
                        print(f"[{now_str}] Received Binary Message #{tick_count} (Len={len(msg)} bytes): {msg[:32].hex()}")
                    else:
                        print(f"[{now_str}] Received Text Message #{tick_count}: {msg}")
                except asyncio.TimeoutError:
                    now_str = (datetime.utcnow() + timedelta(hours=5, minutes=30)).strftime("%H:%M:%S IST")
                    print(f"[{now_str}] (No message received in 2s interval)")
                    
            print(f"Test completed. Total messages received: {tick_count}")
    except Exception as e:
        print(f"WebSocket Error: {e}")

if __name__ == "__main__":
    asyncio.run(run_binary_test())
