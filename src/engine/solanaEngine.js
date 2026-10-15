const fs = require('fs');
const path = require('path');
const rateFeed = require('./rateFeed');

class SolanaEngine {
  constructor() {
    this.settings = {
      startingCapitalINR: 186682.39, // Mudrex Futures Wallet Available Cash
      contractQuantity: 1.0, // Conservative 1.0 SOL default lot size for testing/safety
      leverage: 5,
      instrument: 'SOLUSDT',
      profitTargetMove: 0.45, // $0.45 Target Move for Solana
      buyTargetMove: 0.45,
      sellTargetMove: 0.45,
      gridSpacing: 0.50, // Conservative $0.50 grid spacing (replaces dangerous $0.005 micro-grid)
      basketProfitTargetINR: 500, // ₹500 Punarjanm Basket Profit Threshold
      autoPunarjanmEnabled: false, // Auto-harvest DISABLED
      autoAddNewPairs: false, // Default FALSE: prevent uncontrolled automated pair creation
      maxActivePairs: 10, // Conservative 10 pairs cap (replaces dangerous 500 cap)
      autoCleanKachraEnabled: true, // Auto-flush stale floating legs
      maxFloatingLossThresholdINR: 20000,
      maxOneSidedLegs: 5, // Strict 5 leg imbalance cap (replaces 80)
      dailyFeeBudgetINR: 1000, // Daily ₹1,000 fee budget circuit breaker
      maxDailyOrders: 50, // Max 50 orders/day limit
      priceCooldownMinutes: 30, // 30-minute lock per price level
      takerFeeRate: 0.00075, // 0.075% Mudrex taker fee
      gstRate: 0.18, // 18% GST
      conservativeFeeMultiplier: 1.40, // 1.4x conservative buffer
      slippageBufferINR: 2.0, // ₹2.00 slippage buffer
      usdInrRate: 102.00, // Authoritative Mudrex INR Futures Rate
      tradingMode: 'PAPER', // Default PAPER mode (Fail-Closed)
      realOrdersDisabled: true // Default TRUE: live order placement disabled
    };

    this.pairs = [];
    this.closedPositions = [];
    this.auditLogs = [];
    this.punarjanmCount = 0;
    this.punarjanmCycles = [];
    this.lastPunarjanmSummary = null;
    this.lastPunarjanmTime = 0;
    this.processedRates = new Set();
    this.lastProcessedRate = null;
    this.lastSkippedRate = null;
    this.pairCounter = 1;

    // Per-price cooldown tracking (priceKey -> timestamp)
    this.priceLevelLocks = new Map();

    this.isEngineRunning = false;
    this.engineStatus = 'PAUSED';
    this.pauseReason = 'Safe state: Trading engine initialized in PAUSED mode with real orders disabled.';
    this.engineStartedAt = null;
    this.lastResetTime = null;

    const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, '../../data');
    this.storagePath = path.join(dataDir, 'solana_engine_state.json');
    this.backupPath = path.join('/tmp', 'solana_engine_state_backup.json');

    this.initFromStorage();

    // Subscribe to real-time market rates
    rateFeed.subscribe((type, data) => this.handleRateEvent(type, data));

    // REMOVED: Blind 7-second retry loop. Order retries must only occur via verified idempotency check and exchange status query.

