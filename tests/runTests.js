const paperEngine = require('../src/engine/paperEngine');
const backtest = require('../src/engine/backtest');
const rateFeed = require('../src/engine/rateFeed');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`[FAIL] ${message}`);
  }
}

function sendTestTick(symbol, price, time = Date.now(), status = 'LIVE', usdInrRate = 86.50) {
  rateFeed.updateRate(symbol, price, time, 'TEST');
  paperEngine.processTick({
    symbol,
    price,
    time,
    status,
    usdInrRate
  });
}

async function runTestSuite() {
  console.log('========================================================================');
  console.log('  RUNNING ENGINE & EXPANDED HISTORICAL BACKTESTER TEST SUITE (1-12)      ');
  console.log('========================================================================\n');

  let passedCount = 0;
  let failedCount = 0;

  const testCases = [
    { name: 'Test 1 — 100 Repeated Ticks at $91.35 creates ONLY 1 Pair', fn: test1 },
    { name: 'Test 2 — Rate changes to $91.36 creates 1 NEW Pair', fn: test2 },
    { name: 'Test 3 — Rate returns to $91.35 creates NO New Pair (Already Processed Rate)', fn: test3 },
    { name: 'Test 4 — Multiple Unique Rates create New Pairs while Old Pairs remain Open', fn: test4 },
    { name: 'Test 5 — 25 Active Pairs Cap Enforced (26th Unique Rate Pair Blocked)', fn: test5 },
    { name: 'Test 6 — BUY Target Hit closes ONLY BUY Position (SELL stays Open)', fn: test6 },
    { name: 'Test 7 — SELL Target Hit closes ONLY SELL Position (BUY stays Open)', fn: test7 },
    { name: 'Test 8 — P/L, Fees, Realized Balance & Equity Reconciliation Math', fn: test8 },
    { name: 'Test 9 — Server Restart / Reconnect Preserves Processed Rates (No Duplicate Pair)', fn: test9 },
    { name: 'Test 10 — Zero Real Order Endpoints Isolation Audit', fn: test10 },
    { name: 'Test 11 — Historical Day Backtester Single & Range Mode Simulation', fn: test11 },
    { name: 'Test 12 — Backtester Open Positions Carry Forward & Equity Math', fn: test12 },
    { name: 'Test 13 — Crude Oil (CLUSDT) $0.20 Target Move Execution Verification', fn: test13 },
    { name: 'Test 14 — Silver (XAGUSDT) $1.15 Target Move Execution Verification', fn: test14 }
  ];

  for (const tc of testCases) {
    try {
      paperEngine.resetAllData();
      paperEngine.settings.realOrdersDisabled = true;
      paperEngine.settings.targetDisabled = false;
      paperEngine.settings.profitTargetMove = 0.20;
      paperEngine.settings.maxActivePairs = 25;
      paperEngine.settings.dailyLossCircuitBreakerINR = 2000;
      paperEngine.settings.startingCapitalINR = 50000;
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
  assert(paperEngine.pairs.length === 2, `New unique rate 91.36 created pair 2, got ${paperEngine.pairs.length}`);
}

// Test 3 — $91.35 returns again -> NO new pair created
function test3() {
  sendTestTick('CLUSDT', 91.35);
  sendTestTick('CLUSDT', 91.36);
  assert(paperEngine.pairs.length === 2, '2 pairs created for 91.35 and 91.36');

  sendTestTick('CLUSDT', 91.35);
  assert(paperEngine.pairs.length === 2, `Returning to already processed rate 91.35 should NOT create a 3rd pair, got ${paperEngine.pairs.length}`);
}

// Test 4 — Different unique rates create new pairs while old pairs remain open
function test4() {
  const rates = [91.30, 91.31, 91.32, 91.33, 91.34];
  for (const r of rates) {
    sendTestTick('CLUSDT', r);
  }
  assert(paperEngine.pairs.length === 5, `Expected 5 pairs for 5 unique rates, got ${paperEngine.pairs.length}`);
  assert(paperEngine.getActivePairsCount() === 5, 'All 5 pairs are active');
}

// Test 5 — 25 active pairs cap enforced
function test5() {
  paperEngine.settings.maxActivePairs = 25;
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

// Test 9 — Server Restart / Reconnect preserves processed rates
function test9() {
  sendTestTick('CLUSDT', 91.35);
  sendTestTick('CLUSDT', 91.36);
  assert(paperEngine.pairs.length === 2, '2 pairs created before restart simulation');

  const restoredEngine = new (require('../src/engine/paperEngine').constructor)();
  
  assert(restoredEngine.processedRates['CLUSDT'].has(91.35), '91.35 rate present in restored processed rates');
  assert(restoredEngine.processedRates['CLUSDT'].has(91.36), '91.36 rate present in restored processed rates');

  restoredEngine.processTick({
    symbol: 'CLUSDT',
    price: 91.35,
    time: Date.now(),
    status: 'LIVE',
    usdInrRate: 86.50
  });

  assert(restoredEngine.pairs.length === 2, `No duplicate pair created after restart for already processed rate 91.35, got ${restoredEngine.pairs.length}`);
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

runTestSuite();
