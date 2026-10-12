const rateFeed = require('./rateFeed');
const storage = require('./storage');

class PaperEngine {
  constructor() {
    this.settings = {
      startingCapitalINR: 350000,
      contractQuantity: 5.0,
      leverage: 5,
      instrument: 'CLUSDT',
      profitTargetMode: 'PRICE_MOVE',
      profitTargetMove: 0.20,
      buyTargetMove: 0.20,
      sellTargetMove: 0.20,
      autoAiTargetMode: true,
      targetDisabled: false,
      maxActivePairs: 100,
      dailyLossCircuitBreakerINR: 2000,
      takerFeeRate: 0.00075, // 0.075% strict fee
      gstRate: 0.18, // 18% GST on fees
      slippageBufferINR: 5.0, // ₹5.00 slippage & funding fee buffer per trade
      usdInrRate: 102.00, // 1 USD = 102.00 INR (Mudrex INR Futures Rate)
      tradingMode: 'LIVE', // 'PAPER' (Simulated) or 'LIVE' (Real Orders)
      realOrdersDisabled: false
    };

    this.contractMultipliers = {
      CLUSDT: 1.0, // 1 barrel
      XAGUSDT: 1.0, // 1 troy oz
      BTCUSDT: 1.0  // 1 BTC
    };

    this.pairs = [];
    this.closedPositions = [];
    this.auditLogs = [];
    
    // Processed rates sets per instrument to prevent duplicate pairs on identical rates
    this.processedRates = {
      CLUSDT: new Set(),
      XAGUSDT: new Set(),
      BTCUSDT: new Set()
    };
    this.lastProcessedRate = null;
    this.lastSkippedRate = null;

    this.dailyTracker = {
      dateKey: this.getAsiaKolkataDateKey(),
      realizedNetLossINR: 0,
      realizedNetProfitINR: 0
    };

    this.isEngineRunning = true;
    this.engineStatus = 'RUNNING';
    this.pauseReason = '';

    // Load persisted state if exists
    this.initFromStorage();

    // Listen to rate feed ticks
    rateFeed.subscribe((type, data) => this.handleRateEvent(type, data));
  }