    // Periodic background Mudrex wallet balance sync (keeps available margin fresh)
    setInterval(() => {
      try {
        const mudrexAdapter = require('./mudrexLiveAdapter');
        if (mudrexAdapter && typeof mudrexAdapter.testAuthentication === 'function') {
          mudrexAdapter.testAuthentication().catch(() => {});
        }
      } catch (e) {}
    }, 15000);
  }

  initFromStorage() {
    try {
      let raw = null;
      const seedFile = path.join(__dirname, 'solana_state_seed.json');
      if (fs.existsSync(this.storagePath)) {
        raw = fs.readFileSync(this.storagePath, 'utf8');
      } else if (fs.existsSync(this.backupPath)) {
        raw = fs.readFileSync(this.backupPath, 'utf8');
      } else if (fs.existsSync(seedFile)) {
        raw = fs.readFileSync(seedFile, 'utf8');
      }

      if (raw) {
        const data = JSON.parse(raw);
        if (data) {
          if (Array.isArray(data.pairs) && data.pairs.length > 0) {
            this.pairs = data.pairs.map(p => {
              if (!p.buyPosition && p.buy) p.buyPosition = p.buy;
              if (!p.sellPosition && p.sell) p.sellPosition = p.sell;
              return p;
            });
          }
          if (Array.isArray(data.closedPositions)) this.closedPositions = data.closedPositions;
          if (Array.isArray(data.punarjanmCycles)) this.punarjanmCycles = data.punarjanmCycles;
          if (typeof data.punarjanmCount === 'number') this.punarjanmCount = data.punarjanmCount;
          if (typeof data.pairCounter === 'number') this.pairCounter = data.pairCounter;
          if (data.settings) this.settings = { ...this.settings, ...data.settings };
          
          // Fail-closed enforcement: never auto-enable LIVE execution from saved state
          this.settings.tradingMode = 'PAPER';
          this.settings.realOrdersDisabled = true;
          this.settings.autoAddNewPairs = false;
          if (!this.settings.gridSpacing || this.settings.gridSpacing < 0.20) this.settings.gridSpacing = 0.50;
          if (!this.settings.maxActivePairs || this.settings.maxActivePairs > 20) this.settings.maxActivePairs = 10;
          if (!this.settings.maxOneSidedLegs || this.settings.maxOneSidedLegs > 10) this.settings.maxOneSidedLegs = 5;
          if (!this.settings.contractQuantity) this.settings.contractQuantity = 1.0;
          this.isEngineRunning = false;
          this.engineStatus = 'PAUSED';
          this.pauseReason = 'Engine restored in safe PAUSED state. Operator action required to activate.';

          if (data.engineStartedAt) {
            this.engineStartedAt = data.engineStartedAt;
          } else if (Array.isArray(this.pairs) && this.pairs.length > 0 && this.pairs[0].createdAt) {
            this.engineStartedAt = this.pairs[0].createdAt;
          } else {
            this.engineStartedAt = new Date().toISOString();
          }
          if (data.lastResetTime) this.lastResetTime = data.lastResetTime;
          if (Array.isArray(data.processedRates)) this.processedRates = new Set(data.processedRates);
          console.log(`[Solana Engine] Restored state from storage: ${this.pairs.length} pairs, ${this.closedPositions.length} closed trades. StartedAt: ${this.engineStartedAt}`);
        }
      }

      // If pairs is still empty, load from seed file
      if (this.pairs.length === 0 && fs.existsSync(seedFile)) {
        try {
          const seedData = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
          if (seedData && Array.isArray(seedData.pairs) && seedData.pairs.length > 0) {
            this.pairs = seedData.pairs.map(p => {
              if (!p.buyPosition && p.buy) p.buyPosition = p.buy;
              if (!p.sellPosition && p.sell) p.sellPosition = p.sell;
              return p;
            });
            this.pairCounter = seedData.pairCounter || (this.pairs.length + 1);
            if (Array.isArray(seedData.processedRates)) {
              seedData.processedRates.forEach(r => this.processedRates.add(r));
            }
            if (this.pairs[0] && this.pairs[0].createdAt) {
              this.engineStartedAt = this.pairs[0].createdAt;
            }
            console.log(`[Solana Engine] Seeded ${this.pairs.length} pairs from solana_state_seed.json.`);
          }
        } catch (e) {}
      }

      // Safeguard: Ensure authoritative closed trades from seedFile are ALWAYS merged and preserved
      if (fs.existsSync(seedFile)) {
        try {
          const seedData = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
          if (seedData && Array.isArray(seedData.closedPositions)) {
            const existingIds = new Set(this.closedPositions.map(c => c.positionId));
            let mergedCount = 0;
            for (const t of seedData.closedPositions) {
              if (t.positionId && !existingIds.has(t.positionId)) {
                this.closedPositions.push(t);
                existingIds.add(t.positionId);
                mergedCount++;
              }
            }
            if (mergedCount > 0) {
              // Sort descending by exit timestamp
              this.closedPositions.sort((a, b) => {
                const tA = new Date(a.exitTime || a.exitTimestamp || 0).getTime();
                const tB = new Date(b.exitTime || b.exitTimestamp || 0).getTime();
                return tB - tA;
              });
              console.log(`[Solana Engine] Safeguard merged ${mergedCount} authoritative closed trades from seed. Total closed: ${this.closedPositions.length}`);
            }
          }
        } catch (e) {}
      }
    } catch (e) {
      console.warn('[Solana Engine] Error initializing from storage:', e.message);
    }
  }

  formatUptime(ms) {
    if (!ms || isNaN(ms) || ms < 0) return '0h 0m';
    const totalSecs = Math.floor(ms / 1000);
    const hours = Math.floor(totalSecs / 3600);
    const minutes = Math.floor((totalSecs % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }

  saveState() {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const payload = {
        timestamp: new Date().toISOString(),
        settings: this.settings,
        engineStartedAt: this.engineStartedAt,
        lastResetTime: this.lastResetTime,
        pairs: this.pairs,
        closedPositions: this.closedPositions.slice(0, 1000), // Keep last 1000
        punarjanmCount: this.punarjanmCount,
        punarjanmCycles: this.punarjanmCycles,
        pairCounter: this.pairCounter,
        processedRates: Array.from(this.processedRates)
      };
      const jsonStr = JSON.stringify(payload, null, 2);
      fs.writeFileSync(this.storagePath, jsonStr, 'utf8');
      try {
        fs.writeFileSync(this.backupPath, jsonStr, 'utf8');
      } catch (err) {}
      try {
        const seedFile = path.join(__dirname, 'solana_state_seed.json');
        fs.writeFileSync(seedFile, jsonStr, 'utf8');
      } catch (err) {}
    } catch (e) {
      console.warn('[Solana Engine] Error saving state:', e.message);
    }
  }

  handleRateEvent(type, data) {
    if (!this.isEngineRunning) return;
    if (type !== 'tick' && type !== 'rate_updated') return;
    if (!data || data.symbol !== 'SOLUSDT') return;

    const price = Number(data.price);
    if (!price || isNaN(price) || price <= 0) return;

    // 0. Auto-Clean Guard: if stale floating loss has crossed threshold (e.g. ₹20,000), auto-flush kagzi kachra
    if (this.settings.autoCleanKachraEnabled) {
      const summary = this.calculateFloatingSummary(price);
      const maxLossThreshold = Number(this.settings.maxFloatingLossThresholdINR || 20000);
      if (summary.floatingNetINR <= -maxLossThreshold) {
        console.log(`[Solana Engine] Auto Floating Guard: Floating Loss -₹${Math.abs(summary.floatingNetINR).toFixed(2)} reached threshold ₹${maxLossThreshold}. Auto-cleaning kachra...`);
        this.cleanFloatingKachra(`AUTO_FLOATING_LIMIT_HIT (Threshold ₹${maxLossThreshold})`);
      }
    }

    // 1. Check open positions for target profit exits
    this.evaluateOpenPositions(price);

    // 2. Check Punarjanm Auto-Harvest Basket Profit threshold (₹250)
    if (this.settings.autoPunarjanmEnabled) {
      this.checkPunarjanmAutoHarvest(price);
    }

    // 3. Auto-Add new pairs on price changes
    if (this.settings.autoAddNewPairs) {
      this.evaluateRateForNewPair(price);
    }
  }

  evaluateRateForNewPair(price) {
    // 0. Fail-Closed check: Engine must be actively RUNNING and autoAddNewPairs must be explicitly true
    if (!this.isEngineRunning || !this.settings.autoAddNewPairs) {
      return;
    }

    const roundedPrice = Number(price.toFixed(2));
    if (!roundedPrice || isNaN(roundedPrice) || roundedPrice <= 0) return;

    const usdInrRate = Number(this.settings.usdInrRate || 102.00);
    const qty = Number(this.settings.contractQuantity || 1.0);
    const leverage = Number(this.settings.leverage || 5);
    const gridSpacing = Number(this.settings.gridSpacing || 0.50);

    // 1. Circuit Breaker Check (Fee Budget & Max Daily Orders)
    try {
      const mudrexAdapter = require('./mudrexLiveAdapter');
      if (mudrexAdapter && typeof mudrexAdapter.checkCircuitBreakers === 'function') {
        const cb = mudrexAdapter.checkCircuitBreakers();
        if (!cb.allowed) {
          console.warn(`[Solana Engine] New pair creation blocked by Circuit Breaker: ${cb.reason}`);
          this.lastSkippedRate = roundedPrice;
          return;
        }
      }
    } catch (e) {}

    // 2. Per-Price Level Cooldown Lock Check (Prevents rapid orders at same grid level)
    const priceKey = (Math.round(roundedPrice / gridSpacing) * gridSpacing).toFixed(2);
    const cooldownMs = (this.settings.priceCooldownMinutes || 30) * 60 * 1000;
    if (this.priceLevelLocks && this.priceLevelLocks.has(priceKey)) {
      const lastLockedAt = this.priceLevelLocks.get(priceKey);
      if (Date.now() - lastLockedAt < cooldownMs) {
        this.lastSkippedRate = roundedPrice;
        return;
      }
    }

    // 3. Skip consecutive identical tick
    if (this.lastProcessedRate === roundedPrice) {
      this.lastSkippedRate = roundedPrice;
      return;
    }

    // 4. Check active pairs cap (Conservative 10 pairs cap)
    const activePairsCount = this.pairs.filter(p => p.status === 'OPEN').length;
    const maxPairs = Number(this.settings.maxActivePairs || 10);
    if (activePairsCount >= maxPairs) {
      console.log(`[Solana Engine] Active pairs cap reached (${activePairsCount}/${maxPairs}). Waiting for exits/margin.`);
      return;
    }

    // 5. If zero active pairs are currently open, spawn a fresh pair at live rate
    if (activePairsCount === 0) {
      this.createNewPair('SOLUSDT', roundedPrice, Date.now(), usdInrRate);
      this.lastProcessedRate = roundedPrice;
      if (this.priceLevelLocks) this.priceLevelLocks.set(priceKey, Date.now());
      console.log(`[Solana Engine] Zero active pairs detected. Auto-spawned fresh seed pair at $${roundedPrice.toFixed(2)}.`);
      return;
    }

    // 6. Check for missing legs on existing active pairs
    for (const pair of this.pairs) {
      if (pair.status === 'CLOSED') continue;
      const bOpen = pair.buyPosition && pair.buyPosition.status === 'OPEN';
      const sOpen = pair.sellPosition && pair.sellPosition.status === 'OPEN';

      if (bOpen && sOpen) continue; // Both legs already open

      const tolerance = gridSpacing * 0.25; // Adaptive tolerance based on grid spacing

      // Case 1: BUY is OPEN, SELL was closed, price came back to pair entry price
      if (bOpen && !sOpen && Math.abs(roundedPrice - pair.entryPrice) <= tolerance) {
        this.reopenMissingLeg(pair, 'SELL', roundedPrice, Date.now(), usdInrRate);
        this.lastProcessedRate = roundedPrice;
        return;
      }

      // Case 2: SELL is OPEN, BUY was closed, price came back to pair entry price
      if (sOpen && !bOpen && Math.abs(roundedPrice - pair.entryPrice) <= tolerance) {
        this.reopenMissingLeg(pair, 'BUY', roundedPrice, Date.now(), usdInrRate);
        this.lastProcessedRate = roundedPrice;
        return;
      }
    }

    // 7. Skip if a pair already exists within grid spacing tolerance
    const existingBothOpenPairAtRate = this.pairs.find(p => {
      if (p.status !== 'OPEN') return false;
      const bOpen = p.buyPosition && p.buyPosition.status === 'OPEN';
      const sOpen = p.sellPosition && p.sellPosition.status === 'OPEN';
      return bOpen && sOpen && Math.abs(p.entryPrice - roundedPrice) < gridSpacing;
    });

    if (existingBothOpenPairAtRate) {
      this.lastSkippedRate = roundedPrice;
      return;
    }

    // 8. Prevent excessive one-sided leg imbalance
    const maxImbalance = Number(this.settings.maxOneSidedLegs || 5);
    let openBuys = 0, openSells = 0;
    for (const p of this.pairs) {
      if (p.status !== 'OPEN') continue;
      if (p.buyPosition && p.buyPosition.status === 'OPEN') openBuys++;
      if (p.sellPosition && p.sellPosition.status === 'OPEN') openSells++;
    }
    if (Math.abs(openBuys - openSells) >= maxImbalance) {
      console.log(`[Solana Engine] One-sided leg imbalance limit reached: Buys=${openBuys}, Sells=${openSells}, Diff=${Math.abs(openBuys - openSells)}/${maxImbalance}`);
      this.lastSkippedRate = roundedPrice;
      return;
    }

    // 9. Auto-Clean Guard check: if floating loss reaches threshold, auto-flush stale legs
    if (this.settings.autoCleanKachraEnabled) {
      const summary = this.calculateFloatingSummary(roundedPrice);
      const maxLossThreshold = Number(this.settings.maxFloatingLossThresholdINR || 20000);
      if (summary.floatingNetINR <= -maxLossThreshold) {
        console.log(`[Solana Engine] Auto Floating Guard: Floating Loss -₹${Math.abs(summary.floatingNetINR).toFixed(2)} reached threshold ₹${maxLossThreshold}. Auto-cleaning kachra...`);
        this.cleanFloatingKachra(`AUTO_FLOATING_LIMIT_HIT (Threshold ₹${maxLossThreshold})`);
        return;
      }
    }

    // 10. Authoritative Margin check for 1 pair (5x leverage)
    const reqMarginPairINR = (roundedPrice * qty * usdInrRate) / leverage;
    const metrics = this.getDashboardMetrics();
    const availMargin = Math.max(
      metrics.wallet.availableMarginINR || 0,
      metrics.wallet.totalAvailableINR || 0
    );
    if (availMargin < reqMarginPairINR) {
      console.warn(`[Solana Engine] Available margin exhausted! Needed: ₹${reqMarginPairINR.toFixed(2)}, Available: ₹${availMargin}`);
      return;
    }

    // 11. Create brand new pair at this rate and lock price level
    this.createNewPair('SOLUSDT', roundedPrice, Date.now(), usdInrRate);
    this.lastProcessedRate = roundedPrice;
    if (this.priceLevelLocks) this.priceLevelLocks.set(priceKey, Date.now());
    console.log(`[Solana Engine] New rate $${roundedPrice.toFixed(2)} accepted! Created pair ${this.pairCounter - 1}. Active pairs: ${activePairsCount + 1}`);
  }

  reopenMissingLeg(pair, direction, entryPrice, timestamp = Date.now(), usdInrRate = 102.00) {
    const qty = pair.quantity || this.settings.contractQuantity || 4.0;
    const targetMove = pair.targetMove || this.settings.profitTargetMove || 0.50;
    const seq = pair.pairId.replace('PAIR-SOL-', '');
    const legId = `P-PAIR-SOL-${seq}-${direction}-${Date.now().toString().slice(-4)}`;

    const isLive = this.settings.tradingMode === 'LIVE' && !this.settings.realOrdersDisabled;

    if (direction === 'BUY') {
      const buyTarget = Number((entryPrice + targetMove).toFixed(2));
      pair.buyPosition = {
        pairId: pair.pairId,
        positionId: legId,
        direction: 'BUY',
        symbol: 'SOLUSDT',
        entryTime: new Date(timestamp).toISOString(),
        entryTimestamp: timestamp,
        entryPrice,
        targetExitPrice: buyTarget,
        quantity: qty,
        status: 'OPEN',
        ledger: isLive ? 'LIVE' : 'PAPER',
        source: isLive ? 'MUDREX_EXCHANGE' : 'SOLANA_SIMULATOR',
        apiStatus: isLive ? 'PENDING_TRANSMISSION' : null
      };
      console.log(`[Solana Engine] Reopened missing BUY leg for ${pair.pairId} at $${entryPrice.toFixed(2)}`);
    } else {
      const sellTarget = Number((entryPrice - targetMove).toFixed(2));
      pair.sellPosition = {
        pairId: pair.pairId,
        positionId: legId,
        direction: 'SELL',
        symbol: 'SOLUSDT',
        entryTime: new Date(timestamp).toISOString(),
        entryTimestamp: timestamp,
        entryPrice,
        targetExitPrice: sellTarget,
        quantity: qty,
        status: 'OPEN',
        ledger: isLive ? 'LIVE' : 'PAPER',
        source: isLive ? 'MUDREX_EXCHANGE' : 'SOLANA_SIMULATOR',
        apiStatus: isLive ? 'PENDING_TRANSMISSION' : null
      };
      console.log(`[Solana Engine] Reopened missing SELL leg for ${pair.pairId} at $${entryPrice.toFixed(2)}`);
    }

    pair.status = 'OPEN';
    if (isLive) {
      this.dispatchPairOrders(pair).catch(err => {
        console.error('[Solana Live] Error dispatching reopened leg order:', err.message);
      });
    }
    this.saveState();
  }

  createNewPair(symbol, price, timestamp = Date.now(), usdInrRate = 102.00, customQty = null, customTarget = null) {
    const qty = customQty !== null ? Number(customQty) : Number(this.settings.contractQuantity || 4.0);
    const targetMove = customTarget !== null ? Number(customTarget) : Number(this.settings.profitTargetMove || 0.50);
    const pairId = `PAIR-SOL-${this.pairCounter.toString().padStart(4, '0')}`;
    this.pairCounter++;

    const buyTarget = Number((price + targetMove).toFixed(2));
    const sellTarget = Number((price - targetMove).toFixed(2));

    const buyPos = {
      pairId,
      positionId: `P-${pairId}-BUY`,
      direction: 'BUY',
      symbol: 'SOLUSDT',
      entryTime: new Date(timestamp).toISOString(),
      entryTimestamp: timestamp,
      entryPrice: price,
      targetExitPrice: buyTarget,
      quantity: qty,
      status: 'OPEN',
      ledger: 'PAPER',
      source: 'SOLANA_SIMULATOR'
    };

    const sellPos = {
      pairId,
      positionId: `P-${pairId}-SELL`,
      direction: 'SELL',
      symbol: 'SOLUSDT',
      entryTime: new Date(timestamp).toISOString(),
      entryTimestamp: timestamp,
      entryPrice: price,
      targetExitPrice: sellTarget,
      quantity: qty,
      status: 'OPEN',
      ledger: 'PAPER',
      source: 'SOLANA_SIMULATOR'
    };

    const pair = {
      pairId,
      symbol: 'SOLUSDT',
      entryPrice: price,
      createdAt: new Date(timestamp).toISOString(),
      createdTimestamp: timestamp,
      buyTarget,
      sellTarget,
      targetMove,
      quantity: qty,
      status: 'OPEN',
      buyPosition: buyPos,
      sellPosition: sellPos
    };

    this.pairs.push(pair);
    this.processedRates.add(price);
    this.lastProcessedRate = price;

    // Real Live Mudrex Order Dispatch
    if (this.settings.tradingMode === 'LIVE' && !this.settings.realOrdersDisabled) {
      buyPos.ledger = 'LIVE';
      sellPos.ledger = 'PAPER'; // Prevent opposing hedge in One-Way Net mode
      buyPos.source = 'MUDREX_EXCHANGE';
      sellPos.source = 'SOLANA_SIMULATOR';
      buyPos.apiStatus = 'PENDING_TRANSMISSION';
      sellPos.apiStatus = 'PAPER_HEDGE_SIMULATED';

      this.dispatchPairOrders(pair).catch(err => {
        console.error('[Solana Live] Error dispatching pair orders:', err.message);
      });
    }

    this.saveState();
    return pair;
  }

  async dispatchPairOrders(pair) {
    if (this.settings.tradingMode !== 'LIVE' || this.settings.realOrdersDisabled) return;

    let mudrexLive = null;
    try {
      mudrexLive = require('./mudrexLiveAdapter');
      if (!mudrexLive.isRealExecutionEnabled()) return;
    } catch (e) {
      return;
    }

    // 1. Circuit Breaker Guard
    const cb = mudrexLive.checkCircuitBreakers();
    if (!cb.allowed) {
      console.warn(`[Solana Live] Cannot dispatch order: Circuit Breaker active (${cb.reason})`);
      return;
    }

    const { buyPosition, sellPosition } = pair;

    // 2. ONE-WAY NETTING ENFORCEMENT:
    // Mudrex operates strictly in One-Way Net Mode.
    // Submitting both BUY and SELL orders at the same price creates immediate net-zero fill with 2x taker fees.
    // Therefore, in LIVE mode, only ONE directional entry can be submitted. The opposing leg is marked PAPER simulator only.
    let targetLeg = null;
    if (buyPosition && (!buyPosition.mudrexOrderId || buyPosition.apiStatus !== 'REAL_MUDREX_POSITION')) {
      targetLeg = buyPosition;
      if (sellPosition) {
        sellPosition.ledger = 'PAPER';
        sellPosition.source = 'SOLANA_SIMULATOR';
        sellPosition.apiStatus = 'PAPER_HEDGE_SIMULATED';
      }
    } else if (sellPosition && (!sellPosition.mudrexOrderId || sellPosition.apiStatus !== 'REAL_MUDREX_POSITION')) {
      targetLeg = sellPosition;
    }

    if (!targetLeg) return;

    // 3. Check exchange exposure before placing entry
    try {
      const positions = await mudrexLive.queryRealPositions('SOLUSDT');
      const hasOpposingPosition = Array.isArray(positions) && positions.some(p => {
        const qty = Number(p.quantity || p.size || 0);
        if (Math.abs(qty) <= 0.0001) return false;
        const currentSide = qty > 0 ? 'BUY' : 'SELL';
        return currentSide !== targetLeg.direction;
      });

      if (hasOpposingPosition) {
        console.warn(`[One-Way Netting Shield] Cannot place live ${targetLeg.direction} order: opposing position exists on exchange. Refusing to churn.`);
        targetLeg.apiStatus = 'REJECTED_ONE_WAY_NET_COLLISION';
        this.saveState();
        return;
      }
    } catch (e) {
      console.error('[Solana Live] Exchange position check failed. Failing closed:', e.message);
      return;
    }

    // 4. Unique Idempotency Intent Key
    const intentId = `INTENT-ENTRY-${pair.pairId}-${targetLeg.direction}-${targetLeg.positionId}`;

    targetLeg.apiStatus = 'TRANSMITTING_TO_MUDREX';
    this.saveState();

    try {
      const res = await mudrexLive.createRealOrder({
        symbol: 'SOLUSDT',
        side: targetLeg.direction,
        quantity: targetLeg.quantity || this.settings.contractQuantity || 1.0,
        leverage: this.settings.leverage || 5,
        targetPrice: targetLeg.targetExitPrice,
        intentId
      });

      if (res && res.success) {
        targetLeg.mudrexOrderId = mudrexLive.extractOrderId(res.data);
        targetLeg.apiStatus = 'REAL_MUDREX_POSITION';
        targetLeg.apiError = null;
        console.log(`[Solana Live] Real ${targetLeg.direction} Order confirmed for ${pair.pairId}: ${targetLeg.mudrexOrderId}`);
      } else {
        targetLeg.apiError = res ? (res.error || JSON.stringify(res)) : 'Failed';
        targetLeg.apiStatus = 'ORDER_SUBMISSION_FAILED';
        console.warn(`[Solana Live] Real ${targetLeg.direction} Order failed for ${pair.pairId}:`, targetLeg.apiError);
      }
    } catch (e) {
      targetLeg.apiError = e.message;
      targetLeg.apiStatus = 'ORDER_SUBMISSION_ERROR';
    }
    this.saveState();
  }

  transmitPendingSolanaOrders() {
    // REMOVED BLIND LOOP: Orders must only be transmitted on explicit verified intent, never retried on a blind 7s interval.
    // Kept as safe no-op to maintain interface compatibility without churning orders.
    return;
  }

  evaluateOpenPositions(livePrice) {
    const now = Date.now();
    const usdInr = this.settings.usdInrRate || 102.00;
    const takerFee = this.settings.takerFeeRate || 0.00075;
    const gstRate = this.settings.gstRate || 0.18;

    for (const pair of this.pairs) {
      if (pair.status === 'CLOSED') continue;

      // 1. Evaluate BUY Leg
      if (pair.buyPosition && pair.buyPosition.status === 'OPEN') {
        const b = pair.buyPosition;
        const bTarget = Number(b.targetExitPrice || b.targetPrice || pair.buyTarget || (b.entryPrice + 0.45));
        if (livePrice >= bTarget) {
          this.closePositionLeg(b, livePrice, now, 'BUY TARGET PROFIT HIT', usdInr, takerFee, gstRate);
        }
      }

      // 2. Evaluate SELL Leg
      if (pair.sellPosition && pair.sellPosition.status === 'OPEN') {
        const s = pair.sellPosition;
        const sTarget = Number(s.targetExitPrice || s.targetPrice || pair.sellTarget || (s.entryPrice - 0.45));
        if (livePrice <= sTarget) {
          this.closePositionLeg(s, livePrice, now, 'SELL TARGET PROFIT HIT', usdInr, takerFee, gstRate);
        }
      }

      // If both legs closed, close pair
      const bOpen = pair.buyPosition && pair.buyPosition.status === 'OPEN';
      const sOpen = pair.sellPosition && pair.sellPosition.status === 'OPEN';
      if (!bOpen && !sOpen) {
        pair.status = 'CLOSED';
      }
    }
  }

  closePositionLeg(pos, exitPrice, exitTime = Date.now(), exitReason = 'TARGET PROFIT HIT', usdInr = 102.00, takerFee = 0.00075, gstRate = 0.18, actualFilledQty = null) {
    const totalQty = pos.quantity || this.settings.contractQuantity || 1.0;
    const filledQty = (actualFilledQty !== null && actualFilledQty > 0 && actualFilledQty < totalQty) ? actualFilledQty : totalQty;
    const isPartial = filledQty < totalQty;

    // Handle partial fills: split residual position and keep it OPEN
    let residualPos = null;
    if (isPartial) {
      const remainingQty = Number((totalQty - filledQty).toFixed(4));
      residualPos = {
        ...pos,
        positionId: `${pos.positionId}-RESIDUAL-${Date.now().toString().slice(-4)}`,
        quantity: remainingQty,
        status: 'OPEN',
        isResidual: true,
        parentPositionId: pos.positionId
      };

      const parentPair = this.pairs.find(p => p.pairId === pos.pairId || (p.buyPosition === pos || p.sellPosition === pos));
      if (parentPair) {
        if (parentPair.buyPosition === pos || (parentPair.buyPosition && parentPair.buyPosition.positionId === pos.positionId)) {
          parentPair.buyPosition = residualPos;
        } else if (parentPair.sellPosition === pos || (parentPair.sellPosition && parentPair.sellPosition.positionId === pos.positionId)) {
          parentPair.sellPosition = residualPos;
        }
      }
      pos.status = 'CLOSED_PARTIAL';
    } else {
      pos.status = 'CLOSED';
    }

    pos.quantity = filledQty;
    pos.isPartial = isPartial;
    pos.exitPrice = Number(exitPrice.toFixed(2));
    pos.exitTime = new Date(exitTime).toISOString();
    pos.exitTimestamp = exitTime;
    pos.exitReason = exitReason;

    const qty = filledQty;
    const isBuy = pos.direction === 'BUY';
    const grossUSD = isBuy ? (pos.exitPrice - pos.entryPrice) * qty : (pos.entryPrice - pos.exitPrice) * qty;
    const grossINR = grossUSD * usdInr;

    const entryFeeUSD = pos.entryPrice * qty * takerFee;
    const exitFeeUSD = pos.exitPrice * qty * takerFee;
    const gstUSD = (entryFeeUSD + exitFeeUSD) * gstRate;
    const baseChargesUSD = entryFeeUSD + exitFeeUSD + gstUSD;
    const feeMultiplier = this.settings.conservativeFeeMultiplier || 1.40;
    const chargesUSD = baseChargesUSD * feeMultiplier;
    const chargesINR = chargesUSD * usdInr;

    const netUSD = grossUSD - chargesUSD;
    const netINR = grossINR - chargesINR;

    pos.grossProfitUSD = Number(grossUSD.toFixed(4));
    pos.grossProfitINR = Number(grossINR.toFixed(2));
    pos.entryFeeUSD = Number(entryFeeUSD.toFixed(4));
    pos.exitFeeUSD = Number(exitFeeUSD.toFixed(4));
    pos.gstUSD = Number(gstUSD.toFixed(4));
    pos.totalChargesUSD = Number(chargesUSD.toFixed(4));
    pos.totalChargesINR = Number(chargesINR.toFixed(2));
    pos.netProfitUSD = Number(netUSD.toFixed(4));
    pos.netProfitINR = Number(netINR.toFixed(2));
    pos.usdInrRate = usdInr;

    // Real Live Exit Order Dispatch on Mudrex (Reduce-Only)
    if (this.settings.tradingMode === 'LIVE' && !this.settings.realOrdersDisabled && pos.mudrexOrderId) {
      try {
        const mudrexLive = require('./mudrexLiveAdapter');
        mudrexLive.executeRealExit(null, pos, exitPrice, exitTime, usdInr, exitReason).then(res => {
          console.log(`[Solana Live] Real Exit Order dispatched on Mudrex for ${pos.positionId}:`, res);
        }).catch(err => {
          console.error(`[Solana Live] Real Exit Order error for ${pos.positionId}:`, err.message);
        });
      } catch (e) {
        console.error('[Solana Live] Real Exit dispatch error:', e.message);
      }
    }

    this.closedPositions.unshift({ ...pos });
    this.saveState();
    return { closedPosition: pos, residualPosition: residualPos };
  }

  checkPunarjanmAutoHarvest(livePrice) {
    if (!this.settings.autoPunarjanmEnabled) return;
    const summary = this.calculateFloatingSummary(livePrice);
    const threshold = this.settings.basketProfitTargetINR || 250;

    if (summary.floatingNetINR >= threshold) {
      console.log(`[Solana Engine] Punarjanm Auto-Harvest Triggered! Floating Net: ₹${summary.floatingNetINR} >= Target: ₹${threshold}`);
      this.executePunarjanm('AUTO_BASKET_TARGET_HIT', livePrice, this.settings.usdInrRate);
    }
  }

  executePunarjanm(triggerReason = 'MANUAL_TRIGGER', livePrice = 106.00, usdInrRate = 102.00) {
    const summary = this.calculateFloatingSummary(livePrice);
    this.punarjanmCount++;
    const cycleId = `PUNARJANM-SOL-${this.punarjanmCount}`;

    // Close all open positions at live price and archive into history
    let harvestedGrossINR = 0;
    let harvestedChargesINR = 0;
    let harvestedNetINR = 0;
    let harvestedTrades = 0;

    for (const pair of this.pairs) {
      if (pair.status === 'CLOSED') continue;
      if (pair.buyPosition && pair.buyPosition.status === 'OPEN') {
        this.closePositionLeg(pair.buyPosition, livePrice, Date.now(), `PUNARJANM HARVEST (${cycleId})`, usdInrRate);
        harvestedTrades++;
      }
      if (pair.sellPosition && pair.sellPosition.status === 'OPEN') {
        this.closePositionLeg(pair.sellPosition, livePrice, Date.now(), `PUNARJANM HARVEST (${cycleId})`, usdInrRate);
        harvestedTrades++;
      }
      pair.status = 'CLOSED';
    }

    const cycleRecord = {
      cycleId,
      timestamp: new Date().toISOString(),
      livePrice,
      harvestedProfitINR: summary.floatingNetINR,
      harvestedProfitUSD: Number((summary.floatingNetINR / usdInrRate).toFixed(2)),
      harvestedTrades,
      triggerReason
    };

    this.punarjanmCycles.unshift(cycleRecord);
    this.lastPunarjanmSummary = cycleRecord;
    this.lastPunarjanmTime = Date.now();

    // Reset price grid and active pairs
    this.pairs = [];
    this.processedRates.clear();
    this.lastProcessedRate = null;

    // Spawn fresh seed pair at current live rate
    this.createNewPair('SOLUSDT', livePrice, Date.now(), usdInrRate);
    this.saveState();

    return {
      success: true,
      cycle: cycleRecord
    };
  }

  calculateFloatingSummary(livePrice) {
    const usdInr = this.settings.usdInrRate || 102.00;
    let grossUSD = 0, chargesUSD = 0, netUSD = 0;
    let grossINR = 0, chargesINR = 0, netINR = 0;
    let openBuyCount = 0, openSellCount = 0;
    let dynamicMarginUsedINR = 0;

    const feeMultiplier = this.settings.conservativeFeeMultiplier || 1.40;

    for (const pair of this.pairs) {
      if (pair.status === 'CLOSED') continue;
      const qty = pair.quantity || this.settings.contractQuantity || 4.0;

      // Buy
      if (pair.buyPosition && pair.buyPosition.status === 'OPEN') {
        openBuyCount++;
        const gUSD = (livePrice - pair.buyPosition.entryPrice) * qty;
        const eFee = pair.buyPosition.entryPrice * qty * 0.00075 * 1.18;
        const xFee = livePrice * qty * 0.00075 * 1.18;
        const cUSD = (eFee + xFee) * feeMultiplier;
        grossUSD += gUSD;
        chargesUSD += cUSD;
        netUSD += (gUSD - cUSD);

        const gINR = gUSD * usdInr;
        const cINR = cUSD * usdInr;
        grossINR += gINR;
        chargesINR += cINR;
        netINR += (gINR - cINR);

        dynamicMarginUsedINR += (pair.buyPosition.entryPrice * qty * usdInr) / 5;
      }

      // Sell
      if (pair.sellPosition && pair.sellPosition.status === 'OPEN') {
        openSellCount++;
        const gUSD = (pair.sellPosition.entryPrice - livePrice) * qty;
        const eFee = pair.sellPosition.entryPrice * qty * 0.00075 * 1.18;
        const xFee = livePrice * qty * 0.00075 * 1.18;
        const cUSD = (eFee + xFee) * feeMultiplier;
        grossUSD += gUSD;
        chargesUSD += cUSD;
        netUSD += (gUSD - cUSD);

        const gINR = gUSD * usdInr;
        const cINR = cUSD * usdInr;
        grossINR += gINR;
        chargesINR += cINR;
        netINR += (gINR - cINR);

        dynamicMarginUsedINR += (pair.sellPosition.entryPrice * qty * usdInr) / 5;
      }
    }

    return {
      floatingGrossUSD: Number(grossUSD.toFixed(2)),
      floatingGrossINR: Number(grossINR.toFixed(2)),
      floatingChargesUSD: Number(chargesUSD.toFixed(2)),
      floatingChargesINR: Number(chargesINR.toFixed(2)),
      floatingNetUSD: Number(netUSD.toFixed(2)),
      floatingNetINR: Number(netINR.toFixed(2)),
      openBuyCount,
      openSellCount,
      dynamicMarginUsedINR: Number(dynamicMarginUsedINR.toFixed(2))
    };
  }

  getDashboardMetrics() {
    const rateInfo = rateFeed.getCurrentRate('SOLUSDT') || { price: 106.30, markPrice: 106.30, usdInrRate: 102.00 };
    const livePrice = Number(rateInfo.price || 106.30);
    const usdInr = this.settings.usdInrRate || 102.00;

    // Uptime and Session Tracking (Since Engine Start / Reset)
    const startTs = this.engineStartedAt ? new Date(this.engineStartedAt).getTime() : (this.pairs[0] && this.pairs[0].createdAt ? new Date(this.pairs[0].createdAt).getTime() : Date.now());
    const uptimeMs = Math.max(0, Date.now() - startTs);
    const uptimeHours = Number((uptimeMs / (1000 * 60 * 60)).toFixed(1));
    const uptimeFormatted = this.formatUptime(uptimeMs);

    // Filter closed positions since engine start / reset
    const sessionClosed = this.closedPositions.filter(cp => {
      const t = cp.exitTimestamp || (cp.exitTime ? new Date(cp.exitTime).getTime() : 0);
      return t >= (startTs - 60000); // 1-minute tolerance buffer
    });

    const positionsToSum = sessionClosed.length > 0 ? sessionClosed : this.closedPositions;

    let sessionGrossINR = 0, sessionChargesINR = 0, sessionNetINR = 0;
    let sessionWinCount = 0, sessionLossCount = 0;
    for (const cp of positionsToSum) {
      const g = cp.grossProfitINR || 0;
      const c = cp.totalChargesINR || 0;
      const n = cp.netProfitINR !== undefined ? cp.netProfitINR : (g - c);
      sessionGrossINR += g;
      sessionChargesINR += c;
      sessionNetINR += n;
      if (n >= 0) sessionWinCount++; else sessionLossCount++;
    }

    // All-Time Cumulative Realized Profit for audit & secondary metrics
    let allTimeGrossINR = 0, allTimeChargesINR = 0, allTimeNetINR = 0;
    let allTimeWinCount = 0, allTimeLossCount = 0;
    for (const cp of this.closedPositions) {
      const g = cp.grossProfitINR || 0;
      const c = cp.totalChargesINR || 0;
      const n = cp.netProfitINR !== undefined ? cp.netProfitINR : (g - c);
      allTimeGrossINR += g;
      allTimeChargesINR += c;
      allTimeNetINR += n;
      if (n >= 0) allTimeWinCount++; else allTimeLossCount++;
    }

    // Punarjanm harvests
    let totalHarvestINR = 0;
    for (const cy of this.punarjanmCycles) {
      totalHarvestINR += (cy.harvestedProfitINR || 0);
    }

    // Floating metrics
    const floating = this.calculateFloatingSummary(livePrice);

    // Margins and Capital (Authoritative Real Mudrex Exchange Sync)
    let mudrexAdapter = null;
    try {
      mudrexAdapter = require('./mudrexLiveAdapter');
    } catch (e) {}

    let realMudrexAvailINR = null;
    let realMudrexLockedINR = null;
    let realMudrexSpotINR = null;
    if (mudrexAdapter && mudrexAdapter.lastAuthCheckRes && mudrexAdapter.lastAuthCheckRes.success) {
      if (typeof mudrexAdapter.lastAuthCheckRes.futuresBalance === 'number' && mudrexAdapter.lastAuthCheckRes.futuresBalance > 0) {
        realMudrexAvailINR = mudrexAdapter.lastAuthCheckRes.futuresBalance;
        realMudrexLockedINR = Number(mudrexAdapter.lastAuthCheckRes.raw?.futures?.data?.locked_amount || 0);
        realMudrexSpotINR = Number(mudrexAdapter.lastAuthCheckRes.spotBalance || 0);
      }
    }
    // Background refresh trigger if stale (> 15 seconds)
    if (mudrexAdapter && (!mudrexAdapter.lastAuthCheckTime || (Date.now() - mudrexAdapter.lastAuthCheckTime > 15000))) {
      mudrexAdapter.testAuthentication().catch(() => {});
    }

    const startingCapitalINR = this.settings.startingCapitalINR || 300000.00;
    const lockedMarginINR = realMudrexLockedINR !== null && realMudrexLockedINR > 0 ? realMudrexLockedINR : floating.dynamicMarginUsedINR;
    const availableMarginINR = realMudrexAvailINR !== null ? realMudrexAvailINR : Math.max(0, Number((startingCapitalINR + sessionNetINR - lockedMarginINR).toFixed(2)));
    const equityINR = Number((availableMarginINR + lockedMarginINR + floating.floatingNetINR).toFixed(2));
    const spotBalanceINR = realMudrexSpotINR || 0;

    const openPairs = this.pairs.filter(p => p.status === 'OPEN').map(p => {
      const b = p.buyPosition;
      const s = p.sellPosition;
      let bPnlUSD = 0, bPnlINR = 0;
      let sPnlUSD = 0, sPnlINR = 0;

      const defQty = this.settings.contractQuantity || 4.0;
      const feeMultiplier = this.settings.conservativeFeeMultiplier || 1.40;
      if (b && b.status === 'OPEN') {
        const bQty = b.quantity || defQty;
        const g = (livePrice - b.entryPrice) * bQty;
        const c = (b.entryPrice * 0.00075 + livePrice * 0.00075) * 1.18 * bQty * feeMultiplier;
        bPnlUSD = g - c;
        bPnlINR = bPnlUSD * usdInr;
      }
      if (s && s.status === 'OPEN') {
        const sQty = s.quantity || defQty;
        const g = (s.entryPrice - livePrice) * sQty;
        const c = (s.entryPrice * 0.00075 + livePrice * 0.00075) * 1.18 * sQty * feeMultiplier;
        sPnlUSD = g - c;
        sPnlINR = sPnlUSD * usdInr;
      }

      return {
        pairId: p.pairId,
        entryPrice: p.entryPrice,
        createdAt: p.createdAt,
        buyTarget: p.buyTarget,
        sellTarget: p.sellTarget,
        quantity: p.quantity || defQty,
        status: p.status,
        netPairPnlINR: Number((bPnlINR + sPnlINR).toFixed(2)),
        buy: b ? {
          positionId: b.positionId,
          status: b.status,
          direction: 'BUY',
          entryPrice: b.entryPrice,
          entryTime: b.entryTime || p.createdAt,
          entryTimestamp: b.entryTimestamp || (b.entryTime ? new Date(b.entryTime).getTime() : (p.createdAt ? new Date(p.createdAt).getTime() : Date.now())),
          currentPrice: livePrice,
          targetPrice: Number((b.targetExitPrice || b.targetPrice || p.buyTarget || (b.entryPrice + 0.45)).toFixed(2)),
          targetExitPrice: Number((b.targetExitPrice || b.targetPrice || p.buyTarget || (b.entryPrice + 0.45)).toFixed(2)),
          quantity: b.quantity || defQty,
          distToTarget: Number(((b.targetExitPrice || b.targetPrice || p.buyTarget || (b.entryPrice + 0.45)) - livePrice).toFixed(2)),
          floatingPnlUSD: Number(bPnlUSD.toFixed(2)),
          floatingPnlINR: Number(bPnlINR.toFixed(2)),
          mudrexOrderId: b.mudrexOrderId || null,
          apiStatus: b.apiStatus || null,
          apiError: b.apiError || null
        } : null,
        sell: s ? {
          positionId: s.positionId,
          status: s.status,
          direction: 'SELL',
          entryPrice: s.entryPrice,
          entryTime: s.entryTime || p.createdAt,
          entryTimestamp: s.entryTimestamp || (s.entryTime ? new Date(s.entryTime).getTime() : (p.createdAt ? new Date(p.createdAt).getTime() : Date.now())),
          currentPrice: livePrice,
          targetPrice: Number((s.targetExitPrice || s.targetPrice || p.sellTarget || (s.entryPrice - 0.45)).toFixed(2)),
          targetExitPrice: Number((s.targetExitPrice || s.targetPrice || p.sellTarget || (s.entryPrice - 0.45)).toFixed(2)),
          quantity: s.quantity || defQty,
          distToTarget: Number((livePrice - (s.targetExitPrice || s.targetPrice || p.sellTarget || (s.entryPrice - 0.45))).toFixed(2)),
          floatingPnlUSD: Number(sPnlUSD.toFixed(2)),
          floatingPnlINR: Number(sPnlINR.toFixed(2)),
          mudrexOrderId: s.mudrexOrderId || null,
          apiStatus: s.apiStatus || null,
          apiError: s.apiError || null
        } : null
      };
    });

    // Net Summary for Hero Banner
    let netSummary = null;
    const netQty = Math.abs(floating.openBuyCount - floating.openSellCount) * (this.settings.contractQuantity || 4.0);
    const sideDisplay = floating.openBuyCount >= floating.openSellCount ? 'LONG' : 'SHORT';
    if (floating.openBuyCount > 0 || floating.openSellCount > 0) {
      netSummary = {
        symbol: 'SOLUSDT',
        sideDisplay,
        quantity: Number(netQty.toFixed(1)),
        entryPrice: livePrice,
        currentPrice: livePrice,
        initialMarginINR: lockedMarginINR,
        initialMarginUSD: Number((lockedMarginINR / usdInr).toFixed(2)),
        unrealisedPnlINR: floating.floatingNetINR,
        unrealisedPnlUSD: floating.floatingNetUSD,
        unrealisedPnlPercent: lockedMarginINR > 0 ? Number(((floating.floatingNetINR / lockedMarginINR) * 100).toFixed(2)) : 0,
        leverage: 5,
        source: 'SOLANA_SIMULATOR'
      };
    }

    const qtyBreakdown = {};
    openPairs.forEach(p => {
      const q = Number(p.quantity || this.settings.contractQuantity || 4.0);
      qtyBreakdown[q] = (qtyBreakdown[q] || 0) + 1;
    });

    return {
      success: true,
      timestamp: new Date().toISOString(),
      rate: {
        symbol: 'SOLUSDT',
        price: livePrice,
        markPrice: Number(rateInfo.markPrice || livePrice),
        indexPrice: Number(rateInfo.indexPrice || livePrice),
        usdInrRate: usdInr,
        updatedAt: rateInfo.lastTime ? new Date(rateInfo.lastTime).toISOString() : new Date().toISOString()
      },
      wallet: {
        availableMarginINR,
        availableMarginUSD: Number((availableMarginINR / usdInr).toFixed(2)),
        lockedMarginINR,
        lockedMarginUSD: Number((lockedMarginINR / usdInr).toFixed(2)),
        equityINR,
        equityUSD: Number((equityINR / usdInr).toFixed(2)),
        spotBalanceINR,
        spotBalanceUSD: Number((spotBalanceINR / usdInr).toFixed(2)),
        totalPortfolioINR: Number((equityINR + spotBalanceINR).toFixed(2)),
        totalPortfolioUSD: Number(((equityINR + spotBalanceINR) / usdInr).toFixed(2)),
        totalAvailableINR: Number((availableMarginINR + spotBalanceINR).toFixed(2)),
        totalAvailableUSD: Number(((availableMarginINR + spotBalanceINR) / usdInr).toFixed(2)),
        usdInrRate: usdInr,
        isRealMudrexExchangeWallet: realMudrexAvailINR !== null
      },
      mudrexExchange: {
        positions: [],
        count: openPairs.length,
        netSummary,
        note: realMudrexAvailINR !== null ? 'SUBH-MANI SOLANA LIVE DESK (Authoritative Mudrex Exchange Balance)' : 'SUBH-MANI SOLANA DESK'
      },
      engine: {
        status: this.engineStatus,
        isEngineRunning: this.isEngineRunning,
        activeSymbol: 'SOLUSDT',
        activePairsCount: openPairs.length,
        activeBuyCount: floating.openBuyCount,
        activeSellCount: floating.openSellCount,
        contractQuantity: this.settings.contractQuantity || 4.0,
        qtyBreakdown,
        profitTargetMove: this.settings.profitTargetMove,
        basketProfitTargetINR: this.settings.basketProfitTargetINR,
        leverage: this.settings.leverage,
        tradingMode: this.settings.tradingMode || 'LIVE',
        realOrdersDisabled: this.settings.realOrdersDisabled || false,
        engineStartedAt: this.engineStartedAt || (this.pairs[0] ? this.pairs[0].createdAt : new Date().toISOString()),
        lastResetTime: this.lastResetTime || this.engineStartedAt,
        uptimeMs,
        uptimeHours,
        uptimeFormatted,
        pairs: openPairs
      },
      punarjanm: {
        count: this.punarjanmCount,
        cycles: this.punarjanmCycles,
        basketTargetINR: this.settings.basketProfitTargetINR,
        lastHarvest: this.lastPunarjanmSummary
      },
      pnl: {
        realizedGrossINR: Number(allTimeGrossINR.toFixed(2)),
        realizedGrossUSD: Number((allTimeGrossINR / usdInr).toFixed(2)),
        realizedChargesINR: Number(allTimeChargesINR.toFixed(2)),
        realizedChargesUSD: Number((allTimeChargesINR / usdInr).toFixed(2)),
        realizedNetINR: Number(allTimeNetINR.toFixed(2)),
        realizedNetUSD: Number((allTimeNetINR / usdInr).toFixed(2)),
        totalRealizedINR: Number(allTimeNetINR.toFixed(2)),
        totalRealizedUSD: Number((allTimeNetINR / usdInr).toFixed(2)),
        sessionRealizedNetINR: Number(allTimeNetINR.toFixed(2)),
        sessionRealizedNetUSD: Number((allTimeNetINR / usdInr).toFixed(2)),
        sessionClosedCount: this.closedPositions.length,
        sessionClosedTrades: this.closedPositions.length,
        sessionWinTrades: allTimeWinCount,
        sessionLossTrades: allTimeLossCount,
        sessionWinRate: this.closedPositions.length > 0 ? Number(((allTimeWinCount / this.closedPositions.length) * 100).toFixed(1)) : 100,
        allTimeRealizedNetINR: Number(allTimeNetINR.toFixed(2)),
        allTimeRealizedNetUSD: Number((allTimeNetINR / usdInr).toFixed(2)),
        allTimeClosedTrades: this.closedPositions.length,
        floatingGrossINR: floating.floatingGrossINR,
        floatingGrossUSD: floating.floatingGrossUSD,
        floatingChargesINR: floating.floatingChargesINR,
        floatingChargesUSD: floating.floatingChargesUSD,
        floatingNetINR: floating.floatingNetINR,
        floatingNetUSD: floating.floatingNetUSD,
        totalFloatingINR: floating.floatingNetINR,
        totalFloatingUSD: floating.floatingNetUSD,
        estimatedTotalINR: Number((allTimeNetINR + floating.floatingNetINR).toFixed(2)),
        estimatedTotalUSD: Number(((allTimeNetINR + floating.floatingNetINR) / usdInr).toFixed(2)),
        winTrades: allTimeWinCount,
        lossTrades: allTimeLossCount,
        totalClosedTrades: this.closedPositions.length,
        closedTradesCount: this.closedPositions.length,
        winRate: this.closedPositions.length > 0 ? Number(((allTimeWinCount / this.closedPositions.length) * 100).toFixed(1)) : 100
      },
      closedPositions: this.closedPositions.slice(0, 100)
    };
  }

  closeLotGroup(targetQty, triggerReason = 'USER_MANUAL_LOT_CLOSE', livePrice = null, usdInrRate = 102.00) {
    const qtyTarget = parseFloat(targetQty);
    if (isNaN(qtyTarget) || qtyTarget <= 0) {
      return { success: false, error: 'Valid target lot size required' };
    }

    const price = livePrice ? Number(livePrice) : (this.lastProcessedRate || 104.50);
    const usdInr = usdInrRate || this.settings.usdInrRate || 102.00;
    const takerFee = this.settings.takerFeeRate || 0.00075;
    const gstRate = this.settings.gstRate || 0.18;

    let closedPairs = 0;
    let closedLegs = 0;
    const now = Date.now();

    for (const pair of this.pairs) {
      if (pair.status === 'CLOSED') continue;
      const pQty = Number(pair.quantity || this.settings.contractQuantity || 4.0);
      if (Math.abs(pQty - qtyTarget) > 0.05) continue; // Only target exact lot size!

      let hadOpenLeg = false;
      if (pair.buyPosition && pair.buyPosition.status === 'OPEN') {
        this.closePositionLeg(pair.buyPosition, price, now, `MANUAL CLOSE (${qtyTarget} SOL LOT)`, usdInr, takerFee, gstRate);
        closedLegs++;
        hadOpenLeg = true;
      }
      if (pair.sellPosition && pair.sellPosition.status === 'OPEN') {
        this.closePositionLeg(pair.sellPosition, price, now, `MANUAL CLOSE (${qtyTarget} SOL LOT)`, usdInr, takerFee, gstRate);
        closedLegs++;
        hadOpenLeg = true;
      }

      pair.status = 'CLOSED';
      if (hadOpenLeg) closedPairs++;
    }

    this.saveState();
    console.log(`[Solana Engine] Manual Lot Exit: Closed ${closedPairs} pairs (${closedLegs} legs) of ${qtyTarget} SOL at $${price.toFixed(2)}.`);
    return {
      success: true,
      message: `Closed all ${qtyTarget} SOL pairs (${closedPairs} pairs, ${closedLegs} trade legs).`,
      closedPairs,
      closedLegs,
      lotSize: qtyTarget
    };
  }

  cleanFloatingKachra(triggerReason = 'MANUAL_CLEAN') {
    let livePrice = 102.30;
    let usdInr = this.settings.usdInrRate || 102.00;
    try {
      const rf = rateFeed.getCurrentRate('SOLUSDT');
      if (rf && rf.price > 0) livePrice = rf.price;
      if (rf && rf.usdInrRate > 0) usdInr = rf.usdInrRate;
    } catch (e) {}

    const initialPairsCount = this.pairs.filter(p => p.status === 'OPEN').length;

    // SAFEGUARD: Preserve real Mudrex exchange positions intact! Only flush local simulated pairs.
    const realPairs = this.pairs.filter(p => {
      const bReal = p.buyPosition && (p.buyPosition.mudrexOrderId || p.buyPosition.apiStatus === 'REAL_MUDREX_POSITION');
      const sReal = p.sellPosition && (p.sellPosition.mudrexOrderId || p.sellPosition.apiStatus === 'REAL_MUDREX_POSITION');
      return bReal || sReal;
    });

    const flushedCount = this.pairs.length - realPairs.length;
    this.pairs = realPairs;
    this.processedRates.clear();
    this.lastProcessedRate = null;

    this.saveState();
    try {
      const seedFile = path.join(__dirname, 'solana_state_seed.json');
      const seedPayload = {
        timestamp: new Date().toISOString(),
        settings: this.settings,
        engineStartedAt: this.engineStartedAt,
        lastResetTime: this.lastResetTime,
        pairs: this.pairs,
        closedPositions: this.closedPositions,
        punarjanmCount: this.punarjanmCount,
        punarjanmCycles: this.punarjanmCycles,
        pairCounter: this.pairCounter,
        processedRates: Array.from(this.processedRates)
      };
      fs.writeFileSync(seedFile, JSON.stringify(seedPayload, null, 2), 'utf8');
    } catch (err) {}
    console.log(`[Solana Engine] Cleaned Floating Kachra (${triggerReason}): Flushed ${flushedCount} simulated pairs. Preserved ${realPairs.length} real exchange positions. Realized Profit and Closed Trades intact.`);
    return {
      success: true,
      message: `Simulated kachra cleared! Flushed ${flushedCount} paper pairs. Preserved ${realPairs.length} real exchange positions.`,
      flushedCount,
      preservedRealPairs: realPairs.length
    };
  }

  resetData(newQty = null, newCapital = 186682.39, newTargetMove = null) {
    this.settings.startingCapitalINR = (newCapital && !isNaN(newCapital) && Number(newCapital) > 0) ? Number(newCapital) : 186682.39;
    if (newQty && !isNaN(newQty) && Number(newQty) > 0) {
      this.settings.contractQuantity = Number(newQty);
    } else {
      this.settings.contractQuantity = 1.0;
    }
    if (newTargetMove && !isNaN(newTargetMove) && Number(newTargetMove) > 0) {
      this.settings.profitTargetMove = Number(newTargetMove);
      this.settings.buyTargetMove = Number(newTargetMove);
      this.settings.sellTargetMove = Number(newTargetMove);
    } else {
      this.settings.profitTargetMove = 0.45;
      this.settings.buyTargetMove = 0.45;
      this.settings.sellTargetMove = 0.45;
    }

    // Fail-Closed default: Never auto-enable live trading or real orders on reset
    this.settings.tradingMode = 'PAPER';
    this.settings.realOrdersDisabled = true;
    this.settings.autoPunarjanmEnabled = false;
    this.settings.autoAddNewPairs = false;
    this.settings.gridSpacing = 0.50;
    this.settings.maxActivePairs = 10;
    this.settings.maxOneSidedLegs = 5;

    // SAFEGUARD: Never delete real Mudrex positions or real closed trades!
    this.pairs = this.pairs.filter(p => {
      const bReal = p.buyPosition && (p.buyPosition.mudrexOrderId || p.buyPosition.apiStatus === 'REAL_MUDREX_POSITION');
      const sReal = p.sellPosition && (p.sellPosition.mudrexOrderId || p.sellPosition.apiStatus === 'REAL_MUDREX_POSITION');
      return bReal || sReal;
    });

    // Preserve real exchange closed positions
    this.closedPositions = this.closedPositions.filter(cp => cp.mudrexOrderId || cp.source === 'MUDREX_EXCHANGE' || cp.ledger === 'LIVE');

    this.punarjanmCount = 0;
    this.punarjanmCycles = [];
    this.processedRates.clear();
    this.lastProcessedRate = null;
    this.isEngineRunning = false;
    this.engineStatus = 'PAUSED';
    this.pauseReason = 'Engine reset into safe PAUSED state.';
    this.engineStartedAt = new Date().toISOString();
    this.lastResetTime = this.engineStartedAt;

    this.saveState();
    console.log(`[Solana Engine] Reset data: Capital set to ₹${this.settings.startingCapitalINR.toLocaleString('en-IN')} INR with ${this.settings.contractQuantity} SOL contract size in safe PAPER mode.`);
    return { 
      success: true, 
      message: `Solana data reset in safe PAPER mode: Capital ₹${this.settings.startingCapitalINR.toLocaleString('en-IN')}, lot size ${this.settings.contractQuantity} SOL. Real Mudrex exchange positions and history preserved.`, 
      contractQuantity: this.settings.contractQuantity,
      startingCapitalINR: this.settings.startingCapitalINR,
      profitTargetMove: this.settings.profitTargetMove
    };
  }
}

module.exports = new SolanaEngine();
