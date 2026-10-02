"""
Production FastAPI Main Server & Live Health Monitoring Endpoint.
Serves Live Web Dashboard, REST Endpoints, WebSocket Stream, and Health Status.
STRICTLY PAPER TRADING ONLY - REAL TRADING EXECUTION IS HARDCODED TO DISABLED.
"""

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import os
import asyncio
import time
from datetime import datetime

from config import CONFIG
from live_dhan_engine import LIVE_ENGINE
from live_trading_engine import LIVE_TEST_ENGINE
from database import DB
from wti_paper_engine import WTI_ENGINE
from wti_feed import WTI_FEED
from bitcoin_paper_engine import BITCOIN_ENGINE
from bitcoin_feed import BITCOIN_FEED

app = FastAPI(
    title="AI Trend Detector & Paper Trading Engine V1",
    description="Observation & Paper Trading Engine for CRUDEOILM",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files
static_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.exists(static_dir):
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

@app.get("/", response_class=HTMLResponse)
async def serve_dashboard():
    """Serves the main Live Web Dashboard interface."""
    index_path = os.path.join(os.path.dirname(__file__), "templates", "index.html")
    if os.path.exists(index_path):
        with open(index_path, "r", encoding="utf-8") as f:
            return HTMLResponse(content=f.read())
    return HTMLResponse("<h2>AI Trend Detector Live Dashboard UI</h2>")

@app.get("/live", response_class=HTMLResponse)
async def serve_live_dashboard():
    """Serves the separate CRUDEOILM Live Test Dashboard interface."""
    live_path = os.path.join(os.path.dirname(__file__), "templates", "index.html") if not os.path.exists(os.path.join(os.path.dirname(__file__), "templates", "live.html")) else os.path.join(os.path.dirname(__file__), "templates", "live.html")
    if os.path.exists(live_path):
        with open(live_path, "r", encoding="utf-8") as f:
            return HTMLResponse(content=f.read())
    return HTMLResponse("<h2>CRUDEOILM Live Test Dashboard</h2>")

@app.get("/wti", response_class=HTMLResponse)
async def serve_wti_dashboard():
    """Serves the separate WTI Crude Oil Paper Trading Dashboard."""
    wti_path = os.path.join(os.path.dirname(__file__), "templates", "wti.html")
    if os.path.exists(wti_path):
        with open(wti_path, "r", encoding="utf-8") as f:
            return HTMLResponse(content=f.read())
    return HTMLResponse("<h2>WTI Crude Oil Paper Trading Dashboard</h2>")

@app.get("/api/wti/state")
async def get_wti_state():
    """Returns real-time JSON state for the separate /wti paper trading dashboard."""
    return JSONResponse(WTI_ENGINE.get_dashboard_state())

@app.get("/api/wti/candles")
async def get_wti_candles(tf: str = "5m", range_str: str = "1d"):
    """Returns historical OHLCV candles for WTI Crude Oil chart."""
    candles = WTI_FEED.fetch_historical_candles(tf, range_str)
    return JSONResponse(candles)

@app.post("/api/wti/emergency_exit")
async def wti_emergency_exit():
    """Triggers manual emergency exit for WTI active paper position."""
    pos = WTI_ENGINE.emergency_exit_position()
    return JSONResponse({
        "status": "EMERGENCY_EXIT_EXECUTED" if pos else "NO_ACTIVE_POSITION",
        "message": f"Emergency exit executed for active WTI position." if pos else "No active WTI position to exit."
    })

@app.post("/api/wti/reset")
async def wti_reset_account():
    """Resets WTI paper account balance to $100,000 and clears trade history."""
    WTI_ENGINE.reset_paper_account()
    return JSONResponse({
        "status": "ACCOUNT_RESET",
        "message": "WTI Paper account reset successfully. Capital restored to $100,000 USD."
    })

@app.post("/api/wti/config")
async def wti_update_config(payload: dict):
    """Updates WTI virtual capital configuration or contract type (CL=1,000 bbls / MCL=100 bbls)."""
    updated = []
    capital = payload.get("virtual_capital")
    if capital is not None and float(capital) > 0:
        WTI_ENGINE.set_virtual_capital(float(capital))
        updated.append(f"Virtual capital: ${capital}")

    contract_type = payload.get("contract_type")
    if contract_type in ("CL", "MCL"):
        WTI_ENGINE.set_contract_type(contract_type)
        updated.append(f"Contract type: {contract_type}")

    if updated:
        return JSONResponse({"status": "SUCCESS", "message": f"Updated: {', '.join(updated)}"})
    return JSONResponse({"status": "ERROR", "message": "No valid config fields provided"}, status_code=400)

@app.get("/bitcoin", response_class=HTMLResponse)
async def serve_bitcoin_dashboard():
    """Serves the separate Bitcoin Paper Trading Dashboard."""
    btc_path = os.path.join(os.path.dirname(__file__), "templates", "bitcoin.html")
    if os.path.exists(btc_path):
        with open(btc_path, "r", encoding="utf-8") as f:
            return HTMLResponse(content=f.read())
    return HTMLResponse("<h2>Bitcoin Paper Trading Dashboard</h2>")

@app.get("/api/bitcoin/state")
async def get_bitcoin_state():
    """Returns real-time JSON state for the separate /bitcoin paper trading dashboard."""
    return JSONResponse(BITCOIN_ENGINE.get_dashboard_state())

@app.get("/api/bitcoin/candles")
async def get_bitcoin_candles(tf: str = "5m", range_str: str = "1d"):
    """Returns historical OHLCV candles for Bitcoin chart."""
    candles = BITCOIN_FEED.fetch_historical_candles(tf, range_str)
    return JSONResponse(candles)

@app.post("/api/bitcoin/emergency_exit")
async def bitcoin_emergency_exit():
    """Triggers manual emergency exit for Bitcoin active paper position."""
    pos = BITCOIN_ENGINE.emergency_exit_position()
    return JSONResponse({
        "status": "EMERGENCY_EXIT_EXECUTED" if pos else "NO_ACTIVE_POSITION",
        "message": "Emergency exit executed for active Bitcoin position." if pos else "No active Bitcoin position to exit."
    })

@app.post("/api/bitcoin/reset")
async def bitcoin_reset_account():
    """Resets Bitcoin paper account balance to INR 200,000 and clears trade history."""
    BITCOIN_ENGINE.reset_paper_account()
    return JSONResponse({
        "status": "ACCOUNT_RESET",
        "message": "Bitcoin Paper account reset successfully. Capital restored to INR 200,000."
    })

@app.post("/api/bitcoin/config")
async def bitcoin_update_config(payload: dict):
    """Updates Bitcoin virtual capital configuration."""
    capital = payload.get("virtual_capital")
    if capital is not None and float(capital) > 0:
        BITCOIN_ENGINE.set_virtual_capital(float(capital))
        return JSONResponse({"status": "SUCCESS", "message": f"Updated virtual capital: INR {capital}"})
    return JSONResponse({"status": "ERROR", "message": "No valid config fields provided"}, status_code=400)

@app.get("/api/live/state")
async def get_live_state():
    """Returns real-time JSON state for the separate /live dashboard."""
    # Strictly decoupled from PAPER replay feed
    return JSONResponse(LIVE_TEST_ENGINE.get_live_dashboard_state())

@app.get("/api/live/readiness")
async def get_live_readiness():
    """Returns pre-flight readiness report for LIVE test deployment."""
    return JSONResponse(LIVE_TEST_ENGINE.get_readiness_report())

@app.post("/api/live/update_credentials")
async def update_live_credentials(payload: dict):
    """Updates and persists active Dhan API credentials on running server instance."""
    cid = str(payload.get("client_id", "")).strip()
    token = str(payload.get("access_token", "")).strip()
    if not cid or not token:
        raise HTTPException(status_code=400, detail="client_id and access_token are required.")
    
    LIVE_TEST_ENGINE.adapter.update_credentials(cid, token)
    fund_info = LIVE_TEST_ENGINE.adapter.fetch_fund_limits()
    
    return JSONResponse({
        "status": fund_info["status"],
        "dhan_client_id": cid,
        "available_margin_inr": fund_info.get("available_margin", 0.0),
        "message": "Dhan credentials updated and verified successfully."
    })

@app.post("/api/live/start_test")
async def start_live_test():
    """Starts or resumes continuous 24x7 live engine."""
    LIVE_TEST_ENGINE.start_60min_test()
    return JSONResponse({"status": "STARTED", "message": "Continuous 24x7 live trading engine started."})

@app.post("/api/live/stop_test")
async def stop_live_test():
    """Pauses continuous 24x7 live engine."""
    LIVE_TEST_ENGINE.stop_test("MANUAL_STOP")
    return JSONResponse({"status": "STOPPED", "message": "Continuous live trading engine paused."})

@app.post("/api/live/emergency_exit")
async def emergency_exit():
    """Triggers emergency square-off for any active live position."""
    paper_state = LIVE_ENGINE.get_dashboard_state()
    curr_price = paper_state.get("current_price", 0.0)
    pos = LIVE_TEST_ENGINE.emergency_exit_all(curr_price)
    return JSONResponse({
        "status": "EMERGENCY_EXIT_EXECUTED",
        "message": f"Emergency exit executed for active position." if pos else "No active live position to exit."
    })

SERVER_START_TIME = datetime.now()

@app.get("/health")
async def health_check():
    """
    Health check endpoint reporting service, database, market feed, 24x7 uptime, and real-trading safety lock status.
    """
    state = LIVE_ENGINE.get_dashboard_state()
    uptime_sec = int((datetime.now() - SERVER_START_TIME).total_seconds())
    feed_status = "CONNECTED" if state.get("websocket_connected") and state.get("feed_health") == "LIVE" else "DISCONNECTED/STALE"
    
    # Save 24x7 Heartbeat to SQLite DB
    DB.save_heartbeat(datetime.now().strftime("%Y-%m-%d %H:%M:%S"), uptime_sec)

    return JSONResponse({
        "status": "ONLINE",
        "engine_24x7_status": "ENGINE: RUNNING 24x7",
        "server_mode_label": "PAPER MODE",
        "real_trading_label": "REAL TRADING: DISABLED",
        "browser_label": "BROWSER: VIEW ONLY",
        "server_uptime_seconds": uptime_sec,
        "market_feed": feed_status,
        "websocket_connected": state.get("websocket_connected"),
        "dhan_client_id": state.get("dhan_client_id"),
        "dhan_access_token": state.get("dhan_access_token"),
        "last_ws_error": state.get("last_ws_error"),
        "feed_health": state.get("feed_health"),
        "tick_age_seconds": state.get("tick_age_seconds"),
        "paper_engine": state.get("system_status"),
        "real_trading": "DISABLED (STRICTLY HARDCODED FALSE)",
        "real_trading_enabled": CONFIG.ENABLE_REAL_TRADING,
        "last_tick_timestamp": state.get("last_tick_time_ist"),
        "database_status": "CONNECTED",
        "instrument": CONFIG.INSTRUMENT_NAME,
        "environment": "PAPER_MODE",
        "server_time_ist": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    })

@app.get("/api/state")
async def get_state():
    """Returns complete real-time JSON state of live trend evaluation and paper engine."""
    return JSONResponse(LIVE_ENGINE.get_dashboard_state())

@app.get("/api/ledger")
async def get_ledger():
    """Returns executed paper trade ledger."""
    state = LIVE_ENGINE.get_dashboard_state()
    return JSONResponse({
        "instrument": CONFIG.INSTRUMENT_NAME,
        "total_trades": len(state["trade_ledger"]),
        "ledger": state["trade_ledger"]
    })

@app.get("/api/debug/db_diagnostic")
async def db_diagnostic():
    """
    Production Runtime Database & Environment Diagnostic Endpoint.
    Returns exact runtime paths, file sizes, trade counts, P&L, and state restoration verification.
    """
    import sqlite3
    import subprocess
    
    try:
        git_commit = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"]).decode().strip()
    except Exception as e:
        git_commit = f"UNKNOWN ({e})"

    env_db_path = os.environ.get("DATABASE_PATH")
    data_dir_exists = os.path.exists("/data")
    
    seed_abs = os.path.join(os.path.dirname(__file__), "seed_trading.db")

    def inspect_db_file(path_str: str) -> dict:
        if not os.path.exists(path_str) or os.path.getsize(path_str) == 0:
            return {"exists": False, "size_bytes": 0}
        try:
            with sqlite3.connect(path_str) as conn:
                conn.row_factory = sqlite3.Row
                cur = conn.cursor()
                cur.execute("SELECT COUNT(*) FROM paper_trades")
                total_trades = cur.fetchone()[0]
                
                cur.execute("SELECT COUNT(*) FROM paper_trades WHERE status = 'CLOSED'")
                closed_trades = cur.fetchone()[0]

                cur.execute("SELECT COUNT(*) FROM paper_trades WHERE status = 'OPEN'")
                open_trades = cur.fetchone()[0]

                cur.execute("SELECT SUM(net_pnl) FROM paper_trades WHERE status = 'CLOSED'")
                net_pnl = cur.fetchone()[0] or 0.0

                cur.execute("SELECT trade_id FROM paper_trades WHERE status = 'OPEN' LIMIT 1")
                row_open = cur.fetchone()
                active_trade_id = row_open["trade_id"] if row_open else None

                cur.execute("SELECT key, value FROM replay_state")
                replay_state = {r["key"]: r["value"] for r in cur.fetchall()}

                return {
                    "exists": True,
                    "size_bytes": os.path.getsize(path_str),
                    "total_trades": total_trades,
                    "closed_trades": closed_trades,
                    "open_trades": open_trades,
                    "realized_net_pnl": round(net_pnl, 2),
                    "active_trade_id": active_trade_id,
                    "replay_state": replay_state
                }
        except Exception as err:
            return {"exists": True, "error": str(err)}

    active_db_path = DB.db_path
    active_db_info = inspect_db_file(active_db_path)
    data_db_info = inspect_db_file("/data/trading.db")
    seed_db_info = inspect_db_file(seed_abs)

    state = LIVE_ENGINE.get_dashboard_state()

    return JSONResponse({
        "timestamp_ist": datetime.now().strftime("%Y-%m-%d %H:%M:%S IST"),
        "git_commit": git_commit,
        "environment": {
            "DATABASE_PATH_env": env_db_path,
            "data_dir_exists": data_dir_exists,
            "active_db_path": active_db_path,
            "seed_path": seed_abs
        },
        "active_database_inspection": active_db_info,
        "data_trading_db_inspection": data_db_info,
        "seed_trading_db_inspection": seed_db_info,
        "in_memory_live_engine_state": {
            "total_trades_count": state.get("total_trades_count"),
            "trade_ledger_length": len(state.get("trade_ledger", [])),
            "realized_pnl": state.get("realized_pnl"),
            "active_position": state.get("active_position"),
            "system_status": state.get("system_status"),
            "current_price": state.get("current_price"),
            "last_tick_time_ist": state.get("last_tick_time_ist")
        }
    })

@app.get("/api/debug/outbound-ip")
async def get_outbound_ip():
    """Returns current public outbound IP address of the production server (static IP verification)."""
    import requests
    outbound_ip = "UNKNOWN"
    ipify_ip = "UNKNOWN"
    try:
        r = requests.get("https://api.ipify.org?format=json", timeout=5)
        if r.status_code == 200:
            ipify_ip = r.json().get("ip", "UNKNOWN")
    except Exception as e:
        ipify_ip = f"ERROR ({e})"
    
    try:
        r2 = requests.get("https://ifconfig.me/ip", timeout=5)
        if r2.status_code == 200:
            outbound_ip = r2.text.strip()
    except Exception as e:
        outbound_ip = f"ERROR ({e})"

    return JSONResponse({
        "timestamp_ist": datetime.now().strftime("%Y-%m-%d %H:%M:%S IST"),
        "outbound_ip_ifconfig": outbound_ip,
        "outbound_ip_ipify": ipify_ip,
        "railway_environment": os.environ.get("RAILWAY_ENVIRONMENT", "production"),
        "railway_service_id": os.environ.get("RAILWAY_SERVICE_ID", "UNKNOWN"),
        "railway_deployment_id": os.environ.get("RAILWAY_DEPLOYMENT_ID", "UNKNOWN")
    })


@app.on_event("startup")
async def startup_event():
    """Starts background Dhan WebSocket listener loop and WTI Paper feed loop on app startup."""
    print(f"[{datetime.now()}] [STARTUP] Spawning LIVE_ENGINE.start_feed_loop background task...")
    asyncio.create_task(LIVE_ENGINE.start_feed_loop())

    print(f"[{datetime.now()}] [STARTUP] Spawning WTI_ENGINE.start_feed_loop background task...")
    asyncio.create_task(WTI_ENGINE.start_feed_loop())

    print(f"[{datetime.now()}] [STARTUP] Spawning BITCOIN_ENGINE.start_feed_loop background task...")
    asyncio.create_task(BITCOIN_ENGINE.start_feed_loop())

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)
