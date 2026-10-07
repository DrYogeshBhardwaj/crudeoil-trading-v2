import requests
import time

url = "https://crudeoil-trading-v2-production.up.railway.app/api/debug/outbound-ip"
observed_ips = set()
deployment_ids = set()

print("Polling Railway production server for assigned Static Outbound IPs...")

for i in range(1, 30):
    try:
        r = requests.get(url, timeout=5)
        if r.status_code == 200:
            data = r.json()
            ip_ifconfig = data.get("outbound_ip_ifconfig")
            ip_ipify = data.get("outbound_ip_ipify")
            dep_id = data.get("railway_deployment_id")
            
            if ip_ifconfig and "ERROR" not in ip_ifconfig:
                observed_ips.add(ip_ifconfig)
            if ip_ipify and "ERROR" not in ip_ipify:
                observed_ips.add(ip_ipify)
            if dep_id:
                deployment_ids.add(dep_id)
                
            print(f"Call {i:02d}: IP = {ip_ifconfig} | Deployment ID = {dep_id}")
        else:
            print(f"Call {i:02d}: HTTP {r.status_code}")
    except Exception as e:
        print(f"Call {i:02d}: Request Error ({e})")
    
    time.sleep(1)

print("\n================ VERIFICATION SUMMARY ================")
print(f"Active Deployment ID(s): {list(deployment_ids)}")
print(f"Unique Assigned Outbound Static IPs Observed ({len(observed_ips)} total):")
for ip in sorted(list(observed_ips)):
    print(f"  - {ip}")
print("======================================================")
