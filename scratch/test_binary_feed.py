import asyncio
import websockets
import struct
import json
from datetime import datetime, timedelta

cid = "1113639152"
token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTQ5NjY5LCJpYXQiOjE3OTA4NjMyNjksInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.59QPu_FIyTS6Kh7E0j42pZ8vGdP4cjit2_wZ-7kh8PKX0UyWX54SiM-1A-jJ-WTaOTRhTYDFd6VxRQdNxPjCrw"

def create_dhan_sub_packet(client_id: str, sec_id: str = "545802") -> bytes:
    num_inst = 1
    msg_len = 83 + 4 + (num_inst * 21)
    header = struct.pack('<bH30s50s', 15, msg_len, client_id.encode('utf-8')[:30].ljust(30, b'\0'), b'\0' * 50)
    num_inst_bytes = struct.pack('<I', num_inst)
    inst_bytes = struct.pack('<B20s', 5, sec_id.encode('utf-8')[:20].ljust(20, b'\0'))
    
    padding = b""
    for _ in range(99):
        padding += struct.pack('<B20s', 0, b'\0' * 20)
        
    return header + num_inst_bytes + inst_bytes + padding

def parse_dhan_ticker(data: bytes):
    if len(data) >= 16:
        header_code, length, exchange_seg, sec_id, ltp, ltt = struct.unpack('<BHBIfI', data[0:16])
        return {
            "header_code": header_code,
            "exchange_seg": exchange_seg,
            "sec_id": sec_id,
            "ltp": round(ltp, 2),
            "ltt": ltt
        }
    return None

async def main():
    url = f"wss://api-feed.dhan.co?version=2&token={token}&clientId={cid}&authType=2"
    print("Connecting to Dhan WS v2...")
    async with websockets.connect(url, ping_interval=20, ping_timeout=10) as ws:
        print("Connected!")
        sub_bin = create_dhan_sub_packet(cid, "545802")
        print("Sending binary sub packet, len:", len(sub_bin))
        await ws.send(sub_bin)
        
        for i in range(5):
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=5.0)
                print(f"Recv #{i+1}: type={type(msg)}, len={len(msg)}")
                if isinstance(msg, bytes):
                    tick = parse_dhan_ticker(msg)
                    print("PARSED TICK:", tick)
            except asyncio.TimeoutError:
                print("Timeout waiting for tick")

if __name__ == "__main__":
    asyncio.run(main())
