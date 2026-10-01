import asyncio
import websockets
import json
import struct
from datetime import datetime

cid = "1113639152"
token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTQ5NjY5LCJpYXQiOjE3OTA4NjMyNjksInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.59QPu_FIyTS6Kh7E0j42pZ8vGdP4cjit2_wZ-7kh8PKX0UyWX54SiM-1A-jJ-WTaOTRhTYDFd6VxRQdNxPjCrw"

def create_dhan_sub_packet(client_id: str, sec_id: str = "569901") -> bytes:
    num_inst = 1
    msg_len = 83 + 4 + (num_inst * 21)
    header = struct.pack('<bH30s50s', 15, msg_len, client_id.encode('utf-8')[:30].ljust(30, b'\0'), b'\0' * 50)
    num_inst_bytes = struct.pack('<I', num_inst)
    inst_bytes = struct.pack('<B20s', 5, sec_id.encode('utf-8')[:20].ljust(20, b'\0'))
    
    padding = b""
    for _ in range(99):
        padding += struct.pack('<B20s', 0, b'\0' * 20)
        
    return header + num_inst_bytes + inst_bytes + padding

def parse_dhan_binary_packet(data: bytes):
    if len(data) >= 16:
        header_code, msg_len, ex_seg, sec_id, ltp, ltt = struct.unpack_from('<BHBIfI', data, 0)
        if 1000.0 <= ltp <= 25000.0:
            return {"type": "Ticker", "header_code": header_code, "sec_id": sec_id, "ltp": round(ltp, 2), "ltt": ltt}
    if len(data) >= 50:
        unpack_quote = struct.unpack_from('<BHBIfHIfIIIffff', data, 0)
        ltp = unpack_quote[4]
        if 1000.0 <= ltp <= 25000.0:
            return {"type": "Quote", "sec_id": unpack_quote[3], "ltp": round(ltp, 2), "ltt": unpack_quote[6]}
    return None

async def test_569901():
    url = f"wss://api-feed.dhan.co?version=2&token={token}&clientId={cid}&authType=2"
    print(f"[{datetime.now()}] Connecting to Dhan WS v2 for Active Security ID 569901 (CRUDEOILM-19Oct2026)...")
    
    async with websockets.connect(url, ping_interval=20, ping_timeout=10) as ws:
        print(f"[{datetime.now()}] CONNECTED! Sending subscription for 569901 & 569900...")
        
        # Test 569901 (CRUDEOILM) and 569900 (CRUDEOIL)
        sub_bin = create_dhan_sub_packet(cid, "569901")
        await ws.send(sub_bin)
        
        json_sub = {
            "RequestCode": 15,
            "InstrumentCount": 2,
            "InstrumentList": [
                {"ExchangeSegment": "MCX_COMM", "SecurityId": "569901"},
                {"ExchangeSegment": "MCX_COMM", "SecurityId": "569900"}
            ]
        }
        await ws.send(json.dumps(json_sub))
        print("Sent JSON sub:", json.dumps(json_sub))
        
        ticks_got = 0
        for i in range(10):
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=3.0)
                now_ist = datetime.now().strftime("%H:%M:%S IST")
                if isinstance(msg, bytes):
                    parsed = parse_dhan_binary_packet(msg)
                    if parsed:
                        ticks_got += 1
                        print(f"[{now_ist}] REAL LIVE TICK #{ticks_got} -> SecID: {parsed['sec_id']}, LTP: Rs. {parsed['ltp']}")
                    else:
                        print(f"[{now_ist}] Binary msg (len={len(msg)}): {msg[:32].hex()}")
                elif isinstance(msg, str):
                    print(f"[{now_ist}] Text msg: {msg}")
            except asyncio.TimeoutError:
                print(f"[{datetime.now().strftime('%H:%M:%S IST')}] Waiting for ticks...")

if __name__ == "__main__":
    asyncio.run(test_569901())
