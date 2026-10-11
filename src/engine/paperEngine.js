const rateFeed = require('./rateFeed');
const storage = require('./storage');

class PaperEngine {
  constructor() {
    this.settings = {
      startingCapitalINR: 50000,
      contractQuantity: 1.0,
      leverage: 5,
      instrument: 'CLUSDT',
      profitTargetMode: 'PRICE_MOVE',
      profitTargetMove: 0.05, // $0.05
      targetDisabled: false,
      maxActivePairs: 25,
      dailyLossCircuitBreakerINR: 2000,
      takerFeeRate: 0.0005, // 0.05%
      gstRate: 0.18, // 18% GST on fees
      realOrdersDisabled: true
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
      if (saved.settings) this.settings = { ...this.settings, ...saved.settings };
      if (saved.pairs) this.pairs = saved.pairs;
      if (saved.closedPositions) this.closedPositions = saved.closedPositions;
      if (saved.auditLogs) this.auditLogs = saved.auditLogs.slice(-500);
      if (saved.dailyTracker) this.dailyTracker = saved.dailyTracker;
      if (typeof saved.isEngineRunning === 'boolean') this.isEngineRunning = saved.isEngineRunning;
      if (saved.lastProcessedRate !== undefined) this.lastProcessedRate = saved.lastProcessedRate;

      if (saved.processedRates) {
        for (const sym in saved.processedRates) {
          if (Array.isArray(saved.processedRates[sym])) {
            this.processedRates[sym] = new Set(saved.processedRates[sym]);
          }
        }
      }
      
      this.logAudit('ENGINE_RESTORED', 'Engine state & processed unique rates restored from storage.');
    } else {
      this.logAudit('ENGINE_INIT', 'Engine initialized with default paper settings.');
      this.saveState();
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
    this.settings.realOrdersDisabled = true; // ALWAYS PERMANENTLY TRUE

    if (newSettings.instrument && newSettings.instrument !== oldSettings.instrument) {
      rateFeed.setActiveSymbol(newSettings.instrument);
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
      this.engineStatus = 'PAUSED';
      this.pauseReason = `PAUSED — STALE MARKET FEED FOR ${data.symbol}`;
      this.logAudit('FEED_STALE', `Rate feed for ${data.symbol} is stale. New pair creation paused.`);
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
    this.evaluateTargetExits(normalizedPrice, time, usdInrRate);

    // 2. Check if engine is enabled and market feed is LIVE
    if (!this.isEngineRunning) {
      this.engineStatus = 'STOPPED';
      this.pauseReason = 'ENGINE STOPPED BY USER';
      return;
    }

    if (status === 'STALE' || status === 'NO_DATA') {
      this.engineStatus = 'PAUSED';
      this.pauseReason = `PAUSED — FEED ${status}`;
      return;
    }

    // 3. Check Daily Loss Circuit Breaker
    if (this.dailyTracker.realizedNetLossINR >= this.settings.dailyLossCircuitBreakerINR) {
      this.engineStatus = 'PAUSED';
      this.pauseReason = `PAUSED — DAILY LOSS CIRCUIT BREAKER HIT (Loss: ₹${this.dailyTracker.realizedNetLossINR.toFixed(2)} >= Limit: ₹${this.settings.dailyLossCircuitBreakerINR})`;
      return;
    }

    // 4. Check Active Pairs Cap
    const activePairsCount = this.getActivePairsCount();
    if (activePairsCount >= this.settings.maxActivePairs) {
      this.engineStatus = 'PAUSED';
      this.pauseReason = `PAUSED — MAX PAIRS REACHED (${activePairsCount}/${this.settings.maxActivePairs})`;
      return;
    }

    this.engineStatus = 'RUNNING';
    this.pauseReason = '';

    // 5. Unique Market Rate Deduplication Check
    if (!this.processedRates[symbol]) {
      this.processedRates[symbol] = new Set();
    }

    if (this.processedRates[symbol].has(normalizedPrice)) {
      // Duplicate rate - DO NOT OPEN NEW PAIR
      if (this.lastSkippedRate !== normalizedPrice) {
        this.logAudit('ENTRY_SKIPPED', `ENTRY SKIPPED — RATE ALREADY PROCESSED ($${normalizedPrice})`);
        this.lastSkippedRate = normalizedPrice;
      }
      return;
    }

    // New unique rate detected! Open new BUY + SELL pair immediately.
    this.createNewPair(symbol, normalizedPrice, time, usdInrRate);
  }

  getActivePairsCount() {
    return this.pairs.filter(p => p.status === 'ACTIVE').length;
  }

  createNewPair(symbol, entryPrice, timestamp, usdInrRate) {
    const pairSeq = (this.pairs.length + 1).toString().padStart(4, '0');
    const pairId = `PAIR-${pairSeq}`;
    
    const targetMove = this.settings.targetDisabled ? null : this.settings.profitTargetMove;
    
    // BUY Target: Entry + Target Move
    const buyTarget = targetMove ? this.normalizePrice(entryPrice + targetMove, symbol) : null;
    // SELL Target: Entry - Target Move
    const sellTarget = targetMove ? this.normalizePrice(entryPrice - targetMove, symbol) : null;

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
      targetMove,
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
      targetMove,
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

  evaluateTargetExits(currentPrice, currentTimestamp, currentUsdInrRate) {
    let stateChanged = false;

    for (const pair of this.pairs) {
      if (pair.status === 'CLOSED') continue;

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
    const totalChargesUSD = entryFeeUSD + exitFeeUSD + gstUSD;
    const netUSD = grossUSD - totalChargesUSD;

    let finalExitReason = exitReason;
    if (exitReason.includes('PROFIT HIT') && netUSD < 0) {
      finalExitReason = exitReason.replace('PROFIT HIT', 'PRICE HIT (NET LOSS DUE TO FEES)');
    }
    position.exitReason = finalExitReason;

    const grossINR = grossUSD * usdInrRate;
    const totalChargesINR = totalChargesUSD * usdInrRate;
    const netINR = grossINR - totalChargesINR;

    const holdingDurationMs = exitTimestamp - position.entryTimestamp;
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
    const rateInfo = rateFeed.getCurrentRate(this.settings.instrument);
    const exitPrice = rateInfo.price;
    if (!exitPrice) {
      throw new Error('Cannot close position: Market price is unavailable.');
    }

    for (const pair of this.pairs) {
      if (pair.buyPosition.positionId === positionId && pair.buyPosition.status === 'OPEN') {
        this.closePosition(pair, pair.buyPosition, exitPrice, Date.now(), rateInfo.usdInrRate, 'MANUAL USER CLOSE');
        if (pair.buyPosition.status === 'CLOSED' && pair.sellPosition.status === 'CLOSED') {
          pair.status = 'CLOSED';
          pair.closedTime = new Date().toISOString();
        }
        this.saveState();
        return true;
      }
      if (pair.sellPosition.positionId === positionId && pair.sellPosition.status === 'OPEN') {
        this.closePosition(pair, pair.sellPosition, exitPrice, Date.now(), rateInfo.usdInrRate, 'MANUAL USER CLOSE');
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

    for (const cp of this.closedPositions) {
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
    const mult = this.contractMultipliers[this.settings.instrument] || 1.0;
    const feeRate = this.settings.takerFeeRate;
    const gstRate = this.settings.gstRate;
    const leverage = this.settings.leverage;

    const openPositionsList = [];

    for (const pair of this.pairs) {
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

        if (currentPrice) {
          if (pos.direction === 'BUY') {
            posGrossUSD = (currentPrice - pos.entryPrice) * qty * mult;
          } else {
            posGrossUSD = (pos.entryPrice - currentPrice) * qty * mult;
          }
          posGrossINR = posGrossUSD * usdInrRate;

          const entryValueUSD = pos.entryPrice * qty * mult;
          const estExitValueUSD = currentPrice * qty * mult;
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
          const posNotionalUSD = currentPrice * qty * mult;
          const posMarginUSD = posNotionalUSD / leverage;
          marginUsedINR += (posMarginUSD * usdInrRate);
        }

        openPositionsList.push({
          pairId: pair.pairId,
          positionId: pos.positionId,
          direction: pos.direction,
          symbol: pos.symbol,
          entryTime: pos.entryTime,
          entryPrice: pos.entryPrice,
          currentPrice: currentPrice || pos.entryPrice,
          targetExitPrice: pos.targetExitPrice,
          targetMove: pos.targetMove,
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

    const realizedBalanceINR = this.settings.startingCapitalINR + realizedNetINR;
    const totalEquityINR = realizedBalanceINR + floatingNetINR;
    const availableMarginINR = Math.max(0, totalEquityINR - marginUsedINR);
    const activePairsCount = this.getActivePairsCount();
    const processedRatesCount = this.processedRates[this.settings.instrument] ? this.processedRates[this.settings.instrument].size : 0;

    return {
      rateFeedInfo: rateInfo,
      settings: this.settings,
      engineStatus: this.engineStatus,
      pauseReason: this.pauseReason,
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
        activeBuyCount,
        activeSellCount,
        closedPositionsCount: this.closedPositions.length,
        winCount,
        lossCount,
        winRate: this.closedPositions.length > 0 ? Number(((winCount / this.closedPositions.length) * 100).toFixed(1)) : 0,
        
        dailyRealizedLossINR: Number(this.dailyTracker.realizedNetLossINR.toFixed(2)),
        dailyLossLimitINR: this.settings.dailyLossCircuitBreakerINR
      },
      openPositions: openPositionsList,
      closedPositions: this.closedPositions.slice().reverse().slice(0, 100),
      auditLogs: this.auditLogs
    };
  }

  toggleEngineState() {
    this.isEngineRunning = !this.isEngineRunning;
    this.logAudit('ENGINE_STATE_TOGGLED', { isEngineRunning: this.isEngineRunning });
    this.saveState();
    return this.isEngineRunning;
  }

  resetAllData() {
    this.pairs = [];
    this.closedPositions = [];
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
    this.logAudit('ENGINE_RESET', 'All engine paper positions, processed rates, and history reset.');
    this.saveState();
  }
}

module.exports = new PaperEngine();
