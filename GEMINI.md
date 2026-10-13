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
- Default contract size is **2.0 Barrels** per pair (user-configured).
- Leverage is **5x**.
- Profit Target Move default is **$0.25** (user-configured setting, yielding +₹11.30 to +₹12.30 net profit per 2.0B trade after all Mudrex fees & GST).
- Margin check must always use authoritative available margin based only on actually OPEN positions, immediately freeing margin when any leg closes.

## 4. Punarjanm (Basket Profit Harvest & Rebirth Cycle) Rule
- **Threshold**: ₹100 INR (`basketProfitTargetINR: 100`) for testing mode.
- **Sequential Numbering**: Cycles are sequentially named `Punarjanm 1`, `Punarjanm 2`, `Punarjanm 3`, etc.
- **Action**: When Mudrex net position reaches $\ge$ ₹100 profit (or triggered manually with PIN `340556`), it market-closes the exchange position to lock in the profit, flushes stale pairs into closed history, resets the price grid, frees all margin, and immediately spawns a fresh 2.0B pair at the live price.

## 5. UI Updates & Data Integrity Shield (Admin Password: 340556)
- **Live Trading Data Must NEVER Be Touched or Cleared**: Closed trade history, open positions, active pairs, and balance/margin states must NEVER be cleared or modified during UI styling, frontend refactoring, or minor feature changes.
- **Admin Password Protection (`340556`)**:
  - All destructive and configuration operations (`Reset Data`, `Settings`, `Mudrex API Keys`, `Account Info`, `Pair Kharidne Ka Option`, `Punarjanm`, `Start/Pause Engine`) are protected behind Admin password `340556`.
  - No action that can alter engine state or reset data can be performed without verifying password `340556`.
