import time
from datetime import datetime
from dhanhq import DhanContext, MarketFeed

cid = "1113639152"
token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTY0MTg4LCJpYXQiOjE3OTA4Nzc3ODgsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.BW4iAl5ZEdLaKiev71YsjAY4mQcNMWTbLctUz4mJ8ou1hUGT-uyCRJChqL-idTqZrJIivJFtI2mv3L2I4hZJpQ"

ctx = DhanContext(cid, token)

# Instruments format for Dhan v2: (ExchangeSegment, SecurityId, RequestCode)
# MCX = 5, Ticker = 15, Quote = 17, Full = 21
instruments = [
    (5, "569901", 15)
]

def on_connect(instance):
    print(f"[{datetime.now()}] Dhan SDK Connected successfully!")

def on_ticks(instance, data):
    now_ist = datetime.now().strftime("%H:%M:%S IST")
    print(f"[{now_ist}] Dhan SDK Tick Data: {data}")

def on_error(instance, error):
    print(f"[{datetime.now()}] Dhan SDK Error: {error}")

def on_close(instance):
    print(f"[{datetime.now()}] Dhan SDK Connection Closed.")

mf = MarketFeed(
    dhan_context=ctx,
    instruments=instruments,
    version="v2",
    on_connect=on_connect,
    on_ticks=on_ticks,
    on_error=on_error,
    on_close=on_close
)

print(f"[{datetime.now()}] Starting Dhan MarketFeed async loop...")
feed_thread = mf.start()

# Monitor connection state for 15 seconds
for i in range(15):
    time.sleep(1)
    is_closed = mf._is_ws_closed()
    print(f"[{datetime.now().strftime('%H:%M:%S IST')}] Tick monitor second #{i+1} | WS Closed: {is_closed}")

print("Shutting down test...")
mf.close_connection()
feed_thread.join(timeout=3)
print("Test completed.")
