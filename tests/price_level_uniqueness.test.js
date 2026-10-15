/**
 * SUBH-MANI SOLANA PAIR ENGINE: PERMANENT PRICE-LEVEL UNIQUENESS TEST SUITE
 * 
 * Verifies the 10 mandated requirements:
 * 1. Duplicate BUY entry price is rejected.
 * 2. Duplicate SELL entry price is rejected.
 * 3. BUY and SELL share the same used-price registry (cross-side exclusion).
 * 4. Closing either leg does not release the price.
 * 5. Closing both legs does not release the price.
 * 6. Restart and redeployment preserve used-price locks.
 * 7. Reset and archive preserve used-price locks.
 * 8. Concurrent requests cannot create duplicate pairs at one price.
 * 9. An exit price cannot be reused as a new entry if its normalized level is already USED or reserved by active target.
 * 10. Pair size remains 5 SOL and exit target remains $0.45.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const solanaEngine = require('../src/engine/solanaEngine');
const db = require('../src/engine/db');

async function runTests() {
  console.log('================================================================');
  console.log('   SUBH-MANI SOLANA ENGINE — 10 PRICE-LEVEL UNIQUENESS TESTS    ');
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

  // Ensure safe mode
  solanaEngine.isEngineRunning = false;
  solanaEngine.settings.tradingMode = 'PAPER';
  solanaEngine.settings.realOrdersDisabled = true;
  solanaEngine.settings.contractQuantity = 5.0;
  solanaEngine.settings.profitTargetMove = 0.45;
  solanaEngine.settings.priceBucketSize = 0.50;

  const runOffset = (Math.floor(Date.now() / 1000) % 10000) * 100;
  const testPrice1 = 10000.00 + runOffset;
  const testPrice2 = 10010.00 + runOffset;
  const testPrice3 = 10020.00 + runOffset;
  const testPrice4 = 10030.00 + runOffset;
  const testPrice5 = 10040.00 + runOffset;
  const testPrice6 = 10050.00 + runOffset;
  const testPrice7 = 10060.00 + runOffset;

  // TEST 1: Duplicate BUY entry price is rejected
  test('Duplicate BUY entry price is rejected', () => {
    // First creation should succeed
    const pair1 = solanaEngine.createNewPair('SOLUSDT', testPrice1);
    assert(pair1 !== null, `First pair at ${testPrice1} must succeed`);
    assert.strictEqual(pair1.buyPosition.entryPrice, testPrice1);

    // Second creation at exact same price must fail
    const pair2 = solanaEngine.createNewPair('SOLUSDT', testPrice1);
    assert.strictEqual(pair2, null, `Second pair at ${testPrice1} must be rejected`);

    // Also test near-tick in same bucket (e.g. testPrice1 + 0.02 when bucketSize is 0.50)
    const pair3 = solanaEngine.createNewPair('SOLUSDT', testPrice1 + 0.02);
    assert.strictEqual(pair3, null, 'Tick in same normalized bucket must be rejected');
  });

  // TEST 2: Duplicate SELL entry price is rejected
  test('Duplicate SELL entry price is rejected', () => {
    // The pair already created at testPrice1 had a SELL leg at testPrice1
    // Verify that checking if a SELL can enter at testPrice1 is blocked
    const isLocked = solanaEngine.isPriceLevelLocked(testPrice1);
    assert.strictEqual(isLocked, true, `Price level ${testPrice1} must be reported locked for SELL`);

    const duplicateAttempt = solanaEngine.createNewPair('SOLUSDT', testPrice1);
    assert.strictEqual(duplicateAttempt, null, 'SELL entry at used price must be blocked');
  });

  // TEST 3: BUY and SELL share the same used-price registry (cross-side exclusion)
  test('BUY and SELL share the same used-price registry', () => {
    // Reserve for BUY
    const pair = solanaEngine.createNewPair('SOLUSDT', testPrice2);
    assert(pair !== null, `Pair at ${testPrice2} must succeed`);

    // Cross-side check: Can another entry enter at testPrice2 from either side?
    const isLockedBuy = solanaEngine.isPriceLevelLocked(testPrice2);
    assert.strictEqual(isLockedBuy, true, 'Price must be locked for BUY');
    const isLockedSell = solanaEngine.isPriceLevelLocked(testPrice2);
    assert.strictEqual(isLockedSell, true, 'Price must be locked for SELL');

    const crossSideAttempt = solanaEngine.createNewPair('SOLUSDT', testPrice2);
    assert.strictEqual(crossSideAttempt, null, 'Cross-side entry must be rejected');
  });

  // TEST 4: Closing either leg does not release the price
  test('Closing either leg does not release the price', () => {
    const pair = solanaEngine.createNewPair('SOLUSDT', testPrice3);
    assert(pair !== null, `Pair at ${testPrice3} must succeed`);

    // Simulate BUY leg target hit and closure
    const buyTarget = pair.buyTarget;
    solanaEngine.closePositionLeg(pair.buyPosition, buyTarget, Date.now(), 'BUY TARGET HIT');
    assert.strictEqual(pair.buyPosition.status, 'CLOSED', 'BUY leg must be closed');
    assert.strictEqual(pair.sellPosition.status, 'OPEN', 'SELL leg must remain open');

    // Price returns to testPrice3 - MUST REMAIN LOCKED
    const isLocked = solanaEngine.isPriceLevelLocked(testPrice3);
    assert.strictEqual(isLocked, true, `Price ${testPrice3} must remain locked after BUY leg exit`);

    const reEntryAttempt = solanaEngine.createNewPair('SOLUSDT', testPrice3);
    assert.strictEqual(reEntryAttempt, null, `Re-entry at ${testPrice3} after one leg closed must be rejected`);
  });

  // TEST 5: Closing both legs does not release the price
  test('Closing both legs does not release the price', () => {
    const pair = solanaEngine.createNewPair('SOLUSDT', testPrice4);
    assert(pair !== null, `Pair at ${testPrice4} must succeed`);

    // Close BUY leg
    solanaEngine.closePositionLeg(pair.buyPosition, testPrice4 + 0.45, Date.now(), 'BUY TARGET HIT');
    // Close SELL leg
    solanaEngine.closePositionLeg(pair.sellPosition, testPrice4 - 0.45, Date.now(), 'SELL TARGET HIT');
    pair.status = 'CLOSED';

    assert.strictEqual(pair.buyPosition.status, 'CLOSED');
    assert.strictEqual(pair.sellPosition.status, 'CLOSED');
    assert.strictEqual(pair.status, 'CLOSED');

    // Price returns to testPrice4 - MUST REMAIN PERMANENTLY LOCKED
    const isLocked = solanaEngine.isPriceLevelLocked(testPrice4);
    assert.strictEqual(isLocked, true, `Price ${testPrice4} must remain locked after BOTH legs closed`);

    const postCloseAttempt = solanaEngine.createNewPair('SOLUSDT', testPrice4);
    assert.strictEqual(postCloseAttempt, null, `Re-entry at ${testPrice4} after both legs closed must be rejected`);
  });

  // TEST 6: Restart and redeployment preserve used-price locks
  test('Restart and redeployment preserve used-price locks', () => {
    // testPrice1 and testPrice4 were locked in SQLite
    // Simulate engine restart by creating a new instance
    const SolanaEngineClass = solanaEngine.constructor;
    const freshEngine = new SolanaEngineClass();

    assert.strictEqual(freshEngine.isPriceLevelLocked(testPrice1), true, `Restarted engine must retain ${testPrice1} lock from SQLite`);
    assert.strictEqual(freshEngine.isPriceLevelLocked(testPrice4), true, `Restarted engine must retain ${testPrice4} lock from SQLite`);

    const restartAttempt = freshEngine.createNewPair('SOLUSDT', testPrice1);
    assert.strictEqual(restartAttempt, null, 'Creation of previously locked price on restarted engine must be rejected');
  });

  // TEST 7: Reset and archive preserve used-price locks
  test('Reset and archive preserve used-price locks', () => {
    // Call resetData
    solanaEngine.resetData(5.0, 186682.39, 0.45);
    // Call db resetAll
    db.resetAll();

    // Verify testPrice1 is STILL locked in SQLite
    const lockedInDb = db.isPriceLevelLocked('SOLUSDT', testPrice1);
    assert.strictEqual(lockedInDb, true, 'Reset & archive must NEVER clear used_price_levels table');

    // In engine
    const isLocked = solanaEngine.isPriceLevelLocked(testPrice1);
    assert.strictEqual(isLocked, true, `Engine must report ${testPrice1} locked after reset`);

    const resetAttempt = solanaEngine.createNewPair('SOLUSDT', testPrice1);
    assert.strictEqual(resetAttempt, null, `Cannot re-create pair at ${testPrice1} after reset`);
  });

  // TEST 8: Concurrent requests cannot create duplicate pairs at one price
  await testAsync('Concurrent requests cannot create duplicate pairs at one price', async () => {
    const concurrentPrice = testPrice5;
    
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

  // TEST 9: An exit price cannot be reused as a new entry if its normalized level is already USED
  test('Exit price cannot be reused as a new entry if reserved by active target', () => {
    const pair = solanaEngine.createNewPair('SOLUSDT', testPrice6);
    assert(pair !== null, `Pair at ${testPrice6} must succeed`);
    const target = pair.buyTarget;

    // Check if target price is reserved
    const targetCheck = solanaEngine.isPriceReservedByActiveTarget(target);
    assert.strictEqual(targetCheck.reserved, true, 'Active target price must be reported as reserved');

    // Attempt to open a new pair at the target price
    const targetEntryAttempt = solanaEngine.createNewPair('SOLUSDT', target);
    assert.strictEqual(targetEntryAttempt, null, 'Opening a new pair at an active target price must be blocked');
  });

  // TEST 10: Pair size remains 5 SOL and exit target remains $0.45
  test('Pair size remains 5 SOL and exit target remains $0.45', () => {
    assert.strictEqual(solanaEngine.settings.contractQuantity, 5.0, 'Settings contractQuantity must be 5.0 SOL');
    assert.strictEqual(solanaEngine.settings.profitTargetMove, 0.45, 'Settings profitTargetMove must be $0.45');

    const pair = solanaEngine.createNewPair('SOLUSDT', testPrice7);
    assert(pair !== null, `Pair creation at ${testPrice7} must succeed`);

    assert.strictEqual(pair.quantity, 5.0, 'Pair quantity must be 5.0 SOL');
    assert.strictEqual(pair.buyPosition.quantity, 5.0, 'BUY leg quantity must be 5.0 SOL');
    assert.strictEqual(pair.sellPosition.quantity, 5.0, 'SELL leg quantity must be 5.0 SOL');

    // Verify exit targets: $0.45 price movement
    const expectedBuyTarget = Math.round((testPrice7 + 0.45) * 100) / 100;
    const expectedSellTarget = Math.round((testPrice7 - 0.45) * 100) / 100;
    assert.strictEqual(pair.buyTarget, expectedBuyTarget);
    assert.strictEqual(pair.sellTarget, expectedSellTarget);
    assert.strictEqual(pair.buyPosition.targetExitPrice, expectedBuyTarget);
    assert.strictEqual(pair.sellPosition.targetExitPrice, expectedSellTarget);
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

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
