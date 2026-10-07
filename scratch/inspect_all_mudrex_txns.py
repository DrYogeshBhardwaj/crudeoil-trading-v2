import json

with open("scratch/mudrex_full_audit_response.json", "r", encoding="utf-8") as f:
    audit_data = json.load(f)

mudrex = audit_data.get("mudrex_responses", {})

print("================================================================================")
print("INSPECTING ALL MUDREX RESPONSES")
print("================================================================================")

for key, val in mudrex.items():
    print(f"\n==================== KEY: {key} ====================")
    if isinstance(val, dict):
        print(f"Status: {val.get('status_code')}")
        body = val.get("body")
        if isinstance(body, dict):
            data = body.get("data")
            if isinstance(data, list):
                print(f"Data List Count: {len(data)}")
                for idx, item in enumerate(data, 1):
                    print(f"  [{idx}] {json.dumps(item)}")
            else:
                print(f"Data: {json.dumps(data, indent=2)}")
        else:
            print(f"Body: {body}")
    else:
        print(f"Raw Value: {val}")

