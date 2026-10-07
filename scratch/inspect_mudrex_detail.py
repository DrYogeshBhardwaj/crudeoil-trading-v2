import requests
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

PROD_URL = "https://crudeoil-trading-v2-production.up.railway.app"

def main():
    print("=== MUDREX DIAGNOSTICS ===")
    r1 = requests.get(f"{PROD_URL}/api/debug/test-mudrex", timeout=15).json()
    print(json.dumps(r1, indent=2))

    print("\n=== BITCOIN LIVE STATE ===")
    r2 = requests.get(f"{PROD_URL}/api/bitcoin/live/state", timeout=15).json()
    # Print keys and position details
    print("Engine Status:", r2.get("engine_status"))
    print("Live Trading Enabled:", r2.get("live_trading_enabled"))
    print("New Entries Allowed:", r2.get("new_entries_allowed"))
    print("Block Reason:", r2.get("block_reason"))
    print("Active Mudrex Position:", json.dumps(r2.get("active_mudrex_position"), indent=2))
    print("Authoritative Open Position:", json.dumps(r2.get("authoritative_open_position"), indent=2))
    print("Mudrex Positions List:", json.dumps(r2.get("mudrex_positions"), indent=2))
    print("Mudrex Orders List:", json.dumps(r2.get("mudrex_orders"), indent=2))
    print("Active Position:", json.dumps(r2.get("active_position"), indent=2))
    print("Recent Trades:", json.dumps(r2.get("recent_trades"), indent=2))
    print("Current Price USD:", r2.get("btc_price_usd"))
    print("Current Price INR:", r2.get("current_price"))
    print("Hedge Rate:", r2.get("hedge_rate"))

if __name__ == "__main__":
    main()
