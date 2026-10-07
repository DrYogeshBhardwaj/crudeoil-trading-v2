import requests

url = "https://crudeoil-trading-v2-production.up.railway.app/api/bitcoin/live5/state"
r = requests.get(url, timeout=10)
print("Status:", r.status_code)
data = r.json()
print("Total Open Net PnL:", data.get("total_unrealized_net_pnl"))
print("Realized PnL:", data.get("realized_test_pnl"))
print("Total Test PnL:", data.get("total_test_pnl"))
print("Slots Count:", len(data.get("slots", [])))
for s in data.get("slots", []):
    pos = s.get("position") or {}
    print(f"Slot {s.get('slot_index')}: Status={s.get('status')}, Dir={pos.get('direction')}, NetPnL={s.get('net_pnl')}, EntryUSD=${pos.get('entry_price_usd')}, CurrUSD=${s.get('current_price_usd')}")
