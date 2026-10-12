const https = require('https');
const http = require('http');

class MudrexLiveAdapter {
  constructor() {
    this.baseUrl = 'https://trade.mudrex.com/fapi/v1';
    this.v2Url = 'https://trade.mudrex.com/fapi/v2';
    this.liveOpenPositions = [];
    this.liveClosedPositions = [];
    this.processedRates = new Set();
    this.pairCounter = 1;
    this.userClosedRealPositionIds = new Set();
    this.rateLimitUntil = 0;
    this.lastFetchPositionsTime = 0;
    this.lastFetchPositionsRes = null;
    this.recentPrices = [];

    this.settings = {
      instrument: 'CLUSDT',
      profitTargetMove: 0.20,
      buyTargetMove: 0.20,
      sellTargetMove: 0.20,
      autoAiTargetMode: true,
      targetDisabled: false,
      maxActivePairs: 25,
      contractQuantity: 1.0,
      leverage: 5,
      usdInrRate: 86.5
    };

    this.initFromStorage();

    try {
      const rateFeed = require('./rateFeed');
      rateFeed.subscribe((type, data) => {
        if (type === 'tick') {
          this.processLiveTick(data);
        }
      });
    } catch (e) {}
  }

  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    this.saveState();
  }

  initFromStorage() {
    try {
      const storage = require('./storage');
      const saved = storage.loadState();
      if (saved) {
        if (saved.mudrexSettings) {
          this.settings = { ...this.settings, ...saved.mudrexSettings };
        }
        this.settings.strategyMode = 'ALTERNATING_STAGGERED';
        this.settings.maxActivePairs = 50;
        if (saved.mudrexApiKey && !saved.mudrexApiKey.includes('*') && !process.env.MUDREX_API_KEY) {
          process.env.MUDREX_API_KEY = saved.mudrexApiKey;
        }
        if (saved.mudrexApiSecret && !saved.mudrexApiSecret.includes('*') && !process.env.MUDREX_API_SECRET) {
          process.env.MUDREX_API_SECRET = saved.mudrexApiSecret;
        }
        if (Array.isArray(saved.userClosedRealPositionIds)) {
          this.userClosedRealPositionIds = new Set(saved.userClosedRealPositionIds);
        }
        if (Array.isArray(saved.liveOpenPositions)) {
          this.liveOpenPositions = saved.liveOpenPositions;
        }
        if (Array.isArray(saved.liveClosedPositions)) {
          this.liveClosedPositions = saved.liveClosedPositions;
        }
        if (Array.isArray(saved.closedPositions)) {
          const existingClosedIds = new Set(this.liveClosedPositions.map(p => p.positionId));
          for (const cp of saved.closedPositions) {
            if (!existingClosedIds.has(cp.positionId)) {
              this.liveClosedPositions.push(cp);
              existingClosedIds.add(cp.positionId);
            }
          }
        }
        console.log(`[Mudrex Live Adapter] Restored state from storage: ${this.liveOpenPositions.length} open, ${this.liveClosedPositions.length} closed positions, ${this.userClosedRealPositionIds.size} closed real IDs.`);
      }
    } catch (err) {
      console.warn('[Mudrex Live Adapter] Storage init notice:', err.message);
    }
  }

  saveState() {
    try {
      const storage = require('./storage');
      const paperEngine = require('./paperEngine');
      const currentState = storage.loadState() || {};

      if (Array.isArray(paperEngine.closedPositions)) {
        const existingPaperIds = new Set(paperEngine.closedPositions.map(c => c.positionId));
        for (const lcp of this.liveClosedPositions) {
          if (!existingPaperIds.has(lcp.positionId)) {
            paperEngine.closedPositions.push(lcp);
            existingPaperIds.add(lcp.positionId);
          }
        }
      }

      storage.saveState({
        ...currentState,
        mudrexApiKey: process.env.MUDREX_API_KEY || currentState.mudrexApiKey || '',
        mudrexApiSecret: process.env.MUDREX_API_SECRET || currentState.mudrexApiSecret || '',
        mudrexSettings: this.settings,
        settings: paperEngine.settings,
        pairs: paperEngine.pairs,
        closedPositions: paperEngine.closedPositions,
        liveOpenPositions: this.liveOpenPositions,
        liveClosedPositions: this.liveClosedPositions,
        userClosedRealPositionIds: Array.from(this.userClosedRealPositionIds),
        isEngineRunning: paperEngine.isEngineRunning
      });
    } catch (err) {
      console.error('[Mudrex Live Adapter] Error saving state:', err.message);
    }
  }

  calculateAiTargets() {
    if (!this.recentPrices || this.recentPrices.length < 3) {
      return { trend: 'SIDEWAYS / RANGE ↔️', buyTargetMove: 0.20, sellTargetMove: 0.20 };
    }
    const len = this.recentPrices.length;
    const oldest = this.recentPrices[0];
    const newest = this.recentPrices[len - 1];
    const diff = newest - oldest;

    if (diff >= 0.08) {
      return { trend: 'STRONG UPTREND ↗️', buyTargetMove: 0.35, sellTargetMove: 0.15 };
    } else if (diff >= 0.02) {
      return { trend: 'MODERATE UPTREND ↗️', buyTargetMove: 0.30, sellTargetMove: 0.20 };
    } else if (diff <= -0.08) {
      return { trend: 'STRONG DOWNTREND ↘️', buyTargetMove: 0.15, sellTargetMove: 0.35 };
    } else if (diff <= -0.02) {
      return { trend: 'MODERATE DOWNTREND ↘️', buyTargetMove: 0.20, sellTargetMove: 0.30 };
    } else {
      return { trend: 'SIDEWAYS / RANGE ↔️', buyTargetMove: 0.20, sellTargetMove: 0.20 };
    }
  }

  processLiveTick(tick) {
    try {
      if (process.env.NODE_ENV === 'test') return;

      const paperEngine = require('./paperEngine');
      if (!paperEngine.isEngineRunning) return;

      const symbol = tick.symbol || 'CLUSDT';
      if (symbol !== 'CLUSDT') return;

      const price = tick.price;
      if (!price) return;
      const decimals = symbol === 'BTCUSDT' ? 2 : (symbol === 'XAGUSDT' ? 4 : 2);
      const normPrice = Number(price.toFixed(decimals));

      if (!this.recentPrices) this.recentPrices = [];
      this.recentPrices.push(normPrice);
      if (this.recentPrices.length > 20) this.recentPrices.shift();

      let bMove = this.settings.buyTargetMove || this.settings.profitTargetMove || 0.20;
      let sMove = this.settings.sellTargetMove || this.settings.profitTargetMove || 0.20;

      if (symbol === 'CLUSDT' && (this.settings.profitTargetMode === 'STRATEGY' || (this.settings.strategyMode === 'ALTERNATING_STAGGERED' && this.settings.profitTargetMode !== 'PRICE_MOVE'))) {
        const altIdx = paperEngine.pairs ? paperEngine.pairs.length % 4 : 0;
        if (altIdx === 0) { bMove = 0.20; sMove = 0.20; }
        else if (altIdx === 1) { bMove = 0.20; sMove = 0.30; }
        else if (altIdx === 2) { bMove = 0.30; sMove = 0.20; }
        else { bMove = 0.15; sMove = 0.25; }
      } else if (this.settings.autoAiTargetMode && this.settings.profitTargetMode !== 'PRICE_MOVE') {
        const aiInfo = this.calculateAiTargets();
        bMove = aiInfo.buyTargetMove;
        sMove = aiInfo.sellTargetMove;
      }

      const time = tick.time || Date.now();
      const usdInrRate = tick.usdInrRate || this.settings.usdInrRate || 86.5;

      // 1. Evaluate target exits and update floating P/L for active open positions
      for (let i = this.liveOpenPositions.length - 1; i >= 0; i--) {
        const pos = this.liveOpenPositions[i];
        if (pos.status !== 'OPEN') continue;

        pos.currentPrice = normPrice;
        const qty = pos.quantity || 1.0;
        const pGrossUSD = pos.direction === 'BUY' ? (normPrice - pos.entryPrice) * qty : (pos.entryPrice - normPrice) * qty;
        const pGrossINR = pGrossUSD * usdInrRate;
        const pChargesINR = 0;
        const pNetINR = pGrossINR - pChargesINR;

        pos.floatingGrossUSD = Number(pGrossUSD.toFixed(4));
        pos.floatingGrossINR = Number(pGrossINR.toFixed(2));
        pos.floatingChargesINR = Number(pChargesINR.toFixed(2));
        pos.floatingNetINR = Number(pNetINR.toFixed(2));

        let hitTarget = false;
        if (pos.direction === 'BUY' && pos.targetExitPrice !== null && normPrice >= pos.targetExitPrice) {
          hitTarget = true;
        } else if (pos.direction === 'SELL' && pos.targetExitPrice !== null && normPrice <= pos.targetExitPrice) {
          hitTarget = true;
        }

        if (hitTarget) {
          pos.status = 'CLOSED';
          pos.exitPrice = normPrice;
          pos.exitTime = new Date(time).toISOString();

          pos.grossProfitUSD = Number(pGrossUSD.toFixed(4));
          pos.netProfitINR = Number(pGrossINR.toFixed(2));
          pos.totalChargesINR = 0;
          pos.exitReason = pos.direction + ' TARGET PROFIT HIT';

          this.liveOpenPositions.splice(i, 1);
          this.liveClosedPositions.unshift(pos);
          this.saveState();

          // Transmit Real Close Request to Mudrex Futures API
          if (pos.mudrexOrderId || pos.positionId) {
            this.closeRealPosition(pos.mudrexOrderId || pos.positionId, symbol)
              .then(res => console.log(`[Mudrex Close Position Response ${pos.positionId}]`, res))
              .catch(err => console.error(`[Mudrex Close Position Error ${pos.positionId}]`, err));
          }
        }
      }

      // 2. Open new BUY + SELL pair if rate not processed yet and under cap
      const maxActivePairs = paperEngine.settings.maxActivePairs || this.settings.maxActivePairs || 50;
      const openLegsCount = this.liveOpenPositions.filter(p => p.status === 'OPEN').length;

      if (openLegsCount < maxActivePairs * 2) {
        const hasOpenAtRate = this.liveOpenPositions.some(p => p.status === 'OPEN' && p.entryPrice === normPrice);
        
        if (!hasOpenAtRate) {
          const pairSeq = (this.pairCounter++).toString().padStart(4, '0');
          const pairId = `PAIR-${pairSeq}`;

          const buyTarget = this.settings.targetDisabled ? null : Number((normPrice + bMove).toFixed(decimals));
          const sellTarget = this.settings.targetDisabled ? null : Number((normPrice - sMove).toFixed(decimals));

          const buyPos = {
            pairId,
            positionId: `P-${pairSeq}-BUY`,
            direction: 'BUY',
            symbol,
            entryTime: new Date(time).toISOString(),
            entryPrice: normPrice,
            currentPrice: normPrice,
            targetExitPrice: buyTarget,
            quantity: this.settings.contractQuantity || 1.0,
            floatingGrossUSD: 0,
            floatingGrossINR: 0,
            floatingChargesINR: 0,
            floatingNetUSD: 0,
            floatingNetINR: 0,
            status: 'OPEN',
            apiStatus: 'LIVE_ENGINE_PAIR'
          };

          const sellPos = {
            pairId,
            positionId: `P-${pairSeq}-SELL`,
            direction: 'SELL',
            symbol,
            entryTime: new Date(time).toISOString(),
            entryPrice: normPrice,
            currentPrice: normPrice,
            targetExitPrice: sellTarget,
            quantity: this.settings.contractQuantity || 1.0,
            floatingGrossUSD: 0,
            floatingGrossINR: 0,
            floatingChargesINR: 0,
            floatingNetUSD: 0,
            floatingNetINR: 0,
            status: 'OPEN',
            apiStatus: 'LIVE_ENGINE_PAIR'
          };

          this.liveOpenPositions.push(buyPos);
          this.liveOpenPositions.push(sellPos);
          this.saveState();

          // Transmit Real BUY & SELL Orders to Mudrex Futures API (/fapi/v2/futures/order)
          const qty = this.settings.contractQuantity || 1.0;
          const lev = this.settings.leverage || 5;

          this.createRealOrder({ symbol, side: 'BUY', quantity: qty, leverage: lev })
            .then(res => {
              if (res.success) {
                buyPos.mudrexOrderId = this.extractOrderId(res.data);
                buyPos.apiStatus = 'REAL_MUDREX_POSITION';
              } else {
                buyPos.apiStatus = 'LIVE_ENGINE_PAIR (Mudrex API: ' + (typeof res.error === 'object' ? JSON.stringify(res.error) : (res.error || 'Margin Limit')) + ')';
                buyPos.apiError = res.error;
              }
              this.saveState();
            })
            .catch(err => {
              buyPos.apiStatus = 'LIVE_ENGINE_PAIR';
              buyPos.apiError = err.message;
            });

          this.createRealOrder({ symbol, side: 'SELL', quantity: qty, leverage: lev })
            .then(res => {
              if (res.success) {
                sellPos.mudrexOrderId = this.extractOrderId(res.data);
                sellPos.apiStatus = 'REAL_MUDREX_POSITION';
              } else {
                sellPos.apiStatus = 'LIVE_ENGINE_PAIR (Mudrex API: ' + (typeof res.error === 'object' ? JSON.stringify(res.error) : (res.error || 'Margin Limit')) + ')';
                sellPos.apiError = res.error;
              }
              this.saveState();
            })
            .catch(err => {
              sellPos.apiStatus = 'LIVE_ENGINE_PAIR';
              sellPos.apiError = err.message;
            });
        }
      }
    } catch (e) {
      console.error('Error in processLiveTick:', e);
    }
  }

  getHeaders() {
    let apiSecret = (
      process.env.MUDREX_API_SECRET ||
      process.env.MUDREX_SECRET ||
      process.env.MUDREX_SECRET_KEY || ''
    ).trim();
    if (apiSecret.includes('*')) apiSecret = '';

    let apiKey = (
      process.env.MUDREX_API_KEY ||
      process.env.MUDREX_KEY || ''
    ).trim();
    if (apiKey.includes('*')) apiKey = '';

    const headers = {
      'X-Authentication': apiSecret,
      'x-authentication': apiSecret,
      'Content-Type': 'application/json',
      'User-Agent': 'Mudrex-Node-Live-Engine/1.0'
    };
    if (apiKey) {
      headers['X-Api-Key'] = apiKey;
      headers['x-api-key'] = apiKey;
    }
    return headers;
  }

  request(method, urlStr, bodyData = null) {
    if (Date.now() < this.rateLimitUntil) {
      return Promise.resolve({ success: false, statusCode: 429, error: 'RATE_LIMIT_COOLDOWN_ACTIVE (Mudrex API paused for 30s)' });
    }

    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const headers = this.getHeaders();
      const payload = bodyData ? JSON.stringify(bodyData) : null;

      if (payload) {
        headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: method.toUpperCase(),
        headers
      };

      const req = https.request(options, (res) => {
        let rawData = '';
        res.on('data', chunk => { rawData += chunk; });
        res.on('end', () => {
          let result;
          try {
            const parsed = JSON.parse(rawData);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              result = { success: true, statusCode: res.statusCode, data: parsed };
            } else {
              const errMsg = parsed.message || parsed.text || parsed.error || JSON.stringify(parsed);
              result = { success: false, statusCode: res.statusCode, error: errMsg };
            }
          } catch (e) {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              result = { success: true, statusCode: res.statusCode, data: rawData };
            } else {
              result = { success: false, statusCode: res.statusCode, error: rawData };
            }
          }

          if (!result.success && result.error && (String(result.error).includes('5002') || String(result.error).includes('rate limit') || res.statusCode === 429)) {
            console.warn('[Mudrex Live Adapter] Rate limit (5002) detected from Mudrex API! Cooldown active for 30s.');
            this.rateLimitUntil = Date.now() + 30000;
          }

          resolve(result);
        });
      });

      req.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });

      if (payload) req.write(payload);
      req.end();
    });
  }

  parseBalanceValue(resData) {
    if (!resData) return 0;
    const targetObj = resData.data !== undefined ? resData.data : resData;
    let item = targetObj;
    if (Array.isArray(targetObj) && targetObj.length > 0) {
      item = targetObj[0];
    }
    if (typeof item === 'object' && item !== null) {
      const val = item.withdrawable || item.balance || item.total || item.available_balance || item.wallet_balance || item.margin_balance || item.total_balance || 0;
      return Number(val) || 0;
    }
    if (typeof item === 'number') return item;
    return 0;
  }

  extractOrderId(resData) {
    if (!resData) return 'EXECUTED';
    if (typeof resData === 'string') return resData;
    if (typeof resData === 'object') {
      const d = resData.data !== undefined ? resData.data : resData;
      if (Array.isArray(d) && d.length > 0) {
        return d[0].order_id || d[0].id || d[0].position_id || 'EXECUTED';
      }
      if (typeof d === 'object' && d !== null) {
        return d.order_id || d.id || d.position_id || d.orderId || 'EXECUTED';
      }
    }
    return 'EXECUTED';
  }

  async testAuthentication(force = false) {
    const now = Date.now();
    if (!force && this.lastAuthCheckRes && (now - (this.lastAuthCheckTime || 0) < 15000)) {
      return this.lastAuthCheckRes;
    }
    if (force) {
      this.rateLimitUntil = 0;
    }
    const headers = this.getHeaders();
    if (!headers['X-Authentication'] && !headers['x-authentication']) {
      return { success: false, error: 'MUDREX_API_SECRET missing in environment variables.' };
    }

    let futBal = 0;
    let spotBal = 0;
    let futRaw = null;
    let spotRaw = null;

    let futRes = await this.request('GET', `${this.baseUrl}/futures/funds?trade_currency=INR`);
    if (!futRes.success) {
      futRes = await this.request('GET', `${this.v2Url}/futures/funds`);
    }
    if (!futRes.success) {
      futRes = await this.request('GET', `${this.baseUrl}/futures/funds`);
    }

    if (futRes.success) {
      futBal = this.parseBalanceValue(futRes.data);
      futRaw = futRes.data;
    }

    let spotRes = await this.request('GET', `${this.baseUrl}/wallet/funds?currency=INR`);
    if (spotRes.success) {
      spotBal = this.parseBalanceValue(spotRes.data);
      spotRaw = spotRes.data;
    }

    if (spotBal === 0) {
      let altSpot = await this.request('GET', `${this.baseUrl}/wallet/funds`);
      if (altSpot.success) {
        const altBal = this.parseBalanceValue(altSpot.data);
        if (altBal > 0) {
          spotBal = altBal;
          spotRaw = altSpot.data;
        }
      }
    }

    if (spotBal > 0) {
      this.lastKnownSpotBalance = spotBal;
    } else if (this.lastKnownSpotBalance) {
      spotBal = this.lastKnownSpotBalance;
    }

    const totalPortfolioBalance = Number((spotBal + futBal).toFixed(2));

    if (spotRes.success || futRes.success) {
      const authRes = {
        success: true,
        balance: totalPortfolioBalance > 0 ? totalPortfolioBalance : Math.max(spotBal, futBal),
        spotBalance: spotBal,
        futuresBalance: futBal,
        totalPortfolioBalance,
        raw: { spot: spotRaw, futures: futRaw }
      };
      this.lastAuthCheckRes = authRes;
      this.lastAuthCheckTime = Date.now();
      return authRes;
    }

    if (!spotRes.success && !futRes.success) {
      let errStr = spotRes.error || futRes.error || 'Failed to authenticate with Mudrex API';
      if (typeof errStr === 'object') errStr = JSON.stringify(errStr);
      if (errStr.includes('3100') || errStr.includes('Invalid Authentication')) {
        errStr = 'Invalid Mudrex API Secret Key. Please verify your Secret Key.';
      }
      const failRes = { success: false, error: errStr };
      if (!this.lastAuthCheckRes) {
        this.lastAuthCheckRes = failRes;
        this.lastAuthCheckTime = Date.now();
      }
      return failRes;
    }
  }

  async fetchWalletBalance() {
    const auth = await this.testAuthentication();
    if (auth.success) {
      return { success: true, balance: auth.balance, raw: auth.raw };
    }
    return { success: false, error: auth.error || 'Failed to fetch Mudrex wallet balance' };
  }

  isRealExecutionEnabled() {
    if (process.env.DISABLE_REAL_MUDREX_ORDERS === 'true') return false;
    const key = process.env.MUDREX_API_KEY || this.mudrexApiKey;
    const secret = process.env.MUDREX_API_SECRET || this.mudrexApiSecret;
    if (!key || !secret) return false;
    return true;
  }

  async createRealOrder({ symbol, side, quantity, leverage, targetPrice }) {
    if (!this.isRealExecutionEnabled()) {
      console.log('[Mudrex Live Adapter] Real order execution disabled. Pure paper mode active.');
      return { success: false, error: 'REAL_ORDERS_DISABLED_PURE_PAPER_MODE' };
    }

    const symb = (symbol || 'CLUSDT').toUpperCase();
    const sideUpper = (side || 'BUY').toUpperCase();
    const orderType = (sideUpper === 'BUY' || sideUpper === 'LONG') ? 'LONG' : 'SHORT';
    const qty = String(quantity || 0.01);
    const lev = String(leverage || 5);

    const body = {
      trade_currency: 'INR',
      symbol: symb,
      side: sideUpper === 'BUY' ? 'BUY' : 'SELL',
      order_type: orderType,
      trigger_type: 'MARKET',
      type: 'MARKET',
      quantity: qty,
      leverage: lev,
      reduce_only: false
    };

    if (targetPrice) {
      body.takeprofit_price = String(targetPrice);
      body.is_takeprofit = true;
    }

    const url = `${this.baseUrl}/futures/${symb}/order?is_symbol=true&trade_currency=INR`;
    console.log(`[Mudrex Live Adapter] Sending Real Order POST to ${url}:`, body);
    let res = await this.request('POST', url, body);
    if (!res.success) {
      const altUrl = `${this.baseUrl}/futures/${symb}/order?is_symbol=true`;
      console.log(`[Mudrex Live Adapter] Retrying via ${altUrl}...`);
      res = await this.request('POST', altUrl, body);
    }
    console.log(`[Mudrex Live Adapter] Real Order Result:`, res);
    return res;
  }

  async closeRealPosition(positionId, symbol = 'CLUSDT') {
    if (!this.isRealExecutionEnabled()) {
      console.log('[Mudrex Live Adapter] Real position closing disabled. Pure paper mode active.');
      return { success: false, error: 'REAL_ORDERS_DISABLED_PURE_PAPER_MODE' };
    }

    const url = `${this.baseUrl}/futures/positions/${encodeURIComponent(positionId)}/close`;
    console.log(`[Mudrex Live Adapter] Closing Real Position via POST ${url}`);
    let res = await this.request('POST', url, { symbol, trade_currency: 'INR' });
    if (!res.success) {
      res = await this.request('POST', url, { trade_currency: 'INR' });
    }
    return res;
  }

  async closeAllRealPositions() {
    try {
      const posRes = await this.fetchPositions();
      if (posRes.success && Array.isArray(posRes.data)) {
        for (const pos of posRes.data) {
          const pid = pos.position_id || pos.id || pos.positionId;
          if (pid) {
            await this.closeRealPosition(pid, pos.symbol || 'CLUSDT');
          }
        }
      }
    } catch (e) {
      console.error('Error in closeAllRealPositions:', e);
    }
  }

  resetLiveEngine() {
    this.liveOpenPositions = [];
    this.liveClosedPositions = [];
    this.processedRates.clear();
    this.userClosedRealPositionIds.clear();
    this.pairCounter = 1;
  }

  manualCloseLivePosition(positionId) {
    const rateFeed = require('./rateFeed');
    const paperEngine = require('./paperEngine');
    const symbol = paperEngine.settings.instrument || 'CLUSDT';
    const rateInfo = rateFeed.getCurrentRate(symbol);
    const exitPrice = rateInfo.price || 90.61;
    const usdInrRate = rateInfo.usdInrRate || 86.5;

    if (positionId) {
      this.userClosedRealPositionIds.add(positionId);
      this.userClosedRealPositionIds.add(String(positionId));
    }

    let closedAny = false;
    for (let i = this.liveOpenPositions.length - 1; i >= 0; i--) {
      const pos = this.liveOpenPositions[i];
      if (pos.positionId === positionId || pos.id === positionId || pos.pairId === positionId || positionId.includes(pos.pairId)) {
        if (pos.positionId) this.userClosedRealPositionIds.add(pos.positionId);
        if (pos.pairId) this.userClosedRealPositionIds.add(pos.pairId);

        pos.status = 'CLOSED';
        pos.exitPrice = exitPrice;
        pos.exitTime = new Date().toISOString();
        const qty = pos.quantity || 1.0;
        const pGrossUSD = pos.direction === 'BUY' ? (exitPrice - pos.entryPrice) * qty : (pos.entryPrice - exitPrice) * qty;
        const pGrossINR = pGrossUSD * usdInrRate;
        pos.grossProfitUSD = Number(pGrossUSD.toFixed(4));
        pos.netProfitINR = Number(pGrossINR.toFixed(2));
        pos.exitReason = 'MANUAL USER CLOSE';

        this.liveOpenPositions.splice(i, 1);
        this.liveClosedPositions.unshift(pos);
        closedAny = true;
      }
    }

    this.saveState();
    return closedAny || true;
  }

  async fetchPositions() {
    const now = Date.now();
    if (this.lastFetchPositionsRes && (now - this.lastFetchPositionsTime < 15000)) {
      return this.lastFetchPositionsRes;
    }

    const symbol = 'CLUSDT';
    const endpoints = [
      `${this.baseUrl}/futures/positions?trade_currency=INR`,
      `${this.baseUrl}/futures/${symbol}/positions?trade_currency=INR`,
      `${this.v2Url}/futures/positions?trade_currency=INR`,
      `${this.baseUrl}/futures/open_orders?trade_currency=INR`,
      `${this.v2Url}/futures/open_orders?trade_currency=INR`
    ];

    let combinedItems = [];
    const seenPosIds = new Set();

    for (const url of endpoints) {
      try {
        const res = await this.request('GET', url);
        if (res.success && res.data !== undefined && res.data !== null) {
          let list = [];
          if (Array.isArray(res.data)) {
            list = res.data;
          } else if (Array.isArray(res.data.data)) {
            list = res.data.data;
          } else if (Array.isArray(res.data.positions)) {
            list = res.data.positions;
          } else if (Array.isArray(res.data.orders)) {
            list = res.data.orders;
          } else if (typeof res.data === 'object' && (res.data.position_id || res.data.id || res.data.order_id)) {
            list = [res.data];
          }

          for (const item of list) {
            if (!item || typeof item !== 'object') continue;
            const posId = item.position_id || item.id || item.order_id || item.orderId || item.positionId;
            if (posId && seenPosIds.has(String(posId))) continue;
            if (posId) seenPosIds.add(String(posId));

            const statusStr = String(item.status || item.position_status || item.state || item.order_status || '').toUpperCase();
            if (['CLOSED', 'FILLED', 'CANCELLED', 'EXPIRED', 'COMPLETED', 'REJECTED', 'DONE', 'INACTIVE'].includes(statusStr)) {
              continue;
            }
            if (item.closed === true || item.is_closed === true) continue;
            if (item.quantity !== undefined && Number(item.quantity || item.qty || 0) <= 0) continue;
            const pairId = item.pair_id || item.pairId;
            if (posId && (this.userClosedRealPositionIds.has(posId) || this.userClosedRealPositionIds.has(String(posId)))) continue;
            if (pairId && (this.userClosedRealPositionIds.has(pairId) || this.userClosedRealPositionIds.has(String(pairId)))) continue;
            
            combinedItems.push(item);
          }
        }
      } catch (e) {
        console.warn(`[Mudrex Live Adapter] Error querying ${url}:`, e.message);
      }
    }

    if (combinedItems.length > 0) {
      const parsedPositions = combinedItems.map((item, idx) => {
        const direction = (item.side || item.direction || item.order_type || 'BUY').toUpperCase().includes('SHORT') || (item.side === 'SELL') ? 'SELL' : 'BUY';
        const entryPrice = Number(item.entry_price || item.price || item.entryPrice || 91.15);
        const qty = Number(item.quantity || item.qty || 1.0);
        const posId = item.position_id || item.id || item.order_id || item.orderId || item.positionId || `P-REAL-${idx + 1}`;
        const pairId = item.pair_id || item.pairId || `PAIR-${(idx + 1).toString().padStart(4, '0')}`;
        
        if (this.userClosedRealPositionIds.has(posId) || this.userClosedRealPositionIds.has(pairId) || this.userClosedRealPositionIds.has(`P-REAL-${idx + 1}`)) {
          return null;
        }

        const targetExit = item.takeprofit_price ? Number(item.takeprofit_price) : (direction === 'BUY' ? Number((entryPrice + 1.00).toFixed(2)) : Number((entryPrice - 1.00).toFixed(2)));

        return {
          pairId,
          positionId: posId,
          direction,
          symbol: item.symbol || symbol,
          entryTime: item.created_at || item.created_time || new Date().toISOString(),
          entryPrice,
          currentPrice: entryPrice,
          targetExitPrice: targetExit,
          quantity: qty,
          status: 'OPEN',
          apiStatus: 'REAL_MUDREX_POSITION'
        };
      }).filter(Boolean);

      const resObj = { success: true, data: parsedPositions };
      this.lastFetchPositionsRes = resObj;
      this.lastFetchPositionsTime = Date.now();
      return resObj;
    }

    const fallbackRes = this.lastFetchPositionsRes || { success: false, data: [] };
    this.lastFetchPositionsTime = Date.now();
    return fallbackRes;
  }

  async getLiveMetrics() {
    const rateFeed = require('./rateFeed');
    const paperEngine = require('./paperEngine');
    const rateInfo = rateFeed.getCurrentRate('CLUSDT');
    
    let startingCapital = Math.max(350000, paperEngine.settings.startingCapitalINR || 350000);
    paperEngine.settings.startingCapitalINR = startingCapital;

    let liveOpenPositions = [];

    if (Array.isArray(paperEngine.pairs)) {
      for (const pair of paperEngine.pairs) {
        if (pair.status === 'CLOSED') continue;
        if (pair.buyPosition && pair.buyPosition.status === 'OPEN') {
          liveOpenPositions.push(pair.buyPosition);
        }
        if (pair.sellPosition && pair.sellPosition.status === 'OPEN') {
          liveOpenPositions.push(pair.sellPosition);
        }
      }
    }

    for (const pos of (this.liveOpenPositions || [])) {
      if (pos.status === 'OPEN' && !liveOpenPositions.some(p => p.positionId === pos.positionId)) {
        liveOpenPositions.push(pos);
      }
    }

    // Clean up any stale flags
    for (const pos of liveOpenPositions) {
      if (pos.apiStatus?.includes('REAL_ORDERS_DISABLED')) {
        delete pos.apiStatus;
      }
    }

    if (this.settings.syncRealMudrexPositions && this.isRealExecutionEnabled()) {
      try {
        const realPosRes = await this.fetchPositions();
        if (realPosRes.success && Array.isArray(realPosRes.data)) {
          for (const rPos of realPosRes.data) {
            rPos.apiStatus = 'REAL_MUDREX_POSITION';
            const existingIdx = liveOpenPositions.findIndex(p => p.positionId === rPos.positionId);
            if (existingIdx !== -1) {
              liveOpenPositions[existingIdx] = { ...liveOpenPositions[existingIdx], ...rPos };
            } else {
              liveOpenPositions.push(rPos);
            }
          }
        }
      } catch (e) {}
    }

    liveOpenPositions = liveOpenPositions.filter(p => !this.userClosedRealPositionIds.has(p.positionId) && !this.userClosedRealPositionIds.has(p.pairId));

    this.liveOpenPositions = liveOpenPositions;
    this.liveClosedPositions = liveClosedPositions;

    let realizedGrossUSD = 0, realizedNetINR = 0;
    let winCount = 0, lossCount = 0;
    for (const cp of liveClosedPositions) {
      realizedGrossUSD += cp.grossProfitUSD || 0;
      realizedNetINR += cp.netProfitINR || 0;
      if ((cp.netProfitUSD || cp.netProfitINR || 0) >= 0) winCount++;
      else lossCount++;
    }

    let floatingGrossUSD = 0, floatingNetINR = 0, marginUsedINR = 0;
    let activeBuyCount = 0, activeSellCount = 0;

    for (const pos of liveOpenPositions) {
      if (pos.direction === 'BUY') activeBuyCount++;
      if (pos.direction === 'SELL') activeSellCount++;
      
      const posPrice = rateInfo.price || pos.currentPrice || pos.entryPrice;
      const qty = pos.quantity || 1.0;
      let pGrossUSD = pos.floatingGrossUSD !== undefined ? pos.floatingGrossUSD : (pos.direction === 'BUY' ? (posPrice - pos.entryPrice) * qty : (pos.entryPrice - posPrice) * qty);
      let pGrossINR = pos.floatingGrossINR !== undefined ? pos.floatingGrossINR : pGrossUSD * (rateInfo.usdInrRate || 86.5);
      let pNetINR = pos.floatingNetINR !== undefined ? pos.floatingNetINR : pGrossINR;

      floatingGrossUSD += pGrossUSD;
      floatingNetINR += pNetINR;
      marginUsedINR += (pos.entryPrice * qty * (rateInfo.usdInrRate || 86.5)) / (paperEngine.settings.leverage || 5);
    }

    let displayStartingCap = startingCapital;
    let realizedBalanceINR = startingCapital + realizedNetINR;
    let totalEquityINR = realizedBalanceINR + floatingNetINR;
    let availableMarginINR = Math.max(0, realizedBalanceINR - marginUsedINR);

    const closedCount = liveClosedPositions.length;
    const totalTrades = winCount + lossCount;
    const winRate = totalTrades > 0 ? Math.round((winCount / totalTrades) * 100) : 0;

    let pairs1B = 0;
    let pairs2B = 0;
    const activePairMap = new Map();
    for (const pos of liveOpenPositions) {
      if (pos.status === 'OPEN' && pos.pairId) {
        const q = pos.quantity || 1.0;
        if (!activePairMap.has(pos.pairId) || q > activePairMap.get(pos.pairId)) {
          activePairMap.set(pos.pairId, q);
        }
      }
    }
    for (const [pid, q] of activePairMap.entries()) {
      if (q >= 2.0) pairs2B++;
      else pairs1B++;
    }
    const realActivePairsCount = activePairMap.size > 0 ? activePairMap.size : Math.max(activeBuyCount, activeSellCount);

    return {
      rateFeedInfo: rateInfo,
      settings: { ...paperEngine.settings, instrument: 'CLUSDT' },
      engineStatus: paperEngine.engineStatus,
      pauseReason: paperEngine.pauseReason,
      isEngineRunning: paperEngine.isEngineRunning,
      lastProcessedRate: paperEngine.lastProcessedRate,
      processedRatesCount: paperEngine.processedRatesCount,
      summary: {
        startingCapitalINR: displayStartingCap,
        realizedBalanceINR,
        realizedGrossUSD,
        realizedGrossINR: realizedGrossUSD * (rateInfo.usdInrRate || 86.5),
        realizedChargesUSD: 0,
        realizedChargesINR: 0,
        realizedNetUSD: realizedNetINR / (rateInfo.usdInrRate || 86.5),
        realizedNetINR,
        floatingGrossUSD,
        floatingGrossINR: floatingGrossUSD * (rateInfo.usdInrRate || 86.5),
        floatingChargesUSD: 0,
        floatingChargesINR: 0,
        floatingNetUSD: floatingNetINR / (rateInfo.usdInrRate || 86.5),
        floatingNetINR,
        totalEquityINR,
        marginUsedINR,
        availableMarginINR: Math.max(0, totalEquityINR - marginUsedINR),
        activePairsCount: realActivePairsCount,
        maxActivePairs: paperEngine.settings.maxActivePairs || 25,
        pairs1B,
        pairs2B,
        activeBuyCount,
        activeSellCount,
        closedPositionsCount: closedCount,
        winCount,
        lossCount,
        winRate,
        dailyRealizedLossINR: 0,
        dailyLossLimitINR: 2000
      },
      aiTargetInfo: this.calculateAiTargets(),
      openPositions: liveOpenPositions,
      closedPositions: liveClosedPositions,
      auditLogs: []
    };
  }

  processLiveTick(tick) {
    if (!tick || !tick.price) return;
    if (tick.symbol && tick.symbol !== 'CLUSDT') return;
  }

  resetLiveEngine() {
    this.liveOpenPositions = [];
    this.liveClosedPositions = [];
    this.processedRates.clear();
    this.pairCounter = 1;
    this.userClosedRealPositionIds.clear();
    this.saveState();
  }
}

module.exports = new MudrexLiveAdapter();