  getAsiaKolkataDateKey(timestamp = Date.now()) {
    const d = new Date(timestamp);
    const options = { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' };
    const formatter = new Intl.DateTimeFormat('en-CA', options);
    return formatter.format(d); // YYYY-MM-DD
  }

  normalizePrice(price, symbol = this.settings.instrument) {
    if (price === null || price === undefined || isNaN(price)) return null;
    const decimals = symbol === 'BTCUSDT' ? 2 : (symbol === 'XAGUSDT' ? 4 : 2);
    return Number(price.toFixed(decimals));
  }

  initFromStorage() {
    const saved = storage.loadState();
    if (saved) {
      if (saved.settings) {
        const savedQty = saved.settings.contractQuantity;
        this.settings = { ...this.settings, ...saved.settings };
        if (savedQty !== undefined && savedQty !== null) {
          this.settings.contractQuantity = savedQty;
        }
      }
      this.settings.startingCapitalINR = 82978; // ₹82,978 INR capital (Live Mudrex balance)
      this.settings.maxActivePairs = 500; // 500 Active Pairs Cap
      this.settings.profitTargetMove = 1.0; // $1.00 Target Move
      this.settings.tradingMode = 'LIVE';
      this.settings.realOrdersDisabled = false;
      this.settings.strategyMode = 'ALTERNATING_STAGGERED';
      if (saved.pairs) this.pairs = saved.pairs;
      if (saved.closedPositions) this.closedPositions = saved.closedPositions;
      if (saved.auditLogs) this.auditLogs = saved.auditLogs.slice(-500);
      if (saved.dailyTracker) this.dailyTracker = saved.dailyTracker;
      this.isEngineRunning = true;
      this.engineStatus = 'RUNNING';
      this.pauseReason = '';
      if (saved.lastProcessedRate !== undefined) this.lastProcessedRate = saved.lastProcessedRate;

      if (saved.processedRates) {
        for (const sym in saved.processedRates) {
          if (Array.isArray(saved.processedRates[sym])) {
            this.processedRates[sym] = new Set(saved.processedRates[sym]);
          }
        }
      }

      this.deduplicateActivePairs();
      
      this.logAudit('ENGINE_RESTORED', 'Engine state & processed unique rates restored from storage. Starting capital set to ₹2,00,000.');
      this.saveState();
    } else {
      this.logAudit('ENGINE_INIT', 'Engine initialized with default paper settings (₹2,00,000 capital).');
      this.saveState();
    }
  }

  deduplicateActivePairs() {
    const seenRates = new Set();
    let removedCount = 0;

    for (const pair of this.pairs) {
      const bOpen = pair.buyPosition && pair.buyPosition.status === 'OPEN';
      const sOpen = pair.sellPosition && pair.sellPosition.status === 'OPEN';

      if (!bOpen && !sOpen) {
        pair.status = 'CLOSED';
        continue;
      }
      
      if (pair.status === 'CLOSED') continue;

      const bPrice = bOpen ? pair.buyPosition.entryPrice : null;
      const sPrice = sOpen ? pair.sellPosition.entryPrice : null;
      const sym = pair.symbol || this.settings.instrument;

      const rateLevel = bPrice !== null ? bPrice : sPrice;
      const fullKey = `${sym}-${rateLevel}`;

      if (rateLevel !== null && seenRates.has(fullKey)) {
        if (pair.buyPosition && pair.buyPosition.status === 'OPEN') pair.buyPosition.status = 'CLOSED';
        if (pair.sellPosition && pair.sellPosition.status === 'OPEN') pair.sellPosition.status = 'CLOSED';
        pair.status = 'CLOSED';
        removedCount++;
      } else if (rateLevel !== null) {
        seenRates.add(fullKey);
      }
    }

    if (removedCount > 0) {
      this.logAudit('PAIRS_DEDUPLICATED', `Deduplicated active pairs: Removed ${removedCount} duplicate active pairs.`);
    }
  }

  saveState() {
    const processedRatesObj = {};
    for (const sym in this.processedRates) {
      processedRatesObj[sym] = Array.from(this.processedRates[sym]);
    }

    storage.saveState({
      settings: this.settings,
      pairs: this.pairs,
      closedPositions: this.closedPositions,
      auditLogs: this.auditLogs,
      processedRates: processedRatesObj,
      lastProcessedRate: this.lastProcessedRate,
      dailyTracker: this.dailyTracker,
      isEngineRunning: this.isEngineRunning
    });
  }

  logAudit(event, details) {
    const entry = {
      id: `LOG-${Date.now()}-${Math.floor(Math.random()*1000)}`,
      timestamp: new Date().toISOString(),
      event,
      details
    };
    this.auditLogs.push(entry);
    if (this.auditLogs.length > 500) this.auditLogs.shift();
    console.log(`[Audit] [${entry.timestamp}] ${event}: ${typeof details === 'string' ? details : JSON.stringify(details)}`);
  }

  updateSettings(newSettings) {
    const oldSettings = { ...this.settings };
    this.settings = { ...this.settings, ...newSettings };
    this.settings.realOrdersDisabled = false;

    if (newSettings.instrument && newSettings.instrument !== oldSettings.instrument) {
      rateFeed.setActiveSymbol(newSettings.instrument);
      if (this.pauseReason && this.pauseReason.includes('STALE MARKET FEED')) {
        this.pauseReason = '';
        if (this.isEngineRunning) this.engineStatus = 'RUNNING';
      }
    }

    this.logAudit('SETTINGS_UPDATED', {
      changedBy: 'USER',
      oldSettings,
      newSettings: this.settings
    });
    this.saveState();
  }

  handleRateEvent(type, data) {
    if (type === 'tick') {
      this.processTick(data);
    } else if (type === 'feed_stale') {
      if (data.symbol === this.settings.instrument) {
        this.engineStatus = 'PAUSED';
        this.pauseReason = `PAUSED — STALE MARKET FEED FOR ${data.symbol}`;
        this.logAudit('FEED_STALE', `Rate feed for ${data.symbol} is stale. New pair creation paused.`);
      }
    }
  }

  processTick(tick) {
    const { symbol, price, time, status, usdInrRate } = tick;
    if (symbol !== this.settings.instrument) return;

    const normalizedPrice = this.normalizePrice(price, symbol);
    if (normalizedPrice === null) return;

    // Daily reset check (Asia/Kolkata midnight)
    const currentDateKey = this.getAsiaKolkataDateKey(time);
    if (this.dailyTracker.dateKey !== currentDateKey) {
      this.dailyTracker = {
        dateKey: currentDateKey,
        realizedNetLossINR: 0,
        realizedNetProfitINR: 0
      };
      this.logAudit('DAILY_TRACKER_RESET', `Daily loss tracker reset for new date ${currentDateKey}`);
    }

    // 1. Evaluate Target Exits for Open Positions on EVERY tick
    this.evaluateTargetExits(normalizedPrice, time, usdInrRate, symbol);

    // 2. Check if engine is enabled and market feed is LIVE
    if (!this.isEngineRunning) {
      this.engineStatus = 'STOPPED';
      this.pauseReason = 'ENGINE STOPPED BY USER';
      return;
    }

    if (status === 'STALE' || status === 'NO_DATA') {
      this.engineStatus = 'PAUSED';
      this.pauseReason = `PAUSED — STALE MARKET FEED FOR ${symbol}`;
      return;
    }

    if (this.isEngineRunning && (this.engineStatus === 'PAUSED' || (this.pauseReason && this.pauseReason.includes('STALE MARKET FEED')))) {
      this.engineStatus = 'RUNNING';
      this.pauseReason = '';
      this.logAudit('FEED_RESUMED', `Market feed for ${symbol} recovered. Resuming new pair creation.`);
    }

    // 2. Check for Missing Legs on Existing Active Pairs of this symbol
    const activePairs = this.pairs.filter(p => (p.symbol || this.settings.instrument) === symbol && p.status === 'ACTIVE');
    
    for (const pair of activePairs) {
      const buyOpen = pair.buyPosition && pair.buyPosition.status === 'OPEN';
      const sellOpen = pair.sellPosition && pair.sellPosition.status === 'OPEN';

      // If BOTH legs are already OPEN, this pair has no missing leg — check next pair
      if (buyOpen && sellOpen) continue;

      const tolerance = this.settings.priceMatchingTolerance !== undefined ? this.settings.priceMatchingTolerance : 0.0001;

      // Case 1: BUY is OPEN, SELL is CLOSED/MISSING -> Complete Pair ONLY when current market price matches BUY entry price
      if (buyOpen && !sellOpen) {
        const remainingEntryPrice = pair.buyPosition.entryPrice;
        const matchesEntryRate = Math.abs(normalizedPrice - remainingEntryPrice) <= tolerance;
        
        if (!matchesEntryRate) {
          // Current market price does NOT match remaining leg entry price -> Pair remains incomplete & waiting
          continue;
        }

        if (pair.sellPosition && pair.sellPosition.status === 'CLOSED' && pair.sellPosition.exitPrice === normalizedPrice && (time - pair.sellPosition.exitTimestamp < 5000)) {
          // Skip immediate exit tick loop
        } else {
          const metrics = this.getDashboardMetrics();
          const qty = this.settings.contractQuantity;
          const mult = this.contractMultipliers[symbol] || 1.0;
          const leverage = this.settings.leverage;
          const reqMarginPerPosINR = (normalizedPrice * qty * mult * usdInrRate) / leverage;

          if (metrics.summary.availableMarginINR >= reqMarginPerPosINR) {
            this.engineStatus = 'RUNNING';
            this.pauseReason = '';
            this.reopenMissingLeg(pair, 'SELL', normalizedPrice, time, usdInrRate);
            this.lastProcessedRate = normalizedPrice;
            return; // 1 missing leg re-entry per tick
          }
        }
      }

      // Case 2: SELL is OPEN, BUY is CLOSED/MISSING -> Complete Pair ONLY when current market price matches SELL entry price
      if (sellOpen && !buyOpen) {
        const remainingEntryPrice = pair.sellPosition.entryPrice;
        const matchesEntryRate = Math.abs(normalizedPrice - remainingEntryPrice) <= tolerance;

        if (!matchesEntryRate) {
          // Current market price does NOT match remaining leg entry price -> Pair remains incomplete & waiting
          continue;
        }

        if (pair.buyPosition && pair.buyPosition.status === 'CLOSED' && pair.buyPosition.exitPrice === normalizedPrice && (time - pair.buyPosition.exitTimestamp < 5000)) {
          // Skip immediate exit tick loop
        } else {
          const metrics = this.getDashboardMetrics();
          const qty = this.settings.contractQuantity;
          const mult = this.contractMultipliers[symbol] || 1.0;
          const leverage = this.settings.leverage;
          const reqMarginPerPosINR = (normalizedPrice * qty * mult * usdInrRate) / leverage;

          if (metrics.summary.availableMarginINR >= reqMarginPerPosINR) {
            this.engineStatus = 'RUNNING';
            this.pauseReason = '';
            this.reopenMissingLeg(pair, 'BUY', normalizedPrice, time, usdInrRate);
            this.lastProcessedRate = normalizedPrice;
            return; // 1 missing leg re-entry per tick
          }
        }
      }
    }

    // 3. New Pair Creation Logic: Check if a full ACTIVE pair (both legs open) already exists for this exact rate level
    const existingBothOpenPairAtRate = activePairs.find(p => {
      const bOpen = p.buyPosition && p.buyPosition.status === 'OPEN';
      const sOpen = p.sellPosition && p.sellPosition.status === 'OPEN';
      return bOpen && sOpen && (p.buyPosition.entryPrice === normalizedPrice || p.sellPosition.entryPrice === normalizedPrice);
    });

    if (existingBothOpenPairAtRate) {
      if (this.lastSkippedRate !== normalizedPrice) {
        this.logAudit('ENTRY_SKIPPED', `ENTRY SKIPPED — FULL ACTIVE PAIR ALREADY EXISTS AT RATE ($${normalizedPrice})`);
        this.lastSkippedRate = normalizedPrice;
      }
      return;
    }

    // 4. Consecutive Tick Idempotent Guard for New Pair Creation
    if (this.lastProcessedRate === normalizedPrice && this.getActivePairsCount() > 0) {
      if (this.lastSkippedRate !== normalizedPrice) {
        this.logAudit('ENTRY_SKIPPED', `ENTRY SKIPPED — IDENTICAL TICK RATE ($${normalizedPrice})`);
        this.lastSkippedRate = normalizedPrice;
      }
      return;
    }

    // 5. Check Active Pairs Cap for NEW Pair Creation
    const activePairsCount = this.getActivePairsCount();
    if (activePairsCount >= this.settings.maxActivePairs) {
      this.engineStatus = 'PAUSED';
      this.pauseReason = `PAUSED — MAX PAIRS REACHED (${activePairsCount}/${this.settings.maxActivePairs})`;
      return;
    }

    // 6. Check Available Margin for NEW Pair (1 BUY + 1 SELL of 2 Barrels)
    const qty = this.settings.contractQuantity || 2.0;
    const mult = this.contractMultipliers[symbol] || 1.0;
    const leverage = this.settings.leverage || 5;
    const reqMarginPairINR = ((normalizedPrice * qty * mult * usdInrRate) / leverage) * 2;

    const paperMarginUsedINR = activePairs.length * reqMarginPairINR;
    const startingCap = this.settings.startingCapitalINR || 350000;
    this.settings.startingCapitalINR = startingCap;
    const paperAvailableMarginINR = Math.max(0, startingCap - paperMarginUsedINR);

    if (paperAvailableMarginINR < reqMarginPairINR) {
      this.engineStatus = 'PAUSED';
      this.pauseReason = `PAUSED — INSUFFICIENT MARGIN (Required: ₹${reqMarginPairINR.toFixed(2)}, Available: ₹${paperAvailableMarginINR.toFixed(2)})`;
      if (this.lastSkippedRate !== `MARGIN-${normalizedPrice}`) {
        this.logAudit('ENTRY_REJECTED', `ENTRY REJECTED — INSUFFICIENT MARGIN (Required ₹${reqMarginPairINR.toFixed(2)} for 2 Barrels Pair, Available: ₹${paperAvailableMarginINR.toFixed(2)})`);
        this.lastSkippedRate = `MARGIN-${normalizedPrice}`;
      }
      return;
    }

    this.engineStatus = 'RUNNING';
    this.pauseReason = '';

    // New pair allowed! Create 1 BUY + 1 SELL pair at exact same normalizedPrice.
    this.createNewPair(symbol, normalizedPrice, time, usdInrRate);
  }

  reopenMissingLeg(pair, direction, entryPrice, timestamp, usdInrRate) {
    const symbol = pair.symbol;
    const targetMove = this.settings.targetDisabled ? null : this.settings.profitTargetMove;
    const quantity = this.settings.contractQuantity;
    const multiplier = this.contractMultipliers[symbol] || 1.0;
    const takerFee = this.settings.takerFeeRate;

    const entryValueUSD = entryPrice * quantity * multiplier;
    const estEntryFeeUSD = entryValueUSD * takerFee;

    const seq = pair.pairId.replace('PAIR-', '');
    const legSeq = `${seq}-${direction}-${Date.now().toString().slice(-4)}`;

    if (direction === 'BUY') {
      const buyTarget = targetMove ? this.normalizePrice(entryPrice + targetMove, symbol) : null;
      pair.buyPosition = {
        positionId: `P-${legSeq}`,
        pairId: pair.pairId,
        direction: 'BUY',
        symbol,
        entryTime: new Date(timestamp).toISOString(),
        entryTimestamp: timestamp,
        entryPrice,
        quantity,
        contractMultiplier: multiplier,
        targetExitPrice: buyTarget,
        targetMove,
        status: 'OPEN',
        entryFeeUSD: estEntryFeeUSD,
        usdInrRateAtEntry: usdInrRate
      };
      this.logAudit('LEG_REOPENED', {
        pairId: pair.pairId,
        positionId: pair.buyPosition.positionId,
        direction: 'BUY',
        symbol,
        entryPrice,
        targetExitPrice: buyTarget
      });
    } else { // SELL
      const sellTarget = targetMove ? this.normalizePrice(entryPrice - targetMove, symbol) : null;
      pair.sellPosition = {
        positionId: `P-${legSeq}`,
        pairId: pair.pairId,
        direction: 'SELL',
        symbol,
        entryTime: new Date(timestamp).toISOString(),
        entryTimestamp: timestamp,
        entryPrice,
        quantity,
        contractMultiplier: multiplier,
        targetExitPrice: sellTarget,
        targetMove,
        status: 'OPEN',
        entryFeeUSD: estEntryFeeUSD,
        usdInrRateAtEntry: usdInrRate
      };
      this.logAudit('LEG_REOPENED', {
        pairId: pair.pairId,
        positionId: pair.sellPosition.positionId,
        direction: 'SELL',
        symbol,
        entryPrice,
        targetExitPrice: sellTarget
      });
    }

    this.saveState();
  }

  getActivePairsCount() {
    return this.pairs.filter(p => p.status === 'ACTIVE').length;
  }

  createNewPair(symbol, entryPrice, timestamp, usdInrRate) {
    const pairSeq = (this.pairs.length + 1).toString().padStart(4, '0');
    const pairId = `PAIR-${pairSeq}`;
    
    let bMove = (this.settings.profitTargetMode === 'PRICE_MOVE' && this.settings.profitTargetMove !== undefined) ? this.settings.profitTargetMove : (this.settings.buyTargetMove || this.settings.profitTargetMove || 0.20);
    let sMove = (this.settings.profitTargetMode === 'PRICE_MOVE' && this.settings.profitTargetMove !== undefined) ? this.settings.profitTargetMove : (this.settings.sellTargetMove || this.settings.profitTargetMove || 0.20);

    if (this.settings.profitTargetMode === 'STRATEGY' || (this.settings.strategyMode === 'ALTERNATING_STAGGERED' && this.settings.profitTargetMode !== 'PRICE_MOVE')) {
      const altIdx = this.pairs.length % 4;
      if (altIdx === 0) { bMove = 0.20; sMove = 0.20; }
      else if (altIdx === 1) { bMove = 0.20; sMove = 0.30; }
      else if (altIdx === 2) { bMove = 0.30; sMove = 0.20; }
      else { bMove = 0.15; sMove = 0.25; }
    } else if (this.settings.autoAiTargetMode && this.settings.profitTargetMode !== 'PRICE_MOVE') {
      try {
        const mudrexLive = require('./mudrexLiveAdapter');
        const aiInfo = mudrexLive.calculateAiTargets();
        bMove = aiInfo.buyTargetMove;
        sMove = aiInfo.sellTargetMove;
      } catch (e) {}
    }
    
    // BUY Target: Entry + BUY Target Move
    const buyTarget = this.settings.targetDisabled ? null : this.normalizePrice(entryPrice + bMove, symbol);
    // SELL Target: Entry - SELL Target Move
    const sellTarget = this.settings.targetDisabled ? null : this.normalizePrice(entryPrice - sMove, symbol);

    const quantity = this.settings.contractQuantity;
    const multiplier = this.contractMultipliers[symbol] || 1.0;
    const takerFee = this.settings.takerFeeRate;

    // Estimate entry fee for display
    const entryValueUSD = entryPrice * quantity * multiplier;
    const estEntryFeeUSD = entryValueUSD * takerFee;

    const buyPosition = {
      positionId: `P-${pairSeq}-BUY`,
      pairId,
      direction: 'BUY',
      symbol,
      entryTime: new Date(timestamp).toISOString(),
      entryTimestamp: timestamp,
      entryPrice,
      quantity,
      contractMultiplier: multiplier,
      targetExitPrice: buyTarget,
      targetMove: bMove,
      status: 'OPEN',
      entryFeeUSD: estEntryFeeUSD,
      usdInrRateAtEntry: usdInrRate
    };

    const sellPosition = {
      positionId: `P-${pairSeq}-SELL`,
      pairId,
      direction: 'SELL',
      symbol,
      entryTime: new Date(timestamp).toISOString(),
      entryTimestamp: timestamp,
      entryPrice,
      quantity,
      contractMultiplier: multiplier,
      targetExitPrice: sellTarget,
      targetMove: sMove,
      status: 'OPEN',
      entryFeeUSD: estEntryFeeUSD,
      usdInrRateAtEntry: usdInrRate
    };

    const pair = {
      pairId,
      symbol,
      createdTime: new Date(timestamp).toISOString(),
      createdTimestamp: timestamp,
      entryRate: entryPrice,
      status: 'ACTIVE',
      buyPosition,
      sellPosition
    };

    this.pairs.push(pair);
    
    // Mark rate as processed for this symbol
    if (!this.processedRates[symbol]) this.processedRates[symbol] = new Set();
    this.processedRates[symbol].add(entryPrice);
    
    const prevRate = this.lastProcessedRate;
    this.lastProcessedRate = entryPrice;

    this.logAudit('PAIR_CREATED', {
      reason: 'NEW_UNIQUE_RATE',
      pairId,
      symbol,
      entryPrice,
      previousProcessedRate: prevRate,
      buyTarget,
      sellTarget
    });

    this.saveState();
  }

  createSinglePosition(direction, symbol, entryPrice, quantity, targetMove, usdInrRate) {
    const pairSeq = (this.pairs.length + 1).toString().padStart(4, '0');
    const pairId = `PAIR-${pairSeq}`;
    const qty = quantity || this.settings.contractQuantity || 1.0;
    const tMove = targetMove || 0.20;
    const mult = this.contractMultipliers[symbol] || 1.0;
    const takerFee = this.settings.takerFeeRate || 0.0005;

    const targetExit = direction === 'BUY'
      ? this.normalizePrice(entryPrice + tMove, symbol)
      : this.normalizePrice(entryPrice - tMove, symbol);

    const entryValueUSD = entryPrice * qty * mult;
    const estEntryFeeUSD = entryValueUSD * takerFee;

    const pos = {
      positionId: `P-${pairSeq}-${direction}`,
      pairId,
      direction,
      symbol,
      entryTime: new Date().toISOString(),
      entryTimestamp: Date.now(),
      entryPrice,
      quantity: qty,
      contractMultiplier: mult,
      targetExitPrice: targetExit,
      targetMove: tMove,
      status: 'OPEN',
      entryFeeUSD: estEntryFeeUSD,
      usdInrRateAtEntry: usdInrRate
    };

    const newPair = {
      pairId,
      symbol,
      createdTime: new Date().toISOString(),
      createdTimestamp: Date.now(),
      entryRate: entryPrice,
      status: 'ACTIVE',
      buyPosition: direction === 'BUY' ? pos : null,
      sellPosition: direction === 'SELL' ? pos : null
    };

    this.pairs.push(newPair);
    this.logAudit('MANUAL_POSITION_CREATED', { pairId, positionId: pos.positionId, direction, entryPrice });
    this.saveState();
    return pos;
  }

  evaluateTargetExits(currentPrice, currentTimestamp, currentUsdInrRate, tickSymbol = this.settings.instrument) {
    let stateChanged = false;

    for (const pair of this.pairs) {
      if (pair.status === 'CLOSED') continue;
      const pairSymbol = pair.symbol || this.settings.instrument;
      if (tickSymbol && pairSymbol !== tickSymbol) continue;

      // Check BUY position
      const buy = pair.buyPosition;
      if (buy.status === 'OPEN' && buy.targetExitPrice !== null) {
        if (currentPrice >= buy.targetExitPrice) {
          this.closePosition(pair, buy, currentPrice, currentTimestamp, currentUsdInrRate, 'BUY TARGET PROFIT HIT');
          stateChanged = true;
        }
      }

      // Check SELL position
      const sell = pair.sellPosition;
      if (sell.status === 'OPEN' && sell.targetExitPrice !== null) {
        if (currentPrice <= sell.targetExitPrice) {
          this.closePosition(pair, sell, currentPrice, currentTimestamp, currentUsdInrRate, 'SELL TARGET PROFIT HIT');
          stateChanged = true;
        }
      }

      // Check if pair is now fully closed
      if (pair.buyPosition.status === 'CLOSED' && pair.sellPosition.status === 'CLOSED') {
        if (pair.status !== 'CLOSED') {
          pair.status = 'CLOSED';
          pair.closedTime = new Date(currentTimestamp).toISOString();
          stateChanged = true;
          this.logAudit('PAIR_FULLY_CLOSED', { pairId: pair.pairId });
        }
      }
    }

    if (stateChanged) {
      this.saveState();
    }
  }

  closePosition(pair, position, exitPrice, exitTimestamp, usdInrRate, exitReason) {
    if (position.status === 'CLOSED') return; // Idempotent check

    position.status = 'CLOSED';
    position.exitPrice = exitPrice;
    position.exitTime = new Date(exitTimestamp).toISOString();
    position.exitTimestamp = exitTimestamp;

    // Calculate exact P/L
    const qty = position.quantity;
    const mult = position.contractMultiplier;
    const feeRate = this.settings.takerFeeRate;
    const gstRate = this.settings.gstRate;

    let grossUSD = 0;
    if (position.direction === 'BUY') {
      grossUSD = (exitPrice - position.entryPrice) * qty * mult;
    } else { // SELL
      grossUSD = (position.entryPrice - exitPrice) * qty * mult;
    }

    const entryValueUSD = position.entryPrice * qty * mult;
    const exitValueUSD = exitPrice * qty * mult;

    const entryFeeUSD = entryValueUSD * feeRate;
    const exitFeeUSD = exitValueUSD * feeRate;
    const gstUSD = (entryFeeUSD + exitFeeUSD) * gstRate;
    const slippageUSD = (this.settings.slippageBufferINR || 5.0) / usdInrRate;
    const totalChargesUSD = entryFeeUSD + exitFeeUSD + gstUSD + slippageUSD;
    const netUSD = grossUSD - totalChargesUSD;

    let finalExitReason = exitReason;
    if (exitReason.includes('PROFIT HIT') && netUSD < 0) {
      finalExitReason = exitReason.replace('PROFIT HIT', 'PRICE HIT (NET LOSS DUE TO FEES)');
    }
    position.exitReason = finalExitReason;

    const entryPriceINR = Number((position.entryPrice * usdInrRate).toFixed(2));
    const exitPriceINR = Number((exitPrice * usdInrRate).toFixed(2));
    let grossINR = 0;
    if (position.direction === 'BUY') {
      grossINR = (exitPriceINR - entryPriceINR) * qty * mult;
    } else {
      grossINR = (entryPriceINR - exitPriceINR) * qty * mult;
    }
    grossINR = Number(grossINR.toFixed(2));

    const totalChargesINR = Number((totalChargesUSD * usdInrRate).toFixed(2));
    const netINR = Number((grossINR - totalChargesINR).toFixed(2));

    const entryTs = position.entryTimestamp || (position.entryTime ? new Date(position.entryTime).getTime() : exitTimestamp);
    const holdingDurationMs = Math.max(0, exitTimestamp - entryTs);
    const holdingDurationSec = Math.round(holdingDurationMs / 1000);

    const closedRecord = {
      pairId: pair.pairId,
      positionId: position.positionId,
      direction: position.direction,
      symbol: position.symbol,
      entryTime: position.entryTime,
      exitTime: position.exitTime,
      entryPrice: position.entryPrice,
      exitPrice,
      targetExitPrice: position.targetExitPrice,
      quantity: qty,
      contractMultiplier: mult,
      grossProfitUSD: Number(grossUSD.toFixed(4)),
      grossProfitINR: Number(grossINR.toFixed(2)),
      entryFeeUSD: Number(entryFeeUSD.toFixed(4)),
      exitFeeUSD: Number(exitFeeUSD.toFixed(4)),
      gstUSD: Number(gstUSD.toFixed(4)),
      totalChargesUSD: Number(totalChargesUSD.toFixed(4)),
      totalChargesINR: Number(totalChargesINR.toFixed(2)),
      netProfitUSD: Number(netUSD.toFixed(4)),
      netProfitINR: Number(netINR.toFixed(2)),
      usdInrRate,
      exitReason,
      holdingDurationSec
    };

    // Store in closed positions history
    this.closedPositions.push(closedRecord);

    // Update Daily Loss / Profit tracker
    if (netINR < 0) {
      this.dailyTracker.realizedNetLossINR += Math.abs(netINR);
    } else {
      this.dailyTracker.realizedNetProfitINR += netINR;
    }

    this.logAudit('POSITION_CLOSED', closedRecord);
  }

  manualClosePosition(positionId) {
    for (const pair of this.pairs) {
      const posToClose = [pair.buyPosition, pair.sellPosition].find(p => p && p.positionId === positionId && p.status === 'OPEN');
      if (posToClose) {
        const posSymbol = posToClose.symbol || this.settings.instrument;
        const rateInfo = rateFeed.getCurrentRate(posSymbol);
        const exitPrice = rateInfo.price;
        if (!exitPrice) {
          throw new Error(`Cannot close position: Market price for ${posSymbol} is unavailable.`);
        }
        this.closePosition(pair, posToClose, exitPrice, Date.now(), rateInfo.usdInrRate, 'MANUAL USER CLOSE');
        if (pair.buyPosition.status === 'CLOSED' && pair.sellPosition.status === 'CLOSED') {
          pair.status = 'CLOSED';
          pair.closedTime = new Date().toISOString();
        }
        this.saveState();
        return true;
      }
    }
    throw new Error(`Position ${positionId} not found or already closed.`);
  }

  getDashboardMetrics() {
    const rateInfo = rateFeed.getCurrentRate(this.settings.instrument);
    const currentPrice = rateInfo.price;
    const usdInrRate = rateInfo.usdInrRate;

    let realizedGrossUSD = 0, realizedGrossINR = 0;
    let realizedChargesUSD = 0, realizedChargesINR = 0;
    let realizedNetUSD = 0, realizedNetINR = 0;
    let winCount = 0, lossCount = 0;

    const activeSymbol = this.settings.instrument;
    const filteredClosedPositions = this.closedPositions.filter(cp => !cp.symbol || cp.symbol === activeSymbol);

    for (const cp of filteredClosedPositions) {
      realizedGrossUSD += cp.grossProfitUSD;
      realizedGrossINR += cp.grossProfitINR;
      realizedChargesUSD += cp.totalChargesUSD;
      realizedChargesINR += cp.totalChargesINR;
      realizedNetUSD += cp.netProfitUSD;
      realizedNetINR += cp.netProfitINR;

      if (cp.netProfitUSD >= 0) winCount++;
      else lossCount++;
    }

    let floatingGrossUSD = 0, floatingGrossINR = 0;
    let floatingChargesUSD = 0, floatingChargesINR = 0;
    let floatingNetUSD = 0, floatingNetINR = 0;
    let activeBuyCount = 0, activeSellCount = 0;
    let marginUsedINR = 0;

    const qty = this.settings.contractQuantity;
    const mult = this.contractMultipliers[activeSymbol] || 1.0;
    const feeRate = this.settings.takerFeeRate;
    const gstRate = this.settings.gstRate;
    const leverage = this.settings.leverage;

    const openPositionsList = [];
    const activePairs = this.pairs.filter(p => !p.symbol || p.symbol === activeSymbol);

    for (const pair of activePairs) {
      if (pair.status === 'CLOSED') continue;

      const positions = [pair.buyPosition, pair.sellPosition];
      for (const pos of positions) {
        if (pos.status !== 'OPEN') continue;

        if (pos.direction === 'BUY') activeBuyCount++;
        if (pos.direction === 'SELL') activeSellCount++;

        let posGrossUSD = 0;
        let posGrossINR = 0;
        let posChargesUSD = 0;
        let posChargesINR = 0;
        let posNetUSD = 0;
        let posNetINR = 0;

        const posSymbol = pos.symbol || this.settings.instrument;
        const posRateInfo = rateFeed.getCurrentRate(posSymbol);
        const posCurrentPrice = (posRateInfo && posRateInfo.price) ? posRateInfo.price : pos.entryPrice;
        const posMult = this.contractMultipliers[posSymbol] || 1.0;
        const posQty = pos.quantity || this.settings.contractQuantity || 1.0;

        if (posCurrentPrice) {
          if (pos.direction === 'BUY') {
            posGrossUSD = (posCurrentPrice - pos.entryPrice) * posQty * posMult;
          } else {
            posGrossUSD = (pos.entryPrice - posCurrentPrice) * posQty * posMult;
          }
          posGrossINR = posGrossUSD * usdInrRate;

          const entryValueUSD = pos.entryPrice * posQty * posMult;
          const estExitValueUSD = posCurrentPrice * posQty * posMult;
          const entryFeeUSD = entryValueUSD * feeRate;
          const estExitFeeUSD = estExitValueUSD * feeRate;
          const estGstUSD = (entryFeeUSD + estExitFeeUSD) * gstRate;
          
          posChargesUSD = entryFeeUSD + estExitFeeUSD + estGstUSD;
          posChargesINR = posChargesUSD * usdInrRate;
          
          posNetUSD = posGrossUSD - posChargesUSD;
          posNetINR = posGrossINR - posChargesINR;

          floatingGrossUSD += posGrossUSD;
          floatingGrossINR += posGrossINR;
          floatingChargesUSD += posChargesUSD;
          floatingChargesINR += posChargesINR;
          floatingNetUSD += posNetUSD;
          floatingNetINR += posNetINR;

          // Margin calculation
          const posNotionalUSD = posCurrentPrice * posQty * posMult;
          const posMarginUSD = posNotionalUSD / leverage;
          marginUsedINR += (posMarginUSD * usdInrRate);
        }

        openPositionsList.push({
          pairId: pair.pairId,
          positionId: pos.positionId,
          direction: pos.direction,
          symbol: posSymbol,
          entryTime: pos.entryTime,
          entryPrice: pos.entryPrice,
          currentPrice: posCurrentPrice || pos.entryPrice,
          targetExitPrice: pos.targetExitPrice,
          targetMove: pos.targetMove,
          quantity: posQty,
          floatingGrossUSD: Number(posGrossUSD.toFixed(4)),
          floatingGrossINR: Number(posGrossINR.toFixed(2)),
          floatingChargesUSD: Number(posChargesUSD.toFixed(4)),
          floatingChargesINR: Number(posChargesINR.toFixed(2)),
          floatingNetUSD: Number(posNetUSD.toFixed(4)),
          floatingNetINR: Number(posNetINR.toFixed(2)),
          status: pos.status
        });
      }
    }

    const startingCap = Math.max(350000, this.settings.startingCapitalINR || 350000);
    this.settings.startingCapitalINR = startingCap;
    const realizedBalanceINR = startingCap + realizedNetINR;
    const totalEquityINR = realizedBalanceINR + floatingNetINR;
    const availableMarginINR = Math.max(0, totalEquityINR - marginUsedINR);
    const activePairsCount = this.getActivePairsCount();

    let pairs1B = 0;
    let pairs2B = 0;
    for (const pair of this.pairs) {
      if (pair.status === 'ACTIVE') {
        const q = (pair.buyPosition && pair.buyPosition.quantity) || (pair.sellPosition && pair.sellPosition.quantity) || 1.0;
        if (q >= 2.0) pairs2B++;
        else pairs1B++;
      }
    }

    const processedRatesCount = this.processedRates[this.settings.instrument] ? this.processedRates[this.settings.instrument].size : 0;

    let effectiveEngineStatus = this.engineStatus;
    let effectivePauseReason = this.pauseReason;
    if (rateInfo.status === 'LIVE' && this.isEngineRunning && effectivePauseReason.includes('STALE MARKET FEED')) {
      this.engineStatus = 'RUNNING';
      this.pauseReason = '';
      effectiveEngineStatus = 'RUNNING';
      effectivePauseReason = '';
    }

    let isRealDisabled = true;
    try {
      const mudrexLive = require('./mudrexLiveAdapter');
      isRealDisabled = mudrexLive.isRealOrdersDisabled();
    } catch (e) {}

    return {
      rateFeedInfo: rateInfo,
      settings: { ...this.settings, realOrdersDisabled: isRealDisabled },
      engineStatus: effectiveEngineStatus,
      pauseReason: effectivePauseReason,
      isEngineRunning: this.isEngineRunning,
      lastProcessedRate: this.lastProcessedRate,
      processedRatesCount,
      summary: {
        startingCapitalINR: this.settings.startingCapitalINR,
        realizedBalanceINR: Number(realizedBalanceINR.toFixed(2)),
        realizedGrossUSD: Number(realizedGrossUSD.toFixed(4)),
        realizedGrossINR: Number(realizedGrossINR.toFixed(2)),
        realizedChargesUSD: Number(realizedChargesUSD.toFixed(4)),
        realizedChargesINR: Number(realizedChargesINR.toFixed(2)),
        realizedNetUSD: Number(realizedNetUSD.toFixed(4)),
        realizedNetINR: Number(realizedNetINR.toFixed(2)),
        
        floatingGrossUSD: Number(floatingGrossUSD.toFixed(4)),
        floatingGrossINR: Number(floatingGrossINR.toFixed(2)),
        floatingChargesUSD: Number(floatingChargesUSD.toFixed(4)),
        floatingChargesINR: Number(floatingChargesINR.toFixed(2)),
        floatingNetUSD: Number(floatingNetUSD.toFixed(4)),
        floatingNetINR: Number(floatingNetINR.toFixed(2)),
        
        totalEquityINR: Number(totalEquityINR.toFixed(2)),
        marginUsedINR: Number(marginUsedINR.toFixed(2)),
        availableMarginINR: Number(availableMarginINR.toFixed(2)),
        
        activePairsCount,
        maxActivePairs: this.settings.maxActivePairs,
        pairs1B,
        pairs2B,
        activeBuyCount,
        activeSellCount,
        closedPositionsCount: filteredClosedPositions.length,
        winCount,
        lossCount,
        winRate: filteredClosedPositions.length > 0 ? Number(((winCount / filteredClosedPositions.length) * 100).toFixed(1)) : 0,
        
        dailyRealizedLossINR: Number(this.dailyTracker.realizedNetLossINR.toFixed(2)),
        dailyLossLimitINR: this.settings.dailyLossCircuitBreakerINR
      },
      openPositions: openPositionsList,
      pairs: this.pairs.filter(p => p.status === 'ACTIVE' && (!p.symbol || p.symbol === activeSymbol)),
      closedPositions: filteredClosedPositions.slice().reverse().slice(0, 100),
      auditLogs: this.auditLogs
    };
  }

  toggleEngineState() {
    this.isEngineRunning = !this.isEngineRunning;
    if (this.isEngineRunning) {
      this.engineStatus = 'RUNNING';
      this.pauseReason = '';
    } else {
      this.engineStatus = 'PAUSED';
      this.pauseReason = 'ENGINE PAUSED — CLICK "START ENGINE" TO BEGIN TRADING';
    }
    this.logAudit('ENGINE_STATE_TOGGLED', { isEngineRunning: this.isEngineRunning });
    this.saveState();
    return this.isEngineRunning;
  }

  resetData() {
    this.resetAllData();
  }

  resetAllData() {
    this.settings.startingCapitalINR = 82978;
    this.settings.maxActivePairs = 500;
    this.settings.profitTargetMove = 1.0;
    this.settings.contractQuantity = 5.0;
    this.settings.tradingMode = 'LIVE';
    this.settings.realOrdersDisabled = false;
    this.settings.profitTargetMode = 'PRICE_MOVE';
    this.settings.strategyMode = 'ALTERNATING_STAGGERED';
    delete this.settings.buyTargetMove;
    delete this.settings.sellTargetMove;
    this.pairs = [];
    this.closedPositions = [];
    this.auditLogs = [];
    this.lastProcessedRate = null;
    this.lastSkippedRate = null;
    this.processedRates = {
      CLUSDT: new Set(),
      XAGUSDT: new Set(),
      BTCUSDT: new Set()
    };
    this.dailyTracker = {
      dateKey: this.getAsiaKolkataDateKey(),
      realizedNetLossINR: 0,
      realizedNetProfitINR: 0
    };
    this.isEngineRunning = true;
    this.engineStatus = 'RUNNING';
    this.pauseReason = '';

    try {
      const mudrexLive = require('./mudrexLiveAdapter');
      mudrexLive.liveOpenPositions = [];
      mudrexLive.liveClosedPositions = [];
      mudrexLive.processedRates.clear();
      mudrexLive.pairCounter = 1;
    } catch (e) {}

    storage.resetAll();
    this.logAudit('ENGINE_RESET', 'All engine paper positions, processed rates, and history reset to ₹1,00,000 capital.');
    this.saveState();
  }
}

module.exports = new PaperEngine();
