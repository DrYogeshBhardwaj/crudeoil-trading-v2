/**
 * SUBH-MANI SOLANA PAIR ENGINE: ACTIVE PRICE-LEVEL UNIQUENESS TEST SUITE
 * 
 * Verifies active-price-level uniqueness rules:
 * 1. Same price + active BUY/SELL exists → reject duplicate pair.
 * 2. Same price + one leg remains active → reject duplicate pair.
 * 3. Same price + both legs fully closed → allow a new pair (PROOF OF REUSE!).
 * 4. Different unused price + no active conflict → allow a new pair.
 * 5. Repeated ticks or concurrent requests → only one pair created atomically.
 * 6. Restart preserves active locks from actual active positions.
 * 7. Fully closed historical prices do NOT remain permanently blocked.
 * 8. Partial closure does not release the level while residual quantity is open.
 * 9. Pair size remains 5 SOL and exit target remains $0.45.
 * 10. Active target reservation prevents entering new pair directly on an active target.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const solanaEngine = require('../src/engine/solanaEngine');
const db = require('../src/engine/db');

async function runTests() {
  console.log('================================================================');
  console.log('   SUBH-MANI SOLANA ENGINE — ACTIVE PRICE-LEVEL UNIQUENESS TESTS');
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

  async function testAsync(name, fn) {
    total++;
    try {
      await fn();
      passed++;
      console.log(`  [PASS] ${total}. ${name}`);
    } catch (err) {
      console.error(`  [FAIL] ${total}. ${name}`);
      console.error(`         ${err.message}`);
    }
  }


  // Ensure safe mode & clean test environment
  solanaEngine.isEngineRunning = false;
  solanaEngine.settings.tradingMode = 'PAPER';
  solanaEngine.settings.realOrdersDisabled = true;
  solanaEngine.settings.contractQuantity = 5.0;
  solanaEngine.settings.profitTargetMove = 0.45;
  solanaEngine.settings.priceBucketSize = 0.50;

  // Clean paper pairs for test run
  solanaEngine.pairs = [];
  solanaEngine.syncActivePriceLevels();

  const testPrice1 = 107.25;

  // TEST 1: Same price + active BUY/SELL exists → reject duplicate pair
  test('Same price + active BUY/SELL exists → reject duplicate pair', () => {
    // 1. First creation at 107.25 must succeed
    const pair1 = solanaEngine.createNewPair('SOLUSDT', testPrice1);
    assert(pair1 !== null, 'First pair at 107.25 must succeed');
    assert.strictEqual(pair1.buyPosition.status, 'OPEN');
    assert.strictEqual(pair1.sellPosition.status, 'OPEN');

    // 2. Exact same price must be rejected
    const pairDup = solanaEngine.createNewPair('SOLUSDT', testPrice1);
    assert.strictEqual(pairDup, null, 'Duplicate pair at 107.25 must be rejected while active');

    // 3. Near-tick in same 0.50 bucket (e.g. 107.27) must be rejected
    const pairNear = solanaEngine.createNewPair('SOLUSDT', 107.27);
    assert.strictEqual(pairNear, null, 'Tick in same active bucket must be rejected');
  });

  // TEST 2: Same price + one leg remains active → reject duplicate pair
  test('Same price + one leg remains active → reject duplicate pair', () => {
    const pair = solanaEngine.pairs.find(p => p.entryPrice === testPrice1);
    assert(pair !== null, 'Active pair must exist');

    // Simulate BUY leg target hit and closure ($107.70)
    solanaEngine.closePositionLeg(pair.buyPosition, pair.buyTarget, Date.now(), 'BUY TARGET HIT');
    assert.strictEqual(pair.buyPosition.status, 'CLOSED', 'BUY leg must be closed');
    assert.strictEqual(pair.sellPosition.status, 'OPEN', 'SELL leg must remain open');

    // Level must remain occupied because SELL leg is active
    const isOccupied = solanaEngine.isPriceLevelOccupied(testPrice1);
    assert.strictEqual(isOccupied, true, 'Price 107.25 must remain occupied while one leg is active');

    const reEntryAttempt = solanaEngine.createNewPair('SOLUSDT', testPrice1);
    assert.strictEqual(reEntryAttempt, null, 'Re-entry at 107.25 must be rejected while one leg remains active');
  });

  // TEST 3: Same price + both legs fully closed → allow a new pair (PROOF OF REUSE!)
  test('Same price + both legs fully closed → allow a new pair (REUSE PROOF)', () => {
    const pair = solanaEngine.pairs.find(p => p.entryPrice === testPrice1);
    assert(pair !== null, 'Pair must exist');

    // Now close the SELL leg ($106.80)
    solanaEngine.closePositionLeg(pair.sellPosition, pair.sellTarget, Date.now(), 'SELL TARGET HIT');
    assert.strictEqual(pair.sellPosition.status, 'CLOSED', 'SELL leg must be closed');
    assert.strictEqual(pair.status, 'CLOSED', 'Pair status must be CLOSED');

    // Price level MUST BE RELEASED!
    const isOccupied = solanaEngine.isPriceLevelOccupied(testPrice1);
    assert.strictEqual(isOccupied, false, 'Price 107.25 MUST be released and free for reuse after both legs close');

    const inDb = db.isActivePriceOccupied('SOLUSDT', testPrice1);
    assert.strictEqual(inDb, false, 'Database active reservation MUST be released');

    // Re-creating a pair at 107.25 MUST NOW SUCCEED!
    const freshPair = solanaEngine.createNewPair('SOLUSDT', testPrice1);
    assert(freshPair !== null, 'Creating a new pair at fully closed rate 107.25 MUST SUCCEED!');
    assert.strictEqual(freshPair.status, 'OPEN');
    assert.strictEqual(freshPair.buyPosition.status, 'OPEN');
    assert.strictEqual(freshPair.sellPosition.status, 'OPEN');
  });

  // TEST 4: Different unused price + no active conflict → allow a new pair
  test('Different unused price + no active conflict → allow a new pair', () => {
    const freshPrice = 115.00;
    assert.strictEqual(solanaEngine.isPriceLevelOccupied(freshPrice), false, '115.00 must be unoccupied');

    const pair = solanaEngine.createNewPair('SOLUSDT', freshPrice);
    assert(pair !== null, 'Pair creation at 115.00 must succeed');
    assert.strictEqual(solanaEngine.isPriceLevelOccupied(freshPrice), true, '115.00 must now be occupied');
  });

  // TEST 5: Repeated ticks or concurrent requests → only one pair
  await testAsync('Repeated ticks or concurrent requests → only one pair', async () => {
    const concurrentPrice = 120.00;
    
    // Dispatch 10 concurrent requests at the exact same price
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(Promise.resolve().then(() => solanaEngine.createNewPair('SOLUSDT', concurrentPrice)));
    }

    const results = await Promise.all(promises);
    const successfulPairs = results.filter(p => p !== null);
    const rejectedPairs = results.filter(p => p === null);

    assert.strictEqual(successfulPairs.length, 1, 'Exactly ONE concurrent pair creation must succeed');
    assert.strictEqual(rejectedPairs.length, 9, 'All 9 concurrent duplicate attempts must be rejected');
  });

  // TEST 6: Restart preserves active locks from actual active positions
  test('Restart preserves active locks from actual active positions', () => {
    // Pair at 115.00 and 120.00 are active
    const SolanaEngineClass = solanaEngine.constructor;
    const freshEngine = new SolanaEngineClass();

    assert.strictEqual(freshEngine.isPriceLevelOccupied(115.00), true, 'Restarted engine must recognize 115.00 is active');
    assert.strictEqual(freshEngine.isPriceLevelOccupied(120.00), true, 'Restarted engine must recognize 120.00 is active');

    const restartDup = freshEngine.createNewPair('SOLUSDT', 115.00);
    assert.strictEqual(restartDup, null, 'Restarted engine must reject duplicate pair at active 115.00');
  });

  // TEST 7: Fully closed historical prices do NOT remain permanently blocked
  test('Fully closed historical prices do not remain permanently blocked', () => {
    const historicalPrice = 130.00;
    // Add a closed position in history
    solanaEngine.closedPositions.push({
      positionId: 'HISTORICAL-POS-001',
      pairId: 'HISTORICAL-PAIR-001',
      entryPrice: historicalPrice,
      exitPrice: historicalPrice + 0.45,
      status: 'CLOSED',
      netProfitINR: 18.50
    });

    // Check that historical closed position does NOT block the price level
    const isOccupied = solanaEngine.isPriceLevelOccupied(historicalPrice);
    assert.strictEqual(isOccupied, false, 'Historical closed trade must NOT block 130.00');

    const freshPair = solanaEngine.createNewPair('SOLUSDT', historicalPrice);
    assert(freshPair !== null, 'Creating pair at previously closed historical price must succeed');
  });

  // TEST 8: Partial closure does not release the level
  test('Partial closure does not release the level', () => {
    const partialPrice = 140.00;
    const pair = solanaEngine.createNewPair('SOLUSDT', partialPrice);
    assert(pair !== null, 'Pair at 140.00 must succeed');

    // Partial closure: 2.5 SOL filled out of 5.0 SOL
    const res = solanaEngine.closePositionLeg(pair.buyPosition, partialPrice + 0.45, Date.now(), 'PARTIAL TARGET HIT', 102.00, 0.00075, 0.18, 2.5);
    assert(res.residualPosition !== null, 'Residual position must exist');
    assert.strictEqual(res.residualPosition.quantity, 2.5, 'Residual quantity must be 2.5 SOL');

    // Level must remain occupied!
    const isOccupied = solanaEngine.isPriceLevelOccupied(partialPrice);
    assert.strictEqual(isOccupied, true, 'Partial closure must NOT release the price level');

    const attempt = solanaEngine.createNewPair('SOLUSDT', partialPrice);
    assert.strictEqual(attempt, null, 'Duplicate pair must be rejected while residual leg is open');
  });

  // TEST 9: Pair size remains 5 SOL and exit target remains $0.45
  test('Pair size remains 5 SOL and exit target remains $0.45', () => {
    assert.strictEqual(solanaEngine.settings.contractQuantity, 5.0, 'Settings contractQuantity must be 5.0 SOL');
    assert.strictEqual(solanaEngine.settings.profitTargetMove, 0.45, 'Settings profitTargetMove must be $0.45');

    const testPrice = 150.00;
    const pair = solanaEngine.createNewPair('SOLUSDT', testPrice);
    assert(pair !== null, 'Pair creation at 150.00 must succeed');

    assert.strictEqual(pair.quantity, 5.0, 'Pair quantity must be 5.0 SOL');
    assert.strictEqual(pair.buyPosition.quantity, 5.0, 'BUY leg quantity must be 5.0 SOL');
    assert.strictEqual(pair.sellPosition.quantity, 5.0, 'SELL leg quantity must be 5.0 SOL');

    // Targets: $0.45 move
    assert.strictEqual(pair.buyTarget, 150.45, 'BUY target must be entry + $0.45');
    assert.strictEqual(pair.sellTarget, 149.55, 'SELL target must be entry - $0.45');
  });

  // TEST 10: Active target reservation shield
  test('Active target reservation shield prevents entering on active target', () => {
    const testPrice = 160.00;
    const pair = solanaEngine.createNewPair('SOLUSDT', testPrice);
    assert(pair !== null, 'Pair at 160.00 must succeed');
    const bTarget = pair.buyTarget; // 160.45

    const targetCheck = solanaEngine.isPriceReservedByActiveTarget(bTarget);
    assert.strictEqual(targetCheck.reserved, true, 'Active target price must be reserved');

    const targetEntryAttempt = solanaEngine.createNewPair('SOLUSDT', bTarget);
    assert.strictEqual(targetEntryAttempt, null, 'New pair cannot enter at active target price');
  });

  // Clean new-engine start: Reset temporary test state, leaving real positions intact
  solanaEngine.resetData(5.0, 186682.39, 0.45);

  console.log('\n================================================================');
  console.log(`   TEST RESULTS: ${passed} PASSED, ${total - passed} FAILED (TOTAL ${total})`);
  console.log('================================================================\n');

  if (passed !== total) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
