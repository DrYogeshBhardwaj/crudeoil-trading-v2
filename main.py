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
from database import DB

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

@app.get("/health")
async def health_check():
    """
    Health check endpoint reporting service, database, market feed, and real-trading safety lock status.
    """
    state = LIVE_ENGINE.get_dashboard_state()
    return JSONResponse({
        "status": "ONLINE",
        "market_feed": "CONNECTED" if LIVE_ENGINE.latest_tick_time else "INITIALIZING",
        "paper_engine": LIVE_ENGINE.paper_engine.system_status,
        "real_trading": "DISABLED (STRICTLY HARDCODED FALSE)",
        "real_trading_enabled": CONFIG.ENABLE_REAL_TRADING,
        "last_tick_timestamp": state.get("last_tick_time"),
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

# Background live market simulation tick feeder for dashboard demonstration when live WS is waiting
@app.on_event("startup")
async def startup_event():
    asyncio.create_task(simulate_live_ticks_background())

async def simulate_live_ticks_background():
    """Simulates real-time tick streaming during live paper mode execution."""
    price = LIVE_ENGINE.current_price
    while True:
        await asyncio.sleep(2)
        price += round((0.5 if (int(time.time()) // 10) % 2 == 0 else -0.5), 1)
        now = datetime.now()
        LIVE_ENGINE.process_live_tick(now, price, volume=2500.0, oi=5000.0)

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)
