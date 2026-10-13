# Trading Engine Memory & Core Operational Rules

## 1. Live Mudrex Data Protection (NEVER Reset or Delete)
- **Live Mudrex Exchange Data Must Never Be Deleted or Reset**:
  - Live positions and orders from the real Mudrex API/exchange (`REAL_MUDREX_POSITION`, `mudrexOrderId`) must NEVER be cleared, deleted, or wiped during server restarts, redeployments, or engine resets.
  - When `resetData` or `resetLiveEngine` is called, it only cleans local simulated state while preserving all real Mudrex exchange positions intact.
  - `syncRealMudrexPositions` must ALWAYS remain `true` by default so that the trading dashboard and Mudrex exchange data match 1:1.

## 2. Currency Display Standards (Both ₹ and $ Required)
- **Profit and Margin Metrics Must Be Displayed in ₹ (INR) along with $ (USD)**:
  - All profit cards (`Realized Net P/L`, `Floating Net P/L`, `Estimated Total P/L`) must display the INR value prominently (e.g. `+₹2,540.90 (+ $26.21) PROFIT`).
  - Active positions table and Closed positions table must display net profit/loss in both ₹ (INR) and $ (USD).
  - Available Margin, Equity, and Locked Margin must display in both ₹ (INR) and $ (USD).

## 3. Position Sizing & Margin Policy
- Default contract size is **1.0 Barrel** per pair.
- Leverage is **5x**.
- Profit Target Move default is **$1.00** (or user-configured setting).
- Margin check must always use authoritative available margin based only on actually OPEN positions, immediately freeing margin when any leg closes.
