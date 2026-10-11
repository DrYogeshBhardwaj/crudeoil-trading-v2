const http = require('https');

class HistoricalBacktester {
  constructor() {
    this.contractMultipliers = {
      CLUSDT: 1.0,
      XAGUSDT: 1.0,
      BTCUSDT: 1.0
    };
  }

  normalizePrice(price, symbol) {
    if (price === null || price === undefined || isNaN(price)) return null;
    const decimals = symbol === 'BTCUSDT' ? 2 : (symbol === 'XAGUSDT' ? 4 : 2);
    return Number(price.toFixed(decimals));
  }

  async fetchKlinesForDate(symbol, dateStr) {
    // dateStr format: YYYY-MM-DD
    const start = new Date(`${dateStr}T00:00:00Z`).getTime();
    const end = new Date(`${dateStr}T23:59:59Z`).getTime();

    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&startTime=${start}&endTime=${end}&limit=1440`;

    return new Promise((resolve, reject) => {
      http.get(url, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (Array.isArray(data)) {
              const klines = data.map(k => ({
                openTime: k[0],
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5]),
                closeTime: k[6]
              }));
              resolve(klines);
            } else {
              resolve([]);
            }
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
  }

  generateDateSequence(fromDateStr, toDateStr) {
    const dates = [];
    let current = new Date(`${fromDateStr}T00:00:00Z`);
    const end = new Date(`${toDateStr}T00:00:00Z`);

    while (current <= end) {
      dates.push(current.toISOString().split('T')[0]);
      current.setDate(current.getDate() + 1);
    }
    return dates;
  }

  async runBacktest(config) {
    const {
      mode = 'SINGLE', // 'SINGLE' or 'RANGE'
      symbol = 'CLUSDT',
      dateStr,
      fromDateStr,
      toDateStr,
      startingCapitalINR = 50000,
      contractQuantity = 1.0,
      targetMove = 0.05,
      maxActivePairs = 25,
      takerFeeRate = 0.0005,
      gstRate = 0.18,
      usdInrRate = 86.50,
      leverage = 5
    } = config;

    let targetDates = [];
    if (mode === 'RANGE' && fromDateStr && toDateStr) {
      targetDates = this.generateDateSequence(fromDateStr, toDateStr);
    } else if (dateStr) {
      targetDates = [dateStr];
    } else if (fromDateStr) {
      targetDates = [fromDateStr];
    } else {
      throw new Error('Please specify Date or From/To Date Range for historical backtest.');
    }

    const multiplier = this.contractMultipliers[symbol] || 1.0;
    const processedRates = new Set();
    const pairs = [];
    const closedPositions = [];
    const dailyReports = [];
    const missingDates = [];

    let currentPrice = null;
    const runId = `RUN-${Date.now()}-${Math.floor(Math.random()*1000)}`;

    for (const dStr of targetDates) {
      const klines = await this.fetchKlinesForDate(symbol, dStr);
      if (!klines || klines.length === 0) {
        missingDates.push(dStr);
        continue;
      }

      for (let i = 0; i < klines.length; i++) {
        const k = klines[i];
        currentPrice = this.normalizePrice(k.close, symbol);
        const klineHigh = k.high;
        const klineLow = k.low;
        const timestamp = k.openTime;

        // 1. Evaluate open target hits intrabar (against high & low)
        for (const pair of pairs) {
          if (pair.status === 'CLOSED') continue;

          // BUY Position
          const buy = pair.buyPosition;
          if (buy.status === 'OPEN' && buy.targetExitPrice !== null) {
            if (klineHigh >= buy.targetExitPrice) {
              this.executeBacktestClose(pair, buy, buy.targetExitPrice, timestamp, takerFeeRate, gstRate, usdInrRate, multiplier, contractQuantity, closedPositions);
            }
          }

          // SELL Position
          const sell = pair.sellPosition;
          if (sell.status === 'OPEN' && sell.targetExitPrice !== null) {
            if (klineLow <= sell.targetExitPrice) {
              this.executeBacktestClose(pair, sell, sell.targetExitPrice, timestamp, takerFeeRate, gstRate, usdInrRate, multiplier, contractQuantity, closedPositions);
            }
          }

          // Check if pair fully closed
          if (pair.buyPosition.status === 'CLOSED' && pair.sellPosition.status === 'CLOSED') {
            pair.status = 'CLOSED';
          }
        }

        // 2. Unique Rate Entry Check
        const activePairsCount = pairs.filter(p => p.status === 'ACTIVE').length;
        if (activePairsCount < maxActivePairs && !processedRates.has(currentPrice)) {
          const pairSeq = (pairs.length + 1).toString().padStart(4, '0');
          const pairId = `BT-PAIR-${pairSeq}`;
          const buyTarget = targetMove ? this.normalizePrice(currentPrice + targetMove, symbol) : null;
          const sellTarget = targetMove ? this.normalizePrice(currentPrice - targetMove, symbol) : null;

          const buyPosition = {
            positionId: `BT-${pairSeq}-BUY`,
            pairId,
            direction: 'BUY',
            symbol,
            entryTime: new Date(timestamp).toISOString(),
            entryTimestamp: timestamp,
            entryPrice: currentPrice,
            quantity: contractQuantity,
            contractMultiplier: multiplier,
            targetExitPrice: buyTarget,
            status: 'OPEN'
          };

          const sellPosition = {
            positionId: `BT-${pairSeq}-SELL`,
            pairId,
            direction: 'SELL',
            symbol,
            entryTime: new Date(timestamp).toISOString(),
            entryTimestamp: timestamp,
            entryPrice: currentPrice,
            quantity: contractQuantity,
            contractMultiplier: multiplier,
            targetExitPrice: sellTarget,
            status: 'OPEN'
          };

          pairs.push({
            pairId,
            symbol,
            createdTime: new Date(timestamp).toISOString(),
            entryRate: currentPrice,
            status: 'ACTIVE',
            buyPosition,
            sellPosition
          });

          processedRates.add(currentPrice);
        }
      }

      // Record Day-End Report
      const dayEndData = this.calculateDayEndSnapshot(dStr, startingCapitalINR, pairs, closedPositions, currentPrice, multiplier, contractQuantity, takerFeeRate, gstRate, usdInrRate, leverage);
      dailyReports.push(dayEndData);
    }

    if (dailyReports.length === 0) {
      return {
        success: false,
        message: `No historical kline data available for ${symbol} for the selected dates (${targetDates.join(', ')}).`,
        runId,
        config
      };
    }

    // Final Range Summary
    const finalSummary = this.calculateFinalRangeSummary(startingCapitalINR, pairs, closedPositions, dailyReports, currentPrice, multiplier, contractQuantity, takerFeeRate, gstRate, usdInrRate);

    // Remaining Open Positions List
    const remainingOpenPositions = this.getRemainingOpenPositionsList(pairs, currentPrice, multiplier, contractQuantity, takerFeeRate, gstRate, usdInrRate);

    return {
      success: true,
      runId,
      mode,
      symbol,
      dateStr: mode === 'SINGLE' ? targetDates[0] : `${fromDateStr} to ${toDateStr}`,
      targetDates,
      missingDates,
      config,
      summary: finalSummary,
      dailyReports,
      trades: closedPositions, // full trade ledger
      remainingOpenPositions
    };
  }

  executeBacktestClose(pair, position, exitPrice, exitTimestamp, takerFeeRate, gstRate, usdInrRate, mult, qty, closedPositions) {
    position.status = 'CLOSED';
    position.exitPrice = exitPrice;
    position.exitTime = new Date(exitTimestamp).toISOString();

    let grossUSD = 0;
    if (position.direction === 'BUY') {
      grossUSD = (exitPrice - position.entryPrice) * qty * mult;
    } else {
      grossUSD = (position.entryPrice - exitPrice) * qty * mult;
    }

    const entryValUSD = position.entryPrice * qty * mult;
    const exitValUSD = exitPrice * qty * mult;
    const entryFeeUSD = entryValUSD * takerFeeRate;
    const exitFeeUSD = exitValUSD * takerFeeRate;
    const gstUSD = (entryFeeUSD + exitFeeUSD) * gstRate;
    const chargesUSD = entryFeeUSD + exitFeeUSD + gstUSD;
    const netUSD = grossUSD - chargesUSD;

    const grossINR = grossUSD * usdInrRate;
    const chargesINR = chargesUSD * usdInrRate;
    const netINR = grossINR - chargesINR;

    const exitReason = netUSD >= 0 ? 'TARGET PROFIT HIT' : 'TARGET PRICE HIT (NET LOSS DUE TO FEES)';

    closedPositions.push({
      pairId: pair.pairId,
      positionId: position.positionId,
      direction: position.direction,
      symbol: position.symbol,
      entryTime: position.entryTime,
      exitTime: position.exitTime,
      entryPrice: position.entryPrice,
      exitPrice,
      targetExitPrice: position.targetExitPrice,
      grossProfitUSD: Number(grossUSD.toFixed(4)),
      grossProfitINR: Number(grossINR.toFixed(2)),
      totalChargesUSD: Number(chargesUSD.toFixed(4)),
      totalChargesINR: Number(chargesINR.toFixed(2)),
      netProfitUSD: Number(netUSD.toFixed(4)),
      netProfitINR: Number(netINR.toFixed(2)),
      exitReason
    });
  }

  calculateDayEndSnapshot(dateStr, startingCapitalINR, pairs, closedPositions, dayEndPrice, mult, qty, takerFeeRate, gstRate, usdInrRate, leverage) {
    let cumulativeRealizedGrossINR = 0;
    let cumulativeRealizedChargesINR = 0;
    let cumulativeRealizedNetINR = 0;

    let dailyClosedPositionsCount = 0;
    let dailyRealizedGrossINR = 0;
    let dailyRealizedChargesINR = 0;
    let dailyRealizedNetINR = 0;

    for (const cp of closedPositions) {
      cumulativeRealizedGrossINR += cp.grossProfitINR;
      cumulativeRealizedChargesINR += cp.totalChargesINR;
      cumulativeRealizedNetINR += cp.netProfitINR;

      if (cp.exitTime && cp.exitTime.startsWith(dateStr)) {
        dailyClosedPositionsCount++;
        dailyRealizedGrossINR += cp.grossProfitINR;
        dailyRealizedChargesINR += cp.totalChargesINR;
        dailyRealizedNetINR += cp.netProfitINR;
      }
    }

    let dailyNewPairsOpened = 0;
    for (const pair of pairs) {
      if (pair.createdTime && pair.createdTime.startsWith(dateStr)) {
        dailyNewPairsOpened++;
      }
    }

    let openBuyCount = 0;
    let openSellCount = 0;
    let floatingGrossUSD = 0;
    let floatingGrossINR = 0;
    let floatingChargesUSD = 0;
    let floatingChargesINR = 0;
    let floatingNetUSD = 0;
    let floatingNetINR = 0;

    let activePairsCount = 0;
    let completePairsCount = 0;
    let incompletePairsCount = 0;

    for (const pair of pairs) {
      if (pair.status === 'CLOSED') continue;
      activePairsCount++;

      const isBuyOpen = pair.buyPosition.status === 'OPEN';
      const isSellOpen = pair.sellPosition.status === 'OPEN';

      if (isBuyOpen && isSellOpen) completePairsCount++;
      else incompletePairsCount++;

      const positions = [pair.buyPosition, pair.sellPosition];
      for (const pos of positions) {
        if (pos.status !== 'OPEN') continue;

        if (pos.direction === 'BUY') openBuyCount++;
        if (pos.direction === 'SELL') openSellCount++;

        let posGrossUSD = 0;
        if (dayEndPrice) {
          if (pos.direction === 'BUY') posGrossUSD = (dayEndPrice - pos.entryPrice) * qty * mult;
          else posGrossUSD = (pos.entryPrice - dayEndPrice) * qty * mult;
        }

        const entryValUSD = pos.entryPrice * qty * mult;
        const estExitValUSD = (dayEndPrice || pos.entryPrice) * qty * mult;
        const entryFeeUSD = entryValUSD * takerFeeRate;
        const estExitFeeUSD = estExitValUSD * takerFeeRate;
        const estGstUSD = (entryFeeUSD + estExitFeeUSD) * gstRate;
        const posChargesUSD = entryFeeUSD + estExitFeeUSD + estGstUSD;
        const posNetUSD = posGrossUSD - posChargesUSD;

        const posGrossINR = posGrossUSD * usdInrRate;
        const posChargesINR = posChargesUSD * usdInrRate;
        const posNetINR = posNetUSD * usdInrRate;

        floatingGrossUSD += posGrossUSD;
        floatingGrossINR += posGrossINR;
        floatingChargesUSD += posChargesUSD;
        floatingChargesINR += posChargesINR;
        floatingNetUSD += posNetUSD;
        floatingNetINR += posNetINR;
      }
    }

    const realizedBalanceINR = startingCapitalINR + cumulativeRealizedNetINR;
    const endOfDayEquityINR = realizedBalanceINR + floatingNetINR;

    return {
      dateStr,
      dayEndPrice,
      dailyNewPairsOpened,
      dailyClosedPositionsCount,
      dailyRealizedGrossINR: Number(dailyRealizedGrossINR.toFixed(2)),
      dailyRealizedChargesINR: Number(dailyRealizedChargesINR.toFixed(2)),
      dailyRealizedNetINR: Number(dailyRealizedNetINR.toFixed(2)),
      cumulativeClosedPositionsCount: closedPositions.length,
      cumulativeRealizedGrossINR: Number(cumulativeRealizedGrossINR.toFixed(2)),
      cumulativeRealizedChargesINR: Number(cumulativeRealizedChargesINR.toFixed(2)),
      cumulativeRealizedNetINR: Number(cumulativeRealizedNetINR.toFixed(2)),
      realizedBalanceINR: Number(realizedBalanceINR.toFixed(2)),
      endOfDayEquityINR: Number(endOfDayEquityINR.toFixed(2)),
      floatingGrossUSD: Number(floatingGrossUSD.toFixed(4)),
      floatingGrossINR: Number(floatingGrossINR.toFixed(2)),
      floatingChargesUSD: Number(floatingChargesUSD.toFixed(4)),
      floatingChargesINR: Number(floatingChargesINR.toFixed(2)),
      floatingNetUSD: Number(floatingNetUSD.toFixed(4)),
      floatingNetINR: Number(floatingNetINR.toFixed(2)),
      openBuyCount,
      openSellCount,
      totalOpenPositionsCount: openBuyCount + openSellCount,
      activePairsCount,
      completePairsCount,
      incompletePairsCount
    };
  }

  calculateFinalRangeSummary(startingCapitalINR, pairs, closedPositions, dailyReports, finalPrice, mult, qty, takerFeeRate, gstRate, usdInrRate) {
    let realizedGrossUSD = 0, realizedGrossINR = 0;
    let realizedChargesUSD = 0, realizedChargesINR = 0;
    let realizedNetUSD = 0, realizedNetINR = 0;
    let wins = 0, losses = 0;

    for (const cp of closedPositions) {
      realizedGrossUSD += cp.grossProfitUSD;
      realizedGrossINR += cp.grossProfitINR;
      realizedChargesUSD += cp.totalChargesUSD;
      realizedChargesINR += cp.totalChargesINR;
      realizedNetUSD += cp.netProfitUSD;
      realizedNetINR += cp.netProfitINR;
      if (cp.netProfitUSD >= 0) wins++;
      else losses++;
    }

    const lastDayReport = dailyReports[dailyReports.length - 1];

    let peakEquity = -Infinity;
    let lowestEquity = Infinity;
    for (const dr of dailyReports) {
      if (dr.endOfDayEquityINR > peakEquity) peakEquity = dr.endOfDayEquityINR;
      if (dr.endOfDayEquityINR < lowestEquity) lowestEquity = dr.endOfDayEquityINR;
    }

    const realizedBalanceINR = startingCapitalINR + realizedNetINR;
    const finalEquityINR = realizedBalanceINR + (lastDayReport ? lastDayReport.floatingNetINR : 0);

    return {
      startingCapitalINR,
      realizedBalanceINR: Number(realizedBalanceINR.toFixed(2)),
      finalEquityINR: Number(finalEquityINR.toFixed(2)),
      totalPairsCreated: pairs.length,
      closedPositionsCount: closedPositions.length,
      wins,
      losses,
      winRate: closedPositions.length > 0 ? Number(((wins / closedPositions.length) * 100).toFixed(1)) : 0,
      totalRealizedGrossUSD: Number(realizedGrossUSD.toFixed(4)),
      totalRealizedGrossINR: Number(realizedGrossINR.toFixed(2)),
      totalChargesUSD: Number(realizedChargesUSD.toFixed(4)),
      totalChargesINR: Number(realizedChargesINR.toFixed(2)),
      totalRealizedNetUSD: Number(realizedNetUSD.toFixed(4)),
      totalRealizedNetINR: Number(realizedNetINR.toFixed(2)),
      
      remainingOpenPositionsCount: lastDayReport ? lastDayReport.totalOpenPositionsCount : 0,
      remainingFloatingGrossUSD: lastDayReport ? lastDayReport.floatingGrossUSD : 0,
      remainingFloatingGrossINR: lastDayReport ? lastDayReport.floatingGrossINR : 0,
      remainingFloatingChargesINR: lastDayReport ? lastDayReport.floatingChargesINR : 0,
      remainingFloatingNetINR: lastDayReport ? lastDayReport.floatingNetINR : 0,

      remainingActivePairsCount: lastDayReport ? lastDayReport.activePairsCount : 0,
      remainingCompletePairsCount: lastDayReport ? lastDayReport.completePairsCount : 0,
      remainingIncompletePairsCount: lastDayReport ? lastDayReport.incompletePairsCount : 0,

      peakEquityINR: Number(peakEquity.toFixed(2)),
      lowestEquityINR: Number(lowestEquity.toFixed(2))
    };
  }

  getRemainingOpenPositionsList(pairs, currentPrice, mult, qty, takerFeeRate, gstRate, usdInrRate) {
    const list = [];
    const now = Date.now();

    for (const pair of pairs) {
      if (pair.status === 'CLOSED') continue;

      const positions = [pair.buyPosition, pair.sellPosition];
      for (const pos of positions) {
        if (pos.status !== 'OPEN') continue;

        let floatingGrossUSD = 0;
        if (currentPrice) {
          if (pos.direction === 'BUY') floatingGrossUSD = (currentPrice - pos.entryPrice) * qty * mult;
          else floatingGrossUSD = (pos.entryPrice - currentPrice) * qty * mult;
        }

        const entryValUSD = pos.entryPrice * qty * mult;
        const estExitValUSD = (currentPrice || pos.entryPrice) * qty * mult;
        const entryFeeUSD = entryValUSD * takerFeeRate;
        const estExitFeeUSD = estExitValUSD * takerFeeRate;
        const estGstUSD = (entryFeeUSD + estExitFeeUSD) * gstRate;
        const chargesUSD = entryFeeUSD + estExitFeeUSD + estGstUSD;
        const netUSD = floatingGrossUSD - chargesUSD;

        const durationMs = now - pos.entryTimestamp;
        const durationHours = (durationMs / (1000 * 3600)).toFixed(1);

        list.push({
          pairId: pair.pairId,
          positionId: pos.positionId,
          direction: pos.direction,
          symbol: pos.symbol,
          entryTime: pos.entryTime,
          entryPrice: pos.entryPrice,
          dayEndMarketPrice: currentPrice || pos.entryPrice,
          targetExitPrice: pos.targetExitPrice,
          floatingGrossUSD: Number(floatingGrossUSD.toFixed(4)),
          floatingGrossINR: Number((floatingGrossUSD * usdInrRate).toFixed(2)),
          estimatedChargesINR: Number((chargesUSD * usdInrRate).toFixed(2)),
          floatingNetINR: Number((netUSD * usdInrRate).toFixed(2)),
          holdingDurationHours: `${durationHours}h`,
          status: 'OPEN AT SIMULATION END'
        });
      }
    }
    return list;
  }
}

module.exports = new HistoricalBacktester();
