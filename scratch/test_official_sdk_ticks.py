import time
from datetime import datetime
from dhanhq import DhanContext, MarketFeed

cid = "1113639152"
token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTY0MTg4LCJpYXQiOjE3OTA4Nzc3ODgsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.BW4iAl5ZEdLaKiev71YsjAY4mQcNMWTbLctUz4mJ8ou1hUGT-uyCRJChqL-idTqZrJIivJFtI2mv3L2I4hZJpQ"

ctx = DhanContext(cid, token)

instruments = [
    (MarketFeed.MCX, "569901", MarketFeed.Ticker),
    (MarketFeed.MCX, "569901", MarketFeed.Quote)
]

tick_list = []

def on_connect(instance):
    print(f"[{datetime.now()}] Dhan SDK Connected successfully!")
    instance.subscribe_symbols(instruments)

def on_message(instance, message):
    now_ist = datetime.now().strftime("%H:%M:%S IST")
    print(f"[{now_ist}] Dhan SDK Message Received: {message}")
    tick_list.append(message)

def on_error(instance, error):
    print("Dhan SDK Error:", error)

def on_close(instance, code, reason):
    print("Dhan SDK Closed:", code, reason)

mf = MarketFeed(
    dhan_context=ctx,
    instruments=instruments,
    version="v2",
    on_connect=on_connect,
    on_message=on_message,
    on_error=on_error,
    on_close=on_close
)

print(f"[{datetime.now()}] Starting MarketFeed listener...")
try:
    mf.run_forever()
    start = time.time()
    while time.time() - start < 15:
        time.sleep(1)
    print(f"Total Ticks Captured by SDK: {len(tick_list)}")
except Exception as e:
    print("Feed finished:", e)
