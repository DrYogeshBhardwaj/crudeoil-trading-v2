import time
import threading
from datetime import datetime
from dhanhq import DhanContext, MarketFeed

cid = "1113639152"
token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTY0MTg4LCJpYXQiOjE3OTA4Nzc3ODgsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.BW4iAl5ZEdLaKiev71YsjAY4mQcNMWTbLctUz4mJ8ou1hUGT-uyCRJChqL-idTqZrJIivJFtI2mv3L2I4hZJpQ"

ctx = DhanContext(cid, token)

# Official Dhan HQ SDK tuple structure for MCX CRUDEOILM (569901)
instruments = [
    (MarketFeed.MCX, "569901", MarketFeed.Ticker),
    (MarketFeed.MCX, "569901", MarketFeed.Quote)
]

ticks = []

def on_connect(instance):
    print(f"[{datetime.now()}] Official DhanHQ SDK Connected successfully!")
    instance.subscribe_symbols(instruments)

def on_message(instance, message):
    now_ist = datetime.now().strftime("%H:%M:%S IST")
    print(f"[{now_ist}] TICK ARRIVED: {type(message)} -> {message}")
    ticks.append(message)

def on_error(instance, error):
    print("Dhan Error:", error)

def on_close(instance, code, reason):
    print("Dhan Closed:", code, reason)

mf = MarketFeed(
    dhan_context=ctx,
    instruments=instruments,
    version="v2",
    on_connect=on_connect,
    on_message=on_message,
    on_error=on_error,
    on_close=on_close
)

t = threading.Thread(target=mf.run_forever, daemon=True)
t.start()

print("Listening for 20 seconds...")
for i in range(20):
    time.sleep(1)

print(f"\nCaptured Total Ticks: {len(ticks)}")
