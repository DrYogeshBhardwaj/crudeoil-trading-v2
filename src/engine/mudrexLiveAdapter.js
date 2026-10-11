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

    try {
      const rateFeed = require('./rateFeed');
      rateFeed.subscribe((type, data) => {
        if (type === 'tick') {
          this.processLiveTick(data);
        }
      });
    } catch (e) {}
  }

  processLiveTick(tick) {
    try {
      const paperEngine = require('./paperEngine');
      if (!paperEngine.isEngineRunning) return;

      const symbol = tick.symbol || paperEngine.settings.instrument || 'CLUSDT';
      if (symbol !== paperEngine.settings.instrument) return;

      const price = tick.price;
      if (!price) return;
      const decimals = symbol === 'BTCUSDT' ? 2 : (symbol === 'XAGUSDT' ? 4 : 2);
      const normPrice = Number(price.toFixed(decimals));

      const targetMove = paperEngine.settings.targetDisabled ? null : (paperEngine.settings.profitTargetMove || 0.20);
      const time = tick.time || Date.now();
      const usdInrRate = tick.usdInrRate || 86.5;

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

          // Transmit Real Close Request to Mudrex Futures API
          if (pos.mudrexOrderId || pos.positionId) {
            this.closeRealPosition(pos.mudrexOrderId || pos.positionId, symbol)
              .then(res => console.log(`[Mudrex Close Position Response ${pos.positionId}]`, res))
              .catch(err => console.error(`[Mudrex Close Position Error ${pos.positionId}]`, err));
          }
        }
      }

      // 2. Open new BUY + SELL pair if rate not processed yet and max cap not reached
      const maxPairs = paperEngine.settings.maxActivePairs || 25;
      if (this.liveOpenPositions.length >= maxPairs * 2) return;

      if (!this.processedRates.has(normPrice)) {
        this.processedRates.add(normPrice);
        const pairSeq = (this.pairCounter++).toString().padStart(4, '0');
        const pairId = `PAIR-${pairSeq}`;

        const buyTarget = targetMove ? Number((normPrice + targetMove).toFixed(decimals)) : null;
        const sellTarget = targetMove ? Number((normPrice - targetMove).toFixed(decimals)) : null;

        const buyPos = {
          pairId,
          positionId: `P-${pairSeq}-BUY`,
          direction: 'BUY',
          symbol,
          entryTime: new Date(time).toISOString(),
          entryPrice: normPrice,
          currentPrice: normPrice,
          targetExitPrice: buyTarget,
          quantity: paperEngine.settings.contractQuantity || 1.0,
          floatingGrossUSD: 0,
          floatingGrossINR: 0,
          floatingChargesINR: 0,
          floatingNetUSD: 0,
          floatingNetINR: 0,
          status: 'OPEN',
          apiStatus: 'SENDING_TO_MUDREX'
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
          quantity: paperEngine.settings.contractQuantity || 1.0,
          floatingGrossUSD: 0,
          floatingGrossINR: 0,
          floatingChargesINR: 0,
          floatingNetUSD: 0,
          floatingNetINR: 0,
          status: 'OPEN',
          apiStatus: 'SENDING_TO_MUDREX'
        };

        this.liveOpenPositions.push(buyPos);
        this.liveOpenPositions.push(sellPos);

        // Transmit Real BUY & SELL Orders to Mudrex Futures API (/fapi/v2/futures/order)
        const qty = paperEngine.settings.contractQuantity || 1.0;
        const lev = paperEngine.settings.leverage || 5;

        this.createRealOrder({ symbol, side: 'BUY', quantity: qty, leverage: lev })
          .then(res => {
            console.log(`[Mudrex Real BUY Order Response ${buyPos.positionId}]`, res);
            if (res.success) {
              buyPos.mudrexOrderId = this.extractOrderId(res.data);
              buyPos.apiStatus = 'TRANSMITTED_TO_MUDREX';
            } else {
              buyPos.apiStatus = 'API_ERROR: ' + (typeof res.error === 'object' ? JSON.stringify(res.error) : (res.error || 'Failed'));
              buyPos.apiError = res.error;
            }
          })
          .catch(err => {
            buyPos.apiStatus = 'NETWORK_ERROR';
            buyPos.apiError = err.message;
          });

        this.createRealOrder({ symbol, side: 'SELL', quantity: qty, leverage: lev })
          .then(res => {
            console.log(`[Mudrex Real SELL Order Response ${sellPos.positionId}]`, res);
            if (res.success) {
              sellPos.mudrexOrderId = this.extractOrderId(res.data);
              sellPos.apiStatus = 'TRANSMITTED_TO_MUDREX';
            } else {
              sellPos.apiStatus = 'API_ERROR: ' + (typeof res.error === 'object' ? JSON.stringify(res.error) : (res.error || 'Failed'));
              sellPos.apiError = res.error;
            }
          })
          .catch(err => {
            sellPos.apiStatus = 'NETWORK_ERROR';
            sellPos.apiError = err.message;
          });
      }
    } catch (e) {
      console.error('Error in processLiveTick:', e);
    }
  }

  getHeaders() {
    const apiSecret = (
      process.env.MUDREX_API_SECRET ||
      process.env.MUDREX_SECRET ||
      process.env.MUDREX_SECRET_KEY || ''
    ).trim();

    const apiKey = (
      process.env.MUDREX_API_KEY ||
      process.env.MUDREX_KEY || ''
    ).trim();

    const headers = {
      'X-Authentication': apiSecret,
      'Content-Type': 'application/json',
      'User-Agent': 'Mudrex-Node-Live-Engine/1.0'
    };
    if (apiKey) {
      headers['X-Api-Key'] = apiKey;
    }
    return headers;
  }

  request(method, urlStr, bodyData = null) {
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
          try {
            const parsed = JSON.parse(rawData);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ success: true, statusCode: res.statusCode, data: parsed });
            } else {
              const errMsg = parsed.message || parsed.text || parsed.error || JSON.stringify(parsed);
              resolve({ success: false, statusCode: res.statusCode, error: errMsg });
            }
          } catch (e) {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ success: true, statusCode: res.statusCode, data: rawData });
            } else {
              resolve({ success: false, statusCode: res.statusCode, error: rawData });
            }
          }
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

  async testAuthentication() {
    const headers = this.getHeaders();
    if (!headers['X-Authentication']) {
      return { success: false, error: 'MUDREX_API_SECRET missing in environment variables.' };
    }

    let futBal = 0;
    let spotBal = 0;
    let futRaw = null;
    let spotRaw = null;

    let futRes = await this.request('GET', `${this.baseUrl}/futures/funds?trade_currency=INR`);
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
      return {
        success: true,
        balance: totalPortfolioBalance > 0 ? totalPortfolioBalance : Math.max(spotBal, futBal),
        spotBalance: spotBal,
        futuresBalance: futBal,
        totalPortfolioBalance,
        raw: { spot: spotRaw, futures: futRaw }
      };
    }

    return spotRes.error ? spotRes : (futRes.error ? futRes : { success: false, error: 'Failed to authenticate with Mudrex API' });
  }

  async fetchWalletBalance() {
    const auth = await this.testAuthentication();
    if (auth.success) {
      return { success: true, balance: auth.balance, raw: auth.raw };
    }
    return { success: false, error: auth.error || 'Failed to fetch Mudrex wallet balance' };
  }

  async createRealOrder({ symbol, side, quantity, leverage, targetPrice }) {
    // HARD SAFETY LOCK: NEVER PLACE REAL ORDERS UNLESS EXPLICITLY PERMITTED BY ENV VARIABLE
    if (process.env.ENABLE_REAL_MUDREX_ORDERS !== 'true') {
      console.log('[Mudrex Live Adapter] HARD LOCK: Real order placement is strictly DISABLED. Pure paper mode active.');
      return { success: false, error: 'REAL_ORDERS_DISABLED_PURE_PAPER_MODE' };
    }

    const symb = (symbol || 'CLUSDT').toUpperCase();
    const sideUpper = (side || 'BUY').toUpperCase();
    const orderType = (sideUpper === 'BUY' || sideUpper === 'LONG') ? 'LONG' : 'SHORT';
    const qty = String(quantity || 1.0);
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
    // HARD SAFETY LOCK: NEVER CLOSE REAL POSITIONS UNLESS EXPLICITLY PERMITTED BY ENV VARIABLE
    if (process.env.ENABLE_REAL_MUDREX_ORDERS !== 'true') {
      console.log('[Mudrex Live Adapter] HARD LOCK: Real position closing is strictly DISABLED. Pure paper mode active.');
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
    this.pairCounter = 1;
  }

  manualCloseLivePosition(positionId) {
    const rateFeed = require('./rateFeed');
    const paperEngine = require('./paperEngine');
    const symbol = paperEngine.settings.instrument || 'CLUSDT';
    const rateInfo = rateFeed.getCurrentRate(symbol);
    const exitPrice = rateInfo.price || 90.61;
    const usdInrRate = rateInfo.usdInrRate || 86.5;

    for (let i = this.liveOpenPositions.length - 1; i >= 0; i--) {
      const pos = this.liveOpenPositions[i];
      if (pos.positionId === positionId || pos.id === positionId) {
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
        return true;
      }
    }
    return false;
  }

  async fetchPositions() {
    const symbol = 'CLUSDT';
    const endpoints = [
      `${this.baseUrl}/futures/positions?trade_currency=INR`,
      `${this.baseUrl}/futures/${symbol}/positions?trade_currency=INR`,
      `${this.v2Url}/futures/positions?trade_currency=INR`,
      `${this.baseUrl}/futures/open_orders?trade_currency=INR`
    ];

    for (const url of endpoints) {
      try {
        const res = await this.request('GET', url);
        if (res.success && res.data) {
          let list = Array.isArray(res.data) ? res.data : (Array.isArray(res.data.data) ? res.data.data : (res.data.positions || [res.data]));
          if (Array.isArray(list) && list.length > 0) {
            const parsedPositions = list.map((item, idx) => {
              const direction = (item.side || item.direction || item.order_type || 'BUY').toUpperCase().includes('SHORT') || (item.side === 'SELL') ? 'SELL' : 'BUY';
              const entryPrice = Number(item.entry_price || item.price || item.entryPrice || 91.15);
              const qty = Number(item.quantity || item.qty || 1.0);
              const posId = item.position_id || item.id || item.order_id || `P-REAL-${idx + 1}`;
              const pairId = item.pair_id || `PAIR-${(idx + 1).toString().padStart(4, '0')}`;
              const targetExit = item.takeprofit_price ? Number(item.takeprofit_price) : (direction === 'BUY' ? Number((entryPrice + 0.20).toFixed(2)) : Number((entryPrice - 0.20).toFixed(2)));

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
            });
            return { success: true, data: parsedPositions };
          }
        }
      } catch (e) {
        console.warn(`[Mudrex Live Adapter] Error querying ${url}:`, e.message);
      }
    }
    return { success: false, data: [] };
  }

  async getLiveMetrics() {
    const rateFeed = require('./rateFeed');
    const paperEngine = require('./paperEngine');
    const rateInfo = rateFeed.getCurrentRate(paperEngine.settings.instrument || 'CLUSDT');
    
    let totalBal = 3227.29;
    try {
      const auth = await this.testAuthentication();
      if (auth.success && auth.totalPortfolioBalance > 0) {
        totalBal = auth.totalPortfolioBalance;
      }
    } catch (e) {}

    let liveOpenPositions = this.liveOpenPositions || [];
    let liveClosedPositions = this.liveClosedPositions || [];

    // Auto-retry transmitting positions stuck with old API errors or unassigned Order IDs
    for (const pos of liveOpenPositions) {
      if (pos.status === 'OPEN' && (!pos.mudrexOrderId || pos.apiStatus?.includes('API_ERROR') || pos.apiStatus?.includes('SENDING'))) {
        if (!pos.lastRetryTime || Date.now() - pos.lastRetryTime > 4000) {
          pos.lastRetryTime = Date.now();
          pos.apiStatus = 'SENDING_TO_MUDREX';
          const qty = paperEngine.settings.contractQuantity || 1.0;
          const lev = paperEngine.settings.leverage || 5;

          this.createRealOrder({ symbol: pos.symbol || 'CLUSDT', side: pos.direction, quantity: qty, leverage: lev })
            .then(res => {
              if (res.success) {
                pos.mudrexOrderId = this.extractOrderId(res.data);
                pos.apiStatus = 'TRANSMITTED_TO_MUDREX';
              } else {
                pos.apiStatus = 'API_ERROR: ' + (typeof res.error === 'object' ? JSON.stringify(res.error) : (res.error || 'Failed'));
              }
            })
            .catch(err => {
              pos.apiStatus = 'NETWORK_ERROR';
            });
        }
      }
    }

    try {
      const realPosRes = await this.fetchPositions();
      if (realPosRes.success && Array.isArray(realPosRes.data) && realPosRes.data.length > 0) {
        liveOpenPositions = [...realPosRes.data];
      }
    } catch (e) {}

    // Merge paperEngine active and closed positions into live terminal metrics
    const paperMetrics = paperEngine.getDashboardMetrics();
    const paperPositions = paperMetrics.openPositions || [];
    const paperClosed = paperMetrics.closedPositions || [];

    const existingPosIds = new Set(liveOpenPositions.map(p => p.positionId));
    for (const pPos of paperPositions) {
      if (!existingPosIds.has(pPos.positionId)) {
        liveOpenPositions.push(pPos);
        existingPosIds.add(pPos.positionId);
      }
    }

    const existingClosedIds = new Set(liveClosedPositions.map(p => p.positionId));
    for (const pCls of paperClosed) {
      if (!existingClosedIds.has(pCls.positionId)) {
        liveClosedPositions.push(pCls);
        existingClosedIds.add(pCls.positionId);
      }
    }

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

    const closedCount = liveClosedPositions.length;
    const totalTrades = winCount + lossCount;
    const winRate = totalTrades > 0 ? Math.round((winCount / totalTrades) * 100) : 0;

    return {
      rateFeedInfo: rateInfo,
      settings: paperEngine.settings,
      engineStatus: paperEngine.engineStatus,
      pauseReason: paperEngine.pauseReason,
      isEngineRunning: paperEngine.isEngineRunning,
      lastProcessedRate: paperEngine.lastProcessedRate,
      processedRatesCount: paperEngine.processedRatesCount,
      summary: {
        startingCapitalINR: totalBal,
        realizedBalanceINR: totalBal + realizedNetINR,
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
        totalEquityINR: totalBal + realizedNetINR + floatingNetINR,
        marginUsedINR,
        availableMarginINR: Math.max(0, totalBal + realizedNetINR + floatingNetINR - marginUsedINR),
        activePairsCount: new Set(liveOpenPositions.map(p => p.pairId || (p.positionId ? p.positionId.replace(/-(BUY|SELL).*/, '').replace(/^P-/, 'PAIR-') : p.id))).size || Math.ceil(liveOpenPositions.length / 2),
        maxActivePairs: paperEngine.settings.maxActivePairs || 25,
        activeBuyCount,
        activeSellCount,
        closedPositionsCount: closedCount,
        winCount,
        lossCount,
        winRate,
        dailyRealizedLossINR: 0,
        dailyLossLimitINR: 2000
      },
      openPositions: liveOpenPositions,
      closedPositions: liveClosedPositions,
      auditLogs: []
    };
  }
}

module.exports = new MudrexLiveAdapter();
