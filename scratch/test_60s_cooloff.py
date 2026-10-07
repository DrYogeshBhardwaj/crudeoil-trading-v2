import time
import asyncio
import websockets
from datetime import datetime

cid = "1113639152"
token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTY4MTg4LCJpYXQiOjE3OTA4Nzc3ODgsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.BW4iAl5ZEdLaKiev71YsjAY4mQcNMWTbLctUz4mJ8ou1hUGT-uyCRJChqL-idTqZrJIivJFtI2mv3L2I4hZJpQ"

print(f"[{datetime.now()}] Sleeping 60 seconds for Dhan WS HTTP 429 rate limit cool-off...")
time.sleep(60)
print(f"[{datetime.now()}] Cool-off complete! Attempting single Dhan SDK WS connection...")

from dhanhq import DhanContext, MarketFeed

ctx = DhanContext(cid, token)
instruments = [(MarketFeed.MCX, "569901", MarketFeed.Ticker)]

def on_connect(instance):
    print(f"[{datetime.now()}] SUCCESS! Dhan SDK WS Connected after cool-off!")
    instance.subscribe_symbols(instruments)

def on_message(instance, message):
    print(f"[{datetime.now()}] TICK RECEIVED: {message}")

def on_error(instance, error):
    print("Dhan SDK Error:", error)

mf = MarketFeed(dhan_context=ctx, instruments=instruments, version="v2", on_connect=on_connect, on_message=on_message, on_error=on_error)
try:
    mf.run_forever()
    time.sleep(10)
except Exception as e:
    print("Finished:", e)
