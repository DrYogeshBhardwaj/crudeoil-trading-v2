import os
import json
import requests
import csv
import io

def run_dhan_live_readiness_audit():
    print("==================================================")
    print("   DHAN LIVE API READINESS & CONTRACT AUDIT")
    print("==================================================")
    
    # 1. Load Credentials
    client_id = os.environ.get("DHAN_CLIENT_ID", "").strip()
    access_token = os.environ.get("DHAN_ACCESS_TOKEN", "").strip()
    
    if not client_id or not access_token:
        if os.path.exists("dhan_credentials.json"):
            try:
                with open("dhan_credentials.json", "r") as f:
                    ddata = json.load(f)
                    client_id = client_id or ddata.get("DHAN_CLIENT_ID", "").strip()
                    access_token = access_token or ddata.get("DHAN_ACCESS_TOKEN", "").strip()
            except Exception as e:
                print(f"[!] Error reading dhan_credentials.json: {e}")

    print(f"Client ID Configured: {'YES' if client_id else 'NO'}")
    print(f"Access Token Configured: {'YES' if access_token else 'NO'}")

    if not client_id or not access_token:
        print("\n[RESULT] CRITICAL FAIL: Missing Dhan Client ID or Access Token in environment/credentials file.")
        return False

    headers = {
        "access-token": access_token,
        "client-id": client_id,
        "Content-Type": "application/json"
    }

    # 2. Check Fund Limits / Available Margin
    print("\n--- 1. AUTHENTICATION & MARGIN BALANCE CHECK ---")
    token_valid = False
    available_margin = 0.0
    try:
        r_fund = requests.get("https://api.dhan.co/v2/fundlimit", headers=headers, timeout=5)
        if r_fund.status_code == 200:
            token_valid = True
            fdata = r_fund.json().get("data", {})
            available_margin = float(fdata.get("availabelBalance") or fdata.get("availableBalance") or fdata.get("sodLimit") or 0.0)
            print(f"Status: SUCCESS (HTTP 200 OK)")
            print(f"Available Margin Balance: Rs. {available_margin:,.2f}")
        else:
            print(f"Status: FAILED (HTTP {r_fund.status_code})")
            print(f"Response: {r_fund.text[:250]}")
    except Exception as e:
        print(f"Fund API Exception: {e}")

    if not token_valid:
        print("\n[!] CRITICAL FAIL: Dhan API Token is EXPIRED or INVALID (HTTP 401).")
        print("[!] Cannot proceed with Live Execution until user provides a renewed Dhan Access Token.")

    # 3. Check Order / Position API Access
    print("\n--- 2. BROKER ORDER & POSITION READINESS CHECK ---")
    try:
        r_pos = requests.get("https://api.dhan.co/v2/positions", headers=headers, timeout=5)
        print(f"Positions API (GET /v2/positions): HTTP {r_pos.status_code}")
        r_ord = requests.get("https://api.dhan.co/v2/orders", headers=headers, timeout=5)
        print(f"Orders API (GET /v2/orders): HTTP {r_ord.status_code}")
    except Exception as e:
        print(f"Order/Position API Exception: {e}")

    # 4. Scan Dhan Compact Security Master CSV for MCX SILVERM Contracts
    print("\n--- 3. ACTIVE MCX SILVERM CONTRACT RESOLUTION ---")
    try:
        url = "https://images.dhan.co/api-data/api-scrip-master.csv"
        print("Downloading Dhan Security Master CSV...")
        r_csv = requests.get(url, timeout=10)
        if r_csv.status_code == 200:
            print("CSV Downloaded Successfully. Scanning for SILVERM contracts on MCX...")
            csv_file = io.StringIO(r_csv.text)
            reader = csv.DictReader(csv_file)
            
            silverm_contracts = []
            for row in reader:
                # Filter for MCX exchange and SILVERM
                exch = row.get("SEM_EXM_EXCH_ID", "").strip() or row.get("EXCH_ID", "").strip() or row.get("SEM_EXCHANGE", "").strip()
                custom_symbol = row.get("SEM_CUSTOM_SYMBOL", "").strip() or row.get("SEM_TRADING_SYMBOL", "").strip() or row.get("TRADING_SYMBOL", "").strip()
                instrument_name = row.get("SEM_INSTRUMENT_NAME", "").strip() or row.get("INSTRUMENT_NAME", "").strip()
                sec_id = row.get("SEM_SMST_SECURITY_ID", "").strip() or row.get("SECURITY_ID", "").strip()
                
                if "SILVERM" in custom_symbol.upper() or "SILVERM" in instrument_name.upper():
                    silverm_contracts.append(row)
            
            print(f"Found {len(silverm_contracts)} SILVERM contracts on Master CSV:")
            for c in silverm_contracts[:10]:
                print(dict(c))
        else:
            print(f"Master CSV Download Failed: HTTP {r_csv.status_code}")
    except Exception as e:
        print(f"CSV Scanner Exception: {e}")

    return token_valid

if __name__ == "__main__":
    run_dhan_live_readiness_audit()
