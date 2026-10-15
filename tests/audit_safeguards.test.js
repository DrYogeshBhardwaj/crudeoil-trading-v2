const assert = require('assert');
const path = require('path');
const fs = require('fs');

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = path.join(__dirname, '../data');

const db = require('../src/engine/db');
const mudrexLive = require('../src/engine/mudrexLiveAdapter');
const solanaEngine = require('../src/engine/solanaEngine');

async function runAuditSafeguardsTestSuite() {
  console.log('================================================================');
  console.log('   MUDREX ENGINE FORENSIC AUDIT — 10 SCENARIO SAFEGUARD TEST    ');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  [FAIL] ${name}:`, err.message);
      console.error(err.stack);
      failed++;
    }
  }

  const origIsEnabled = mudrexLive.isRealExecutionEnabled;
  const origRequest = mudrexLive.request;
  const origVerify = mudrexLive.verifyOrderOnExchange;
  const origQueryPositions = mudrexLive.queryRealPositions;

  // Test 1: BUY followed by SELL under one-way/net position mode
  await test('1. One-Way Net Mode: Prohibit simultaneous opposing BUY and SELL hedge churn', async () => {
    mudrexLive.isRealExecutionEnabled = () => true;
    solanaEngine.settings.tradingMode = 'LIVE';
    solanaEngine.settings.realOrdersDisabled = false;

    mudrexLive.queryRealPositions = async () => [];

    const mockPair = {
      pairId: 'TEST-NET-001',
      symbol: 'SOLUSDT',
      buyPosition: { positionId: 'P-TEST-BUY', direction: 'BUY', quantity: 1.0, apiStatus: 'PENDING_TRANSMISSION' },
      sellPosition: { positionId: 'P-TEST-SELL', direction: 'SELL', quantity: 1.0, apiStatus: 'PENDING_TRANSMISSION' }
    };

    await solanaEngine.dispatchPairOrders(mockPair);

    mudrexLive.queryRealPositions = origQueryPositions;
    mudrexLive.isRealExecutionEnabled = origIsEnabled;

    assert.strictEqual(mockPair.sellPosition.ledger, 'PAPER', 'Opposing SELL leg must be marked PAPER in One-Way Net Mode');
    assert.strictEqual(mockPair.sellPosition.apiStatus, 'PAPER_HEDGE_SIMULATED', 'Opposing leg apiStatus must be PAPER_HEDGE_SIMULATED');

    solanaEngine.settings.tradingMode = 'PAPER';
    solanaEngine.settings.realOrdersDisabled = true;
  });

  // Test 2: Repeated ticks at the same price
  await test('2. Price Cooldown: Repeated ticks at same price level are locked and rejected', async () => {
    solanaEngine.isEngineRunning = true;
    solanaEngine.settings.autoAddNewPairs = true;
    solanaEngine.settings.gridSpacing = 0.50;
    solanaEngine.settings.priceCooldownMinutes = 30;

    const testPrice = 105.00;
    const initialPairsCount = solanaEngine.pairs.length;

    // First tick creates pair and sets lock
    solanaEngine.evaluateRateForNewPair(testPrice);
    const countAfterFirst = solanaEngine.pairs.length;

    // Second tick at exact same price
    solanaEngine.evaluateRateForNewPair(testPrice);
    assert.strictEqual(solanaEngine.pairs.length, countAfterFirst, 'Second tick at same price must be blocked');

    // Third tick within grid spacing ($0.04 away)
    solanaEngine.evaluateRateForNewPair(105.04);
    assert.strictEqual(solanaEngine.pairs.length, countAfterFirst, 'Tick within grid cooldown must be blocked');

    solanaEngine.isEngineRunning = false;
    solanaEngine.settings.autoAddNewPairs = false;
  });

  // Test 3: Duplicate scheduler / concurrent entry requests
  await test('3. Concurrency Mutex: Concurrent dispatch requests are serialized and de-duplicated', async () => {
    mudrexLive.isRealExecutionEnabled = () => true;
    let callCount = 0;
    
    mudrexLive.request = async (method, url, body) => {
      callCount++;
      await new Promise(r => setTimeout(r, 50));
      return { success: true, data: { order_id: 'MUDREX-ORDER-MUTEX-TEST' } };
    };

    const intentId = `TEST-MUTEX-INTENT-${Date.now()}`;
    const orderPayload = {
      symbol: 'SOLUSDT',
      side: 'BUY',
      quantity: 1.0,
      leverage: 5,
      intentId
    };

    const [res1, res2, res3] = await Promise.all([
      mudrexLive.createRealOrder({ ...orderPayload }),
      mudrexLive.createRealOrder({ ...orderPayload }),
      mudrexLive.createRealOrder({ ...orderPayload })
    ]);

    mudrexLive.request = origRequest;
    mudrexLive.isRealExecutionEnabled = origIsEnabled;

    assert.strictEqual(callCount, 1, `Expected exactly 1 exchange call, got ${callCount}`);
    assert.strictEqual(res1.success, true);
    assert.strictEqual(res2.isExistingIntent, true, 'Second call must return existing intent without resubmission');
    assert.strictEqual(res3.isExistingIntent, true, 'Third call must return existing intent without resubmission');
  });

  // Test 4: API timeout after an order may have reached the exchange
  await test('4. Timeout Recovery: Check exchange before retry; never blindly resubmit on timeout', async () => {
    mudrexLive.isRealExecutionEnabled = () => true;
    let orderQueriedOnExchange = false;

    mudrexLive.request = async () => {
      return { success: false, error: 'Gateway Timeout (504)' };
    };

    mudrexLive.verifyOrderOnExchange = async () => {
      orderQueriedOnExchange = true;
      return { found: true, status: 'FILLED', orderId: 'RECONCILED-MUDREX-123', filledQty: 1.0 };
    };

    const intentId = `TEST-TIMEOUT-${Date.now()}`;
    const res = await mudrexLive.createRealOrder({
      symbol: 'SOLUSDT',
      side: 'BUY',
      quantity: 1.0,
      leverage: 5,
      intentId
    });

    mudrexLive.request = origRequest;
    mudrexLive.verifyOrderOnExchange = origVerify;
    mudrexLive.isRealExecutionEnabled = origIsEnabled;

    assert.strictEqual(orderQueriedOnExchange, true, 'Engine must query exchange to verify status on timeout');
    assert.strictEqual(res.success, true, 'Order resolved successfully via exchange reconciliation');
    assert.strictEqual(res.reconciledFromExchange, true, 'Result flagged as reconciled from exchange');
  });

  // Test 5: HTTP 429 and retry recovery
  await test('5. HTTP 429 Rate Limit: Enforce backoff cooldown and trip circuit breaker on repeated 429', async () => {
    mudrexLive.isRealExecutionEnabled = () => true;
    
    mudrexLive.request = async () => {
      return { success: false, error: 'HTTP 429 Too Many Requests (code 5002)' };
    };

    const intentId = `TEST-429-${Date.now()}`;
    const res = await mudrexLive.createRealOrder({
      symbol: 'SOLUSDT',
      side: 'BUY',
      quantity: 1.0,
      leverage: 5,
      intentId
    });

    mudrexLive.request = origRequest;
    mudrexLive.isRealExecutionEnabled = origIsEnabled;

    assert.strictEqual(res.success, false, '429 must return false');
    assert.strictEqual(res.rateLimited, true, 'Response must be flagged rateLimited');
    assert.ok(mudrexLive.rateLimitUntil > Date.now(), 'rateLimitUntil cooldown must be set in the future');
  });

  // Test 6: Partial fills and residual positions
  await test('6. Partial Fills: Split filled portion and keep residual quantity open', async () => {
    const pos = {
      pairId: 'TEST-PARTIAL-UNIQUE-01',
      positionId: 'P-PARTIAL-U01',
      direction: 'BUY',
      symbol: 'SOLUSDT',
      entryPrice: 100.00,
      quantity: 2.0,
      status: 'OPEN'
    };

    const testPair = {
      pairId: 'TEST-PARTIAL-UNIQUE-01',
      buyPosition: pos,
      sellPosition: null,
      status: 'OPEN'
    };
    solanaEngine.pairs.push(testPair);

    // Partial fill: 1.2 SOL filled out of 2.0 SOL total
    const filledQty = 1.2;
    const exitPrice = 101.00;
    const result = solanaEngine.closePositionLeg(pos, exitPrice, Date.now(), 'PARTIAL TARGET HIT', 102.00, 0.00075, 0.18, filledQty);

    assert.strictEqual(pos.quantity, 1.2, 'Closed position quantity must equal filledQty');
    assert.strictEqual(pos.isPartial, true, 'Position must be flagged isPartial');

    // Check returned residual
    assert.ok(result.residualPosition, 'Residual position must be returned');
    assert.strictEqual(result.residualPosition.status, 'OPEN', 'Residual position must remain OPEN');
    assert.strictEqual(result.residualPosition.quantity, 0.8, 'Residual quantity must equal 0.8 SOL (2.0 - 1.2)');
    assert.strictEqual(result.residualPosition.isResidual, true, 'Residual flag must be true');

    // Verify parent pair updated
    assert.strictEqual(testPair.buyPosition.quantity, 0.8, 'Parent pair buyPosition must hold residual');

    solanaEngine.pairs = solanaEngine.pairs.filter(p => p.pairId !== 'TEST-PARTIAL-UNIQUE-01');
  });

  // Test 7: Process restart and database recovery
  await test('7. Restart & DB Recovery: Order intents and real Mudrex positions survive restart', async () => {
    const testIntentId = `TEST-RECOVERY-${Date.now()}`;
    db.saveOrderIntent({
      intentId: testIntentId,
      symbol: 'SOLUSDT',
      side: 'BUY',
      quantity: 1.0,
      targetPrice: 106.00,
      status: 'FILLED',
      mudrexOrderId: 'MUDREX-RECOVERED-999',
      filledQty: 1.0
    });

    const recovered = db.getOrderIntent(testIntentId);
    assert.ok(recovered, 'Order intent must be recovered from database');
    assert.strictEqual(recovered.mudrexOrderId, 'MUDREX-RECOVERED-999');
    assert.strictEqual(recovered.status, 'FILLED');

    // Verify real Mudrex position preservation during reset
    solanaEngine.pairs.push({
      pairId: 'REAL-PAIR-999',
      buyPosition: { mudrexOrderId: 'MUDREX-REAL-999', apiStatus: 'REAL_MUDREX_POSITION', status: 'OPEN' },
      status: 'OPEN'
    });

    solanaEngine.resetData(1.0, 186682.39, 0.45);

    const realStillExists = solanaEngine.pairs.some(p => p.buyPosition && p.buyPosition.mudrexOrderId === 'MUDREX-REAL-999');
    assert.strictEqual(realStillExists, true, 'Real Mudrex position MUST NOT be wiped on reset');

    solanaEngine.pairs = solanaEngine.pairs.filter(p => p.pairId !== 'REAL-PAIR-999');
  });

  // Test 8: Duplicate exchange events and fee records
  await test('8. Duplicate Prevention: Duplicate order intents are rejected idempotently', async () => {
    mudrexLive.isRealExecutionEnabled = () => true;
    mudrexLive.circuitBreakers.isCircuitBreakerTripped = false;
    mudrexLive.circuitBreakers.tripReason = '';
    mudrexLive.rateLimitUntil = 0;

    const intentId = `TEST-DUP-INTENT-${Date.now()}`;
    db.saveOrderIntent({
      intentId,
      symbol: 'SOLUSDT',
      side: 'BUY',
      quantity: 1.0,
      status: 'FILLED',
      mudrexOrderId: 'MUDREX-ORDER-DUP-01',
      filledQty: 1.0
    });

    let apiCalled = false;
    mudrexLive.request = async () => { apiCalled = true; return { success: true }; };

    const res = await mudrexLive.createRealOrder({
      symbol: 'SOLUSDT',
      side: 'BUY',
      quantity: 1.0,
      intentId
    });

    mudrexLive.request = origRequest;
    mudrexLive.isRealExecutionEnabled = origIsEnabled;

    assert.strictEqual(apiCalled, false, 'Must not call exchange for already filled intent');
    assert.strictEqual(res.isExistingIntent, true);
  });

  // Test 9: Exit target, stop-loss and reduce-only behavior
  await test('9. Flat-Position Exit Shield: Refuse exit order when exchange is already flat (0)', async () => {
    mudrexLive.isRealExecutionEnabled = () => true;
    let exitDispatched = false;

    mudrexLive.queryRealPositions = async () => [
      { symbol: 'SOLUSDT', quantity: 0, size: 0 }
    ];

    mudrexLive.request = async (method, url, data) => {
      if (method === 'POST') exitDispatched = true;
      return { success: true, data: [] };
    };

    const mockPos = {
      positionId: 'POS-EXIT-TEST',
      symbol: 'SOLUSDT',
      direction: 'BUY',
      quantity: 1.0,
      mudrexOrderId: 'MUDREX-OLD-123'
    };

    const res = await mudrexLive.executeRealExit(null, mockPos, 106.00, Date.now(), 102.00, 'TEST_EXIT');

    mudrexLive.queryRealPositions = origQueryPositions;
    mudrexLive.request = origRequest;
    mudrexLive.isRealExecutionEnabled = origIsEnabled;

    assert.strictEqual(exitDispatched, false, 'Must not dispatch exit order when exchange is already flat');
    assert.strictEqual(res.skipped, true, 'Exit must be skipped safely');
  });

  // Test 10: Fee budget and maximum-order circuit breakers
  await test('10. Circuit Breakers: Daily fee budget & order count limits trip and halt trading', async () => {
    mudrexLive.circuitBreakers.dailyFeesSpentINR = 1200; // Over ₹1,000 budget
    mudrexLive.circuitBreakers.dailyOrdersCount = 10;
    mudrexLive.circuitBreakers.isCircuitBreakerTripped = false;

    let cb = mudrexLive.checkCircuitBreakers();
    assert.strictEqual(cb.allowed, false, 'Circuit breaker must trip when fee budget exceeded');
    assert.ok(cb.reason.includes('DAILY_FEE_BUDGET_EXCEEDED'), 'Trip reason must cite fee budget');

    // Reset fee, test max orders breach
    mudrexLive.circuitBreakers.dailyFeesSpentINR = 200;
    mudrexLive.circuitBreakers.dailyOrdersCount = 55; // Over 50 orders limit
    mudrexLive.circuitBreakers.isCircuitBreakerTripped = false;

    cb = mudrexLive.checkCircuitBreakers();
    assert.strictEqual(cb.allowed, false, 'Circuit breaker must trip when max daily orders exceeded');
    assert.ok(cb.reason.includes('ORDER_LIMIT_EXCEEDED'), 'Trip reason must cite daily orders cap');

    mudrexLive.circuitBreakers.dailyFeesSpentINR = 0;
    mudrexLive.circuitBreakers.dailyOrdersCount = 0;
    mudrexLive.circuitBreakers.isCircuitBreakerTripped = false;
    mudrexLive.circuitBreakers.tripReason = '';
  });

  console.log('\n================================================================');
  console.log(`   TEST RESULTS: ${passed} PASSED, ${failed} FAILED (TOTAL ${passed + failed})`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAuditSafeguardsTestSuite().catch(err => {
  console.error('Test Suite Fatal Error:', err);
  process.exit(1);
});
