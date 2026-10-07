"""
Scratch script to inspect Railway production live state and exact rejection reason.
100% READ-ONLY.
"""
import requests
import json

url = "https://crudeoil-trading-v2-production.up.railway.app/api/bitcoin/live/state"
resp = requests.get(url, timeout=10)
data = resp.json()

print("=== PRODUCTION STATE DUMP ===")
print("Scanner Status:", data.get("scanner_status"))
print("New Entries Allowed:", data.get("new_entries_allowed"))
print("New Entries Reason:", data.get("new_entries_reason"))
print("Mudrex API Status:", data.get("mudrex_api_status"))
print("Active Position:", data.get("active_position"))
print("Discrepancy / Status Note:", json.dumps(data, indent=2).replace("\u20b9", "Rs."))
