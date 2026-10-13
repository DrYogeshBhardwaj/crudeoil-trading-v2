const fs = require('fs');
const path = require('path');
const rateFeed = require('./rateFeed');

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, '../../data');
const STATE_FILE = path.join(DATA_DIR, 'pair_add_state.json');

class PairAddEngine {
  constructor() {
    this.settings = {
      startingCapitalINR: 100000.00,
      contractQuantity: 1.0,
      leverage: 5,
      instrument: 'CLUSDT',
      profitTargetMode: 'PRICE_MOVE',
      profitTargetMove: 0.20,
      autoAiTargetMode: false,
      targetDisabled: false,
      maxActivePairs: 100,
      takerFeeRate: 0.00075,
      gstRate: 0.18,
      slippageBufferINR: 5.0,
      usdInrRate: 96.00,
      tradingMode: 'SIMULATOR',
      engineName: 'PAIR_ADD_ENGINE'
    };

    this.pairs = [];
    this.closedPositions = [];
    this.auditLogs = [];
    this.processedRates = new Set();
    this.lastProcessedRate = null;
    this.isEngineRunning = true;
    this.pairCounter = 1;

    this.loadState();

    // Subscribe to rate ticks
    rateFeed.subscribe((type, data) => this.handleRateEvent(type, data));
  }

  loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (data.settings) this.settings = { ...this.settings, ...data.settings };
        if (Array.isArray(data.pairs)) this.pairs = data.pairs;
        if (Array.isArray(data.closedPositions)) this.closedPositions = data.closedPositions;
        if (Array.isArray(data.auditLogs)) this.auditLogs = data.auditLogs;
        if (data.isEngineRunning !== undefined) this.isEngineRunning = data.isEngineRunning;
        if (data.pairCounter) this.pairCounter = data.pairCounter;
        console.log(`[PairAddEngine] Loaded state (${this.pairs.length} pairs, ${this.closedPositions.length} closed).`);
      }
    } catch (e) {
      console.warn('[PairAddEngine] Error loading state:', e.message);
    }
  }

  saveState() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const data = {
        settings: this.settings,
        pairs: this.pairs,
        closedPositions: this.closedPositions.slice(0, 500),
        auditLogs: this.auditLogs.slice(-100),
        isEngineRunning: this.isEngineRunning,
        pairCounter: this.pairCounter,
        updatedAt: new Date().toISOString()
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      console.warn('[PairAddEngine] Error saving state:', e.message);
    }
  }

  resetEngine() {
    this.pairs = [];
    this.closedPositions = [];
    this.auditLogs = [];
    this.processedRates.clear();
    this.lastProcessedRate = null;
    this.pairCounter = 1;
    this.isEngineRunning = true;
    this.saveState();
    return { success: true, message: 'Pair-Add Simulator reset successfully with clean data!' };
  }

  toggleEngine() {
    this.isEngineRunning = !this.isEngineRunning;
    this.saveState();
    return this.isEngineRunning;
  }

  updateSettings(newSettings) {
    if (!newSettings || typeof newSettings !== 'object') return;
    if (newSettings.profitTargetMove !== undefined) {
      this.settings.profitTargetMove = Number(newSettings.profitTargetMove);
    }
    if (newSettings.contractQuantity !== undefined) {
      this.settings.contractQuantity = Math.max(1.0, Number(newSettings.contractQuantity));
    }
    if (newSettings.leverage !== undefined) {
      this.settings.leverage = Number(newSettings.leverage);
    }
    this.saveState();
    return this.settings;
  }

  // Create a standard 1 BUY + 1 SELL pair
  createNewPair(symbol = 'CLUSDT', customPrice = null, customQty = null, customTarget = null) {
    const rateInfo = rateFeed.getCurrentRate(symbol);
    const price = customPrice ? Number(customPrice) : (rateInfo.price || 91.20);
    const usdInrRate = rateInfo.usdInrRate || this.settings.usdInrRate || 96.00;
    const quantity = customQty ? Number(customQty) : (this.settings.contractQuantity || 1.0);
    const targetMove = customTarget ? Number(customTarget) : (this.settings.profitTargetMove || 0.20);

    const pairId = `PAIR-ADD-${String(this.pairCounter++).padStart(4, '0')}`;
    const now = new Date().toISOString();

    const buyPos = {
      pairId,
      positionId: `${pairId}-BUY`,
      direction: 'BUY',
      symbol,
      entryTime: now,
      entryPrice: price,
      currentPrice: price,
      targetExitPrice: Number((price + targetMove).toFixed(2)),
      quantity,
      status: 'OPEN',
      mode: 'PAIR_ADD'
    };

    const sellPos = {
      pairId,
      positionId: `${pairId}-SELL`,
      direction: 'SELL',
      symbol,
      entryTime: now,
      entryPrice: price,
      currentPrice: price,
      targetExitPrice: Number((price - targetMove).toFixed(2)),
      quantity,
      status: 'OPEN',
      mode: 'PAIR_ADD'
    };

    const pair = {
      pairId,
      symbol,
      entryRate: price,
      createdTime: now,
      status: 'ACTIVE',
      buyPosition: buyPos,
      sellPosition: sellPos,
      targetMove,
      quantity
    };

    this.pairs.unshift(pair);
    this.processedRates.add(price);
    this.lastProcessedRate = price;
    this.saveState();

    return {
      success: true,
      message: `Created Pair ${pairId} (BUY & SELL) at $${price.toFixed(2)} with ${quantity} Barrels`,
      pair
    };
  }

  // Smart Pair Balancer
  smartPairAdd(symbol = 'CLUSDT', customPrice = null, customQty = null, customTarget = null) {
    const rateInfo = rateFeed.getCurrentRate(symbol);
    const price = customPrice ? Number(customPrice) : (rateInfo.price || 91.20);
    const quantity = customQty ? Number(customQty) : (this.settings.contractQuantity || 1.0);
    const targetMove = customTarget ? Number(customTarget) : (this.settings.profitTargetMove || 0.20);
    const tolerance = 0.05;

    let hasBuy = false;
    let hasSell = false;
    let matchingPair = null;

    for (const p of this.pairs) {
      if (p.status === 'CLOSED') continue;
      const bOpen = p.buyPosition && p.buyPosition.status === 'OPEN';
      const sOpen = p.sellPosition && p.sellPosition.status === 'OPEN';

      if (bOpen && Math.abs(p.buyPosition.entryPrice - price) <= tolerance) {
        hasBuy = true;
        matchingPair = p;
      }
      if (sOpen && Math.abs(p.sellPosition.entryPrice - price) <= tolerance) {
        hasSell = true;
        matchingPair = p;
      }
    }

    const now = new Date().toISOString();

    if (hasBuy && !hasSell) {
      // Missing SELL at this rate -> Add only SELL leg
      const pairId = matchingPair ? matchingPair.pairId : `PAIR-ADD-${String(this.pairCounter++).padStart(4, '0')}`;
      const sellPos = {
        pairId,
        positionId: `${pairId}-SELL-${Date.now().toString().slice(-4)}`,
        direction: 'SELL',
        symbol,
        entryTime: now,
        entryPrice: price,
        currentPrice: price,
        targetExitPrice: Number((price - targetMove).toFixed(2)),
        quantity,
        status: 'OPEN',
        mode: 'PAIR_ADD'
      };

      if (matchingPair) {
        matchingPair.sellPosition = sellPos;
        matchingPair.status = 'ACTIVE';
      } else {
        this.pairs.unshift({
          pairId,
          symbol,
          entryRate: price,
          createdTime: now,
          status: 'ACTIVE',
          buyPosition: null,
          sellPosition: sellPos,
          targetMove,
          quantity
        });
      }

      this.saveState();
      return {
        success: true,
        action: 'ADDED_SELL_LEG',
        message: `Found BUY at $${price.toFixed(2)}. Added missing SELL position with ${quantity} Barrels!`,
        position: sellPos
      };
    } else if (hasSell && !hasBuy) {
      // Missing BUY at this rate -> Add only BUY leg
      const pairId = matchingPair ? matchingPair.pairId : `PAIR-ADD-${String(this.pairCounter++).padStart(4, '0')}`;
      const buyPos = {
        pairId,
        positionId: `${pairId}-BUY-${Date.now().toString().slice(-4)}`,
        direction: 'BUY',
        symbol,
        entryTime: now,
        entryPrice: price,
        currentPrice: price,
        targetExitPrice: Number((price + targetMove).toFixed(2)),
        quantity,
        status: 'OPEN',
        mode: 'PAIR_ADD'
      };

      if (matchingPair) {
        matchingPair.buyPosition = buyPos;
        matchingPair.status = 'ACTIVE';
      } else {
        this.pairs.unshift({
          pairId,
          symbol,
          entryRate: price,
          createdTime: now,
          status: 'ACTIVE',
          buyPosition: buyPos,
          sellPosition: null,
          targetMove,
          quantity
        });
      }

      this.saveState();
      return {
        success: true,
        action: 'ADDED_BUY_LEG',
        message: `Found SELL at $${price.toFixed(2)}. Added missing BUY position with ${quantity} Barrels!`,
        position: buyPos
      };
    } else if (!hasBuy && !hasSell) {
      // Neither exists at this rate -> Add Full Pair
      return this.createNewPair(symbol, price, quantity, targetMove);
    } else {
      // Both already active at this rate
      return {
        success: true,
        action: 'ALREADY_BALANCED',
        message: `Rate $${price.toFixed(2)} already has both BUY & SELL positions open. Balanced!`,
        rate: price
      };
    }
  }

  manualClosePosition(positionId) {
    const rateInfo = rateFeed.getCurrentRate('CLUSDT');
    const exitPrice = rateInfo.price || 91.20;
    const usdInrRate = rateInfo.usdInrRate || this.settings.usdInrRate || 96.00;

    for (const p of this.pairs) {
      for (const pos of [p.buyPosition, p.sellPosition]) {
        if (pos && pos.status === 'OPEN' && (pos.positionId === positionId || p.pairId === positionId)) {
          pos.status = 'CLOSED';
          pos.exitPrice = exitPrice;
          pos.exitTime = new Date().toISOString();
          pos.exitReason = 'MANUAL CLOSE';

          const qty = pos.quantity || 1.0;
          const pGrossUSD = pos.direction === 'BUY' ? (exitPrice - pos.entryPrice) * qty : (pos.entryPrice - exitPrice) * qty;
          const pGrossINR = pGrossUSD * usdInrRate;
          const chargesUSD = (pos.entryPrice * qty * 0.00075) + (exitPrice * qty * 0.00075);
          const totalChargesINR = chargesUSD * usdInrRate * 1.18 + 5.0;
          const netINR = pGrossINR - totalChargesINR;

          pos.grossProfitUSD = Number(pGrossUSD.toFixed(4));
          pos.grossProfitINR = Number(pGrossINR.toFixed(2));
          pos.totalChargesINR = Number(totalChargesINR.toFixed(2));
          pos.netProfitINR = Number(netINR.toFixed(2));
          pos.netProfitUSD = Number((netINR / usdInrRate).toFixed(4));

          this.closedPositions.unshift({ ...pos });
        }
      }
      const bOpen = p.buyPosition && p.buyPosition.status === 'OPEN';
      const sOpen = p.sellPosition && p.sellPosition.status === 'OPEN';
      if (!bOpen && !sOpen) p.status = 'CLOSED';
    }

    this.saveState();
    return true;
  }

  handleRateEvent(type, data) {
    if (type !== 'TICK' || !data || !data.price) return;
    if (!this.isEngineRunning) return;

    const price = data.price;
    const usdInrRate = data.usdInrRate || this.settings.usdInrRate || 96.00;
    let stateChanged = false;

    // Evaluate active positions for profit targets
    for (const p of this.pairs) {
      if (p.status === 'CLOSED') continue;

      // Check BUY position
      if (p.buyPosition && p.buyPosition.status === 'OPEN') {
        p.buyPosition.currentPrice = price;
        if (price >= p.buyPosition.targetExitPrice) {
          // BUY Hit target!
          p.buyPosition.status = 'CLOSED';
          p.buyPosition.exitPrice = price;
          p.buyPosition.exitTime = new Date().toISOString();
          p.buyPosition.exitReason = 'BUY TARGET PROFIT HIT';

          const qty = p.buyPosition.quantity || 1.0;
          const pGrossUSD = (price - p.buyPosition.entryPrice) * qty;
          const pGrossINR = pGrossUSD * usdInrRate;
          const chargesUSD = (p.buyPosition.entryPrice * qty * 0.00075) + (price * qty * 0.00075);
          const totalChargesINR = chargesUSD * usdInrRate * 1.18 + 5.0;
          const netINR = pGrossINR - totalChargesINR;

          p.buyPosition.grossProfitUSD = Number(pGrossUSD.toFixed(4));
          p.buyPosition.grossProfitINR = Number(pGrossINR.toFixed(2));
          p.buyPosition.totalChargesINR = Number(totalChargesINR.toFixed(2));
          p.buyPosition.netProfitINR = Number(netINR.toFixed(2));
          p.buyPosition.netProfitUSD = Number((netINR / usdInrRate).toFixed(4));

          this.closedPositions.unshift({ ...p.buyPosition });
          stateChanged = true;
        }
      }

      // Check SELL position
      if (p.sellPosition && p.sellPosition.status === 'OPEN') {
        p.sellPosition.currentPrice = price;
        if (price <= p.sellPosition.targetExitPrice) {
          // SELL Hit target!
          p.sellPosition.status = 'CLOSED';
          p.sellPosition.exitPrice = price;
          p.sellPosition.exitTime = new Date().toISOString();
          p.sellPosition.exitReason = 'SELL TARGET PROFIT HIT';

          const qty = p.sellPosition.quantity || 1.0;
          const pGrossUSD = (p.sellPosition.entryPrice - price) * qty;
          const pGrossINR = pGrossUSD * usdInrRate;
          const chargesUSD = (p.sellPosition.entryPrice * qty * 0.00075) + (price * qty * 0.00075);
          const totalChargesINR = chargesUSD * usdInrRate * 1.18 + 5.0;
          const netINR = pGrossINR - totalChargesINR;

          p.sellPosition.grossProfitUSD = Number(pGrossUSD.toFixed(4));
          p.sellPosition.grossProfitINR = Number(pGrossINR.toFixed(2));
          p.sellPosition.totalChargesINR = Number(totalChargesINR.toFixed(2));
          p.sellPosition.netProfitINR = Number(netINR.toFixed(2));
          p.sellPosition.netProfitUSD = Number((netINR / usdInrRate).toFixed(4));

          this.closedPositions.unshift({ ...p.sellPosition });
          stateChanged = true;
        }
      }

      const bOpen = p.buyPosition && p.buyPosition.status === 'OPEN';
      const sOpen = p.sellPosition && p.sellPosition.status === 'OPEN';
      if (!bOpen && !sOpen) {
        p.status = 'CLOSED';
        stateChanged = true;
      }
    }

    if (stateChanged) {
      this.saveState();
    }
  }

  getMetrics() {
    const rateInfo = rateFeed.getCurrentRate('CLUSDT');
    const price = rateInfo.price || 91.20;
    const usdInrRate = rateInfo.usdInrRate || this.settings.usdInrRate || 96.00;
    const leverage = this.settings.leverage || 5;
    const qty = this.settings.contractQuantity || 1.0;

    // Minimum Required Margin for selected Barrels: (Barrels * Price / 5)
    const requiredMarginUSD = Number(((qty * price) / leverage).toFixed(2));
    const requiredMarginINR = Number((requiredMarginUSD * usdInrRate).toFixed(2));

    let openPositions = [];
    for (const p of this.pairs) {
      if (p.status === 'CLOSED') continue;
      if (p.buyPosition && p.buyPosition.status === 'OPEN') {
        const pos = { ...p.buyPosition, currentPrice: price };
        const pGrossUSD = (price - pos.entryPrice) * (pos.quantity || 1.0);
        pos.floatingGrossUSD = Number(pGrossUSD.toFixed(4));
        pos.floatingGrossINR = Number((pGrossUSD * usdInrRate).toFixed(2));
        pos.floatingNetINR = Number((pGrossUSD * usdInrRate - 20).toFixed(2));
        pos.floatingNetUSD = Number((pos.floatingNetINR / usdInrRate).toFixed(4));
        openPositions.push(pos);
      }
      if (p.sellPosition && p.sellPosition.status === 'OPEN') {
        const pos = { ...p.sellPosition, currentPrice: price };
        const pGrossUSD = (pos.entryPrice - price) * (pos.quantity || 1.0);
        pos.floatingGrossUSD = Number(pGrossUSD.toFixed(4));
        pos.floatingGrossINR = Number((pGrossUSD * usdInrRate).toFixed(2));
        pos.floatingNetINR = Number((pGrossUSD * usdInrRate - 20).toFixed(2));
        pos.floatingNetUSD = Number((pos.floatingNetINR / usdInrRate).toFixed(4));
        openPositions.push(pos);
      }
    }

    let realizedNetINR = 0;
    let realizedNetUSD = 0;
    for (const cp of this.closedPositions) {
      realizedNetINR += cp.netProfitINR || 0;
      realizedNetUSD += cp.netProfitUSD || 0;
    }

    let floatingNetINR = 0;
    let floatingNetUSD = 0;
    let lockedMarginINR = 0;
    for (const op of openPositions) {
      floatingNetINR += op.floatingNetINR || 0;
      floatingNetUSD += op.floatingNetUSD || 0;
      lockedMarginINR += (op.entryPrice * (op.quantity || 1.0) * usdInrRate) / leverage;
    }

    const startingCap = this.settings.startingCapitalINR || 100000.00;
    const equityINR = Number((startingCap + realizedNetINR + floatingNetINR).toFixed(2));
    const availableMarginINR = Math.max(0, Number((equityINR - lockedMarginINR).toFixed(2)));

    return {
      engineName: 'PAIR_ADD_ENGINE',
      rateFeedInfo: rateInfo,
      settings: this.settings,
      isEngineRunning: this.isEngineRunning,
      engineStatus: this.isEngineRunning ? 'RUNNING' : 'PAUSED',
      lastProcessedRate: this.lastProcessedRate,
      activePairsCount: this.pairs.filter(p => p.status === 'ACTIVE').length,
      openPositionsCount: openPositions.length,
      closedPositionsCount: this.closedPositions.length,
      openPositions,
      activePairs: this.pairs.filter(p => p.status === 'ACTIVE'),
      closedPositions: this.closedPositions,
      realizedNetProfitINR: Number(realizedNetINR.toFixed(2)),
      realizedNetProfitUSD: Number(realizedNetUSD.toFixed(2)),
      floatingNetProfitINR: Number(floatingNetINR.toFixed(2)),
      floatingNetProfitUSD: Number(floatingNetUSD.toFixed(2)),
      totalEstimatedNetProfitINR: Number((realizedNetINR + floatingNetINR).toFixed(2)),
      totalEstimatedNetProfitUSD: Number((realizedNetUSD + floatingNetUSD).toFixed(2)),
      equityINR,
      equityUSD: Number((equityINR / usdInrRate).toFixed(2)),
      availableMarginINR,
      availableMarginUSD: Number((availableMarginINR / usdInrRate).toFixed(2)),
      lockedMarginINR: Number(lockedMarginINR.toFixed(2)),
      lockedMarginUSD: Number((lockedMarginINR / usdInrRate).toFixed(2)),
      summary: {
        startingCapitalINR: startingCap,
        realizedBalanceINR: equityINR,
        realizedGrossUSD: 0,
        realizedGrossINR: 0,
        realizedChargesUSD: 0,
        realizedChargesINR: 0,
        realizedNetUSD,
        realizedNetINR,
        floatingGrossUSD: 0,
        floatingGrossINR: 0,
        floatingChargesUSD: 0,
        floatingChargesINR: 0,
        floatingNetUSD,
        floatingNetINR,
        totalEquityINR: equityINR,
        marginUsedINR: lockedMarginINR,
        availableMarginINR,
        activePairsCount: this.pairs.filter(p => p.status === 'ACTIVE').length,
        maxActivePairs: this.settings.maxActivePairs || 100,
        activeBuyCount: openPositions.filter(p => p.direction === 'BUY').length,
        activeSellCount: openPositions.filter(p => p.direction === 'SELL').length,
        closedPositionsCount: this.closedPositions.length,
        winCount: this.closedPositions.filter(c => (c.netProfitINR || 0) >= 0).length,
        lossCount: this.closedPositions.filter(c => (c.netProfitINR || 0) < 0).length,
        winRate: this.closedPositions.length > 0 ? Number(((this.closedPositions.filter(c => (c.netProfitINR || 0) >= 0).length / this.closedPositions.length) * 100).toFixed(1)) : 100
      },
      // Margin required for next order calculation
      marginRequirement: {
        selectedBarrels: qty,
        leverage,
        currentPrice: price,
        requiredMarginUSD,
        requiredMarginINR,
        formula: `${qty} Barrels × $${price.toFixed(2)} ÷ 5x Leverage = $${requiredMarginUSD} (~₹${requiredMarginINR.toLocaleString('en-IN')})`
      }
    };
  }
}

module.exports = new PairAddEngine();
