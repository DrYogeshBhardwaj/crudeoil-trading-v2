import requests

def inspect_railway_html():
    url = "https://crudeoil-trading-v2-production.up.railway.app/mcx-silver/live"
    print(f"Fetching HTML from {url}...")
    try:
        r = requests.get(url, timeout=10)
        print(f"HTTP Status: {r.status_code}")
        html_text = r.text
        
        # Check for title and header strings
        if "<title>" in html_text:
            title = html_text.split("<title>")[1].split("</title>")[0]
            print(f"Page <title>: {title}")
        
        if "SILVERM (SILVER MINI)" in html_text:
            idx = html_text.find("SILVERM (SILVER MINI)")
            snippet = html_text[idx:idx+100]
            print(f"Header Snippet: {snippet}")

    except Exception as e:
        print(f"Exception: {e}")

if __name__ == "__main__":
    inspect_railway_html()
