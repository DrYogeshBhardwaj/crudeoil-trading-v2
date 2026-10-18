@echo off
title BTC Quantity ^& Risk Comparison Lab
color 0A

echo ===============================================================
echo   BTC Quantity ^& Risk Comparison Lab (0.02 vs 0.06 BTC)
echo ===============================================================
echo.

cd /d "c:\SinaankProjects\Mudrex LIVE Rate Trading Engine"

:: 1. Check if server is already running on port 3000
netstat -ano | findstr :3000 | findstr LISTENING > nul
if %ERRORLEVEL% equ 0 (
    echo [OK] Local Trading Engine is ALREADY running on port 3000!
    echo Opening http://localhost:3000/btc-compare in browser...
    start "" "http://localhost:3000/btc-compare"
    ping -n 3 127.0.0.1 > nul
    exit /b 0
)

:: 2. If not running, start server in its own dedicated window
echo [1/2] Local server band hai. Server ko start kar rahe hain...
start "Mudrex Local Trading Engine Server" node src/server.js

echo [2/2] Server ke initialize hone ka wait kar rahe hain (3 seconds)...
ping -n 4 127.0.0.1 > nul

echo.
echo [DONE] BTC Compare Lab browser me open ho raha hai:
echo http://localhost:3000/btc-compare
start "" "http://localhost:3000/btc-compare"

ping -n 3 127.0.0.1 > nul
exit /b 0
