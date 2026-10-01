import time
from datetime import datetime
from dhanhq import DhanContext, MarketFeed

cid = "1113639152"
token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTQ5NjY5LCJpYXQiOjE3OTA4NjMyNjksInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.59QPu_FIyTS6Kh7E0j42pZ8vGdP4cjit2_wZ-7kh8PKX0UyWX54SiM-1A-jJ-WTaOTRhTYDFd6VxRQdNxPjCrw"

ctx = DhanContext(cid, token)

instruments = [
    (MarketFeed.MCX, "545802", MarketFeed.Ticker),
    (MarketFeed.MCX, "545802", MarketFeed.Quote)
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
