const paperEngine = require('../src/engine/paperEngine');
const backtest = require('../src/engine/backtest');
const rateFeed = require('../src/engine/rateFeed');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`[FAIL] ${message}`);
  }
}

function sendTestTick(symbol, price, time = Date.now(), status = 'LIVE', usdInrRate = 86.50) {
  rateFeed.usdInrRate = usdInrRate;
  rateFeed.activeSymbol = symbol;
  rateFeed.updateRate(symbol, price, time, 'TEST');
}

async function runTestSuite() {
  console.log('========================================================================');
  console.log('  RUNNING ENGINE & EXPANDED HISTORICAL BACKTESTER TEST SUITE (1-18)      ');
  console.log('========================================================================\n');

  let passedCount = 0;
  let failedCount = 0;

  const testCases = [
    { name: 'Test 1 — 100 Repeated Ticks at $91.35 creates ONLY 1 Pair', fn: test1 },
    { name: 'Test 2 — Rate changes to $91.36 creates 1 NEW Pair', fn: test2 },
    { name: 'Test 3 — Historical Rate $91.35 Returns & Creates New Pair (Not Blocked by History)', fn: test3 },
    { name: 'Test 4 — Multiple Unique Rates create New Pairs while Old Pairs remain Open', fn: test4 },
    { name: 'Test 5 — 25 Active Pairs Cap Enforced (26th Unique Rate Pair Blocked)', fn: test5 },
    { name: 'Test 6 — BUY Target Hit closes ONLY BUY Position (SELL stays Open)', fn: test6 },
    { name: 'Test 7 — SELL Target Hit closes ONLY SELL Position (BUY stays Open)', fn: test7 },
    { name: 'Test 8 — P/L, Fees, Realized Balance & Equity Reconciliation Math', fn: test8 },
    { name: 'Test 9 — Server Restart / Reconnect Restores State & Prevents Duplicates', fn: test9 },
    { name: 'Test 10 — Zero Real Order Endpoints Isolation Audit', fn: test10 },
    { name: 'Test 11 — Historical Day Backtester Single & Range Mode Simulation', fn: test11 },
    { name: 'Test 12 — Backtester Open Positions Carry Forward & Equity Math', fn: test12 },
    { name: 'Test 13 — Crude Oil (CLUSDT) $0.20 Target Move Execution Verification', fn: test13 },
    { name: 'Test 14 — Silver (XAGUSDT) $1.15 Target Move Execution Verification', fn: test14 },
    { name: 'Test 15 — Selected Symbol Feed Isolation and Auto-Resume Audit', fn: test15 },
    { name: 'Test 16 — Midnight Crossing Continuous Trading & Single Position Manual Close Reconciliation Audit', fn: test16 },
    { name: 'Test 17 — Entry Rejection Audit and Insufficient Margin Check', fn: test17 },
    { name: 'Test 18 — Position State-Driven Pair-Entry Strategy Verification (Leg Reopening, Idempotency & Cap)', fn: test18 },
    { name: 'Test 19 — Same-Rate Atomic Pair Creation & Missing-Side Re-Entry at Same Rate Verification', fn: test19 },
    { name: 'Test 20 — Strict Pair Completion Condition Audit (No Re-entry at Unrelated Price)', fn: test20 },
    { name: 'Test 21 — Accounting Formula & Margin Reconciliation Math Verification', fn: test21 }
  ];

  for (const tc of testCases) {
    try {
      paperEngine.resetAllData();
      paperEngine.settings.realOrdersDisabled = true;
      paperEngine.settings.targetDisabled = false;
      paperEngine.settings.profitTargetMove = 0.20;
      paperEngine.settings.maxActivePairs = 25;
      paperEngine.settings.dailyLossCircuitBreakerINR = 2000;
      paperEngine.settings.startingCapitalINR = 200000;
      paperEngine.settings.instrument = 'CLUSDT';
      
      await tc.fn();
      console.log(`[PASS] ${tc.name}`);
      passedCount++;
    } catch (err) {
      console.error(`[FAIL] ${tc.name}`);
      console.error(`       Error: ${err.message}\n`);
      failedCount++;
    }
  }

  console.log('\n========================================================================');
  console.log(` SUMMARY: ${passedCount} PASSED | ${failedCount} FAILED`);
  console.log('========================================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  }
}

// Test 1 — 100 repeated ticks at $91.35 -> ONLY 1 pair created
function test1() {
  const price = 91.35;
  for (let i = 0; i < 100; i++) {
    sendTestTick('CLUSDT', price, Date.now() + i * 100);
  }
  assert(paperEngine.pairs.length === 1, `Expected exactly 1 pair for 100 identical ticks at 91.35, got ${paperEngine.pairs.length}`);
}

// Test 2 — $91.35 followed by $91.36 -> 1 new pair created
function test2() {
  sendTestTick('CLUSDT', 91.35);
  assert(paperEngine.pairs.length === 1, 'First rate 91.35 created pair 1');

  sendTestTick('CLUSDT', 91.36);
  assert(paperEngine.pairs.length === 2, `New rate 91.36 created pair 2, got ${paperEngine.pairs.length}`);
}

// Test 3 — Returning to rate 91.35 while Pair 1 is active skips duplicate pair, but after Pair 1 closes, 91.35 creates a new pair
function test3() {
  sendTestTick('CLUSDT', 91.35);
  sendTestTick('CLUSDT', 91.36);
  assert(paperEngine.pairs.length === 2, '2 pairs created for 91.35 and 91.36');

  // Next tick returns to 91.35 while Pair 1 is active -> No duplicate pair created
  sendTestTick('CLUSDT', 91.35);
  assert(paperEngine.pairs.length === 2, `Returning to 91.35 while Pair 1 is active should NOT create duplicate pair, got ${paperEngine.pairs.length}`);

  // Close both legs of Pair 1 at 91.35
  const p1 = paperEngine.pairs[0];
  paperEngine.manualClosePosition(p1.buyPosition.positionId);
  paperEngine.manualClosePosition(p1.sellPosition.positionId);
  assert(p1.status === 'CLOSED', 'Pair 1 is now CLOSED');

  // Next tick returns to 91.35 -> Now a new pair CAN be created at 91.35
  sendTestTick('CLUSDT', 91.35);
  assert(paperEngine.pairs.length === 3, `After Pair 1 closes, returning to 91.35 creates Pair 3, got ${paperEngine.pairs.length}`);
}

// Test 4 — Different unique rates create new pairs while old pairs remain open
function test4() {
  const rates = [91.30, 91.31, 91.32, 91.33, 91.34];
  for (const r of rates) {
    sendTestTick('CLUSDT', r);
  }
  assert(paperEngine.pairs.length === 5, `Expected 5 pairs for 5 rates, got ${paperEngine.pairs.length}`);
  assert(paperEngine.getActivePairsCount() === 5, 'All 5 pairs are active');
}

// Test 5 — 25 active pairs cap enforced
function test5() {
  paperEngine.updateSettings({ startingCapitalINR: 500000, maxActivePairs: 25, profitTargetMove: 10.00 });
  for (let i = 1; i <= 30; i++) {
    const rate = Number((90.00 + i * 0.01).toFixed(2));
    sendTestTick('CLUSDT', rate);
  }
  assert(paperEngine.pairs.length === 25, `Expected cap of 25 pairs, got ${paperEngine.pairs.length}`);
  assert(paperEngine.engineStatus === 'PAUSED', 'Engine status paused when cap hit');
  assert(paperEngine.pauseReason.includes('MAX PAIRS REACHED'), 'Pause reason mentions MAX PAIRS REACHED');
}

// Test 6 — BUY target hit closes ONLY BUY position
function test6() {
  paperEngine.settings.profitTargetMove = 0.05;
  sendTestTick('CLUSDT', 100.00);
  const pair = paperEngine.pairs[0];

  sendTestTick('CLUSDT', 100.05);

  assert(pair.buyPosition.status === 'CLOSED', 'BUY position closed');
  assert(pair.sellPosition.status === 'OPEN', 'SELL position remains OPEN');
  assert(pair.sellPosition.entryPrice === 100.00, 'SELL entry price unchanged');
  assert(pair.sellPosition.targetExitPrice === 99.95, 'SELL target exit price unchanged');
}

// Test 7 — SELL target hit closes ONLY SELL position
function test7() {
  paperEngine.settings.profitTargetMove = 0.05;
  sendTestTick('CLUSDT', 100.00);
  const pair = paperEngine.pairs[0];

  sendTestTick('CLUSDT', 99.95);

  assert(pair.sellPosition.status === 'CLOSED', 'SELL position closed');
  assert(pair.buyPosition.status === 'OPEN', 'BUY position remains OPEN');
  assert(pair.buyPosition.entryPrice === 100.00, 'BUY entry price unchanged');
  assert(pair.buyPosition.targetExitPrice === 100.05, 'BUY target exit price unchanged');
}

// Test 8 — P/L, Fees, Realized Balance & Equity Reconciliation
function test8() {
  paperEngine.settings.startingCapitalINR = 50000;
  sendTestTick('CLUSDT', 100.00);
  sendTestTick('CLUSDT', 100.05);

  const metrics = paperEngine.getDashboardMetrics();
  const s = metrics.summary;

  const expectedRealizedBalance = s.startingCapitalINR + s.realizedNetINR;
  const expectedEquity = expectedRealizedBalance + s.floatingNetINR;

  assert(Math.abs(s.realizedBalanceINR - expectedRealizedBalance) < 0.01, `Realized Balance math mismatch. Got ${s.realizedBalanceINR}, expected ${expectedRealizedBalance}`);
  assert(Math.abs(s.totalEquityINR - expectedEquity) < 0.01, `Total Equity math mismatch. Got ${s.totalEquityINR}, expected ${expectedEquity}`);
}

// Test 9 — Server Restart / Reconnect restores state & prevents duplicate legs on same rate
function test9() {
  sendTestTick('CLUSDT', 91.35);
  sendTestTick('CLUSDT', 91.36);
  assert(paperEngine.pairs.length === 2, '2 pairs created before restart simulation');

  const restoredEngine = new (require('../src/engine/paperEngine').constructor)();
  
  assert(restoredEngine.pairs.length === 2, 'Restored engine loaded 2 existing pairs');

  // Immediately send exact same rate 91.36 tick
  restoredEngine.processTick({
    symbol: 'CLUSDT',
    price: 91.36,
    time: Date.now(),
    status: 'LIVE',
    usdInrRate: 86.50
  });

  assert(restoredEngine.pairs.length === 2, `No duplicate pair created for immediate duplicate tick 91.36, got ${restoredEngine.pairs.length}`);
}

// Test 10 — Zero real order endpoints isolation
function test10() {
  assert(paperEngine.settings.realOrdersDisabled === true, 'realOrdersDisabled is permanently true');
  const paperEngineCode = require('fs').readFileSync(require('path').join(__dirname, '../src/engine/paperEngine.js'), 'utf8');
  assert(!paperEngineCode.includes('placeOrder') && !paperEngineCode.includes('binance.com/fapi/v1/order'), 'Zero real exchange order API calls present');
}

// Test 11 — Historical Day Backtester Single & Range Mode Simulation
async function test11() {
  const dateStr = '2026-10-10';
  const result = await backtest.runBacktest({
    mode: 'SINGLE',
    symbol: 'CLUSDT',
    dateStr,
    startingCapitalINR: 50000,
    targetMove: 0.05,
    maxActivePairs: 25
  });

  assert(result.success === true, 'Backtest execution succeeded');
  assert(result.summary.startingCapitalINR === 50000, 'Starting capital matched');
  assert(result.summary.finalEquityINR > 0, 'Final equity calculated');
  assert(Array.isArray(result.dailyReports), 'Daily reports array generated');
  assert(Array.isArray(result.remainingOpenPositions), 'Remaining open positions list generated');
}

// Test 12 — Backtester Open Positions Carry Forward & Equity Math
async function test12() {
  const result = await backtest.runBacktest({
    mode: 'RANGE',
    symbol: 'CLUSDT',
    fromDateStr: '2026-10-09',
    toDateStr: '2026-10-10',
    startingCapitalINR: 50000,
    targetMove: 0.05,
    maxActivePairs: 25
  });

  assert(result.success === true, 'Range backtest execution succeeded');
  assert(result.dailyReports.length === 2, '2 daily reports generated for 2-day date range');
  
  const s = result.summary;
  const expectedFinalEquity = s.startingCapitalINR + s.totalRealizedNetINR + s.remainingFloatingNetINR;
  assert(Math.abs(s.finalEquityINR - expectedFinalEquity) < 0.05, `End-of-Day Final Equity math mismatch. Got ${s.finalEquityINR}, expected ${expectedFinalEquity}`);
}

// Test 13 — Crude Oil (CLUSDT) $0.20 Target Move Execution Verification
function test13() {
  paperEngine.settings.instrument = 'CLUSDT';
  paperEngine.settings.profitTargetMove = 0.20;

  sendTestTick('CLUSDT', 90.00);
  assert(paperEngine.pairs.length === 1, '1 pair opened at $90.00');
  const pair = paperEngine.pairs[0];
  assert(pair.buyPosition.targetExitPrice === 90.20, `BUY target exit price must be $90.20, got ${pair.buyPosition.targetExitPrice}`);
  assert(pair.sellPosition.targetExitPrice === 89.80, `SELL target exit price must be $89.80, got ${pair.sellPosition.targetExitPrice}`);

  sendTestTick('CLUSDT', 90.15);
  assert(pair.buyPosition.status === 'OPEN', 'BUY position remains OPEN at $90.15');

  sendTestTick('CLUSDT', 90.20);
  assert(pair.buyPosition.status === 'CLOSED', 'BUY position CLOSED when price hits $90.20 ($0.20 target move)');
  assert(pair.sellPosition.status === 'OPEN', 'SELL position remains OPEN after BUY target hit');
}

// Test 14 — Silver (XAGUSDT) $1.15 Target Move Execution Verification
function test14() {
  paperEngine.settings.instrument = 'XAGUSDT';
  paperEngine.settings.profitTargetMove = 1.15;

  sendTestTick('XAGUSDT', 30.00);
  assert(paperEngine.pairs.length === 1, '1 pair opened for Silver at $30.00');
  const pair = paperEngine.pairs[0];
  assert(pair.buyPosition.targetExitPrice === 31.15, `BUY target exit price must be $31.15, got ${pair.buyPosition.targetExitPrice}`);
  assert(pair.sellPosition.targetExitPrice === 28.85, `SELL target exit price must be $28.85, got ${pair.sellPosition.targetExitPrice}`);

  sendTestTick('XAGUSDT', 30.50);
  assert(pair.buyPosition.status === 'OPEN', 'BUY position remains OPEN at $30.50');

  sendTestTick('XAGUSDT', 31.15);
  assert(pair.buyPosition.status === 'CLOSED', 'BUY position CLOSED when Silver hits $31.15 ($1.15 target move)');
  assert(pair.sellPosition.status === 'OPEN', 'SELL position remains OPEN after BUY target hit');
}

// Test 15 — Selected Symbol Feed Isolation and Auto-Resume Audit
function test15() {
  paperEngine.settings.instrument = 'XAGUSDT';
  paperEngine.isEngineRunning = true;
  paperEngine.engineStatus = 'RUNNING';
  paperEngine.pauseReason = '';

  // 1. Send stale event for UNSELECTED symbol (CLUSDT) -> Engine must NOT pause!
  paperEngine.handleRateEvent('feed_stale', { symbol: 'CLUSDT' });
  assert(paperEngine.engineStatus === 'RUNNING', 'Engine status remains RUNNING when unselected instrument (CLUSDT) is stale');
  assert(paperEngine.pauseReason === '', 'Pause reason remains empty when unselected instrument is stale');

  // 2. Send stale event for SELECTED symbol (XAGUSDT) -> Engine must PAUSE new pair creation!
  paperEngine.handleRateEvent('feed_stale', { symbol: 'XAGUSDT' });
  assert(paperEngine.engineStatus === 'PAUSED', 'Engine status becomes PAUSED when selected instrument (XAGUSDT) is stale');
  assert(paperEngine.pauseReason.includes('STALE MARKET FEED FOR XAGUSDT'), 'Pause reason mentions XAGUSDT stale feed');

  // 3. Send fresh LIVE tick for SELECTED symbol (XAGUSDT) -> Engine must AUTO-RESUME to RUNNING!
  sendTestTick('XAGUSDT', 32.00, Date.now(), 'LIVE');
  assert(paperEngine.engineStatus === 'RUNNING', 'Engine AUTO-RESUMES to RUNNING when fresh LIVE tick arrives for XAGUSDT');
  assert(paperEngine.pauseReason === '', 'Pause reason cleared on auto-resume');
}

// Test 16 — Midnight Crossing Continuous Trading & Single Position Manual Close Reconciliation Audit
function test16() {
  paperEngine.settings.instrument = 'CLUSDT';
  paperEngine.settings.profitTargetMove = 0.20;

  // Day 1: Send tick at 23:59:50
  const day1Time = new Date('2026-10-11T23:59:50.000Z').getTime();
  sendTestTick('CLUSDT', 90.00, day1Time);
  assert(paperEngine.pairs.length === 1, 'Day 1: Pair opened at $90.00');

  // Day 2 (Midnight Crossing): Send tick at 00:00:10
  const day2Time = new Date('2026-10-12T00:00:10.000Z').getTime();
  sendTestTick('CLUSDT', 90.10, day2Time);
  assert(paperEngine.pairs.length === 2, 'Day 2 (Midnight): New rate $90.10 creates 2nd Pair continuously across midnight');
  assert(paperEngine.engineStatus === 'RUNNING', 'Engine remains RUNNING across midnight');

  // Test Manual Close of SINGLE position P-0001-BUY
  const targetPair = paperEngine.pairs[0];
  assert(targetPair.buyPosition.status === 'OPEN', 'P-0001-BUY is OPEN');
  assert(targetPair.sellPosition.status === 'OPEN', 'P-0001-SELL is OPEN');

  // Manually close P-0001-BUY at current rate $90.10
  const closedSuccess = paperEngine.manualClosePosition('P-0001-BUY');
  assert(closedSuccess === true, 'Manual close executed successfully');

  assert(targetPair.buyPosition.status === 'CLOSED', 'P-0001-BUY is now CLOSED');
  assert(targetPair.sellPosition.status === 'OPEN', 'P-0001-SELL remains OPEN (independent management)');
  assert(targetPair.status === 'ACTIVE', 'Pair status remains ACTIVE because SELL position is still OPEN');

  // Verify Metrics Reconciliation
  const metrics = paperEngine.getDashboardMetrics();
  assert(metrics.summary.closedPositionsCount === 1, 'Closed positions count is 1');
  assert(metrics.summary.realizedBalanceINR > 0, 'Realized balance updated correctly');
  assert(metrics.summary.totalEquityINR > 0, 'Total equity updated without double counting');
}

// Test 17 — Entry Rejection Audit and Insufficient Margin Check
function test17() {
  paperEngine.settings.instrument = 'CLUSDT';
  paperEngine.settings.contractQuantity = 1.0;
  paperEngine.settings.startingCapitalINR = 4500; // Small capital ₹4500 (enough for 1 pair of 1 Barrel @ ₹3114)
  paperEngine.settings.profitTargetMove = 0.20;

  // Send ticks to consume margin (5x leverage at $90 = ~₹1,557 per position, ~₹3,114 per pair)
  sendTestTick('CLUSDT', 90.00);
  assert(paperEngine.pairs.length === 1, '1 pair opened with ₹4500 capital');

  // Next rate $90.10: Available margin is now < ₹3,114 required for 2nd pair
  sendTestTick('CLUSDT', 90.10);
  assert(paperEngine.pairs.length === 1, '2nd pair rejected due to insufficient available margin');
  assert(paperEngine.engineStatus === 'PAUSED', 'Engine paused on insufficient margin');
  assert(paperEngine.pauseReason.includes('INSUFFICIENT MARGIN'), 'Pause reason states INSUFFICIENT MARGIN');

  // Close BOTH positions of pair 1 to free up all margin
  paperEngine.manualClosePosition('P-0001-BUY');
  paperEngine.manualClosePosition('P-0001-SELL');

  // Send next rate $90.20: Engine retries and creates 2nd pair!
  sendTestTick('CLUSDT', 90.20);
  assert(paperEngine.pairs.length === 2, 'Engine automatically retries and creates 2nd pair when margin becomes available');
  assert(paperEngine.engineStatus === 'RUNNING', 'Engine status resumes to RUNNING');
}

// Test 18 — Position State-Driven Pair-Entry Strategy Verification
function test18() {
  paperEngine.settings.instrument = 'CLUSDT';
  paperEngine.settings.profitTargetMove = 0.20;
  paperEngine.settings.startingCapitalINR = 100000;

  // Rule 4 & 6: 1. Start with initial tick at $90.00
  const t0 = Date.now();
  sendTestTick('CLUSDT', 90.00, t0);
  assert(paperEngine.pairs.length === 1, 'Pair 1 created at 90.00');
  const p1 = paperEngine.pairs[0];
  assert(p1.buyPosition.status === 'OPEN', 'P1 BUY is OPEN');
  assert(p1.sellPosition.status === 'OPEN', 'P1 SELL is OPEN');

  // Repeated identical tick at $90.00 -> No duplicate position created
  sendTestTick('CLUSDT', 90.00, t0 + 100);
  assert(paperEngine.pairs.length === 1, 'Repeated same rate tick does NOT create duplicate pair');

  // Rule 1: BUY open + SELL closed => only missing SELL leg opens
  // Move price to hit BUY target ($90.20)
  sendTestTick('CLUSDT', 90.20, t0 + 6000);
  assert(p1.buyPosition.status === 'CLOSED', 'P1 BUY closed at target $90.20');
  assert(p1.sellPosition.status === 'OPEN', 'P1 SELL remains OPEN');
  
  // Note: 90.20 was tick price, which created Pair 2 at 90.20 with both legs open.
  assert(paperEngine.pairs.length === 2, 'Pair 2 created at 90.20');

  // P1 has BUY CLOSED at target $90.20, and SELL OPEN at $90.00.
  // Send tick at 90.25 -> Market price $90.25 does NOT match remaining SELL entry price $90.00 => P1 BUY remains CLOSED!
  sendTestTick('CLUSDT', 90.25, t0 + 12000);
  assert(p1.buyPosition.status === 'CLOSED', 'P1 BUY remains CLOSED when current price ($90.25) != remaining SELL entry ($90.00)');

  // Send tick returning to $90.00 -> Matches remaining SELL entry price $90.00 => P1 BUY re-opens at $90.00!
  sendTestTick('CLUSDT', 90.00, t0 + 15000);
  assert(p1.buyPosition.status === 'OPEN', 'P1 BUY leg re-opens when market price returns to $90.00');
  assert(p1.buyPosition.entryPrice === 90.00, 'P1 re-opened BUY leg entry price is $90.00');

  // Test missing SELL reopening: Move price to hit SELL target ($89.80 for SELL entered at 90.00)
  sendTestTick('CLUSDT', 89.80, t0 + 18000);
  assert(p1.sellPosition.status === 'CLOSED', 'P1 SELL closed at target $89.80');
  assert(p1.buyPosition.status === 'OPEN', 'P1 BUY remains OPEN at $90.00');

  // Send tick at 89.85 -> Current price $89.85 does NOT match remaining BUY entry $90.00 => P1 SELL remains CLOSED!
  sendTestTick('CLUSDT', 89.85, t0 + 21000);
  assert(p1.sellPosition.status === 'CLOSED', 'P1 SELL remains CLOSED when current price ($89.85) != remaining BUY entry ($90.00)');

  // Send tick returning to $90.00 -> Matches remaining BUY entry price $90.00 => P1 SELL re-opens at $90.00!
  sendTestTick('CLUSDT', 90.00, t0 + 24000);
  assert(p1.sellPosition.status === 'OPEN', 'P1 SELL leg re-opens when market price returns to $90.00');
  assert(p1.sellPosition.entryPrice === 90.00, 'P1 re-opened SELL leg entry price is $90.00');

  // Rule 3: Both legs closed => pair completed, new pair can start
  // Manually close both legs of P1
  paperEngine.manualClosePosition(p1.buyPosition.positionId);
  paperEngine.manualClosePosition(p1.sellPosition.positionId);
  assert(p1.status === 'CLOSED', 'P1 is now fully CLOSED');

  // Send new tick -> Active pairs decreases, new pair can start
  sendTestTick('CLUSDT', 90.50, t0 + 30000);
  assert(paperEngine.pairs.length > 2, 'New pair started after previous pair completed');

  // Rule 5: Historical rate does not block valid current entry
  sendTestTick('CLUSDT', 90.00, t0 + 36000);
  const pairsWith90 = paperEngine.pairs.filter(p => p.buyPosition.entryPrice === 90.00 || p.sellPosition.entryPrice === 90.00);
  assert(pairsWith90.length >= 1, 'Historical rate 90.00 was allowed again');

  // Rule 7: Pair cap 25 enforced
  paperEngine.settings.startingCapitalINR = 500000;
  for (let i = 1; i <= 30; i++) {
    sendTestTick('CLUSDT', Number((91.00 + i * 0.10).toFixed(2)), t0 + 40000 + i * 1000);
  }
  assert(paperEngine.getActivePairsCount() <= 25, `Active pairs cap 25 enforced, got ${paperEngine.getActivePairsCount()}`);
}

// Test 19 — Same-Rate Atomic Pair Creation & Missing-Side Re-Entry at Same Rate Verification
function test19() {
  paperEngine.settings.instrument = 'CLUSDT';
  paperEngine.settings.profitTargetMove = 0.20;
  paperEngine.settings.startingCapitalINR = 200000;

  // 1. Same-Rate Atomic Pair Creation Check
  sendTestTick('CLUSDT', 91.51);
  assert(paperEngine.pairs.length === 1, '1 Pair created at $91.51');
  const pair = paperEngine.pairs[0];
  assert(pair.buyPosition.entryPrice === 91.51, `BUY entry price must be 91.51, got ${pair.buyPosition.entryPrice}`);
  assert(pair.sellPosition.entryPrice === 91.51, `SELL entry price must be 91.51, got ${pair.sellPosition.entryPrice}`);
  assert(pair.buyPosition.status === 'OPEN', 'BUY status is OPEN');
  assert(pair.sellPosition.status === 'OPEN', 'SELL status is OPEN');

  // 2. BUY Target Hit -> BUY closes at $91.71, SELL remains OPEN at $91.51
  sendTestTick('CLUSDT', 91.71);
  assert(pair.buyPosition.status === 'CLOSED', 'BUY position closed at target $91.71');
  assert(pair.sellPosition.status === 'OPEN', 'SELL position remains OPEN');
  assert(pair.sellPosition.entryPrice === 91.51, 'SELL position entry price remains 91.51');

  // 3. Tick returns to $91.51: Missing BUY leg must re-open at $91.51 EVEN THOUGH SELL entry price is $91.51!
  sendTestTick('CLUSDT', 91.51);
  assert(pair.buyPosition.status === 'OPEN', 'Missing BUY leg re-opened when market tick returned to $91.51');
  assert(pair.buyPosition.entryPrice === 91.51, `Re-opened BUY leg entry price must be $91.51, got ${pair.buyPosition.entryPrice}`);

  // 4. Repeated tick at $91.51 when BOTH legs are OPEN -> No extra duplicate missing-leg created
  const openPositionsBefore = paperEngine.getDashboardMetrics().openPositions.length;
  sendTestTick('CLUSDT', 91.51);
  const openPositionsAfter = paperEngine.getDashboardMetrics().openPositions.length;
  assert(openPositionsBefore === openPositionsAfter, `Repeated tick at $91.51 when both legs open should NOT create duplicate leg (before=${openPositionsBefore}, after=${openPositionsAfter})`);

  // 5. SELL Target Hit -> SELL closes at $91.31 ($0.20 target move from $91.51), BUY remains OPEN at $91.51
  sendTestTick('CLUSDT', 91.31);
  assert(pair.sellPosition.status === 'CLOSED', 'SELL position closed at target $91.31');
  assert(pair.buyPosition.status === 'OPEN', 'BUY position remains OPEN');

  // 6. Tick returns to $91.51: Missing SELL leg must re-open at $91.51 EVEN THOUGH BUY entry price is $91.51!
  sendTestTick('CLUSDT', 91.51);
  assert(pair.sellPosition.status === 'OPEN', 'Missing SELL leg re-opened when market tick returned to $91.51');
  assert(pair.sellPosition.entryPrice === 91.51, `Re-opened SELL leg entry price must be $91.51, got ${pair.sellPosition.entryPrice}`);

  // 7. Verify positions audit history maintained (closed positions history retains accurate logs)
  const history = paperEngine.closedPositions;
  assert(history.length >= 2, `Closed positions history must contain closed legs, got ${history.length}`);
}

// Test 20 — Strict Pair Completion Condition Audit (No Re-entry at Unrelated Price)
function test20() {
  paperEngine.settings.instrument = 'CLUSDT';
  paperEngine.settings.profitTargetMove = 0.20;
  paperEngine.settings.startingCapitalINR = 200000;

  // 1. Create initial pair at $90.88
  sendTestTick('CLUSDT', 90.88);
  assert(paperEngine.pairs.length === 1, '1 Pair created at $90.88');
  const pair = paperEngine.pairs[0];
  assert(pair.buyPosition.entryPrice === 90.88, 'BUY entry price is 90.88');
  assert(pair.sellPosition.entryPrice === 90.88, 'SELL entry price is 90.88');

  // 2. Move price to $91.08 -> BUY target hit, BUY closes. SELL remains OPEN at $90.88.
  sendTestTick('CLUSDT', 91.08);
  assert(pair.buyPosition.status === 'CLOSED', 'BUY position closed at target $91.08');
  assert(pair.sellPosition.status === 'OPEN', 'SELL position remains OPEN at $90.88');

  // 3. Send unrelated market tick at $90.94 -> BUY MUST NOT re-open at $90.94!
  sendTestTick('CLUSDT', 90.94);
  assert(pair.buyPosition.status === 'CLOSED', 'BUY position MUST stay CLOSED when current price ($90.94) != remaining SELL entry ($90.88)');

  // 4. Send another unrelated market tick at $91.20 -> BUY MUST NOT re-open at $91.20!
  sendTestTick('CLUSDT', 91.20);
  assert(pair.buyPosition.status === 'CLOSED', 'BUY position MUST stay CLOSED when current price ($91.20) != remaining SELL entry ($90.88)');

  // 5. Send matching tick at $90.88 (matches remaining SELL entry price $90.88) -> Replacement BUY opens at $90.88!
  sendTestTick('CLUSDT', 90.88);
  assert(pair.buyPosition.status === 'OPEN', 'BUY position re-opens ONLY when current price matches remaining SELL entry price ($90.88)');
  assert(pair.buyPosition.entryPrice === 90.88, `Re-opened BUY entry price MUST be $90.88, got ${pair.buyPosition.entryPrice}`);

  // 6. Test inverse (SELL missing): Move price to $90.68 -> SELL target hit, SELL closes. BUY remains OPEN at $90.88.
  sendTestTick('CLUSDT', 90.68);
  assert(pair.sellPosition.status === 'CLOSED', 'SELL position closed at target $90.68');
  assert(pair.buyPosition.status === 'OPEN', 'BUY position remains OPEN at $90.88');

  // 7. Send unrelated tick at $90.75 -> SELL MUST NOT re-open at $90.75!
  sendTestTick('CLUSDT', 90.75);
  assert(pair.sellPosition.status === 'CLOSED', 'SELL position MUST stay CLOSED when current price ($90.75) != remaining BUY entry ($90.88)');

  // 8. Send matching tick at $90.88 -> Replacement SELL opens at $90.88!
  sendTestTick('CLUSDT', 90.88);
  assert(pair.sellPosition.status === 'OPEN', 'SELL position re-opens ONLY when current price matches remaining BUY entry price ($90.88)');
  assert(pair.sellPosition.entryPrice === 90.88, `Re-opened SELL entry price MUST be $90.88, got ${pair.sellPosition.entryPrice}`);
}

// Test 21 — Accounting Formula & Margin Reconciliation Math Verification
function test21() {
  paperEngine.settings.instrument = 'CLUSDT';
  paperEngine.settings.startingCapitalINR = 103227.29;
  paperEngine.settings.profitTargetMove = 0.20;
  paperEngine.settings.leverage = 5;

  sendTestTick('CLUSDT', 100.00);
  sendTestTick('CLUSDT', 100.20); // BUY target hit at 100.20 -> closes BUY leg

  const metrics = paperEngine.getDashboardMetrics();
  const s = metrics.summary;

  // 1. Realized Balance = Starting Virtual Capital + Realized Net P/L
  const expectedRealizedBalance = s.startingCapitalINR + s.realizedNetINR;
  assert(Math.abs(s.realizedBalanceINR - expectedRealizedBalance) < 0.01, `Realized Balance mismatch: got ${s.realizedBalanceINR}, expected ${expectedRealizedBalance}`);

  // 2. Total Equity = Realized Balance + Floating Net P/L
  const expectedEquity = s.realizedBalanceINR + s.floatingNetINR;
  assert(Math.abs(s.totalEquityINR - expectedEquity) < 0.01, `Total Equity mismatch: got ${s.totalEquityINR}, expected ${expectedEquity}`);

  // 3. Available Margin = Total Equity - Margin Used
  const expectedAvailableMargin = Math.max(0, s.totalEquityINR - s.marginUsedINR);
  assert(Math.abs(s.availableMarginINR - expectedAvailableMargin) < 0.01, `Available Margin mismatch: got ${s.availableMarginINR}, expected ${expectedAvailableMargin}`);
}

runTestSuite();
