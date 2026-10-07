import asyncio
import time
from dhanhq import DhanContext, marketfeed

client_id = "1113639152"
access_token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTY0MTg4LCJpYXQiOjE3OTA4Nzc3ODgsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.BW4iAl5ZEdLaKiev71YsjAY4mQcNMWTbLctUz4mJ8ou1hUGT-uyCRJChqL-idTqZrJIivJFtI2mv3L2I4hZJpQ"

# Security ID 569901 = CRUDEOILM 19-OCT-2026 Futures on MCX (5)
instruments = [
    (marketfeed.MarketFeed.MCX, "569901", marketfeed.MarketFeed.Ticker),
    (marketfeed.MarketFeed.MCX, "569901", marketfeed.MarketFeed.Quote),
]

def on_connect(feed):
    print(">>> ON_CONNECT: Connected successfully to Dhan HQ Feed!")

def on_ticks(feed, data):
    print(f">>> ON_TICKS: {data}")

def on_close(feed):
    print(">>> ON_CLOSE: Feed connection closed.")

def on_error(feed, err):
    print(f">>> ON_ERROR: {err}")

if __name__ == "__main__":
    print("Initializing Official DhanHQ MarketFeed...")
    ctx = DhanContext(client_id, access_token)
    feed = marketfeed.MarketFeed(
        dhan_context=ctx,
        instruments=instruments,
        version='v2',
        on_connect=on_connect,
        on_ticks=on_ticks,
        on_close=on_close,
        on_error=on_error
    )
    
    print("Starting MarketFeed in background thread...")
    t = feed.start()
    
    time.sleep(10)
    print("Closing connection...")
    feed.close_connection()
    t.join(timeout=5)
    print("Done!")
