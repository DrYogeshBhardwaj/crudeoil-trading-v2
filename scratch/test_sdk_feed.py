import asyncio
import os
from dhanhq import dhanhq, marketfeed

cid = "1113639152"
token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTQ5NjY5LCJpYXQiOjE3OTA4NjMyNjksInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.59QPu_FIyTS6Kh7E0j42pZ8vGdP4cjit2_wZ-7kh8PKX0UyWX54SiM-1A-jJ-WTaOTRhTYDFd6VxRQdNxPjCrw"

dhan = dhanhq(cid, token)

print("--- Testing Dhan HQ Fund Limits via SDK ---")
fund_resp = dhan.get_fund_limits()
print("Fund Limits SDK Response:", fund_resp)

print("\n--- Testing Dhan HQ Market Feed (LTP) via SDK ---")
try:
    # Test Dhan HQ SDK marketfeed structure
    instruments = [
        (marketfeed.MCX, "545802", marketfeed.Ticker)
    ]
    
    print("Instruments format:", instruments)

    async def on_connect(instance):
        print("Connected to Dhan Marketfeed WS via SDK!")
        await instance.subscribe_symbols(instruments)

    async def on_message(instance, message):
        print("SDK Received Marketfeed Message:", message)

    subscription_code = marketfeed.Ticker
    print("Subscription Code:", subscription_code)

    # Initialize DhanFeed via official SDK
    feed = marketfeed.DhanFeed(cid, token, instruments, subscription_code)
    
    async def run_feed():
        print("Running DhanFeed connect...")
        await feed.connect()

    asyncio.run(run_feed())

except Exception as e:
    print("SDK Marketfeed Error:", type(e).__name__, "-", e)
