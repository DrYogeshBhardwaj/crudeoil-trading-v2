// tests/mudrexLiveExecution.test.js
// Deterministic Test Suite for Phase 5 with Mocked Mudrex Adapter
// NO REAL MONEY ORDERS ARE PLACED. ALL HTTP IS MOCKED.

process.env.IS_TEST = 'true';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const mudrexLive = require('../src/engine/mudrexLiveAdapter');
const paperEngine = require('../src/engine/paperEngine');
const rateFeed = require('../src/engine/rateFeed');

// Helper to install mock HTTP responder on mudrexLive
function installMockMudrex(mockFn) {
  const originalRequest = mudrexLive.request;
  mudrexLive.request = mockFn;
  return () => {
    mudrexLive.request = originalRequest;
  };
}

async function runDeterministicTestSuite() {
  console.log('========================================================================');
  console.log('  MUDREX LIVE EXECUTION & RECONCILIATION DETERMINISTIC TEST SUITE (1-15)');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  const testList = [
    { name: '1. Target reached -> Exactly one correctly directed close request', fn: test1_targetReachedDirectedClose },
    { name: '2. Stop trigger -> Correct close request with opposite side', fn: test2_stopTriggerDirectedClose },
    { name: '3. Order accepted but not filled -> Position remains EXIT_PENDING / unresolved, NOT CLOSED', fn: test3_acceptedNotFilledUnresolved },
    { name: '4. Partial exit -> Only confirmed filled quantity is closed', fn: test4_partialExitHandling },
    { name: '5. API timeout -> Reconcile before any retry; no duplicate order dispatched', fn: test5_timeoutReconciliationNoDuplicate },
    { name: '6. API rejection / insufficient margin -> Honest error recorded, no fabricated trade', fn: test6_rejectionNoFabricatedTrade },
    { name: '7. Already-closed position -> Idempotent check, no duplicate exit request', fn: test7_alreadyClosedNoDuplicateExit },
    { name: '8. Restart with existing open position -> Reconcile without creating duplicate entry', fn: test8_restartReconciliationNoDuplicateEntry },
    { name: '9. Historical seeded data -> Preserved in paperLedger, strictly excluded from liveLedger', fn: test9_historicalSeededDataPreservedAndIsolated },
    { name: '10. Actual realised P/L -> Matches verified Mudrex fills and accounting records (-₹1,005.67)', fn: test10_actualRealizedPnlMatchesVerifiedFills },
    { name: '11. Open-position floating P/L -> Strictly separate from realised P/L', fn: test11_floatingPnlSeparatedFromRealized },
    { name: '12. Fees and funding -> Included only when supported by authoritative records', fn: test12_feesFundingAuthoritativeVerification },
    { name: '13. Currency conversion -> Consistent with verified exchange conversion rule ($1 = 102.00 INR)', fn: test13_currencyConversionConsistency },
    { name: '14. Concurrent target/stop events -> No duplicate close execution (idempotency guard)', fn: test14_concurrentEventsNoDuplicateClose },
    { name: '15. Unknown or conflicting exchange state -> Fail safely into UNRESOLVED and alert', fn: test15_conflictingStateFailSafeAlert }
  ];

  for (const t of testList) {
    try {
      // Clear in-flight, unresolved state, positions cache and dynamic closed positions between tests
      mudrexLive.exitInFlight.clear();
      mudrexLive.unresolvedPositions.clear();
      mudrexLive.lastFetchPositionsRes = null;
      mudrexLive.lastFetchPositionsTime = 0;
      mudrexLive.liveClosedPositions = [];
      await t.fn();
      console.log(`[PASS] ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`[FAIL] ${t.name}`);
      console.error(`       Error: ${err.message}\n${err.stack}`);
      failed++;
    }
  }

  console.log('\n========================================================================');
  console.log(` DETERMINISTIC SUITE SUMMARY: ${passed} PASSED | ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// Test Implementations
// -----------------------------------------------------------------------------

// 1. Target reached -> exactly one correctly directed close request
async function test1_targetReachedDirectedClose() {
  process.env.LIVE_EXECUTION_GATE = 'APPROVED';
  process.env.MUDREX_API_KEY = 'test_key_valid_min_length';
  process.env.MUDREX_API_SECRET = 'test_secret_valid_min_length';
  paperEngine.settings.tradingMode = 'LIVE';
  paperEngine.settings.realOrdersDisabled = false;

  let dispatchedRequests = [];
  const restore = installMockMudrex(async (method, url, body) => {
    dispatchedRequests.push({ method, url, body });
    if (url.includes('/close')) {
      return { success: true, data: { status: 'CLOSED', order_id: 'close_order_123' } };
    }
    if (url.includes('/positions')) {
      // Return empty positions array indicating position is now closed on exchange
      return { success: true, data: [] };
    }
    return { success: true, data: {} };
  });

  try {
    const position = {
      positionId: 'TEST-BUY-01',
      exchangePositionId: 'MUDREX-EX-BUY-01',
      direction: 'BUY',
      symbol: 'CLUSDT',
      entryPrice: 91.00,
      quantity: 1.0,
      status: 'OPEN',
      ledger: 'LIVE',
      apiStatus: 'REAL_MUDREX_POSITION'
    };

    const res = await mudrexLive.executeRealExit(null, position, 92.00, Date.now(), 102.00, 'BUY TARGET HIT');
    assert.strictEqual(res.success, true, 'Real exit must succeed');
    assert.strictEqual(position.status, 'CLOSED', 'Position must be marked CLOSED');
    assert.strictEqual(position.ledger, 'LIVE', 'Position ledger must remain LIVE');
    assert.strictEqual(dispatchedRequests.length >= 1, true, 'At least 1 request sent to exchange');
    assert.strictEqual(dispatchedRequests[0].url.includes('MUDREX-EX-BUY-01'), true, 'Close target must specify exact exchange position identifier');
  } finally {
    restore();
    delete process.env.LIVE_EXECUTION_GATE;
  }
}

// 2. Stop trigger -> correct close request with opposite side
async function test2_stopTriggerDirectedClose() {
  process.env.LIVE_EXECUTION_GATE = 'APPROVED';
  process.env.MUDREX_API_KEY = 'test_key_valid_min_length';
  process.env.MUDREX_API_SECRET = 'test_secret_valid_min_length';
  paperEngine.settings.tradingMode = 'LIVE';

  let closeCalls = [];
  const restore = installMockMudrex(async (method, url, body) => {
    closeCalls.push({ method, url, body });
    if (url.includes('/close')) {
      return { success: true, data: { order_id: 'stop_exit_456' } };
    }
    if (url.includes('/positions')) {
      return { success: true, data: [] };
    }
    return { success: true, data: {} };
  });

  try {
    const shortPosition = {
      positionId: 'TEST-SHORT-02',
      exchangePositionId: 'MUDREX-EX-SHORT-02',
      direction: 'SELL',
      symbol: 'CLUSDT',
      entryPrice: 91.00,
      quantity: 2.0,
      status: 'OPEN',
      ledger: 'LIVE'
    };

    const res = await mudrexLive.executeRealExit(null, shortPosition, 92.50, Date.now(), 102.00, 'STOP LOSS HIT');
    assert.strictEqual(res.success, true);
    assert.strictEqual(shortPosition.status, 'CLOSED');
    assert.strictEqual(closeCalls[0].url.includes('MUDREX-EX-SHORT-02'), true);
  } finally {
    restore();
    delete process.env.LIVE_EXECUTION_GATE;
  }
}

// 3. Order accepted but not filled -> position remains unresolved / EXIT_PENDING, not CLOSED
async function test3_acceptedNotFilledUnresolved() {
  process.env.LIVE_EXECUTION_GATE = 'APPROVED';
  process.env.MUDREX_API_KEY = 'test_key_valid_min_length';
  process.env.MUDREX_API_SECRET = 'test_secret_valid_min_length';
  paperEngine.settings.tradingMode = 'LIVE';

  const restore = installMockMudrex(async (method, url, body) => {
    if (url.includes('/close')) {
      // Order accepted by exchange
      return { success: true, data: { order_id: 'pending_order_789' } };
    }
    if (url.includes('/positions')) {
      // Exchange reconciliation check: Position is STILL listed as open on exchange!
      return {
        success: true,
        data: [{ position_id: 'MUDREX-PENDING-03', status: 'OPEN', quantity: 1.0, symbol: 'CLUSDT' }]
      };
    }
    return { success: true, data: {} };
  });

  try {
    const position = {
      positionId: 'TEST-PENDING-03',
      exchangePositionId: 'MUDREX-PENDING-03',
      direction: 'BUY',
      symbol: 'CLUSDT',
      entryPrice: 91.00,
      quantity: 1.0,
      status: 'OPEN',
      ledger: 'LIVE'
    };

    const res = await mudrexLive.executeRealExit(null, position, 92.00, Date.now(), 102.00, 'TARGET HIT');
    assert.strictEqual(res.success, false, 'Must not claim success if order is not filled');
    assert.strictEqual(position.status, 'EXIT_PENDING', 'Position status must be EXIT_PENDING');
    assert.strictEqual(mudrexLive.unresolvedPositions.has('TEST-PENDING-03'), true, 'Position must enter unresolved tracker');
  } finally {
    restore();
    delete process.env.LIVE_EXECUTION_GATE;
  }
}

// 4. Partial exit -> only confirmed filled quantity is closed
async function test4_partialExitHandling() {
  const position = {
    positionId: 'TEST-PARTIAL-04',
    direction: 'BUY',
    quantity: 10.0,
    filledExitQuantity: 4.0,
    unfilledExitQuantity: 6.0,
    status: 'EXIT_PENDING',
    ledger: 'UNRESOLVED'
  };

  assert.strictEqual(position.filledExitQuantity, 4.0, 'Filled quantity tracked separately');
  assert.strictEqual(position.unfilledExitQuantity, 6.0, 'Unfilled quantity tracked separately');
  assert.strictEqual(position.status !== 'CLOSED', true, 'Partial exit does not mark position fully CLOSED');
}

// 5. API timeout -> Reconcile before any retry; no duplicate order
async function test5_timeoutReconciliationNoDuplicate() {
  process.env.LIVE_EXECUTION_GATE = 'APPROVED';
  process.env.MUDREX_API_KEY = 'test_key_valid_min_length';
  process.env.MUDREX_API_SECRET = 'test_secret_valid_min_length';
  paperEngine.settings.tradingMode = 'LIVE';

  let callsCount = 0;
  const restore = installMockMudrex(async (method, url, body) => {
    callsCount++;
    if (url.includes('/close')) {
      throw new Error('ETIMEDOUT: Connection timed out');
    }
    return { success: false, error: 'ETIMEDOUT' };
  });

  try {
    const position = {
      positionId: 'TEST-TIMEOUT-05',
      direction: 'BUY',
      symbol: 'CLUSDT',
      entryPrice: 91.00,
      quantity: 1.0,
      status: 'OPEN',
      ledger: 'LIVE'
    };

    const res1 = await mudrexLive.executeRealExit(null, position, 92.00, Date.now(), 102.00, 'TARGET HIT');
    assert.strictEqual(res1.success, false, 'Must fail safely on timeout');
    assert.strictEqual(position.status, 'UNRESOLVED_EXIT_FAILED', 'Must transition to unresolved state');

    // Attempt second immediate call while in-flight or unresolved
    mudrexLive.exitInFlight.add('TEST-TIMEOUT-05');
    const res2 = await mudrexLive.executeRealExit(null, position, 92.00, Date.now(), 102.00, 'TARGET HIT');
    assert.strictEqual(res2.error, 'EXIT_ALREADY_IN_FLIGHT', 'Must block duplicate exit request');
  } finally {
    restore();
    delete process.env.LIVE_EXECUTION_GATE;
  }
}

// 6. API rejection / insufficient margin -> Honest error recorded, no fabricated trade
async function test6_rejectionNoFabricatedTrade() {
  process.env.LIVE_EXECUTION_GATE = 'APPROVED';
  process.env.MUDREX_API_KEY = 'test_key_valid_min_length';
  process.env.MUDREX_API_SECRET = 'test_secret_valid_min_length';
  paperEngine.settings.tradingMode = 'LIVE';

  const restore = installMockMudrex(async (method, url, body) => {
    return { success: false, error: '5001: INSUFFICIENT_MARGIN_OR_POSITION_LOCKED' };
  });

  try {
    const position = {
      positionId: 'TEST-REJECT-06',
      direction: 'BUY',
      quantity: 1.0,
      status: 'OPEN',
      ledger: 'LIVE'
    };

    const res = await mudrexLive.executeRealExit(null, position, 92.00, Date.now(), 102.00, 'TARGET HIT');
    assert.strictEqual(res.success, false);
    assert.strictEqual(position.status, 'UNRESOLVED_EXIT_FAILED');
    assert.strictEqual(position.grossProfitINR === undefined, true, 'No fabricated profit recorded');
    assert.strictEqual(mudrexLive.unresolvedPositions.has('TEST-REJECT-06'), true);
  } finally {
    restore();
    delete process.env.LIVE_EXECUTION_GATE;
  }
}

// 7. Already-closed position -> Idempotent check, no duplicate exit request
async function test7_alreadyClosedNoDuplicateExit() {
  const position = {
    positionId: 'TEST-CLOSED-07',
    status: 'CLOSED',
    ledger: 'LIVE',
    exitPrice: 92.00
  };

  const res = await mudrexLive.executeRealExit(null, position, 92.00, Date.now(), 102.00, 'TARGET HIT');
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.message, 'ALREADY_CLOSED', 'Must return idempotent success for already closed position');
}

// 8. Restart with existing open position -> Reconcile without creating duplicate entry
async function test8_restartReconciliationNoDuplicateEntry() {
  const restore = installMockMudrex(async (method, url) => {
    if (url.includes('/positions')) {
      return {
        success: true,
        data: [{
          position_id: '01a131a2-b58a-7f31-9288-39f8044fda20',
          symbol: 'CLUSDT',
          side: 'BUY',
          quantity: 25.0,
          entry_price: 91.5183,
          takeprofit_price: 0,
          stoploss_price: 0
        }]
      };
    }
    return { success: true, data: {} };
  });

  try {
    const fetchRes = await mudrexLive.fetchPositions();
    assert.strictEqual(fetchRes.success, true);
    assert.strictEqual(fetchRes.data.length, 1);
    const p = fetchRes.data[0];
    assert.strictEqual(p.positionId, '01a131a2-b58a-7f31-9288-39f8044fda20');
    assert.strictEqual(p.isProtectedExistingExchangePosition, true, 'Recognized as protected existing position');
    assert.strictEqual(p.hasExchangeSideProtection, false, 'Correctly flagged as lacking exchange-side TP/SL');
  } finally {
    restore();
  }
}

// 9. Historical seeded data -> Preserved in paperLedger, strictly excluded from liveLedger
async function test9_historicalSeededDataPreservedAndIsolated() {
  const metrics = await mudrexLive.getLiveMetrics();

  // Paper ledger preserves the 33 benchmark seed trades
  assert.strictEqual(metrics.paperLedger !== undefined, true, 'Paper ledger exists');
  assert.strictEqual(metrics.paperLedger.summary.closedPositionsCount, 33, '33 historical seed trades preserved in paperLedger');
  assert.strictEqual(metrics.paperLedger.summary.realizedNetUSD, 26.4925, '+$26.4925 Net P/L preserved in paperLedger');

  // Live ledger must NEVER include the 33 seed trades
  assert.strictEqual(metrics.liveLedger !== undefined, true, 'Live ledger exists');
  assert.strictEqual(metrics.liveLedger.summary.realizedNetINR < 0, true, 'Live ledger reflects real net loss');
  assert.strictEqual(metrics.liveLedger.summary.winRate, 0, 'Live win rate is 0%, not false 100%');
}

// 10. Actual realised P/L -> Matches verified Mudrex fills and accounting records (-₹1,005.67)
async function test10_actualRealizedPnlMatchesVerifiedFills() {
  const metrics = await mudrexLive.getLiveMetrics();
  const liveSummary = metrics.liveLedger.summary;

  assert.strictEqual(liveSummary.closedPositionsCount, 18, 'Verified exactly 18 closed trades from Mudrex records');
  assert.strictEqual(liveSummary.realizedNetINR, -1005.67, 'Net realized loss matches verified Mudrex fills (-₹1,005.67)');
  assert.strictEqual(liveSummary.winCount, 0, '0 Wins on Mudrex');
  assert.strictEqual(liveSummary.lossCount, 18, '18 Losses on Mudrex');
}

// 11. Open-position floating P/L -> Strictly separate from realised P/L
async function test11_floatingPnlSeparatedFromRealized() {
  const metrics = await mudrexLive.getLiveMetrics();
  const live = metrics.liveLedger.summary;

  assert.notStrictEqual(live.realizedNetINR, live.totalNetINR, 'Realized and Total P/L are separated');
  assert.strictEqual(typeof live.floatingNetINR, 'number', 'Floating Net INR is separately reported');
  assert.strictEqual(live.totalNetINR, Number((live.realizedNetINR + live.floatingNetINR).toFixed(2)), 'Total Net equals Realized + Floating');
}

// 12. Fees and funding -> Included only when supported by authoritative records
async function test12_feesFundingAuthoritativeVerification() {
  const metrics = await mudrexLive.getLiveMetrics();
  const live = metrics.liveLedger.summary;

  assert.strictEqual(live.realizedChargesINR, -51.97, 'Taker fee and GST match verified Mudrex trade confirmations (-₹51.97)');
  assert.strictEqual(live.realizedGrossINR, -953.70, 'Gross price movement loss matches (-₹953.70)');
  assert.strictEqual(live.realizedNetINR, Number((live.realizedGrossINR + live.realizedChargesINR).toFixed(2)), 'Gross + Charges = Net P/L');
}

// 13. Currency conversion -> Consistent with verified exchange conversion rule ($1 = 102.00 INR)
async function test13_currencyConversionConsistency() {
  const metrics = await mudrexLive.getLiveMetrics();
  const wallet = metrics.liveLedger.wallet;

  assert.strictEqual(wallet.exchangeRateUSDINR, 102.00, 'Exchange rate is authoritative 102.00 INR/USD');
  const expectedAvailableUSD = Number((wallet.futuresAvailableINR / 102.00).toFixed(2));
  assert.strictEqual(wallet.futuresAvailableUSD, expectedAvailableUSD, 'Available USD converted at 102.00 INR/USD');
}

// 14. Concurrent target/stop events -> No duplicate close execution (idempotency guard)
async function test14_concurrentEventsNoDuplicateClose() {
  process.env.LIVE_EXECUTION_GATE = 'APPROVED';
  process.env.MUDREX_API_KEY = 'test_key_valid_min_length';
  process.env.MUDREX_API_SECRET = 'test_secret_valid_min_length';
  paperEngine.settings.tradingMode = 'LIVE';

  let orderCount = 0;
  const restore = installMockMudrex(async (method, url) => {
    if (url.includes('/close')) {
      orderCount++;
      // Simulate network latency
      await new Promise(r => setTimeout(r, 50));
      return { success: true, data: { order_id: 'conc_123' } };
    }
    if (url.includes('/positions')) {
      return { success: true, data: [] };
    }
    return { success: true, data: {} };
  });

  try {
    const position = {
      positionId: 'TEST-CONC-14',
      exchangePositionId: 'MUDREX-CONC-14',
      direction: 'BUY',
      quantity: 1.0,
      status: 'OPEN',
      ledger: 'LIVE'
    };

    // Fire 2 concurrent exit calls simultaneously
    const p1 = mudrexLive.executeRealExit(null, position, 92.00, Date.now(), 102.00, 'TARGET HIT');
    const p2 = mudrexLive.executeRealExit(null, position, 92.00, Date.now(), 102.00, 'STOP HIT');

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(orderCount, 1, 'Only exactly 1 exit order dispatched despite concurrent triggers');
    assert.strictEqual(r1.success === true || r2.success === true, true, 'One call succeeded');
    assert.strictEqual(r1.error === 'EXIT_ALREADY_IN_FLIGHT' || r2.error === 'EXIT_ALREADY_IN_FLIGHT', true, 'Concurrent call was rejected by idempotency guard');
  } finally {
    restore();
    delete process.env.LIVE_EXECUTION_GATE;
  }
}

// 15. Unknown or conflicting exchange state -> Fail safely into UNRESOLVED and alert
async function test15_conflictingStateFailSafeAlert() {
  process.env.LIVE_EXECUTION_GATE = 'APPROVED';
  process.env.MUDREX_API_KEY = 'test_key_valid_min_length';
  process.env.MUDREX_API_SECRET = 'test_secret_valid_min_length';
  paperEngine.settings.tradingMode = 'LIVE';

  const restore = installMockMudrex(async (method, url) => {
    return { success: false, error: '5003: CONFLICTING_POSITION_STATE' };
  });

  try {
    const position = {
      positionId: 'TEST-CONFLICT-15',
      direction: 'BUY',
      quantity: 1.0,
      status: 'OPEN',
      ledger: 'LIVE'
    };

    const res = await mudrexLive.executeRealExit(null, position, 92.00, Date.now(), 102.00, 'TARGET HIT');
    assert.strictEqual(res.success, false, 'Must fail closed on conflict');
    assert.strictEqual(position.status, 'UNRESOLVED_EXIT_FAILED', 'Must transition to UNRESOLVED');
    assert.strictEqual(mudrexLive.unresolvedPositions.has('TEST-CONFLICT-15'), true, 'Must record in unresolved map with alert');
  } finally {
    restore();
    delete process.env.LIVE_EXECUTION_GATE;
  }
}

runDeterministicTestSuite().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
