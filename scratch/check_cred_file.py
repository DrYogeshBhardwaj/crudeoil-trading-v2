import os
import json
import time

def check_file_status():
    if os.path.exists("dhan_credentials.json"):
        mtime = os.path.getmtime("dhan_credentials.json")
        mtime_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(mtime))
        print(f"dhan_credentials.json last modified: {mtime_str}")
        with open("dhan_credentials.json", "r") as f:
            d = json.load(f)
            cid = d.get("DHAN_CLIENT_ID", "")
            tok = d.get("DHAN_ACCESS_TOKEN", "")
            print(f"Client ID length: {len(cid)}")
            print(f"Token length: {len(tok)}")
    else:
        print("dhan_credentials.json file does NOT exist in local directory.")

    env_cid = os.environ.get("DHAN_CLIENT_ID", "")
    env_tok = os.environ.get("DHAN_ACCESS_TOKEN", "")
    print(f"Environment DHAN_CLIENT_ID length: {len(env_cid)}")
    print(f"Environment DHAN_ACCESS_TOKEN length: {len(env_tok)}")

if __name__ == "__main__":
    check_file_status()
