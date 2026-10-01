import asyncio
import websockets
import json
import struct

cid = "1113639152"
token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTQ5NjY5LCJpYXQiOjE3OTA4NjMyNjksInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.59QPu_FIyTS6Kh7E0j42pZ8vGdP4cjit2_wZ-7kh8PKX0UyWX54SiM-1A-jJ-WTaOTRhTYDFd6VxRQdNxPjCrw"

def create_dhan_v2_sub_packet(client_id: str, sec_id: str = "545802") -> bytes:
    num_inst = 1
    msg_len = 83 + 4 + (num_inst * 21)
    header = struct.pack('<bH30s50s', 15, msg_len, client_id.encode('utf-8')[:30].ljust(30, b'\0'), b'\0' * 50)
    num_inst_bytes = struct.pack('<I', num_inst)
    inst_bytes = struct.pack('<B20s', 5, sec_id.encode('utf-8')[:20].ljust(20, b'\0'))
    
    padding = b""
    for _ in range(99):
        padding += struct.pack('<B20s', 0, b'\0' * 20)
        
    return header + num_inst_bytes + inst_bytes + padding

async def diagnose():
    url = f"wss://api-feed.dhan.co?version=2&token={token}&clientId={cid}&authType=2"
    print(f"Connecting to: wss://api-feed.dhan.co?version=2&token=[REDACTED]&clientId={cid}&authType=2")
    
    ws_connected = False
    sub_sent = False
    tick_received = False
    disconnect_reason = None
    
    try:
        async with websockets.connect(url, ping_interval=20, ping_timeout=10) as ws:
            ws_connected = True
            print("STATUS: WebSocket CONNECTED to Dhan server!")
            
            # Send Binary Subscription Packet
            sub_packet = create_dhan_v2_sub_packet(cid, "545802")
            await ws.send(sub_packet)
            sub_sent = True
            print("STATUS: Subscription packet for Security ID 545802 SENT!")
            
            # Listen for ticks / response
            try:
                for i in range(5):
                    msg = await asyncio.wait_for(ws.recv(), timeout=5.0)
                    print(f"Received Packet #{i+1}: len={len(msg)}, type={type(msg)}")
                    if isinstance(msg, bytes):
                        print("Hex bytes:", msg[:32].hex())
                        if len(msg) >= 16:
                            code, msg_len, ex_seg, sec_id, ltp, ltt = struct.unpack_from('<BHBIfI', msg, 0)
                            print(f"PARSED TICK -> Code:{code}, SecID:{sec_id}, LTP:₹{ltp}, LTT:{ltt}")
                            if ltp > 0:
                                tick_received = True
                    elif isinstance(msg, str):
                        print("Text frame:", msg)
            except asyncio.TimeoutError:
                print("STATUS: WAITING FOR TICK — Connection open, but no tick received in 5s window (Market quiet/closed or no tick stream)")
    except websockets.exceptions.ConnectionClosed as cc:
        disconnect_reason = f"ConnectionClosed: code={cc.code}, reason={cc.reason}"
        print(f"STATUS: DISCONNECTED — {disconnect_reason}")
    except Exception as e:
        disconnect_reason = f"{type(e).__name__}: {e}"
        print(f"STATUS: DISCONNECTED — {disconnect_reason}")

    print("\n=== SUMMARY DIAGNOSTIC RESULT ===")
    print(f"1. WS Connected: {ws_connected}")
    print(f"2. Sub Packet Sent: {sub_sent}")
    print(f"3. Tick Received: {tick_received}")
    print(f"4. Disconnect Reason: {disconnect_reason or 'None (Connection closed cleanly)'}")

if __name__ == "__main__":
    asyncio.run(diagnose())
