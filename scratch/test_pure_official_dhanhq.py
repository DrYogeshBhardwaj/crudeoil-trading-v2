import time
from datetime import datetime
from dhanhq import DhanContext, MarketFeed

cid = "1113639152"
token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJ1c2VyUmVnaW9uIjoiUjEiLCJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzkwOTY0MTg4LCJpYXQiOjE3OTA4Nzc3ODgsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTEzNjM5MTUyIn0.BW4iAl5ZEdLaKiev71YsjAY4mQcNMWTbLctUz4mJ8ou1hUGT-uyCRJChqL-idTqZrJIivJFtI2mv3L2I4hZJpQ"

ctx = DhanContext(cid, token)

class FeedTester:
    def __init__(self, version):
        self.version = version
        self.conn_ok = False
        self.err_msg = None
        self.ticks = []

    def on_connect(self, instance):
        self.conn_ok = True
        print(f"[{datetime.now()}] [{self.version}] ON_CONNECT SUCCESSFUL!")

    def on_ticks(self, instance, data):
        print(f"[{datetime.now()}] [{self.version}] ON_TICKS: {data}")
        self.ticks.append(data)

    def on_error(self, instance, error):
        self.err_msg = str(error)
        print(f"[{datetime.now()}] [{self.version}] ON_ERROR: {error}")

    def on_close(self, instance):
        print(f"[{datetime.now()}] [{self.version}] ON_CLOSE: Connection closed.")

    def run_test(self):
        print(f"\n================ TESTING DHANHQ MARKETFEED (VERSION={self.version}) ================")
        insts = [(5, "569901", 15)]
        try:
            mf = MarketFeed(
                dhan_context=ctx,
                instruments=insts,
                version=self.version,
                on_connect=self.on_connect,
                on_ticks=self.on_ticks,
                on_error=self.on_error,
                on_close=self.on_close
            )
            t = mf.start()
            print(f"[{self.version}] Listening for 8 seconds...")
            time.sleep(8)
            is_closed = mf._is_ws_closed()
            print(f"[{self.version}] After 8s -> Connected: {self.conn_ok}, WS Closed: {is_closed}, Ticks: {len(self.ticks)}, Error: {self.err_msg}")
            mf.close_connection()
            t.join(timeout=3)
        except Exception as e:
            print(f"[{self.version}] EXCEPTION: {e}")

if __name__ == "__main__":
    FeedTester('v2').run_test()
    time.sleep(3)
    FeedTester('v1').run_test()
