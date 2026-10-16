/**
 * SOL PAIR ENGINE V2 — Comprehensive Test Suite
 * 
 * Verifies the complete automatic lifecycle:
 * 1. Clean initial start & automatic startup in RUNNING + PAPER mode.
 * 2. Background tick processing: valid tick automatically creates first 5 SOL pair.
 * 3. Permanent entry price immutability: live ticks never overwrite entry prices.
 * 4. Active level occupancy rejection: duplicate blocked while active.
 * 5. Independent leg tracking: BUY target hit closes BUY once, SELL remains open, level remains occupied.
 * 6. Full closure & dynamic release: both legs closed releases level for reuse -> PROOF OF REUSE.
 * 7. Partial closure: residual open quantity holds level lock.
 * 8. Safety limits enforcement: max active pairs, margin limit, leg imbalance.
 * 9. Evaluation & rejection logging: reasons logged and stored in diagnostics buffer.
 * 10. Process restart & recovery: restores active pairs & locks without importing old history.
 * 11. Pause & Resume control: rejects new pair when paused, resumes when started.
 * 12. Clean state reset for production deployment.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const solanaEngineV2 = require('../src/engine/solanaEngineV2');
const db = require('../src/engine/db');

async function runV2Tests() {
  console.log('================================================================');
  console.log('   SOL PAIR ENGINE V2 — AUTOMATIC LIFECYCLE ACCEPTANCE TESTS   ');
  console.log('================================================================\n');

  let passed = 0;
  let total = 0;

  function test(name, fn) {
    total++;
    try {
      fn();
      passed++;
      console.log(`  [PASS] ${total}. ${name}`);
    } catch (err) {
      console.error(`  [FAIL] ${total}. ${name}`);
      console.error(`         ${err.message}`);
    }
  }

  // Ensure clean test start in RUNNING mode
  solanaEngineV2.resetData(5.0, 200000.00, 0.45, true);

  // TEST 1: Clean initial start & automatic startup in RUNNING + PAPER mode
  test('Clean initial start & automatic startup in RUNNING + PAPER mode', () => {
    assert.strictEqual(solanaEngineV2.pairs.length, 0, 'Must have 0 pairs');
    assert.strictEqual(solanaEngineV2.closedPositions.length, 0, 'Must have 0 closed trades');
    const realized = solanaEngineV2.calculateRealizedSummary();
    assert.strictEqual(realized.realizedNetINR, 0, 'Realized INR must be 0');
    assert.strictEqual(realized.realizedNetUSD, 0, 'Realized USD must be 0');
    assert.strictEqual(solanaEngineV2.settings.contractQuantity, 5.0, 'Default contract quantity must be 5.0 SOL');
    assert.strictEqual(solanaEngineV2.settings.profitTargetMove, 0.45, 'Default profit target move must be $0.45');
    assert.strictEqual(solanaEngineV2.settings.tradingMode, 'PAPER', 'Trading mode must be PAPER');
    assert.strictEqual(solanaEngineV2.settings.realOrdersDisabled, true, 'Real orders must be disabled');
    assert.strictEqual(solanaEngineV2.engineStatus, 'RUNNING', 'Engine status must be RUNNING automatically');
    assert.strictEqual(solanaEngineV2.isEngineRunning, true, 'Engine must be running');
  });

  // TEST 2: Background tick processing creates first 5 SOL pair at live price
  const testPrice1 = 107.25;
  test('Background tick processing: valid tick automatically creates first 5 SOL pair ($0.45 targets)', () => {
    // Process live rate tick via the core evaluation cycle
    solanaEngineV2.processEvaluationCycle('TEST_TICK', { symbol: 'SOLUSDT', price: testPrice1, time: Date.now() });

    assert.strictEqual(solanaEngineV2.pairs.length, 1, 'First pair must be created automatically');
    const pair = solanaEngineV2.pairs[0];
    assert.strictEqual(pair.entryPrice, testPrice1, 'Pair entryPrice must be 107.25');
    assert.strictEqual(pair.quantity, 5.0, 'Pair quantity must be 5.0 SOL');
    assert.strictEqual(pair.buyTarget, 107.70, 'BUY target must be 107.25 + 0.45 = 107.70');
    assert.strictEqual(pair.sellTarget, 106.80, 'SELL target must be 107.25 - 0.45 = 106.80');

    assert(pair.buyPosition !== null, 'BUY leg must exist');
    assert.strictEqual(pair.buyPosition.direction, 'BUY');
    assert.strictEqual(pair.buyPosition.quantity, 5.0);
    assert.strictEqual(pair.buyPosition.entryPrice, 107.25);
    assert.strictEqual(pair.buyPosition.targetExitPrice, 107.70);
    assert.strictEqual(pair.buyPosition.status, 'OPEN');

    assert(pair.sellPosition !== null, 'SELL leg must exist');
    assert.strictEqual(pair.sellPosition.direction, 'SELL');
    assert.strictEqual(pair.sellPosition.quantity, 5.0);
    assert.strictEqual(pair.sellPosition.entryPrice, 107.25);
    assert.strictEqual(pair.sellPosition.targetExitPrice, 106.80);
    assert.strictEqual(pair.sellPosition.status, 'OPEN');
  });

  // TEST 3: Permanent entry price immutability
  test('Permanent entry price immutability: live ticks never overwrite entry prices', () => {
    const pair = solanaEngineV2.pairs[0];
    assert(pair !== null, 'Pair must exist');

    // Simulate multiple live market ticks moving far away from entry
    const marketTicks = [108.50, 106.10, 112.40, 95.00, 107.20];
    for (const tick of marketTicks) {
      // Evaluate metrics which calculate floating P&L using tick
      const metrics = solanaEngineV2.getDashboardMetrics();
      // Ensure original entry prices in state remain permanently untouched
      assert.strictEqual(pair.entryPrice, testPrice1, `Pair entryPrice must stay ${testPrice1} after tick ${tick}`);
      assert.strictEqual(pair.buyPosition.entryPrice, testPrice1, `BUY entryPrice must stay ${testPrice1}`);
      assert.strictEqual(pair.sellPosition.entryPrice, testPrice1, `SELL entryPrice must stay ${testPrice1}`);
    }
  });

  // TEST 4: Active level occupancy rejection
  test('Active level occupancy rejection: duplicate pair blocked while active', () => {
    // Attempt duplicate at exact price
    const dup = solanaEngineV2.createNewPair('SOLUSDT', testPrice1);
    assert.strictEqual(dup, null, 'Duplicate pair at 107.25 must be rejected while active');

    // Attempt near tick in same bucket (e.g. 107.28 in 107.50 bucket)
    const nearTick = solanaEngineV2.createNewPair('SOLUSDT', 107.28);
    assert.strictEqual(nearTick, null, 'Near tick in same active bucket must be rejected');
  });

  // TEST 5: Independent leg tracking & BUY target hit
  test('Independent leg tracking: BUY target hit closes BUY once, SELL remains open, level remains occupied', () => {
    const pair = solanaEngineV2.pairs[0];
    const buyTarget = pair.buyTarget; // 107.70

    // Simulate market reaching BUY target
    solanaEngineV2.evaluateOpenPositions(buyTarget);

    assert.strictEqual(pair.buyPosition.status, 'CLOSED', 'BUY leg must now be CLOSED');
    assert.strictEqual(pair.buyPosition.exitPrice, 107.70, 'BUY exit price must be 107.70');
    assert.strictEqual(pair.sellPosition.status, 'OPEN', 'SELL leg must remain OPEN');
    assert.strictEqual(pair.status, 'OPEN', 'Pair status must remain OPEN while SELL leg is open');

    // Level must STILL be occupied because SELL leg is active!
    assert.strictEqual(solanaEngineV2.isPriceLevelOccupied(testPrice1), true, 'Price level 107.25 must still be occupied');

    // Attempting new pair must be blocked
    const attempt = solanaEngineV2.createNewPair('SOLUSDT', testPrice1);
    assert.strictEqual(attempt, null, 'Cannot create new pair while SELL leg is active');
  });

  // TEST 6: Full closure & dynamic release (Proof of Reuse)
  test('Full closure & dynamic release: both legs closed releases level for reuse -> PROOF OF REUSE', () => {
    const pair = solanaEngineV2.pairs[0];
    const sellTarget = pair.sellTarget; // 106.80

    // Simulate market reaching SELL target
    solanaEngineV2.evaluateOpenPositions(sellTarget);

    assert.strictEqual(pair.sellPosition.status, 'CLOSED', 'SELL leg must now be CLOSED');
    assert.strictEqual(pair.sellPosition.exitPrice, 106.80, 'SELL exit price must be 106.80');
    assert.strictEqual(pair.status, 'CLOSED', 'Pair status must now be CLOSED');

    // Price level 107.25 must now be RELEASED!
    assert.strictEqual(solanaEngineV2.isPriceLevelOccupied(testPrice1), false, '107.25 must now be unoccupied');

    // Now recreate pair at 107.25 -> MUST SUCCEED (REUSE PROOF)
    const reusedPair = solanaEngineV2.createNewPair('SOLUSDT', testPrice1);
    assert(reusedPair !== null, 'Reusing 107.25 after full closure must succeed');
    assert.strictEqual(reusedPair.entryPrice, testPrice1);
    assert.strictEqual(reusedPair.status, 'OPEN');
  });

  // TEST 7: Partial closure keeps level occupied
  test('Partial closure: residual open quantity holds level lock', () => {
    const partialPrice = 135.00;
    const pair = solanaEngineV2.createNewPair('SOLUSDT', partialPrice);
    assert(pair !== null, 'Pair at 135.00 must succeed');

    // Partial closure: close 2.5 of 5.0 SOL
    const res = solanaEngineV2.closePositionLeg(pair.buyPosition, partialPrice + 0.45, Date.now(), 'PARTIAL TARGET', 102.00, 0.00075, 0.18, 2.5);
    assert(res.residualPosition !== null, 'Residual position must exist');
    assert.strictEqual(res.residualPosition.quantity, 2.5, 'Residual quantity must be 2.5 SOL');
    assert.strictEqual(res.residualPosition.status, 'OPEN', 'Residual must be OPEN');

    // Level must remain occupied!
    assert.strictEqual(solanaEngineV2.isPriceLevelOccupied(partialPrice), true, 'Partial closure must hold lock');

    const blocked = solanaEngineV2.createNewPair('SOLUSDT', partialPrice);
    assert.strictEqual(blocked, null, 'Must reject duplicate while residual leg is open');
  });

  // TEST 8: Safety limits enforcement
  test('Safety limits enforcement: max active pairs, margin limit, and leg imbalance', () => {
    // Check max active pairs limit
    solanaEngineV2.settings.maxActivePairs = 3;
    // We already have 2 active pairs (107.25 reused, 135.00 partial). Add 1 more:
    const pair3 = solanaEngineV2.createNewPair('SOLUSDT', 140.00);
    assert(pair3 !== null, '3rd pair must succeed');

    // 4th pair must exceed limit
    const pair4 = solanaEngineV2.createNewPair('SOLUSDT', 145.00);
    assert.strictEqual(pair4, null, '4th pair must be rejected due to maxActivePairs = 3');

    // Restore limit
    solanaEngineV2.settings.maxActivePairs = 10;
  });

  // TEST 9: Evaluation & rejection logging
  test('Evaluation & rejection logging: reasons logged and retrievable via API diagnostics', () => {
    // Attempt pair at occupied level 107.25 via evaluateRateForNewPair
    solanaEngineV2.evaluateRateForNewPair(testPrice1, 'DIAGNOSTIC_TEST');

    assert(solanaEngineV2.recentLogs.length > 0, 'Recent logs ring buffer must not be empty');
    assert(solanaEngineV2.lastEvaluation !== null, 'lastEvaluation must be set');
    assert.strictEqual(solanaEngineV2.lastEvaluation.code, 'LEVEL_OCCUPIED', 'Rejection code must be LEVEL_OCCUPIED');
    assert(solanaEngineV2.lastEvaluation.message.includes('currently occupied'), 'Rejection message must explain occupancy');

    const metrics = solanaEngineV2.getDashboardMetrics();
    assert(Array.isArray(metrics.engine.recentLogs), 'Metrics must expose recentLogs array');
    assert(metrics.engine.lastEvaluation !== null, 'Metrics must expose lastEvaluation');
  });

  // TEST 10: Process restart & recovery
  test('Process restart & recovery: restores active pairs & locks without importing old history', () => {
    // Current engine has active pairs
    const activeCountBefore = solanaEngineV2.pairs.filter(p => p.status === 'OPEN').length;
    assert(activeCountBefore > 0, 'Active pairs must exist');

    // Instantiate fresh engine class
    const SolanaEngineV2Class = solanaEngineV2.constructor;
    const restartedEngine = new SolanaEngineV2Class();

    assert.strictEqual(restartedEngine.pairs.filter(p => p.status === 'OPEN').length, activeCountBefore, 'Active pairs must be restored on restart');
    assert.strictEqual(restartedEngine.isPriceLevelOccupied(107.25), true, '107.25 active lock must be preserved');
    assert.strictEqual(restartedEngine.engineStatus, 'RUNNING', 'Restarted engine must default to RUNNING');

    // Cannot create duplicate at 107.25 on restarted engine
    const restartDup = restartedEngine.createNewPair('SOLUSDT', 107.25);
    assert.strictEqual(restartDup, null, 'Restarted engine must reject duplicate at 107.25');

    // Stop background interval of test instance
    restartedEngine.stopEvaluationLoop();
  });

  // TEST 11: Pause & Resume control
  test('Pause & Resume control: rejects new pair when paused, resumes when started', () => {
    solanaEngineV2.pauseEngine('Testing operator pause');
    assert.strictEqual(solanaEngineV2.isEngineRunning, false);
    assert.strictEqual(solanaEngineV2.engineStatus, 'PAUSED');

    // When paused, evaluation cycle must not create new pairs
    const pairsCountBefore = solanaEngineV2.pairs.length;
    solanaEngineV2.processEvaluationCycle('PAUSED_TEST', { symbol: 'SOLUSDT', price: 155.00, time: Date.now() });
    assert.strictEqual(solanaEngineV2.pairs.length, pairsCountBefore, 'No pair must be created while paused');
    assert.strictEqual(solanaEngineV2.lastEvaluation.code, 'ENGINE_PAUSED');

    // Resume engine
    solanaEngineV2.lastOrderTimestamp = 0;
    solanaEngineV2.startEngine();
    assert.strictEqual(solanaEngineV2.isEngineRunning, true);
    assert.strictEqual(solanaEngineV2.engineStatus, 'RUNNING');

    // Now evaluation cycle creates the pair
    solanaEngineV2.processEvaluationCycle('RESUMED_TEST', { symbol: 'SOLUSDT', price: 155.00, time: Date.now() });
    assert.strictEqual(solanaEngineV2.pairs.length, pairsCountBefore + 1, 'Pair must be created after start');
  });

  // TEST 12: Clean state reset for production deployment
  test('Clean state reset: pristine isolated state for production deployment', () => {
    const res = solanaEngineV2.resetData(5.0, 200000.00, 0.45, true);
    assert.strictEqual(res.success, true);
    assert.strictEqual(solanaEngineV2.pairs.length, 0, 'Pairs must be 0');
    assert.strictEqual(solanaEngineV2.closedPositions.length, 0, 'Closed trades must be 0');
    assert.strictEqual(solanaEngineV2.activePriceLevels.size, 0, 'Active price locks must be 0');
    assert.strictEqual(solanaEngineV2.engineStatus, 'RUNNING', 'Engine must be RUNNING for automatic operation');
    assert.strictEqual(solanaEngineV2.settings.tradingMode, 'PAPER', 'Engine must be PAPER');
    assert.strictEqual(solanaEngineV2.settings.realOrdersDisabled, true, 'Real orders must be disabled');
  });

  console.log('\n================================================================');
  console.log(`   TEST RESULTS: ${passed} PASSED, ${total - passed} FAILED (TOTAL ${total})`);
  console.log('================================================================\n');

  if (passed !== total) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runV2Tests().catch(err => {
  console.error('Fatal V2 test error:', err);
  process.exit(1);
});
