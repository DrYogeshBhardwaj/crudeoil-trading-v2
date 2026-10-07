import re

with open("main.py", "r", encoding="utf-8") as f:
    lines = f.readlines()

for idx, line in enumerate(lines):
    if "@app." in line or "/api/" in line or "/bitcoin" in line:
        print(f"Line {idx+1}: {line.strip()}")
