const fs = require('fs');
const path = require('path');
const rateFeed = require('./rateFeed');

class SolanaEngine {
  constructor() {
    this.settings = {
      startingCapitalINR: 300000.00, // ₹3.0 Lakh starting capital requested by user
      contractQuantity: 3.0, // 3.0 SOL default lot size requested by user
      leverage: 5,
      instrument: 'SOLUSDT',
      profitTargetMove: 0.45, // $0.45 Target Move for Solana as configured
      buyTargetMove: 0.45,
      sellTargetMove: 0.45,
      basketProfitTargetINR: 250, // ₹250 Punarjanm Basket Profit Threshold
      autoPunarjanmEnabled: false, // Auto-harvest disabled per user request
      autoAddNewPairs: true,
      maxActivePairs: 50,
      takerFeeRate: 0.00075, // 0.075% Mudrex taker fee
      gstRate: 0.18, // 18% GST
      conservativeFeeMultiplier: 1.40, // 1.4x conservative buffer (50 -> 70 charges) requested by user
      slippageBufferINR: 2.0, // ₹2.00 slippage buffer
      usdInrRate: 102.00, // Authoritative Mudrex INR Futures Rate
      tradingMode: 'PAPER', // Pure simulator for checking only as requested
      realOrdersDisabled: true
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

    this.isEngineRunning = true;
    this.engineStatus = 'RUNNING';
    this.pauseReason = '';

    this.storagePath = path.join(__dirname, '../../data/solana_engine_state.json');

    this.initFromStorage();

    // Subscribe to real-time market rates
    rateFeed.subscribe((type, data) => this.handleRateEvent(type, data));
  }

  initFromStorage() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const data = JSON.parse(raw);
        if (data) {
          if (Array.isArray(data.pairs)) this.pairs = data.pairs;
          if (Array.isArray(data.closedPositions)) this.closedPositions = data.closedPositions;
          if (Array.isArray(data.punarjanmCycles)) this.punarjanmCycles = data.punarjanmCycles;
          if (typeof data.punarjanmCount === 'number') this.punarjanmCount = data.punarjanmCount;
          if (typeof data.pairCounter === 'number') this.pairCounter = data.pairCounter;
          if (data.settings) this.settings = { ...this.settings, ...data.settings, tradingMode: 'PAPER', realOrdersDisabled: true };
          if (Array.isArray(data.processedRates)) this.processedRates = new Set(data.processedRates);
          console.log(`[Solana Engine] Restored state from storage: ${this.pairs.length} pairs, ${this.closedPositions.length} closed trades.`);
        }
      }
    } catch (e) {
      console.warn('[Solana Engine] Error initializing from storage:', e.message);
    }
  }

  saveState() {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const payload = {
        timestamp: new Date().toISOString(),
        settings: this.settings,
        pairs: this.pairs,
        closedPositions: this.closedPositions.slice(0, 1000), // Keep last 1000
        punarjanmCount: this.punarjanmCount,
        punarjanmCycles: this.punarjanmCycles,
        pairCounter: this.pairCounter,
        processedRates: Array.from(this.processedRates)
      };
      fs.writeFileSync(this.storagePath, JSON.stringify(payload, null, 2), 'utf8');
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
    const roundedPrice = Number(price.toFixed(2));
    if (!roundedPrice || isNaN(roundedPrice) || roundedPrice <= 0) return;

    // 1. Skip consecutive identical tick
    if (this.lastProcessedRate === roundedPrice) {
      this.lastSkippedRate = roundedPrice;
      return;
    }

    const usdInrRate = Number(this.settings.usdInrRate || 102.00);
    const qty = Number(this.settings.contractQuantity || 5.0);
    const leverage = Number(this.settings.leverage || 5);

    // 2. Check for missing legs on existing active pairs
    for (const pair of this.pairs) {
      if (pair.status === 'CLOSED') continue;
      const bOpen = pair.buyPosition && pair.buyPosition.status === 'OPEN';
      const sOpen = pair.sellPosition && pair.sellPosition.status === 'OPEN';

      if (bOpen && sOpen) continue; // Both legs already open

      const tolerance = 0.005;

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

    // 3. Check if a full active pair (both legs OPEN) already exists at this exact rate
    const existingBothOpenPairAtRate = this.pairs.find(p => {
      if (p.status !== 'OPEN') return false;
      const bOpen = p.buyPosition && p.buyPosition.status === 'OPEN';
      const sOpen = p.sellPosition && p.sellPosition.status === 'OPEN';
      return bOpen && sOpen && Math.abs(p.entryPrice - roundedPrice) < 0.005;
    });

    if (existingBothOpenPairAtRate) {
      this.lastSkippedRate = roundedPrice;
      return;
    }

    // 4. Check active pairs cap
    const activePairsCount = this.pairs.filter(p => p.status === 'OPEN').length;
    if (activePairsCount >= (this.settings.maxActivePairs || 50)) {
      return;
    }

    // 5. Margin check for 1 pair (BUY + SELL at 5x leverage)
    const reqMarginPairINR = ((roundedPrice * qty * usdInrRate) / leverage) * 2;
    const metrics = this.getDashboardMetrics();
    if (metrics.wallet.availableMarginINR < reqMarginPairINR) {
      console.warn(`[Solana Engine] Margin exhausted. Needed: ₹${reqMarginPairINR.toFixed(2)}, Available: ₹${metrics.wallet.availableMarginINR}`);
      return;
    }

    // 6. Create brand new pair at this rate!
    this.createNewPair('SOLUSDT', roundedPrice, Date.now(), usdInrRate);
    this.lastProcessedRate = roundedPrice;
    console.log(`[Solana Engine] New rate $${roundedPrice.toFixed(2)} accepted! Created pair ${this.pairCounter - 1}. Active pairs: ${activePairsCount + 1}`);
  }

  reopenMissingLeg(pair, direction, entryPrice, timestamp = Date.now(), usdInrRate = 102.00) {
    const qty = pair.quantity || this.settings.contractQuantity || 5.0;
    const targetMove = pair.targetMove || this.settings.profitTargetMove || 0.50;
    const seq = pair.pairId.replace('PAIR-SOL-', '');
    const legId = `P-PAIR-SOL-${seq}-${direction}-${Date.now().toString().slice(-4)}`;

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
        ledger: 'PAPER',
        source: 'SOLANA_SIMULATOR'
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
        ledger: 'PAPER',
        source: 'SOLANA_SIMULATOR'
      };
      console.log(`[Solana Engine] Reopened missing SELL leg for ${pair.pairId} at $${entryPrice.toFixed(2)}`);
    }

    pair.status = 'OPEN';
    this.saveState();
  }

  createNewPair(symbol, price, timestamp = Date.now(), usdInrRate = 102.00, customQty = null, customTarget = null) {
    const qty = customQty !== null ? Number(customQty) : Number(this.settings.contractQuantity || 5.0);
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
    this.saveState();
    return pair;
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
        if (livePrice >= b.targetExitPrice) {
          this.closePositionLeg(b, livePrice, now, 'BUY TARGET PROFIT HIT', usdInr, takerFee, gstRate);
        }
      }

      // 2. Evaluate SELL Leg
      if (pair.sellPosition && pair.sellPosition.status === 'OPEN') {
        const s = pair.sellPosition;
        if (livePrice <= s.targetExitPrice) {
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

  closePositionLeg(pos, exitPrice, exitTime = Date.now(), exitReason = 'TARGET PROFIT HIT', usdInr = 102.00, takerFee = 0.00075, gstRate = 0.18) {
    pos.status = 'CLOSED';
    pos.exitPrice = Number(exitPrice.toFixed(2));
    pos.exitTime = new Date(exitTime).toISOString();
    pos.exitTimestamp = exitTime;
    pos.exitReason = exitReason;

    const qty = pos.quantity || this.settings.contractQuantity || 5.0;
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

    this.closedPositions.unshift({ ...pos });
    this.saveState();
  }

  checkPunarjanmAutoHarvest(livePrice) {
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
      const qty = pair.quantity || this.settings.contractQuantity || 3.0;

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

    // Realized Net Profit from closed positions
    let realizedGrossINR = 0, realizedChargesINR = 0, realizedNetINR = 0;
    let winCount = 0, lossCount = 0;
    for (const cp of this.closedPositions) {
      const g = cp.grossProfitINR || 0;
      const c = cp.totalChargesINR || 0;
      const n = cp.netProfitINR !== undefined ? cp.netProfitINR : (g - c);
      realizedGrossINR += g;
      realizedChargesINR += c;
      realizedNetINR += n;
      if (n >= 0) winCount++; else lossCount++;
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

    const startingCapitalINR = this.settings.startingCapitalINR || 300000.00;
    const lockedMarginINR = realMudrexLockedINR !== null && realMudrexLockedINR > 0 ? realMudrexLockedINR : floating.dynamicMarginUsedINR;
    const availableMarginINR = realMudrexAvailINR !== null ? realMudrexAvailINR : Math.max(0, Number((startingCapitalINR + realizedNetINR - lockedMarginINR).toFixed(2)));
    const equityINR = Number((availableMarginINR + lockedMarginINR + floating.floatingNetINR).toFixed(2));
    const spotBalanceINR = realMudrexSpotINR || 0;

    const openPairs = this.pairs.filter(p => p.status === 'OPEN').map(p => {
      const b = p.buyPosition;
      const s = p.sellPosition;
      let bPnlUSD = 0, bPnlINR = 0;
      let sPnlUSD = 0, sPnlINR = 0;

      const defQty = this.settings.contractQuantity || 3.0;
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
          entryTime: b.entryTime,
          currentPrice: livePrice,
          targetPrice: b.targetExitPrice,
          quantity: b.quantity || defQty,
          distToTarget: Number((b.targetExitPrice - livePrice).toFixed(2)),
          floatingPnlUSD: Number(bPnlUSD.toFixed(2)),
          floatingPnlINR: Number(bPnlINR.toFixed(2))
        } : null,
        sell: s ? {
          positionId: s.positionId,
          status: s.status,
          direction: 'SELL',
          entryPrice: s.entryPrice,
          entryTime: s.entryTime,
          currentPrice: livePrice,
          targetPrice: s.targetExitPrice,
          quantity: s.quantity || defQty,
          distToTarget: Number((livePrice - s.targetExitPrice).toFixed(2)),
          floatingPnlUSD: Number(sPnlUSD.toFixed(2)),
          floatingPnlINR: Number(sPnlINR.toFixed(2))
        } : null
      };
    });

    // Net Summary for Hero Banner
    let netSummary = null;
    const netQty = Math.abs(floating.openBuyCount - floating.openSellCount) * (this.settings.contractQuantity || 5.0);
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
        usdInrRate: usdInr,
        isRealMudrexExchangeWallet: realMudrexAvailINR !== null
      },
      mudrexExchange: {
        positions: [],
        count: openPairs.length,
        netSummary,
        note: realMudrexAvailINR !== null ? 'SUBH MONEY SOLANA LIVE DESK (Authoritative Mudrex Exchange Balance)' : 'SUBH MONEY SOLANA DESK'
      },
      engine: {
        status: this.engineStatus,
        isEngineRunning: this.isEngineRunning,
        activeSymbol: 'SOLUSDT',
        activePairsCount: openPairs.length,
        activeBuyCount: floating.openBuyCount,
        activeSellCount: floating.openSellCount,
        contractQuantity: this.settings.contractQuantity,
        profitTargetMove: this.settings.profitTargetMove,
        basketProfitTargetINR: this.settings.basketProfitTargetINR,
        leverage: this.settings.leverage,
        tradingMode: 'PAPER',
        realOrdersDisabled: true,
        pairs: openPairs
      },
      punarjanm: {
        count: this.punarjanmCount,
        cycles: this.punarjanmCycles,
        basketTargetINR: this.settings.basketProfitTargetINR,
        lastHarvest: this.lastPunarjanmSummary
      },
      pnl: {
        realizedGrossINR: Number(realizedGrossINR.toFixed(2)),
        realizedGrossUSD: Number((realizedGrossINR / usdInr).toFixed(2)),
        realizedChargesINR: Number(realizedChargesINR.toFixed(2)),
        realizedChargesUSD: Number((realizedChargesINR / usdInr).toFixed(2)),
        realizedNetINR: Number(realizedNetINR.toFixed(2)),
        realizedNetUSD: Number((realizedNetINR / usdInr).toFixed(2)),
        totalRealizedINR: Number(realizedNetINR.toFixed(2)),
        totalRealizedUSD: Number((realizedNetINR / usdInr).toFixed(2)),
        floatingGrossINR: floating.floatingGrossINR,
        floatingGrossUSD: floating.floatingGrossUSD,
        floatingChargesINR: floating.floatingChargesINR,
        floatingChargesUSD: floating.floatingChargesUSD,
        floatingNetINR: floating.floatingNetINR,
        floatingNetUSD: floating.floatingNetUSD,
        totalFloatingINR: floating.floatingNetINR,
        totalFloatingUSD: floating.floatingNetUSD,
        estimatedTotalINR: Number((realizedNetINR + floating.floatingNetINR).toFixed(2)),
        estimatedTotalUSD: Number(((realizedNetINR + floating.floatingNetINR) / usdInr).toFixed(2)),
        winTrades: winCount,
        lossTrades: lossCount,
        totalClosedTrades: this.closedPositions.length,
        closedTradesCount: this.closedPositions.length,
        winRate: this.closedPositions.length > 0 ? Number(((winCount / this.closedPositions.length) * 100).toFixed(1)) : 0
      },
      closedPositions: this.closedPositions.slice(0, 100)
    };
  }

  resetData(newQty = null, newCapital = 300000.00, newTargetMove = null) {
    this.settings.startingCapitalINR = (newCapital && !isNaN(newCapital) && Number(newCapital) > 0) ? Number(newCapital) : 300000.00;
    if (newQty && !isNaN(newQty) && Number(newQty) > 0) {
      this.settings.contractQuantity = Number(newQty);
    } else {
      this.settings.contractQuantity = 3.0;
    }
    if (newTargetMove && !isNaN(newTargetMove) && Number(newTargetMove) > 0) {
      this.settings.profitTargetMove = Number(newTargetMove);
      this.settings.buyTargetMove = Number(newTargetMove);
      this.settings.sellTargetMove = Number(newTargetMove);
    }
    this.settings.autoPunarjanmEnabled = false; // Harvest disabled per user request
    this.pairs = [];
    this.closedPositions = [];
    this.punarjanmCount = 0;
    this.punarjanmCycles = [];
    this.processedRates.clear();
    this.lastProcessedRate = null;
    this.pairCounter = 1;
    this.isEngineRunning = true;
    this.engineStatus = 'RUNNING';

    // Auto-create initial fresh pair with current lot size if live rate is present
    try {
      const cur = rateFeed.getCurrentRate('SOLUSDT');
      if (cur && cur.price > 0) {
        this.createNewPair('SOLUSDT', cur.price, Date.now(), cur.usdInrRate || 102.00);
      }
    } catch (e) {
      console.warn('[Solana Engine] Error creating initial pair after reset:', e.message);
    }

    this.saveState();
    console.log(`[Solana Engine] Reset data: Capital set to ₹${this.settings.startingCapitalINR.toLocaleString('en-IN')} INR with ${this.settings.contractQuantity} SOL contract size and $${this.settings.profitTargetMove.toFixed(2)} target move.`);
    return { 
      success: true, 
      message: `Solana simulator data reset to ₹${this.settings.startingCapitalINR.toLocaleString('en-IN')} capital, ${this.settings.contractQuantity} SOL lot size, and $${this.settings.profitTargetMove.toFixed(2)} target move.`, 
      contractQuantity: this.settings.contractQuantity,
      startingCapitalINR: this.settings.startingCapitalINR,
      profitTargetMove: this.settings.profitTargetMove
    };
  }
}

module.exports = new SolanaEngine();
