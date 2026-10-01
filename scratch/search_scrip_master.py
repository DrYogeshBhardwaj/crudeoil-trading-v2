import urllib.request
import csv
import io

print("Fetching Dhan Scrip Master CSV...")
url = "https://images.dhan.co/api-data/api-scrip-master.csv"

try:
    req = urllib.request.Request(url, headers={"User-Agent": "CRUDEOILM-TEST"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        content = resp.read().decode('utf-8')
        print(f"Downloaded Scrip Master CSV size: {len(content)} bytes")
        
        f = io.StringIO(content)
        reader = csv.DictReader(f)
        
        matches = []
        for row in reader:
            sec_id = row.get("SEM_SM_ID") or row.get("SEM_SECURITY_ID") or row.get("SECURITY_ID") or row.get("SEM_SM_SYMBOL")
            sym = row.get("SEM_TRADING_SYMBOL") or row.get("SEM_CUSTOM_SYMBOL") or row.get("SEM_SYMBOL_NAME") or ""
            
            if "545802" in str(row.values()) or ("CRUDE" in str(sym).upper()):
                matches.append(row)
                if len(matches) <= 15:
                    print("MATCH ROW:", {k: v for k, v in row.items() if v and len(str(v)) < 50})

        print(f"\nTotal Crude Oil matches found: {len(matches)}")
except Exception as e:
    print("Error fetching scrip master:", e)
