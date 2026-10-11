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
          status: 'OPEN'
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
          status: 'OPEN'
        };

        this.liveOpenPositions.push(buyPos);
        this.liveOpenPositions.push(sellPos);
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
              resolve({ success: false, statusCode: res.statusCode, error: parsed.message || rawData });
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
      let altSpot = await this.request('GET', `https://trade.mudrex.com/api/v1/wallet/funds?currency=INR`);
      if (altSpot.success) {
        const altBal = this.parseBalanceValue(altSpot.data);
        if (altBal > 0) {
          spotBal = altBal;
          spotRaw = altSpot.data;
        }
      }
    }

    if (spotBal === 0) {
      let altSpot2 = await this.request('GET', `https://trade.mudrex.com/api/v1/wallet/funds`);
      if (altSpot2.success) {
        const altBal2 = this.parseBalanceValue(altSpot2.data);
        if (altBal2 > 0) {
          spotBal = altBal2;
          spotRaw = altSpot2.data;
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
    const body = {
      symbol: symbol || 'CLUSDT',
      side: side.toUpperCase(),
      quantity: Number(quantity) || 1.0,
      leverage: Number(leverage) || 5,
      target_price: targetPrice ? Number(targetPrice) : null
    };

    const url = `${this.v2Url}/futures/order?symbol=${encodeURIComponent(body.symbol)}`;
    return await this.request('POST', url, body);
  }

  async closeRealPosition(positionId, symbol = 'CLUSDT') {
    const url = `${this.v2Url}/futures/positions/${encodeURIComponent(positionId)}/close`;
    return await this.request('POST', url, { symbol });
  }

  async fetchPositions() {
    return await this.request('GET', `${this.baseUrl}/futures/positions`);
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

    try {
      const realPosRes = await this.fetchPositions();
      if (realPosRes.success && Array.isArray(realPosRes.data) && realPosRes.data.length > 0) {
        liveOpenPositions = realPosRes.data;
      }
    } catch (e) {}

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
        activePairsCount: liveOpenPositions.length,
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
