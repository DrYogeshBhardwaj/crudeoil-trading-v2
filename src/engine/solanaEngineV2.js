/**
 * SOL PAIR ENGINE V2 — Completely Isolated Backend Engine
 * 
 * Features:
 * 1. Independent module, separate state (solana_engine_v2_state.json) and database namespace.
 * 2. Starts with zero trades, zero realized P&L, clean history (PAPER mode, PAUSED, real orders disabled).
 * 3. Default Settings: SOLUSDT, 5.0 SOL per virtual pair, $0.45 target exit move.
 * 4. Active-price-level uniqueness: blocks entry if ANY active BUY or SELL leg occupies that price level.
 * 5. Permanent entry price immutability: live rate changes NEVER overwrite existing pair entry price.
 * 6. Dynamic release: price level released for future reuse ONLY once both legs are fully closed.
 * 7. Comprehensive safety limits: max active pairs, simulated margin, stale feed guard, order cooldown, leg imbalance.
 */

const fs = require('fs');
const path = require('path');
const rateFeed = require('./rateFeed');
const db = require('./db');

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, '../../data');
const STATE_V2_FILE = path.join(DATA_DIR, 'solana_engine_v2_state.json');
const TMP_BACKUP_V2_FILE = path.join('/tmp', 'solana_engine_v2_state.json');

class SolanaEngineV2 {
  constructor() {
    this.storagePath = STATE_V2_FILE;
    this.backupPath = TMP_BACKUP_V2_FILE;

    this.settings = {
      startingCapitalINR: 200000.00,
      contractQuantity: 5.0, // Pair Size: 5 SOL (Immutable default)
      leverage: 5,
      instrument: 'SOLUSDT',
      profitTargetMove: 0.45, // Target Move: $0.45 (Immutable default)
      buyTargetMove: 0.45,
      sellTargetMove: 0.45,
      gridSpacing: 0.50,
      priceBucketSize: 0.50,
      basketProfitTargetINR: 500.00,
      autoPunarjanmEnabled: false,
      autoAddNewPairs: true,
      maxActivePairs: 10,
      autoCleanKachraEnabled: false,
      maxFloatingLossThresholdINR: 20000.00,
      maxOneSidedLegs: 5,
      dailyFeeBudgetINR: 1000.00,
      maxDailyOrders: 50,
      priceCooldownMinutes: 5,
      takerFeeRate: 0.00075,
      gstRate: 0.18,
      conservativeFeeMultiplier: 1.40,
      slippageBufferINR: 2.00,
      usdInrRate: 102.00,
      tradingMode: 'PAPER',
      realOrdersDisabled: true
    };

    this.engineStartedAt = new Date().toISOString();
    this.lastResetTime = this.engineStartedAt;
    this.isEngineRunning = true; // Auto-start in PAPER mode for continuous hands-free operation
    this.engineStatus = 'RUNNING';
    this.pauseReason = '';

    this.pairs = [];
    this.closedPositions = [];
    this.punarjanmCount = 0;
    this.punarjanmCycles = [];
    this.pairCounter = 1;
    this.processedRates = new Set();
    this.lastProcessedRate = null;
    this.lastSkippedRate = null;
    this.lastOrderTimestamp = 0;

    // Active price level locks (in-memory fast cache)
    this.activePriceLevels = new Set();

    // Diagnostics & Evaluation Ring Buffer
    this.recentLogs = [];
    this.lastEvaluation = null;
    this.lastLogKey = '';
    this.lastLogTimestamp = 0;
    this.evaluationInterval = null;

    this.ensureDirectory();
    this.loadState();
    this.syncActivePriceLevels();
    this.initRateFeedListener();
    this.startEvaluationLoop();
  }

  ensureDirectory() {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (e) {}
  }

  loadState() {
    try {
      let data = null;
      if (fs.existsSync(this.storagePath)) {
        try {
          data = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'));
        } catch (e) {}
      } else if (fs.existsSync(this.backupPath)) {
        try {
          data = JSON.parse(fs.readFileSync(this.backupPath, 'utf8'));
        } catch (e) {}
      }

      if (data) {
        if (data.settings) this.settings = { ...this.settings, ...data.settings };
        // Enforce strict invariants
        this.settings.instrument = 'SOLUSDT';
        this.settings.contractQuantity = 5.0;
        this.settings.profitTargetMove = 0.45;
        this.settings.tradingMode = 'PAPER';
        this.settings.realOrdersDisabled = true;

        this.pairs = Array.isArray(data.pairs) ? data.pairs : [];
        this.closedPositions = Array.isArray(data.closedPositions) ? data.closedPositions : [];
        this.punarjanmCount = data.punarjanmCount || 0;
        this.punarjanmCycles = Array.isArray(data.punarjanmCycles) ? data.punarjanmCycles : [];
        this.pairCounter = data.pairCounter || (this.pairs.length + 1);

        // Keep engine running by default in PAPER mode unless explicitly paused in state
        if (data.isEngineRunning !== undefined) {
          this.isEngineRunning = Boolean(data.isEngineRunning);
          this.engineStatus = this.isEngineRunning ? 'RUNNING' : 'PAUSED';
          this.pauseReason = data.pauseReason || (this.isEngineRunning ? '' : 'Engine paused');
        } else {
          this.isEngineRunning = true;
          this.engineStatus = 'RUNNING';
          this.pauseReason = '';
        }

        if (data.engineStartedAt) this.engineStartedAt = data.engineStartedAt;
        if (data.lastResetTime) this.lastResetTime = data.lastResetTime;
        if (Array.isArray(data.processedRates)) this.processedRates = new Set(data.processedRates);

        console.log(`[Solana Engine V2] Restored state from storage: ${this.pairs.length} pairs, ${this.closedPositions.length} closed trades. Engine Status: ${this.engineStatus}`);
      } else {
        this.isEngineRunning = true;
        this.engineStatus = 'RUNNING';
        this.pauseReason = '';
        console.log('[Solana Engine V2] Clean start: Engine RUNNING in PAPER mode. Zero pairs, zero closed trades.');
      }
    } catch (e) {
      console.warn('[Solana Engine V2] Notice loading state:', e.message);
    }
  }

