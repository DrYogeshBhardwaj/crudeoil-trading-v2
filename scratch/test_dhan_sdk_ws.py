import asyncio
import time
from dhanhq import DhanContext, MarketFeed

cid = "1113639152"
token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTQ5NjY5LCJpYXQiOjE3OTA4NjMyNjksInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.59QPu_FIyTS6Kh7E0j42pZ8vGdP4cjit2_wZ-7kh8PKX0UyWX54SiM-1A-jJ-WTaOTRhTYDFd6VxRQdNxPjCrw"

ctx = DhanContext(cid, token)

# Check MarketFeed exchange segment constants
print("MarketFeed.MCX:", getattr(MarketFeed, "MCX", None))
print("MarketFeed.NSE:", getattr(MarketFeed, "NSE", None))
print("MarketFeed.Ticker:", getattr(MarketFeed, "Ticker", None))
print("MarketFeed.Quote:", getattr(MarketFeed, "Quote", None))

instruments = [
    (MarketFeed.MCX, "545802", MarketFeed.Ticker),
    (MarketFeed.MCX, "545802", MarketFeed.Quote)
]

def on_connect(instance):
    print("Dhan SDK WS Connected!")

def on_message(instance, message):
    print("Dhan SDK WS Received Message:", message)

def on_error(instance, error):
    print("Dhan SDK WS Error:", error)

def on_close(instance, code, reason):
    print("Dhan SDK WS Closed:", code, reason)

mf = MarketFeed(
    dhan_context=ctx,
    instruments=instruments,
    version="v2",
    on_connect=on_connect,
    on_message=on_message,
    on_error=on_error,
    on_close=on_close
)

print("Starting MarketFeed.run_forever()...")
try:
    mf.run_forever()
except Exception as e:
    print("Error running feed:", e)
