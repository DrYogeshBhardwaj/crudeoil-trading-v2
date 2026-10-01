import asyncio
import time
from datetime import datetime, timedelta
from dhanhq import DhanContext, MarketFeed

cid = "1113639152"
token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTQ5NjY5LCJpYXQiOjE3OTA4NjMyNjksInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.59QPu_FIyTS6Kh7E0j42pZ8vGdP4cjit2_wZ-7kh8PKX0UyWX54SiM-1A-jJ-WTaOTRhTYDFd6VxRQdNxPjCrw"

ctx = DhanContext(cid, token)

# Instruments format for Dhan SDK: [(ExchangeSegmentInt, SecurityIdStr, RequestCodeInt)]
# MarketFeed.MCX = 5, SecurityId = "545802", RequestCode = 15 (Ticker)
instruments = [
    (MarketFeed.MCX, "545802", MarketFeed.Ticker)
]

ticks_received = []

def on_connect(instance):
    print(f"[{datetime.now()}] Connected to Dhan HQ Market Feed WebSocket!")

def on_message(instance, message):
    try:
        if isinstance(message, dict):
            ltp = message.get("LTP")
            sec_id = message.get("security_id")
            ltt = message.get("LTT")
            print(f"[{datetime.now()}] REAL TICK RECEIVED -> SecID: {sec_id}, LTP: ₹{ltp}, LTT: {ltt}")
            ticks_received.append((sec_id, ltp, ltt))
        else:
            print("Message raw:", message)
    except Exception as e:
        print("Message error:", e)

def on_error(instance, error):
    print("WS Error:", error)

def on_close(instance, code, reason):
    print("WS Closed:", code, reason)

mf = MarketFeed(
    dhan_context=ctx,
    instruments=instruments,
    version="v2",
    on_connect=on_connect,
    on_message=on_message,
    on_error=on_error,
    on_close=on_close
)

print("Starting MarketFeed listener loop...")
try:
    mf.run_forever()
except KeyboardInterrupt:
    print("Stopped.")