  saveState() {
    try {
      this.ensureDirectory();
      const payload = {
        timestamp: new Date().toISOString(),
        settings: this.settings,
        engineStartedAt: this.engineStartedAt,
        lastResetTime: this.lastResetTime,
        isEngineRunning: this.isEngineRunning,
        engineStatus: this.engineStatus,
        pauseReason: this.pauseReason,
        pairs: this.pairs,
        closedPositions: this.closedPositions.slice(0, 1000),
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
    } catch (e) {
      console.warn('[Solana Engine V2] Error saving state:', e.message);
    }
  }

  startEvaluationLoop() {
    if (this.evaluationInterval) clearInterval(this.evaluationInterval);
    // Continuous background evaluation loop every 1000ms (1s) independent of any UI requests
    this.evaluationInterval = setInterval(() => {
      this.processEvaluationCycle('BACKGROUND_TIMER');
    }, 1000);
    if (this.evaluationInterval.unref) this.evaluationInterval.unref();
    console.log('[Solana Engine V2] Continuous background price-evaluation loop started (1s interval).');
  }

  stopEvaluationLoop() {
    if (this.evaluationInterval) {
      clearInterval(this.evaluationInterval);
      this.evaluationInterval = null;
    }
  }

  initRateFeedListener() {
    if (rateFeed && typeof rateFeed.subscribe === 'function') {
      rateFeed.subscribe((type, data) => {
        if (data && data.symbol === 'SOLUSDT') {
          this.handleRateEvent(type, data);
        }
      });
    }
  }

  handleRateEvent(type, data) {
    if (!data || data.symbol !== 'SOLUSDT') return;
    this.processEvaluationCycle('WEBSOCKET_TICK', data);
  }

  processEvaluationCycle(source = 'BACKGROUND_TIMER', tickData = null) {
    if (!this.isEngineRunning) {
      this.logEvaluation('ENGINE_PAUSED', null, `Engine is PAUSED: ${this.pauseReason || 'Paused by operator'}`);
      return;
    }

    // Determine current rate: use provided tickData or poll rateFeed directly
    let livePrice = null;
    let rateObj = null;

    if (tickData && tickData.price && tickData.symbol === 'SOLUSDT') {
      livePrice = Number(tickData.price);
      rateObj = tickData;
    } else if (rateFeed && typeof rateFeed.getCurrentRate === 'function') {
      rateObj = rateFeed.getCurrentRate('SOLUSDT');
      if (rateObj && rateObj.price) {
        livePrice = Number(rateObj.price);
      }
    }

    if (!livePrice || isNaN(livePrice) || livePrice <= 0) {
      this.logEvaluation('WAITING_PRICE', null, 'Waiting for valid live SOLUSDT market price feed...');
      return;
    }

    // Stale feed check
    const tickTime = rateObj ? (rateObj.lastTime || rateObj.receivedTime || rateObj.time || Date.now()) : Date.now();
    const tickAgeMs = Date.now() - tickTime;
    if (tickAgeMs > 30000) {
      this.logEvaluation('FEED_STALE', livePrice, `SOLUSDT tick is STALE (${tickAgeMs}ms old). Skipping cycle.`);
      return;
    }

    // 1. Evaluate open positions for target profit exits
    this.evaluateOpenPositions(livePrice);

    // 2. Auto-Add new pairs on price movement if enabled
    if (this.settings.autoAddNewPairs) {
      this.evaluateRateForNewPair(livePrice, source);
    }
  }

  logEvaluation(code, price, message) {
    const now = Date.now();
    this.lastEvaluation = {
      timestamp: new Date().toISOString(),
      code,
      price: price ? Number(price.toFixed(2)) : null,
      message
    };

    // Console logging: log high-priority events immediately, throttle repetitive heartbeat logs
    const isPriorityEvent = (code === 'PAIR_CREATED' || code === 'TARGET_HIT' || code === 'FULL_PAIR_CLOSED' || code === 'PUNARJANM');
    const logKey = `${code}_${price ? price.toFixed(1) : 'NONE'}`;
    const isHeartbeatDue = (now - this.lastLogTimestamp > 15000);

    if (isPriorityEvent || this.lastLogKey !== logKey || isHeartbeatDue) {
      this.lastLogKey = logKey;
      this.lastLogTimestamp = now;
      console.log(`[Solana Engine V2] [${code}] ${message}`);
    }

    if (!this.recentLogs) this.recentLogs = [];
    this.recentLogs.unshift({
      timestamp: new Date().toISOString(),
      code,
      price: price ? Number(price.toFixed(2)) : null,
      message
    });
    if (this.recentLogs.length > 50) this.recentLogs.pop();
  }

  // --- ACTIVE PRICE-LEVEL REGISTRY & LOCKING ---

  syncActivePriceLevels() {
    this.activePriceLevels.clear();
    const bucketSize = Number(this.settings.priceBucketSize || this.settings.gridSpacing || 0.50);

    const activePairs = this.pairs.filter(p => {
      const bOpen = p.buyPosition && p.buyPosition.status === 'OPEN';
      const sOpen = p.sellPosition && p.sellPosition.status === 'OPEN';
      return p.status === 'OPEN' || bOpen || sOpen;
    });

    for (const p of activePairs) {
      const price = Number(p.entryPrice || (p.buyPosition && p.buyPosition.entryPrice) || (p.sellPosition && p.sellPosition.entryPrice));
      if (!price || isNaN(price) || price <= 0) continue;
      const norm = this.getNormalizedPriceBucket(price, bucketSize);
      if (norm) {
        this.activePriceLevels.add(norm.bucketKey);
        this.activePriceLevels.add(norm.normalizedPrice.toFixed(4));
      }
    }

    try {
      if (db && typeof db.syncActivePriceReservationsV2 === 'function') {
        db.syncActivePriceReservationsV2('SOLUSDT', activePairs, bucketSize);
      }
    } catch (e) {}

    console.log(`[Solana Engine V2] Active Price Locks initialized: ${this.activePriceLevels.size} active price buckets occupied.`);
  }

  getNormalizedPriceBucket(price, bucketSize = this.settings.priceBucketSize || 0.50) {
    return db.normalizePriceBucket(price, bucketSize);
  }

  isPriceLevelOccupied(price, bucketSize = this.settings.priceBucketSize || 0.50) {
    const norm = this.getNormalizedPriceBucket(price, bucketSize);
    if (!norm) return false;

    // 1. Fast in-memory check
    if (this.activePriceLevels.has(norm.bucketKey) || this.activePriceLevels.has(norm.normalizedPrice.toFixed(4))) {
      return true;
    }

    // 2. Persistent SQLite DB check
    if (db && typeof db.isActivePriceOccupiedV2 === 'function') {
      if (db.isActivePriceOccupiedV2('SOLUSDT', price, bucketSize)) {
        this.activePriceLevels.add(norm.bucketKey);
        this.activePriceLevels.add(norm.normalizedPrice.toFixed(4));
        return true;
      }
    }

    // 3. Memory cross-check of active pairs (strictly ignore closed pairs)
    for (const p of this.pairs) {
      if (p.status === 'CLOSED') continue;
      const bOpen = p.buyPosition && p.buyPosition.status === 'OPEN';
      const sOpen = p.sellPosition && p.sellPosition.status === 'OPEN';
      if (!bOpen && !sOpen) continue; // Both legs closed -> level is free

      if (!p.entryPrice) continue;
      const pNorm = this.getNormalizedPriceBucket(p.entryPrice, bucketSize);
      if (pNorm && pNorm.bucketKey === norm.bucketKey) {
        this.activePriceLevels.add(norm.bucketKey);
        this.activePriceLevels.add(norm.normalizedPrice.toFixed(4));
        return true;
      }
    }

    // Historical closed positions do NOT block any price level!
    return false;
  }

  releaseActivePriceLevel(pair) {
    if (!pair || !pair.entryPrice) return;
    const bucketSize = Number(this.settings.priceBucketSize || 0.50);
    const norm = this.getNormalizedPriceBucket(pair.entryPrice, bucketSize);
    if (norm) {
      this.activePriceLevels.delete(norm.bucketKey);
      this.activePriceLevels.delete(norm.normalizedPrice.toFixed(4));
    }
    if (db && typeof db.releaseActivePriceLevelV2 === 'function') {
      db.releaseActivePriceLevelV2('SOLUSDT', pair.pairId, norm ? norm.bucketKey : null);
    }
  }

  isPriceReservedByActiveTarget(price, tolerance = null) {
    const p = Number(price);
    if (!p || isNaN(p) || p <= 0) return { reserved: false };
    const tol = tolerance !== null ? tolerance : 0.05;

    for (const pair of this.pairs) {
      if (pair.status === 'CLOSED') continue;
      if (pair.buyPosition && pair.buyPosition.status === 'OPEN' && pair.buyTarget) {
        if (Math.abs(p - pair.buyTarget) <= tol) {
          return { reserved: true, type: 'BUY_TARGET', pairId: pair.pairId, targetPrice: pair.buyTarget };
        }
      }
      if (pair.sellPosition && pair.sellPosition.status === 'OPEN' && pair.sellTarget) {
        if (Math.abs(p - pair.sellTarget) <= tol) {
          return { reserved: true, type: 'SELL_TARGET', pairId: pair.pairId, targetPrice: pair.sellTarget };
        }
      }
    }
    return { reserved: false };
  }

  reservePriceLevel(rawPrice, pairId = null, bucketSize = this.settings.priceBucketSize || 0.50, direction = 'BOTH') {
    const res = db.reserveActivePriceLevelV2('SOLUSDT', rawPrice, pairId, bucketSize, direction);
    if (res.success && res.bucketKey) {
      this.activePriceLevels.add(res.bucketKey);
      this.activePriceLevels.add(res.normalizedPrice.toFixed(4));
    }
    return res;
  }

  // --- SAFETY LIMITS & CHECKS ---

  canOpenNewPair(price) {
    if (!this.isEngineRunning) return { allowed: false, reason: 'ENGINE_PAUSED' };

    // 1. Max active pairs check
    const activePairsCount = this.pairs.filter(p => p.status === 'OPEN').length;
    if (activePairsCount >= this.settings.maxActivePairs) {
      return { allowed: false, reason: `MAX_ACTIVE_PAIRS_REACHED (${activePairsCount}/${this.settings.maxActivePairs})` };
    }

    // 2. Margin availability check
    const marginReq = this.calculateRequiredMarginForPair(price);
    const availMargin = this.calculateAuthoritativeAvailableMargin(price);
    if (availMargin < marginReq) {
      return { allowed: false, reason: `INSUFFICIENT_MARGIN (Required: ₹${marginReq.toFixed(2)}, Available: ₹${availMargin.toFixed(2)})` };
    }

    // 3. Leg imbalance check
    let buyCount = 0;
    let sellCount = 0;
    for (const p of this.pairs) {
      if (p.buyPosition && p.buyPosition.status === 'OPEN') buyCount++;
      if (p.sellPosition && p.sellPosition.status === 'OPEN') sellCount++;
    }
    const diff = Math.abs(buyCount - sellCount);
    if (diff >= this.settings.maxOneSidedLegs) {
      return { allowed: false, reason: `LEG_IMBALANCE_LIMIT (Buys: ${buyCount}, Sells: ${sellCount}, Diff: ${diff}/${this.settings.maxOneSidedLegs})` };
    }

    // 4. Rate limit cooldown (e.g. 5 seconds minimum between pair creations)
    const now = Date.now();
    if (now - this.lastOrderTimestamp < 3000) {
      return { allowed: false, reason: 'ORDER_FREQUENCY_COOLDOWN' };
    }

    return { allowed: true };
  }

  calculateRequiredMarginForPair(price) {
    const p = Number(price) || 105.00;
    const qty = Number(this.settings.contractQuantity) || 5.0;
    const lev = Number(this.settings.leverage) || 5;
    const usdInr = Number(this.settings.usdInrRate) || 102.00;
    // 2 legs (BUY + SELL)
    const notionalUSD = p * qty * 2;
    const marginUSD = notionalUSD / lev;
    return marginUSD * usdInr;
  }

  calculateAuthoritativeAvailableMargin(currentPrice = null) {
    const startCap = Number(this.settings.startingCapitalINR) || 200000.00;
    const realized = this.calculateRealizedSummary().realizedNetINR;
    let lockedMargin = 0;
    const lev = Number(this.settings.leverage) || 5;
    const usdInr = Number(this.settings.usdInrRate) || 102.00;

    for (const p of this.pairs) {
      if (p.buyPosition && p.buyPosition.status === 'OPEN') {
        const notional = (p.buyPosition.entryPrice || 105.00) * (p.buyPosition.quantity || 5.0);
        lockedMargin += (notional / lev) * usdInr;
      }
      if (p.sellPosition && p.sellPosition.status === 'OPEN') {
        const notional = (p.sellPosition.entryPrice || 105.00) * (p.sellPosition.quantity || 5.0);
        lockedMargin += (notional / lev) * usdInr;
      }
    }

    const avail = (startCap + realized) - lockedMargin;
    return Math.max(0, avail);
  }

  // --- PAIR CREATION CYCLE ---

  evaluateRateForNewPair(livePrice, source = 'EVAL') {
    const numPrice = Number(livePrice);
    if (!numPrice || isNaN(numPrice) || numPrice <= 0) return;

    const bucketSize = Number(this.settings.priceBucketSize || 0.50);
    const norm = this.getNormalizedPriceBucket(numPrice, bucketSize);
    if (!norm) {
      this.logEvaluation('INVALID_BUCKET', numPrice, 'Could not determine price bucket.');
      return;
    }

    // Check if level is already occupied
    if (this.isPriceLevelOccupied(numPrice, bucketSize)) {
      this.lastSkippedRate = numPrice;
      this.logEvaluation('LEVEL_OCCUPIED', numPrice, `Price level $${numPrice.toFixed(2)} (${norm.bucketKey}) is currently occupied by an active position.`);
      return;
    }

    // Target reservation check
    const targetCheck = this.isPriceReservedByActiveTarget(numPrice);
    if (targetCheck.reserved) {
      this.lastSkippedRate = numPrice;
      this.logEvaluation('TARGET_RESERVED', numPrice, `Price level $${numPrice.toFixed(2)} is reserved by active ${targetCheck.type} for ${targetCheck.pairId} ($${targetCheck.targetPrice}).`);
      return;
    }

    // Safety checks
    const check = this.canOpenNewPair(numPrice);
    if (!check.allowed) {
      this.lastSkippedRate = numPrice;
      this.logEvaluation('SAFETY_BLOCKED', numPrice, `Safety condition blocked pair creation: ${check.reason}`);
      return;
    }

    // Create the pair!
    const pair = this.createNewPair('SOLUSDT', numPrice, Date.now());
    if (pair) {
      this.logEvaluation('PAIR_CREATED', numPrice, `AUTOMATIC PAIR CREATED: ${pair.pairId} at $${numPrice.toFixed(2)} (BUY: $${pair.buyTarget}, SELL: $${pair.sellTarget}) via ${source}`);
      console.log(`[Solana Engine V2] Created Pair ${pair.pairId} at entry price $${numPrice.toFixed(2)} (Targets: BUY $${pair.buyTarget}, SELL $${pair.sellTarget}).`);
    }
  }

  createNewPair(symbol, price, timestamp = Date.now(), usdInrRate = 102.00, customQty = null, customTarget = null) {
    const numPrice = Number(price);
    if (!numPrice || isNaN(numPrice) || numPrice <= 0) {
      console.warn(`[Solana Engine V2] createNewPair rejected: Invalid price ${price}`);
      return null;
    }

    const bucketSize = Number(this.settings.priceBucketSize || 0.50);

    // 0. Safety limit check: max active pairs
    const activePairsCount = this.pairs.filter(p => p.status === 'OPEN').length;
    if (activePairsCount >= this.settings.maxActivePairs) {
      console.warn(`[Solana Engine V2] createNewPair BLOCKED: maxActivePairs limit reached (${activePairsCount}/${this.settings.maxActivePairs}).`);
      return null;
    }

    // 1. Active occupancy check
    if (this.isPriceLevelOccupied(numPrice, bucketSize)) {
      const norm = this.getNormalizedPriceBucket(numPrice, bucketSize);
      console.warn(`[Solana Engine V2] createNewPair BLOCKED: Price level $${numPrice.toFixed(2)} (${norm ? norm.bucketKey : 'N/A'}) is ACTIVE.`);
      return null;
    }

    // 2. Active target reservation check
    const targetCheck = this.isPriceReservedByActiveTarget(numPrice);
    if (targetCheck.reserved) {
      console.warn(`[Solana Engine V2] createNewPair BLOCKED: Price $${numPrice.toFixed(2)} is reserved by ${targetCheck.type} for ${targetCheck.pairId}.`);
      return null;
    }

    const pairId = `PAIR-V2-${this.pairCounter.toString().padStart(4, '0')}`;

    // 3. Atomic Database Price Lock Reservation
    const reserveRes = this.reservePriceLevel(numPrice, pairId, bucketSize, 'BOTH');
    if (!reserveRes.success) {
      console.warn(`[Solana Engine V2] createNewPair BLOCKED: Atomic DB reservation failed for $${numPrice.toFixed(2)} (${reserveRes.reason})`);
      return null;
    }

    this.pairCounter++;
    this.lastOrderTimestamp = Date.now();

    // Invariable Settings: 5.0 SOL, $0.45 target move
    const qty = customQty !== null ? Number(customQty) : Number(this.settings.contractQuantity || 5.0);
    const targetMove = customTarget !== null ? Number(customTarget) : Number(this.settings.profitTargetMove || 0.45);

    const buyTarget = Number((numPrice + targetMove).toFixed(2));
    const sellTarget = Number((numPrice - targetMove).toFixed(2));

    const buyPos = {
      pairId,
      positionId: `P-${pairId}-BUY`,
      direction: 'BUY',
      symbol: 'SOLUSDT',
      entryTime: new Date(timestamp).toISOString(),
      entryTimestamp: timestamp,
      entryPrice: numPrice, // IMMUTABLE: never overwritten by live ticks
      targetExitPrice: buyTarget,
      quantity: qty,
      status: 'OPEN',
      ledger: 'PAPER',
      source: 'SOLANA_V2_SIMULATOR'
    };

    const sellPos = {
      pairId,
      positionId: `P-${pairId}-SELL`,
      direction: 'SELL',
      symbol: 'SOLUSDT',
      entryTime: new Date(timestamp).toISOString(),
      entryTimestamp: timestamp,
      entryPrice: numPrice, // IMMUTABLE: never overwritten by live ticks
      targetExitPrice: sellTarget,
      quantity: qty,
      status: 'OPEN',
      ledger: 'PAPER',
      source: 'SOLANA_V2_SIMULATOR'
    };

    const pair = {
      pairId,
      symbol: 'SOLUSDT',
      entryPrice: numPrice, // IMMUTABLE: permanently retains original entry price
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
    this.processedRates.add(numPrice);
    this.lastProcessedRate = numPrice;

    this.saveState();
    return pair;
  }

  // --- POSITION EVALUATION & CLOSURE ---

  evaluateOpenPositions(livePrice) {
    const price = Number(livePrice);
    if (!price || isNaN(price) || price <= 0) return;

    const now = Date.now();
    const usdInr = Number(this.settings.usdInrRate) || 102.00;
    const takerFee = Number(this.settings.takerFeeRate) || 0.00075;
    const gstRate = Number(this.settings.gstRate) || 0.18;

    for (const pair of this.pairs) {
      if (pair.status === 'CLOSED') continue;

      // BUY leg: exits if live price >= buyTarget
      if (pair.buyPosition && pair.buyPosition.status === 'OPEN') {
        if (price >= pair.buyPosition.targetExitPrice) {
          const res = this.closePositionLeg(pair.buyPosition, price, now, 'BUY TARGET HIT', usdInr, takerFee, gstRate);
          this.logEvaluation('TARGET_HIT', price, `BUY TARGET HIT for ${pair.pairId}: Exit at $${price.toFixed(2)} (Target was $${pair.buyPosition.targetExitPrice}). Net PnL: ₹${res?.closedPosition?.netProfitINR}`);
        }
      }

      // SELL leg: exits if live price <= sellTarget
      if (pair.sellPosition && pair.sellPosition.status === 'OPEN') {
        if (price <= pair.sellPosition.targetExitPrice) {
          const res = this.closePositionLeg(pair.sellPosition, price, now, 'SELL TARGET HIT', usdInr, takerFee, gstRate);
          this.logEvaluation('TARGET_HIT', price, `SELL TARGET HIT for ${pair.pairId}: Exit at $${price.toFixed(2)} (Target was $${pair.sellPosition.targetExitPrice}). Net PnL: ₹${res?.closedPosition?.netProfitINR}`);
        }
      }

      // Check full closure of pair
      const bOpen = pair.buyPosition && pair.buyPosition.status === 'OPEN';
      const sOpen = pair.sellPosition && pair.sellPosition.status === 'OPEN';
      if (!bOpen && !sOpen) {
        if (pair.status !== 'CLOSED') {
          pair.status = 'CLOSED';
          this.releaseActivePriceLevel(pair);
          this.logEvaluation('FULL_PAIR_CLOSED', pair.entryPrice, `PAIR ${pair.pairId} FULLY CLOSED: Price level $${pair.entryPrice.toFixed(2)} released for future reuse.`);
          console.log(`[Solana Engine V2] PAIR ${pair.pairId} FULLY CLOSED: Price level $${pair.entryPrice.toFixed(2)} released for future reuse.`);
        }
      }
    }
  }

  closePositionLeg(pos, exitPrice, exitTime = Date.now(), exitReason = 'TARGET HIT', usdInr = 102.00, takerFee = 0.00075, gstRate = 0.18, actualFilledQty = null) {
    if (!pos || pos.status === 'CLOSED') return null;

    const totalQty = pos.quantity || 5.0;
    const filledQty = (actualFilledQty !== null && actualFilledQty > 0 && actualFilledQty < totalQty) ? actualFilledQty : totalQty;
    const isPartial = filledQty < totalQty;

    let residualPos = null;
    if (isPartial) {
      const remQty = Number((totalQty - filledQty).toFixed(4));
      residualPos = {
        ...pos,
        positionId: `${pos.positionId}-RESIDUAL-${Date.now().toString().slice(-4)}`,
        quantity: remQty,
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

    // Check if parent pair is now fully closed and release price level
    const parentPair = this.pairs.find(p => p.pairId === pos.pairId || (p.buyPosition === pos || p.sellPosition === pos));
    if (parentPair) {
      const isBuyClosed = !parentPair.buyPosition || parentPair.buyPosition.status === 'CLOSED';
      const isSellClosed = !parentPair.sellPosition || parentPair.sellPosition.status === 'CLOSED';
      const hasResidual = (parentPair.buyPosition && parentPair.buyPosition.isResidual) || (parentPair.sellPosition && parentPair.sellPosition.isResidual);
      if (isBuyClosed && isSellClosed && !hasResidual) {
        if (parentPair.status !== 'CLOSED') {
          parentPair.status = 'CLOSED';
          this.releaseActivePriceLevel(parentPair);
          console.log(`[Solana Engine V2] PAIR ${parentPair.pairId} FULLY CLOSED: Price level $${parentPair.entryPrice.toFixed(2)} released for future reuse.`);
        }
      }
    }

    this.closedPositions.unshift({ ...pos });
    this.saveState();
    return { closedPosition: pos, residualPosition: residualPos };
  }

  // --- METRICS & ACCOUNTING ---

  calculateRealizedSummary() {
    let grossUSD = 0, grossINR = 0, chargesUSD = 0, chargesINR = 0, netUSD = 0, netINR = 0;
    for (const cp of this.closedPositions) {
      grossUSD += Number(cp.grossProfitUSD || 0);
      grossINR += Number(cp.grossProfitINR || 0);
      chargesUSD += Number(cp.totalChargesUSD || 0);
      chargesINR += Number(cp.totalChargesINR || 0);
      netUSD += Number(cp.netProfitUSD || 0);
      netINR += Number(cp.netProfitINR || 0);
    }
    return {
      realizedGrossUSD: Number(grossUSD.toFixed(4)),
      realizedGrossINR: Number(grossINR.toFixed(2)),
      realizedChargesUSD: Number(chargesUSD.toFixed(4)),
      realizedChargesINR: Number(chargesINR.toFixed(2)),
      realizedNetUSD: Number(netUSD.toFixed(4)),
      realizedNetINR: Number(netINR.toFixed(2)),
      closedCount: this.closedPositions.length
    };
  }

  calculateFloatingSummary(livePrice = null) {
    let curPrice = Number(livePrice);
    if (!curPrice || isNaN(curPrice) || curPrice <= 0) {
      const rf = rateFeed.getCurrentRate('SOLUSDT');
      curPrice = (rf && rf.price > 0) ? rf.price : 105.00;
    }
    const usdInr = Number(this.settings.usdInrRate) || 102.00;
    const takerFee = Number(this.settings.takerFeeRate) || 0.00075;
    const gstRate = Number(this.settings.gstRate) || 0.18;
    const feeMult = Number(this.settings.conservativeFeeMultiplier) || 1.40;

    let floatingGrossUSD = 0, floatingChargesUSD = 0;

    for (const p of this.pairs) {
      if (p.status === 'CLOSED') continue;

      if (p.buyPosition && p.buyPosition.status === 'OPEN') {
        const qty = Number(p.buyPosition.quantity) || 5.0;
        const entry = Number(p.buyPosition.entryPrice);
        const gross = (curPrice - entry) * qty;
        const exitFee = curPrice * qty * takerFee;
        const entryFee = entry * qty * takerFee;
        const gst = (entryFee + exitFee) * gstRate;
        const charges = (entryFee + exitFee + gst) * feeMult;
        floatingGrossUSD += gross;
        floatingChargesUSD += charges;
      }

      if (p.sellPosition && p.sellPosition.status === 'OPEN') {
        const qty = Number(p.sellPosition.quantity) || 5.0;
        const entry = Number(p.sellPosition.entryPrice);
        const gross = (entry - curPrice) * qty;
        const exitFee = curPrice * qty * takerFee;
        const entryFee = entry * qty * takerFee;
        const gst = (entryFee + exitFee) * gstRate;
        const charges = (entryFee + exitFee + gst) * feeMult;
        floatingGrossUSD += gross;
        floatingChargesUSD += charges;
      }
    }

    const floatingNetUSD = floatingGrossUSD - floatingChargesUSD;
    const floatingGrossINR = floatingGrossUSD * usdInr;
    const floatingChargesINR = floatingChargesUSD * usdInr;
    const floatingNetINR = floatingNetUSD * usdInr;

    return {
      floatingGrossUSD: Number(floatingGrossUSD.toFixed(4)),
      floatingGrossINR: Number(floatingGrossINR.toFixed(2)),
      floatingChargesUSD: Number(floatingChargesUSD.toFixed(4)),
      floatingChargesINR: Number(floatingChargesINR.toFixed(2)),
      floatingNetUSD: Number(floatingNetUSD.toFixed(4)),
      floatingNetINR: Number(floatingNetINR.toFixed(2))
    };
  }

  getDashboardMetrics() {
    const rf = rateFeed.getCurrentRate('SOLUSDT') || {};
    const livePrice = Number(rf.price || 105.00);
    const usdInr = Number(rf.usdInrRate || this.settings.usdInrRate || 102.00);

    const realized = this.calculateRealizedSummary();
    const floating = this.calculateFloatingSummary(livePrice);
    const totalNetINR = realized.realizedNetINR + floating.floatingNetINR;
    const totalNetUSD = realized.realizedNetUSD + floating.floatingNetUSD;

    const startCap = Number(this.settings.startingCapitalINR) || 200000.00;
    const availMargin = this.calculateAuthoritativeAvailableMargin(livePrice);
    const lockedMargin = Math.max(0, (startCap + realized.realizedNetINR) - availMargin);

    const activePairs = this.pairs.filter(p => p.status === 'OPEN');
    let buyCount = 0;
    let sellCount = 0;
    for (const p of activePairs) {
      if (p.buyPosition && p.buyPosition.status === 'OPEN') buyCount++;
      if (p.sellPosition && p.sellPosition.status === 'OPEN') sellCount++;
    }

    // Format pairs for UI display with immutable entry price & dynamic target distances
    const formattedPairs = activePairs.map(p => {
      const bPos = p.buyPosition;
      const sPos = p.sellPosition;
      const bPnlUSD = bPos && bPos.status === 'OPEN' ? (livePrice - bPos.entryPrice) * bPos.quantity : null;
      const sPnlUSD = sPos && sPos.status === 'OPEN' ? (sPos.entryPrice - livePrice) * sPos.quantity : null;

      return {
        pairId: p.pairId,
        entryPrice: p.entryPrice,
        createdAt: p.createdAt,
        buyTarget: p.buyTarget,
        sellTarget: p.sellTarget,
        quantity: p.quantity,
        status: p.status,
        netPairPnlINR: ((bPnlUSD || 0) + (sPnlUSD || 0)) * usdInr,
        buy: bPos ? {
          positionId: bPos.positionId,
          status: bPos.status,
          direction: 'BUY',
          entryPrice: bPos.entryPrice, // IMMUTABLE
          currentPrice: livePrice,
          targetPrice: p.buyTarget,
          targetExitPrice: p.buyTarget,
          quantity: bPos.quantity,
          distToTarget: Number((p.buyTarget - livePrice).toFixed(2)),
          floatingPnlUSD: bPnlUSD !== null ? Number(bPnlUSD.toFixed(2)) : null,
          floatingPnlINR: bPnlUSD !== null ? Number((bPnlUSD * usdInr).toFixed(2)) : null
        } : null,
        sell: sPos ? {
          positionId: sPos.positionId,
          status: sPos.status,
          direction: 'SELL',
          entryPrice: sPos.entryPrice, // IMMUTABLE
          currentPrice: livePrice,
          targetPrice: p.sellTarget,
          targetExitPrice: p.sellTarget,
          quantity: sPos.quantity,
          distToTarget: Number((livePrice - p.sellTarget).toFixed(2)),
          floatingPnlUSD: sPnlUSD !== null ? Number(sPnlUSD.toFixed(2)) : null,
          floatingPnlINR: sPnlUSD !== null ? Number((sPnlUSD * usdInr).toFixed(2)) : null
        } : null
      };
    });

    const activeLocks = Array.from(this.activePriceLevels);

    return {
      success: true,
      timestamp: new Date().toISOString(),
      engineVersion: 'V2',
      rate: {
        price: livePrice,
        symbol: 'SOLUSDT',
        usdInrRate: usdInr,
        status: rf.status || 'LIVE',
        source: 'Mudrex LIVE WebSocket'
      },
      wallet: {
        availableMarginINR: availMargin,
        availableMarginUSD: Number((availMargin / usdInr).toFixed(2)),
        lockedMarginINR: lockedMargin,
        lockedMarginUSD: Number((lockedMargin / usdInr).toFixed(2)),
        equityINR: startCap + totalNetINR,
        equityUSD: Number(((startCap + totalNetINR) / usdInr).toFixed(2)),
        spotBalanceINR: 0,
        spotBalanceUSD: 0,
        totalPortfolioINR: startCap + totalNetINR,
        totalPortfolioUSD: Number(((startCap + totalNetINR) / usdInr).toFixed(2)),
        totalAvailableINR: availMargin,
        totalAvailableUSD: Number((availMargin / usdInr).toFixed(2)),
        usdInrRate: usdInr,
        isRealMudrexExchangeWallet: false
      },
      engine: {
        version: 'V2',
        name: 'SOL Pair Engine V2',
        status: this.engineStatus,
        isEngineRunning: this.isEngineRunning,
        activeSymbol: 'SOLUSDT',
        activePairsCount: activePairs.length,
        activeBuyCount: buyCount,
        activeSellCount: sellCount,
        contractQuantity: this.settings.contractQuantity,
        profitTargetMove: this.settings.profitTargetMove,
        basketProfitTargetINR: this.settings.basketProfitTargetINR,
        leverage: this.settings.leverage,
        tradingMode: this.settings.tradingMode,
        realOrdersDisabled: this.settings.realOrdersDisabled,
        engineStartedAt: this.engineStartedAt,
        lastResetTime: this.lastResetTime,
        uptimeFormatted: this.getUptimeFormatted(),
        pairs: formattedPairs,
        activePriceLocksCount: this.activePriceLevels.size,
        lastEvaluation: this.lastEvaluation || null,
        recentLogs: (this.recentLogs || []).slice(0, 30)
      },
      punarjanm: {
        count: this.punarjanmCount,
        cycles: this.punarjanmCycles,
        thresholdINR: this.settings.basketProfitTargetINR,
        autoEnabled: this.settings.autoPunarjanmEnabled
      },
      pnl: {
        realizedNetINR: realized.realizedNetINR,
        realizedNetUSD: realized.realizedNetUSD,
        floatingNetINR: floating.floatingNetINR,
        floatingNetUSD: floating.floatingNetUSD,
        totalEstimatedINR: Number(totalNetINR.toFixed(2)),
        totalEstimatedUSD: Number(totalNetUSD.toFixed(2)),
        totalChargesPaidINR: realized.realizedChargesINR,
        totalChargesPaidUSD: realized.realizedChargesUSD,
        closedTradesCount: this.closedPositions.length
      },
      closedPositions: this.closedPositions.slice(0, 500),
      activeLocks
    };
  }

  getUptimeFormatted() {
    const started = new Date(this.engineStartedAt).getTime();
    const diff = Math.max(0, Date.now() - started);
    const totalSecs = Math.floor(diff / 1000);
    const hrs = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    return `${hrs}h ${mins}m`;
  }

  // --- ACTIONS ---

  startEngine() {
    this.isEngineRunning = true;
    this.engineStatus = 'RUNNING';
    this.pauseReason = '';
    this.startEvaluationLoop();
    this.saveState();
    this.logEvaluation('ENGINE_STARTED', null, 'SOL Pair Engine V2 started in automatic PAPER mode.');
    console.log('[Solana Engine V2] Engine STARTED in automatic PAPER mode.');
    this.processEvaluationCycle('MANUAL_START');
    return { success: true, message: 'SOL Pair Engine V2 started successfully in PAPER mode.' };
  }

  pauseEngine(reason = 'Operator paused engine') {
    this.isEngineRunning = false;
    this.engineStatus = 'PAUSED';
    this.pauseReason = reason;
    this.saveState();
    this.logEvaluation('ENGINE_PAUSED', null, `SOL Pair Engine V2 PAUSED: ${reason}`);
    console.log(`[Solana Engine V2] Engine PAUSED: ${reason}`);
    return { success: true, message: 'SOL Pair Engine V2 paused successfully.', reason };
  }

  resetData(newQty = null, newCapital = 200000.00, newTargetMove = null, keepRunning = true) {
    this.settings.startingCapitalINR = (newCapital && !isNaN(newCapital) && Number(newCapital) > 0) ? Number(newCapital) : 200000.00;
    this.settings.contractQuantity = 5.0; // Invariable
    this.settings.profitTargetMove = 0.45; // Invariable
    this.settings.buyTargetMove = 0.45;
    this.settings.sellTargetMove = 0.45;

    this.settings.tradingMode = 'PAPER';
    this.settings.realOrdersDisabled = true;
    this.settings.autoPunarjanmEnabled = false;
    this.settings.autoAddNewPairs = true;

    this.pairs = [];
    this.closedPositions = [];
    this.punarjanmCount = 0;
    this.punarjanmCycles = [];
    this.processedRates.clear();
    this.lastProcessedRate = null;
    this.lastSkippedRate = null;
    this.isEngineRunning = Boolean(keepRunning);
    this.engineStatus = this.isEngineRunning ? 'RUNNING' : 'PAUSED';
    this.pauseReason = this.isEngineRunning ? '' : 'Engine reset into clean initial state.';
    this.engineStartedAt = new Date().toISOString();
    this.lastResetTime = this.engineStartedAt;
    this.pairCounter = 1;
    this.recentLogs = [];
    this.lastEvaluation = null;

    this.syncActivePriceLevels();
    this.saveState();

    console.log(`[Solana Engine V2] Reset: Fresh engine initialized with 0 trades, 0 P&L. Engine Status: ${this.engineStatus}`);
    return {
      success: true,
      message: 'SOL Pair Engine V2 cleanly reset. 0 active pairs, 0 closed trades.',
      contractQuantity: this.settings.contractQuantity,
      startingCapitalINR: this.settings.startingCapitalINR,
      profitTargetMove: this.settings.profitTargetMove,
      isEngineRunning: this.isEngineRunning,
      engineStatus: this.engineStatus
    };
  }

  cleanFloatingKachra(reason = 'MANUAL_CLEAN') {
    const flushedCount = this.pairs.length;
    this.pairs = [];
    this.processedRates.clear();
    this.lastProcessedRate = null;
    this.syncActivePriceLevels();
    this.saveState();

    console.log(`[Solana Engine V2] Cleaned simulated floating kachra (${reason}): Flushed ${flushedCount} pairs.`);
    return {
      success: true,
      message: `Simulated kachra cleared! Flushed ${flushedCount} paper pairs.`,
      flushedCount
    };
  }

  executePunarjanm(triggerReason = 'MANUAL_USER_REQUEST', currentRate = null, usdInr = 102.00) {
    let livePrice = Number(currentRate);
    if (!livePrice || isNaN(livePrice) || livePrice <= 0) {
      const rf = rateFeed.getCurrentRate('SOLUSDT');
      livePrice = (rf && rf.price > 0) ? rf.price : 105.00;
    }

    const now = Date.now();
    const takerFee = Number(this.settings.takerFeeRate) || 0.00075;
    const gstRate = Number(this.settings.gstRate) || 0.18;

    let closedPairsCount = 0;
    let closedLegsCount = 0;

    for (const p of this.pairs) {
      if (p.status === 'CLOSED') continue;
      if (p.buyPosition && p.buyPosition.status === 'OPEN') {
        this.closePositionLeg(p.buyPosition, livePrice, now, `PUNARJANM HARVEST (#${this.punarjanmCount + 1})`, usdInr, takerFee, gstRate);
        closedLegsCount++;
      }
      if (p.sellPosition && p.sellPosition.status === 'OPEN') {
        this.closePositionLeg(p.sellPosition, livePrice, now, `PUNARJANM HARVEST (#${this.punarjanmCount + 1})`, usdInr, takerFee, gstRate);
        closedLegsCount++;
      }
      p.status = 'CLOSED';
      closedPairsCount++;
    }

    this.punarjanmCount++;
    const cycleRecord = {
      cycleNumber: this.punarjanmCount,
      timestamp: new Date().toISOString(),
      triggerReason,
      livePrice,
      closedPairsCount,
      closedLegsCount
    };
    this.punarjanmCycles.unshift(cycleRecord);

    this.syncActivePriceLevels();

    // Spawn a fresh new pair at live price
    const freshPair = this.createNewPair('SOLUSDT', livePrice, now, usdInr);

    this.saveState();
    console.log(`[Solana Engine V2] Punarjanm #${this.punarjanmCount} executed: Closed ${closedPairsCount} pairs (${closedLegsCount} legs). Spawned fresh pair ${freshPair ? freshPair.pairId : 'N/A'}.`);
    return {
      success: true,
      cycleNumber: this.punarjanmCount,
      closedPairsCount,
      closedLegsCount,
      freshPair,
      message: `Punarjanm #${this.punarjanmCount} completed! Harvested ${closedPairsCount} pairs.`
    };
  }

  closeLotGroup(qtyTarget = 5.0, reason = 'USER_MANUAL_LOT_CLOSE', livePrice = null, usdInr = 102.00) {
    let price = Number(livePrice);
    if (!price || isNaN(price) || price <= 0) {
      const rf = rateFeed.getCurrentRate('SOLUSDT');
      price = (rf && rf.price > 0) ? rf.price : 105.00;
    }
    const now = Date.now();
    const takerFee = Number(this.settings.takerFeeRate) || 0.00075;
    const gstRate = Number(this.settings.gstRate) || 0.18;

    let closedPairs = 0;
    let closedLegs = 0;

    for (const pair of this.pairs) {
      if (pair.status === 'CLOSED') continue;
      const pairQty = Number(pair.quantity) || 5.0;
      if (Math.abs(pairQty - qtyTarget) > 0.05) continue;

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
    return {
      success: true,
      message: `Closed all ${qtyTarget} SOL pairs (${closedPairs} pairs, ${closedLegs} legs).`,
      closedPairs,
      closedLegs
    };
  }
}

module.exports = new SolanaEngineV2();
