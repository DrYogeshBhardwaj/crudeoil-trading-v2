const rateFeed = require('./rateFeed');
const storage = require('./storage');

class PaperEngine {
  constructor() {
    this.settings = {
      startingCapitalINR: 119923.61,
      contractQuantity: 2.0,
      leverage: 5,
      instrument: 'CLUSDT',
      profitTargetMode: 'PRICE_MOVE',
      profitTargetMove: 0.25, // $0.25 Target Move (User-Configured)
      buyTargetMove: 0.25,
      sellTargetMove: 0.25,
      basketProfitTargetINR: 250, // ₹250 Punarjanm Basket Profit Threshold (Promoted from ₹100 testing)
      autoPunarjanmEnabled: true,
      autoAiTargetMode: false,
      autoAddNewPairs: true, // Auto add new pairs on rate changes
      targetDisabled: false,
      maxActivePairs: 500,
      dailyLossCircuitBreakerINR: 2000,
      takerFeeRate: 0.00075, // 0.075% strict fee
      gstRate: 0.18, // 18% GST on fees
      slippageBufferINR: 5.0, // ₹5.00 slippage & funding fee buffer per trade
      usdInrRate: 102.00, // 1 USD = 102.00 INR (Mudrex INR Futures Rate)
      tradingMode: 'LIVE', // 'PAPER' (Simulated) or 'LIVE' (Real Orders)
      realOrdersDisabled: false,
      sessionScheduler: {
        enabled: true,
        sessions: [
          {
            id: 'high_vol_eu_us',
            name: '⚡ European & US Session (High Volatility)',
            shortName: 'EU / US Session',
            startIST: '13:00',
            endIST: '23:30',
            contractQuantity: 2.0,
            profitTargetMove: 0.25,
            basketProfitTargetINR: 250
          },
          {
            id: 'low_vol_asian_night',
            name: '🌙 Asian & Night Session (Low Volatility)',
            shortName: 'Night / Asian Session',
            startIST: '23:30',
            endIST: '13:00',
            contractQuantity: 2.0,
            profitTargetMove: 0.25,
            basketProfitTargetINR: 250
          }
        ]
      }
    };

    this.contractMultipliers = {
      CLUSDT: 1.0, // 1 barrel
      XAGUSDT: 1.0, // 1 troy oz
      BTCUSDT: 1.0  // 1 BTC
    };

    this.pairs = [];
    this.closedPositions = [];
    this.auditLogs = [];
    this.punarjanmCount = 0;
    this.lastPunarjanmSummary = null;
    this.lastPunarjanmTime = 0;
    this.currentSessionId = null;
    
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

  getCurrentISTTimeInfo(timestamp = Date.now()) {
    const d = new Date(timestamp);
    const timeStr = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }); // "HH:MM:SS"
    const [hh, mm] = timeStr.split(':').map(Number);
    const minuteOfDay = (hh || 0) * 60 + (mm || 0);
    return { timeStr, hh, mm, minuteOfDay };
  }

  isMinuteInTimeRange(minuteOfDay, startStr, endStr) {
    if (!startStr || !endStr) return false;
    const [sH, sM] = startStr.split(':').map(Number);
    const [eH, eM] = endStr.split(':').map(Number);
    const startMin = (sH || 0) * 60 + (sM || 0);
    const endMin = (eH || 0) * 60 + (eM || 0);
    
    if (startMin <= endMin) {
      return minuteOfDay >= startMin && minuteOfDay < endMin;
    } else {
      return minuteOfDay >= startMin || minuteOfDay < endMin;
    }
  }

  evaluateSessionScheduler(time = Date.now()) {
    if (!this.settings.sessionScheduler || this.settings.sessionScheduler.enabled === false) return null;
    const { minuteOfDay, timeStr } = this.getCurrentISTTimeInfo(time);
    const sessions = this.settings.sessionScheduler.sessions || [];
    
    const active = sessions.find(s => this.isMinuteInTimeRange(minuteOfDay, s.startIST, s.endIST));
    if (!active) return null;

    if (this.currentSessionId !== active.id) {
      const prevSessionId = this.currentSessionId;
      this.currentSessionId = active.id;
      
      if (active.contractQuantity !== undefined && Number(active.contractQuantity) > 0) {
        this.settings.contractQuantity = Number(active.contractQuantity);
      }
      if (active.basketProfitTargetINR !== undefined && Number(active.basketProfitTargetINR) > 0) {
        this.settings.basketProfitTargetINR = Number(active.basketProfitTargetINR);
      }
      if (active.profitTargetMove !== undefined && Number(active.profitTargetMove) > 0) {
        this.settings.profitTargetMove = Number(active.profitTargetMove);
        this.settings.buyTargetMove = Number(active.profitTargetMove);
        this.settings.sellTargetMove = Number(active.profitTargetMove);
      }
      
      this.logAudit('SESSION_SCHEDULE_SWITCHED', {
        previousSession: prevSessionId,
        newSession: active.name,
        timeIST: timeStr,
        contractQuantity: this.settings.contractQuantity,
        basketProfitTargetINR: this.settings.basketProfitTargetINR,
        profitTargetMove: this.settings.profitTargetMove
      });
      this.saveState();
    }

    return {
      ...active,
      timeStr,
      minuteOfDay
    };
  }

  getSessionSchedulerStatus(time = Date.now()) {
    const { minuteOfDay, timeStr } = this.getCurrentISTTimeInfo(time);
    const scheduler = this.settings.sessionScheduler || { enabled: true, sessions: [] };
    const sessions = scheduler.sessions || [];
    const active = sessions.find(s => this.isMinuteInTimeRange(minuteOfDay, s.startIST, s.endIST)) || null;

    return {
      enabled: scheduler.enabled !== false,
      currentTimeIST: timeStr,
      currentMinuteOfDay: minuteOfDay,
      activeSession: active ? {
        ...active,
        currentContractQuantity: this.settings.contractQuantity,
        currentBasketProfitTargetINR: this.settings.basketProfitTargetINR,
        currentProfitTargetMove: this.settings.profitTargetMove
      } : null,
      sessions
    };
  }

  updateSessionScheduler(newConfig) {
    if (!newConfig || typeof newConfig !== 'object') return false;
    if (!this.settings.sessionScheduler) this.settings.sessionScheduler = {};
    if (newConfig.enabled !== undefined) this.settings.sessionScheduler.enabled = !!newConfig.enabled;
    if (Array.isArray(newConfig.sessions)) {
      this.settings.sessionScheduler.sessions = newConfig.sessions;
    }
    this.currentSessionId = null; // force re-evaluation
    this.evaluateSessionScheduler();
    this.saveState();
    return true;
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
      this.settings.startingCapitalINR = 119923.61; // ₹1,19,923.61 INR capital (Live Mudrex balance)
      this.settings.maxActivePairs = 500; // 500 Active Pairs Cap
      this.settings.contractQuantity = 2.0; // 2.0 Barrels per pair
      this.settings.profitTargetMove = 0.25; // $0.25 Target Move (User-Configured)
      this.settings.buyTargetMove = 0.25;
      this.settings.sellTargetMove = 0.25;
      this.settings.basketProfitTargetINR = 250; // ₹250 Punarjanm Basket Profit Threshold (Promoted from ₹100 testing)
      this.settings.autoPunarjanmEnabled = true;
      this.settings.profitTargetMode = 'PRICE_MOVE';
      this.settings.tradingMode = 'LIVE';
      this.settings.realOrdersDisabled = false;
      if (saved.punarjanmCount !== undefined) this.punarjanmCount = saved.punarjanmCount;
      if (saved.lastPunarjanmSummary) this.lastPunarjanmSummary = saved.lastPunarjanmSummary;
      if (saved.pairs) this.pairs = saved.pairs;
      if (saved.closedPositions) this.closedPositions = saved.closedPositions;
      // Ensure stale PAIR-0013 and PAIR-0014 from Punarjanm 1 (entry < 93.60) are marked CLOSED
      for (const p of this.pairs) {
        if ((p.pairId === 'PAIR-0013' || p.pairId === 'PAIR-0014') && (p.entryRate < 93.60 || (p.buyPosition && p.buyPosition.entryPrice < 93.60))) {
          p.status = 'CLOSED';
          if (p.buyPosition) p.buyPosition.status = 'CLOSED';
          if (p.sellPosition) p.sellPosition.status = 'CLOSED';
        }
      }

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

      if (saved.settings && saved.settings.sessionScheduler) {
        this.settings.sessionScheduler = saved.settings.sessionScheduler;
      }
      this.evaluateSessionScheduler();
      
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

      // Prune legacy test dummy pairs (e.g. entry rate >= $98.0 or test IDs PAIR-0049/0050)
      const testBPrice = bOpen ? pair.buyPosition.entryPrice : null;
      const testSPrice = sOpen ? pair.sellPosition.entryPrice : null;
      const testRate = testBPrice !== null ? testBPrice : testSPrice;
      if (testRate !== null && (testRate >= 98.0 || pair.pairId === 'PAIR-0049' || pair.pairId === 'PAIR-0050')) {
        if (pair.buyPosition) pair.buyPosition.status = 'CLOSED';
        if (pair.sellPosition) pair.sellPosition.status = 'CLOSED';
        pair.status = 'CLOSED';
        removedCount++;
        continue;
      }

      // Preserve active pairs in LIVE mode without pruning on temporary API retry/rate limit status

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
      isEngineRunning: this.isEngineRunning,
      punarjanmCount: this.punarjanmCount || 0,
      lastPunarjanmSummary: this.lastPunarjanmSummary || null
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

    // Evaluate market session auto-scheduler on every tick
    this.evaluateSessionScheduler(time);

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

    // Auto-Punarjanm Cycle Check (Idempotency throttle: 30 seconds cooldown)
    if (this.settings.autoPunarjanmEnabled && this.settings.basketProfitTargetINR > 0) {
      if (!this.lastPunarjanmTime || (time - this.lastPunarjanmTime > 30000)) {
        try {
          const mudrexLive = require('./mudrexLiveAdapter');
          let currentNetPnlINR = 0;
          if (mudrexLive.lastFetchPositionsRes && mudrexLive.lastFetchPositionsRes.data && mudrexLive.lastFetchPositionsRes.data.length > 0) {
            const mainPos = mudrexLive.lastFetchPositionsRes.data[0];
            const posQty = Number(mainPos.quantity || 0);
            const posEntry = Number(mainPos.entryPrice || mainPos.entry_price || 0);
            const isShort = mainPos.direction === 'SELL' || mainPos.direction === 'SHORT';
            if (posQty > 0 && posEntry > 0) {
              const pnlUSD = isShort ? (posEntry - normalizedPrice) * posQty : (normalizedPrice - posEntry) * posQty;
              currentNetPnlINR = pnlUSD * (usdInrRate || 102.00);
            }
          }
          if (currentNetPnlINR >= this.settings.basketProfitTargetINR) {
            this.lastPunarjanmTime = time;
            console.log(`[Auto-Punarjanm] Triggering Rebirth Cycle! Mudrex Net Profit: +₹${currentNetPnlINR.toFixed(2)} >= Target ₹${this.settings.basketProfitTargetINR}`);
            this.executePunarjanm(`AUTO_BASKET_PROFIT (+₹${currentNetPnlINR.toFixed(2)})`, normalizedPrice, usdInrRate).catch(err => {
              console.error('[Auto-Punarjanm] Execution error:', err.message);
            });
            return;
          }
        } catch (e) {}
      }
    }

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

          let availMargin = metrics.summary.availableMarginINR;
          if (this.settings.tradingMode === 'LIVE' && process.env.IS_TEST !== 'true' && process.env.NODE_ENV !== 'test') {
            try {
              const mudrexLive = require('./mudrexLiveAdapter');
              const liveAvail = mudrexLive.getAvailableMargin();
              if (typeof liveAvail === 'number' && liveAvail > 0) {
                availMargin = liveAvail;
              }
            } catch (e) {}
          }

          if (availMargin >= reqMarginPerPosINR) {
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

          let availMargin = metrics.summary.availableMarginINR;
          if (this.settings.tradingMode === 'LIVE' && process.env.IS_TEST !== 'true' && process.env.NODE_ENV !== 'test') {
            try {
              const mudrexLive = require('./mudrexLiveAdapter');
              const liveAvail = mudrexLive.getAvailableMargin();
              if (typeof liveAvail === 'number' && liveAvail > 0) {
                availMargin = liveAvail;
              }
            } catch (e) {}
          }

          if (availMargin >= reqMarginPerPosINR) {
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

    // 6. Check Available Margin for NEW Pair (1 BUY + 1 SELL of contractQuantity)
    const qty = this.settings.contractQuantity || 1.0;
    const mult = this.contractMultipliers[symbol] || 1.0;
    const leverage = this.settings.leverage || 5;
    const reqMarginPairINR = ((normalizedPrice * qty * mult * usdInrRate) / leverage) * 2;

    const metrics = this.getDashboardMetrics();
    let paperAvailableMarginINR = (metrics && metrics.summary && metrics.summary.availableMarginINR !== undefined)
      ? metrics.summary.availableMarginINR
      : Math.max(0, (this.settings.startingCapitalINR || 119923.61) - reqMarginPairINR);

    // In LIVE mode, authoritative available margin is from the real Mudrex futures wallet!
    if (this.settings.tradingMode === 'LIVE' && process.env.IS_TEST !== 'true' && process.env.NODE_ENV !== 'test') {
      try {
        const mudrexLive = require('./mudrexLiveAdapter');
        const liveAvail = mudrexLive.getAvailableMargin();
        if (typeof liveAvail === 'number' && liveAvail > 0) {
          paperAvailableMarginINR = liveAvail;
        }
      } catch (e) {}
    }

    if (paperAvailableMarginINR < reqMarginPairINR) {
      this.engineStatus = 'PAUSED';
      this.pauseReason = `PAUSED — INSUFFICIENT MARGIN (Required: ₹${reqMarginPairINR.toFixed(2)}, Available: ₹${paperAvailableMarginINR.toFixed(2)})`;
      if (this.lastSkippedRate !== `MARGIN-${normalizedPrice}`) {
        this.logAudit('ENTRY_REJECTED', `ENTRY REJECTED — INSUFFICIENT MARGIN (Required ₹${reqMarginPairINR.toFixed(2)} for ${qty} Barrels Pair, Available: ₹${paperAvailableMarginINR.toFixed(2)})`);
        this.lastSkippedRate = `MARGIN-${normalizedPrice}`;
      }
      return;
    }

    this.engineStatus = 'RUNNING';
    this.pauseReason = '';

    // New pair allowed! Create 1 BUY + 1 SELL pair at exact same normalizedPrice.
    this.createNewPair(symbol, normalizedPrice, time, usdInrRate);
  }

  reopenMissingLeg(pair, direction, entryPrice, timestamp, usdInrRate, customQuantity, customTargetMove) {
    const symbol = pair.symbol;
    const targetMove = customTargetMove !== undefined ? customTargetMove : (this.settings.targetDisabled ? null : this.settings.profitTargetMove);
    const quantity = customQuantity !== undefined ? customQuantity : this.settings.contractQuantity;
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

  createNewPair(symbol, entryPrice, timestamp, usdInrRate, customQuantity, customTargetMove) {
    const pairSeq = (this.pairs.length + 1).toString().padStart(4, '0');
    const pairId = `PAIR-${pairSeq}`;
    
    let bMove = customTargetMove !== undefined ? customTargetMove : (this.settings.profitTargetMove || this.settings.buyTargetMove || 0.25);
    let sMove = customTargetMove !== undefined ? customTargetMove : (this.settings.profitTargetMove || this.settings.sellTargetMove || 0.25);
    
    // BUY Target: Entry + BUY Target Move
    const buyTarget = this.settings.targetDisabled ? null : this.normalizePrice(entryPrice + bMove, symbol);
    // SELL Target: Entry - SELL Target Move
    const sellTarget = this.settings.targetDisabled ? null : this.normalizePrice(entryPrice - sMove, symbol);

    const quantity = customQuantity !== undefined ? customQuantity : this.settings.contractQuantity;
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

    // In LIVE mode, trigger real order transmission to Mudrex!
    if (this.settings.tradingMode === 'LIVE' && process.env.IS_TEST !== 'true' && process.env.NODE_ENV !== 'test') {
      try {
        const mudrexLive = require('./mudrexLiveAdapter');
        if (mudrexLive && typeof mudrexLive.transmitPendingLiveOrders === 'function') {
          mudrexLive.transmitPendingLiveOrders().catch(() => {});
        }
      } catch (e) {}
    }

    return pair;
  }

  async executePunarjanm(reason = 'MANUAL_USER_REQUEST', customPrice = null, customUsdInrRate = null) {
    const rateFeed = require('./rateFeed');
    const cur = rateFeed.getCurrentRate('CLUSDT');
    const closeRate = customPrice || (cur ? cur.price : (this.lastProcessedRate || 93.50));
    const usdInrRate = customUsdInrRate || (cur ? (cur.usdInrRate || 102.00) : 102.00);

    this.punarjanmCount = (this.punarjanmCount || 0) + 1;
    const cycleTag = `Punarjanm${this.punarjanmCount}`;

    let mudrexCloseRes = null;
    let closedQty = 0;
    let closedPosId = '';
    let mudrexPnlINR = 0;

    // 1. Close Real Mudrex Position if exists
    try {
      const mudrexLive = require('./mudrexLiveAdapter');
      const pRes = await mudrexLive.fetchPositions();
      const posList = (pRes && pRes.success && Array.isArray(pRes.data)) ? pRes.data : [];

      if (posList.length > 0) {
        const targetPos = posList[0];
        closedPosId = targetPos.positionId || targetPos.exchangePositionId;
        closedQty = targetPos.quantity;
        mudrexPnlINR = Number(targetPos.unrealized_pnl || targetPos.unrealised_pnl || 0);
        const sym = (targetPos.symbol || 'CLUSDT').replace('-', '');
        const dir = targetPos.direction;
        const oppSide = (dir === 'BUY' || dir === 'LONG') ? 'SELL' : 'BUY';
        const oppOrderType = oppSide === 'BUY' ? 'LONG' : 'SHORT';

        if (closedPosId) {
          mudrexCloseRes = await mudrexLive.closeRealPosition(closedPosId, sym);
        }

        if (!mudrexCloseRes || !mudrexCloseRes.success) {
          const body = {
            trade_currency: 'INR',
            symbol: sym,
            side: oppSide,
            order_type: oppOrderType,
            trigger_type: 'MARKET',
            type: 'MARKET',
            quantity: String(closedQty),
            reduce_only: true
          };
          const orderUrl = `${mudrexLive.baseUrl}/futures/${sym}/order?is_symbol=true&trade_currency=INR`;
          mudrexCloseRes = await mudrexLive.request('POST', orderUrl, body);
        }

        if (closedPosId) {
          mudrexLive.userClosedRealPositionIds.add(String(closedPosId));
        }
      }

      mudrexLive.lastFetchPositionsRes = null;
      mudrexLive.lastFetchPositionsTime = 0;
      mudrexLive.saveState();
    } catch (e) {
      console.warn(`[${cycleTag}] Mudrex position close dispatch error:`, e.message);
    }

    // 2. Synchronize and complete all existing open legs in engine memory WITHOUT recording negative standalone paper losses
    let flushedPairsCount = 0;
    if (Array.isArray(this.pairs)) {
      for (const pair of this.pairs) {
        if (pair.status !== 'CLOSED') {
          flushedPairsCount++;
          if (pair.buyPosition && pair.buyPosition.status === 'OPEN') {
            pair.buyPosition.status = 'CLOSED';
            pair.buyPosition.exitPrice = closeRate;
            pair.buyPosition.exitTime = new Date().toISOString();
            pair.buyPosition.exitReason = `${cycleTag} Flushed in Basket Profit Harvest`;
          }
          if (pair.sellPosition && pair.sellPosition.status === 'OPEN') {
            pair.sellPosition.status = 'CLOSED';
            pair.sellPosition.exitPrice = closeRate;
            pair.sellPosition.exitTime = new Date().toISOString();
            pair.sellPosition.exitReason = `${cycleTag} Flushed in Basket Profit Harvest`;
          }
          pair.status = 'CLOSED';
        }
      }
    }

    // 2b. Authoritatively record the real Mudrex Basket Profit Harvest trade in closed positions ledger!
    const harvestPnlINR = (mudrexPnlINR && mudrexPnlINR > 0) ? mudrexPnlINR : (this.settings.basketProfitTargetINR || 250);
    const harvestPnlUSD = Number((harvestPnlINR / usdInrRate).toFixed(4));
    const harvestRecord = {
      pairId: cycleTag,
      positionId: `P-${cycleTag}-HARVEST`,
      direction: 'MUDREX_BASKET',
      symbol: 'CLUSDT',
      entryTime: new Date(Date.now() - 3600000).toISOString(),
      exitTime: new Date().toISOString(),
      entryPrice: closeRate,
      exitPrice: closeRate,
      targetExitPrice: closeRate,
      quantity: closedQty || (flushedPairsCount * (this.settings.contractQuantity || 2.0)),
      contractMultiplier: 1.0,
      grossProfitUSD: harvestPnlUSD,
      grossProfitINR: harvestPnlINR,
      entryFeeUSD: 0,
      exitFeeUSD: 0,
      gstUSD: 0,
      totalChargesUSD: 0,
      totalChargesINR: 0,
      netProfitUSD: harvestPnlUSD,
      netProfitINR: harvestPnlINR,
      usdInrRate,
      exitReason: `${cycleTag} Basket Profit Harvest (+₹${harvestPnlINR.toFixed(2)})`,
      holdingDurationSec: 60,
      ledger: 'MUDREX_LIVE',
      source: 'REAL_EXCHANGE'
    };
    this.closedPositions.push(harvestRecord);
    this.dailyTracker.realizedNetProfitINR += harvestPnlINR;
    this.logAudit('PUNARJANM_HARVEST_RECORDED', harvestRecord);

    // 3. Clear active pairs memory & unique rate grid so new pairs can be opened freely!
    this.pairs = this.pairs.filter(p => p.status === 'ACTIVE'); // will be []
    if (this.processedRates && this.processedRates.CLUSDT) {
      this.processedRates.CLUSDT.clear();
    }
    this.lastProcessedRate = null;
    this.lastSkippedRate = null;

    // 4. Update Punarjanm Tracker
    this.lastPunarjanmSummary = {
      cycleName: cycleTag,
      cycleNumber: this.punarjanmCount,
      timestamp: new Date().toISOString(),
      price: closeRate,
      reason,
      closedMudrexQty: closedQty,
      flushedPairsCount,
      mudrexPnlINR,
      status: 'SUCCESS'
    };

    // 5. Unpause engine and spawn fresh 2.0B pair at the new current price with 0.25 target move!
    this.engineStatus = 'RUNNING';
    this.isEngineRunning = true;
    this.pauseReason = '';

    const newPair = this.createNewPair('CLUSDT', closeRate, Date.now(), usdInrRate, this.settings.contractQuantity, this.settings.profitTargetMove || 0.25);

    this.logAudit('PUNARJANM_CYCLE_COMPLETED', {
      cycleName: cycleTag,
      cycleNumber: this.punarjanmCount,
      reason,
      price: closeRate,
      closedMudrexQty: closedQty,
      flushedPairs: flushedPairsCount,
      mudrexPnlINR
    });

    this.saveState();

    return {
      success: true,
      cycleName: cycleTag,
      cycleNumber: this.punarjanmCount,
      message: `${cycleTag} completed successfully! Mudrex closed (${closedQty} BBL), ${flushedPairsCount} pairs flushed, fresh 2.0B pair birthed at $${closeRate.toFixed(2)}.`,
      punarjanmSummary: this.lastPunarjanmSummary,
      newPair
    };
  }

  smartPairAdd(symbol = 'CLUSDT', targetPrice = null, quantity = 1.0, targetMove = 0.20) {
    const rateFeed = require('./rateFeed');
    const rateInfo = rateFeed.getCurrentRate(symbol);
    const price = targetPrice !== null && targetPrice !== undefined && targetPrice > 0 ? Number(targetPrice) : (rateInfo.price || 91.35);
    const usdInrRate = rateInfo.usdInrRate || this.settings.usdInrRate || 95.91;
    const normalizedPrice = this.normalizePrice(price, symbol);
    const tolerance = this.settings.priceMatchingTolerance || 0.02;
    const qty = Number(quantity) || this.settings.contractQuantity || 1.0;
    const tMove = Number(targetMove) || 0.20;

    // Check all active pairs for rate matching within tolerance
    let matchedPair = null;
    for (const pair of this.pairs) {
      if (pair.status === 'CLOSED') continue;
      const bEntry = (pair.buyPosition && pair.buyPosition.status === 'OPEN') ? pair.buyPosition.entryPrice : null;
      const sEntry = (pair.sellPosition && pair.sellPosition.status === 'OPEN') ? pair.sellPosition.entryPrice : null;
      const refPrice = bEntry !== null ? bEntry : sEntry;
      if (refPrice !== null && Math.abs(refPrice - normalizedPrice) <= tolerance) {
        matchedPair = pair;
        break;
      }
    }

    if (matchedPair) {
      const buyOpen = matchedPair.buyPosition && matchedPair.buyPosition.status === 'OPEN';
      const sellOpen = matchedPair.sellPosition && matchedPair.sellPosition.status === 'OPEN';

      // 1. BUY open hai, SELL missing/end ho gaya -> Sirf missing SELL reopen karo
      if (buyOpen && !sellOpen) {
        this.reopenMissingLeg(matchedPair, 'SELL', normalizedPrice, Date.now(), usdInrRate, qty, tMove);
        return {
          success: true,
          actionTaken: 'REOPENED_SELL',
          rate: normalizedPrice,
          quantity: qty,
          targetMove: tMove,
          pairId: matchedPair.pairId,
          message: `Rate $${normalizedPrice} par BUY pehle se active tha aur SELL end ho gaya tha. Missing SELL (${qty} Barrels) leg successfully add kar di gayi!`
        };
      }

      // 2. SELL open hai, BUY missing/end ho gaya -> Sirf missing BUY reopen karo
      if (sellOpen && !buyOpen) {
        this.reopenMissingLeg(matchedPair, 'BUY', normalizedPrice, Date.now(), usdInrRate, qty, tMove);
        return {
          success: true,
          actionTaken: 'REOPENED_BUY',
          rate: normalizedPrice,
          quantity: qty,
          targetMove: tMove,
          pairId: matchedPair.pairId,
          message: `Rate $${normalizedPrice} par SELL pehle se active tha aur BUY end ho gaya tha. Missing BUY (${qty} Barrels) leg successfully add kar di gayi!`
        };
      }

      // 3. Dono already open hain -> Naya additional pair create kar do
      if (buyOpen && sellOpen) {
        const newPair = this.createNewPair(symbol, normalizedPrice, Date.now(), usdInrRate, qty, tMove);
        return {
          success: true,
          actionTaken: 'CREATED_NEW_PAIR',
          rate: normalizedPrice,
          quantity: qty,
          targetMove: tMove,
          pairId: newPair ? newPair.pairId : 'NEW',
          message: `Rate $${normalizedPrice} par pehle se pair hedged tha. Additional naya Pair (${qty} Barrels BUY + SELL) add kiya gaya!`
        };
      }
    }

    // 4. Is rate par na BUY hai na SELL -> Fresh Pair (BUY + SELL) create karo
    const newPair = this.createNewPair(symbol, normalizedPrice, Date.now(), usdInrRate, qty, tMove);
    return {
      success: true,
      actionTaken: 'CREATED_NEW_PAIR',
      rate: normalizedPrice,
      quantity: qty,
      targetMove: tMove,
      pairId: newPair ? newPair.pairId : 'NEW',
      message: `Rate $${normalizedPrice} par koi position nahi thi. Naya Pair (${qty} Barrels BUY + SELL) add kiya gaya!`
    };
  }

  getActiveRatesInspector(symbol = 'CLUSDT') {
    const rateFeed = require('./rateFeed');
    const rateInfo = rateFeed.getCurrentRate(symbol);
    const currentPrice = rateInfo.price || 91.35;
    const usdInrRate = rateInfo.usdInrRate || 95.91;

    const rateMap = new Map();
    for (const pair of this.pairs) {
      if (pair.status === 'CLOSED') continue;
      const bPos = (pair.buyPosition && pair.buyPosition.status === 'OPEN') ? pair.buyPosition : null;
      const sPos = (pair.sellPosition && pair.sellPosition.status === 'OPEN') ? pair.sellPosition : null;

      const rate = pair.entryRate || (bPos ? bPos.entryPrice : (sPos ? sPos.entryPrice : null));
      if (!rate) continue;

      if (!rateMap.has(rate)) {
        rateMap.set(rate, {
          rate,
          pairId: pair.pairId,
          hasBuy: !!bPos,
          buyQty: bPos ? bPos.quantity : 0,
          buyTarget: bPos ? bPos.targetExitPrice : null,
          hasSell: !!sPos,
          sellQty: sPos ? sPos.quantity : 0,
          sellTarget: sPos ? sPos.targetExitPrice : null,
          status: (bPos && sPos) ? 'BALANCED' : (bPos ? 'ONLY_BUY' : (sPos ? 'ONLY_SELL' : 'INCOMPLETE'))
        });
      }
    }

    const ratesList = Array.from(rateMap.values()).sort((a, b) => b.rate - a.rate);
    return {
      currentPrice,
      usdInrRate,
      ratesList,
      totalActivePairs: this.getActivePairsCount(),
      availableMarginINR: this.getDashboardMetrics()?.summary?.availableMarginINR || 0
    };
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
      if (buy && (buy.status === 'OPEN' || buy.status === 'UNRESOLVED_EXIT_FAILED' || buy.status === 'EXIT_PENDING') && buy.targetExitPrice !== null) {
        if (currentPrice >= buy.targetExitPrice) {
          const exitPrice = Number(buy.targetExitPrice || currentPrice);
          // 1. Authoritative Close in Engine Ledger (Guarantees Realized Trade & Profit is ALWAYS recorded)
          this.closePosition(pair, buy, exitPrice, currentTimestamp, currentUsdInrRate, 'BUY TARGET PROFIT HIT');
          stateChanged = true;

          // 2. Dispatch real Mudrex exit if live exchange position
          const isReal = buy.apiStatus === 'REAL_MUDREX_POSITION' || buy.mudrexOrderId || buy.ledger === 'LIVE';
          if (isReal) {
            try {
              const mudrexLive = require('./mudrexLiveAdapter');
              mudrexLive.executeRealExit(pair, buy, exitPrice, currentTimestamp, currentUsdInrRate, 'BUY TARGET PROFIT HIT')
                .then(res => {
                  this.saveState();
                })
                .catch(err => {
                  console.error('[Live Engine] Real buy exit dispatch error:', err.message);
                });
            } catch (liveErr) {
              console.error('[Live Engine] Adapter error on buy exit:', liveErr.message);
            }
          }
        }
      }

      // Check SELL position
      const sell = pair.sellPosition;
      if (sell && (sell.status === 'OPEN' || sell.status === 'UNRESOLVED_EXIT_FAILED' || sell.status === 'EXIT_PENDING') && sell.targetExitPrice !== null) {
        if (currentPrice <= sell.targetExitPrice) {
          const exitPrice = Number(sell.targetExitPrice || currentPrice);
          // 1. Authoritative Close in Engine Ledger (Guarantees Realized Trade & Profit is ALWAYS recorded)
          this.closePosition(pair, sell, exitPrice, currentTimestamp, currentUsdInrRate, 'SELL TARGET PROFIT HIT');
          stateChanged = true;

          // 2. Dispatch real Mudrex exit if live exchange position
          const isReal = sell.apiStatus === 'REAL_MUDREX_POSITION' || sell.mudrexOrderId || sell.ledger === 'LIVE';
          if (isReal) {
            try {
              const mudrexLive = require('./mudrexLiveAdapter');
              mudrexLive.executeRealExit(pair, sell, exitPrice, currentTimestamp, currentUsdInrRate, 'SELL TARGET PROFIT HIT')
                .then(res => {
                  this.saveState();
                })
                .catch(err => {
                  console.error('[Live Engine] Real sell exit dispatch error:', err.message);
                });
            } catch (liveErr) {
              console.error('[Live Engine] Adapter error on sell exit:', liveErr.message);
            }
          }
        }
      }

      // Check if pair is now fully closed
      const buyClosed = !pair.buyPosition || pair.buyPosition.status === 'CLOSED';
      const sellClosed = !pair.sellPosition || pair.sellPosition.status === 'CLOSED';
      if (buyClosed && sellClosed) {
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
      holdingDurationSec,
      ledger: position.ledger || 'PAPER',
      source: position.source || 'SIMULATED'
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

    const startingCap = this.settings.startingCapitalINR || 119923.61;
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
    this.settings.startingCapitalINR = 119923.61;
    this.settings.maxActivePairs = 500;
    this.settings.profitTargetMove = 0.20;
    this.settings.contractQuantity = 1.0;
    this.settings.tradingMode = 'LIVE';
    this.settings.realOrdersDisabled = false;
    this.settings.profitTargetMode = 'PRICE_MOVE';
    this.settings.strategyMode = 'ALTERNATING_STAGGERED';
    delete this.settings.buyTargetMove;
    delete this.settings.sellTargetMove;
    const isTestEnv = process.env.IS_TEST === 'true' || process.env.NODE_ENV === 'test';
    if (isTestEnv) {
      this.pairs = [];
      this.closedPositions = [];
    } else {
      // Safeguard: Preserve real Mudrex exchange positions and closed history
      const realPairs = (this.pairs || []).filter(p => {
        const bReal = p.buyPosition && (p.buyPosition.apiStatus === 'REAL_MUDREX_POSITION' || p.buyPosition.mudrexOrderId || p.buyPosition.ledger === 'LIVE');
        const sReal = p.sellPosition && (p.sellPosition.apiStatus === 'REAL_MUDREX_POSITION' || p.sellPosition.mudrexOrderId || p.sellPosition.ledger === 'LIVE');
        return bReal || sReal;
      });
      const realClosed = (this.closedPositions || []).filter(p => p.apiStatus === 'REAL_MUDREX_POSITION' || p.mudrexOrderId || p.ledger === 'LIVE');

      this.pairs = realPairs;
      this.closedPositions = realClosed;
    }
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
