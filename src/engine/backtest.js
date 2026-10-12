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

  checkMarketClosedStatus(dateStr) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    const dayOfWeek = d.getUTCDay();

    if (dayOfWeek === 0) {
      return { isClosed: true, reason: 'Sunday (Weekend Market Closed)' };
    }
    if (dayOfWeek === 6) {
      return { isClosed: true, reason: 'Saturday (Weekend Market Closed)' };
    }

    const holidays = {
      '2026-01-26': 'Republic Day',
      '2026-03-08': 'Mahashivratri',
      '2026-03-25': 'Holi',
      '2026-04-03': 'Good Friday',
      '2026-04-14': 'Dr. Ambedkar Jayanti',
      '2026-05-01': 'Maharashtra Day',
      '2026-08-15': 'Independence Day',
      '2026-10-02': 'Mahatma Gandhi Jayanti',
      '2026-11-08': 'Diwali Laxmi Pujan',
      '2026-11-24': 'Guru Nanak Jayanti',
      '2026-12-25': 'Christmas',

      '2025-01-26': 'Republic Day',
      '2025-02-26': 'Mahashivratri',
      '2025-03-14': 'Holi',
      '2025-03-31': 'Id-Ul-Fitr',
      '2025-04-10': 'Mahavir Jayanti',
      '2025-04-18': 'Good Friday',
      '2025-04-14': 'Dr. Ambedkar Jayanti',
      '2025-05-01': 'Maharashtra Day',
      '2025-06-07': 'Bakri Id',
      '2025-07-06': 'Moharram',
      '2025-08-15': 'Independence Day',
      '2025-10-02': 'Mahatma Gandhi Jayanti',
      '2025-10-21': 'Diwali Laxmi Pujan',
      '2025-10-22': 'Diwali Balipratipada',
      '2025-11-05': 'Guru Nanak Jayanti',
      '2025-12-25': 'Christmas',

      '2024-01-26': 'Republic Day',
      '2024-03-08': 'Mahashivratri',
      '2024-03-25': 'Holi',
      '2024-03-29': 'Good Friday',
      '2024-04-11': 'Id-Ul-Fitr',
      '2024-04-17': 'Ram Navami',
      '2024-05-01': 'Maharashtra Day',
      '2024-06-17': 'Bakri Id',
      '2024-07-17': 'Moharram',
      '2024-08-15': 'Independence Day',
      '2024-10-02': 'Mahatma Gandhi Jayanti',
      '2024-11-01': 'Diwali Laxmi Pujan',
      '2024-11-15': 'Guru Nanak Jayanti',
      '2024-12-25': 'Christmas'
    };

    if (holidays[dateStr]) {
      return { isClosed: true, reason: `Market Holiday — ${holidays[dateStr]}` };
    }

    return { isClosed: false, reason: '' };
  }

  async runBacktest(config) {
    const {
      mode = 'SINGLE', // 'SINGLE' or 'RANGE'
      symbol = 'CLUSDT',
      dateStr,
      fromDateStr,
      toDateStr,
      startingCapitalINR = 100000,
      contractQuantity = 2.0,
      targetMove = 0.20,
      maxActivePairs = 25,
      takerFeeRate = 0.00059, // Mudrex exact 0.059%
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
    let lastProcessedRate = null;
    const runId = `RUN-${Date.now()}-${Math.floor(Math.random()*1000)}`;

    for (const dStr of targetDates) {
      const closedInfo = this.checkMarketClosedStatus(dStr);
      const klines = await this.fetchKlinesForDate(symbol, dStr);
      if (!klines || klines.length === 0) {
        missingDates.push(dStr);
        if (closedInfo.isClosed) {
          const dayEndData = this.calculateDayEndSnapshot(dStr, startingCapitalINR, pairs, closedPositions, currentPrice, multiplier, contractQuantity, takerFeeRate, gstRate, usdInrRate, leverage);
          dayEndData.isMarketClosed = true;
          dayEndData.marketClosedReason = closedInfo.reason;
          dailyReports.push(dayEndData);
        }
        if (mode === 'SINGLE' && closedInfo.isClosed) {
          return {
            success: false,
            isMarketClosed: true,
            marketClosedReason: closedInfo.reason,
            message: `Selected Date (${dStr}) is ${closedInfo.reason}. Market was closed on this day! Please pick a trading weekday or Date Range.`,
            runId,
            config
          };
        }
        continue;
      }

      for (let i = 0; i < klines.length; i++) {
        const k = klines[i];
        currentPrice = this.normalizePrice(k.close, symbol);
        const timestamp = k.openTime;

        // Sub-tick price sequence for candle (Green: Open->Low->High->Close, Red: Open->High->Low->Close)
        const isBullish = k.close >= k.open;
        const priceSubTicks = isBullish 
          ? [k.open, k.low, k.high, k.close]
          : [k.open, k.high, k.low, k.close];

        for (const rawPrice of priceSubTicks) {
          const priceStep = this.normalizePrice(rawPrice, symbol);
          if (priceStep === null) continue;

          // 1. Evaluate Target Exits for ALL Open Positions on THIS sub-tick rate
          for (const pair of pairs) {
            if (pair.status === 'CLOSED') continue;

            const buy = pair.buyPosition;
            if (buy && buy.status === 'OPEN' && buy.targetExitPrice !== null) {
              if (priceStep >= buy.targetExitPrice) {
                this.executeBacktestClose(pair, buy, buy.targetExitPrice, timestamp, takerFeeRate, gstRate, usdInrRate, multiplier, contractQuantity, closedPositions);
              }
            }

            const sell = pair.sellPosition;
            if (sell && sell.status === 'OPEN' && sell.targetExitPrice !== null) {
              if (priceStep <= sell.targetExitPrice) {
                this.executeBacktestClose(pair, sell, sell.targetExitPrice, timestamp, takerFeeRate, gstRate, usdInrRate, multiplier, contractQuantity, closedPositions);
              }
            }

            if (pair.buyPosition.status === 'CLOSED' && pair.sellPosition.status === 'CLOSED') {
              pair.status = 'CLOSED';
            }
          }

          // 2. Evaluate Missing Legs Re-opening on THIS sub-tick rate
          const activePairs = pairs.filter(p => p.status === 'ACTIVE');
          const tolerance = 0.0001;
          let legReopened = false;

          for (const pair of activePairs) {
            const buyOpen = pair.buyPosition && pair.buyPosition.status === 'OPEN';
            const sellOpen = pair.sellPosition && pair.sellPosition.status === 'OPEN';

            if (buyOpen && sellOpen) continue;

            if (buyOpen && !sellOpen) {
              if (Math.abs(priceStep - pair.buyPosition.entryPrice) <= tolerance) {
                this.reopenBacktestLeg(pair, 'SELL', priceStep, timestamp, targetMove, symbol, contractQuantity, multiplier, config.buyTargetMove, config.sellTargetMove);
                legReopened = true;
                break;
              }
            }

            if (sellOpen && !buyOpen) {
              if (Math.abs(priceStep - pair.sellPosition.entryPrice) <= tolerance) {
                this.reopenBacktestLeg(pair, 'BUY', priceStep, timestamp, targetMove, symbol, contractQuantity, multiplier, config.buyTargetMove, config.sellTargetMove);
                legReopened = true;
                break;
              }
            }
          }

          if (legReopened) {
            lastProcessedRate = priceStep;
            continue;
          }

          // 3. NEW PAIR CREATION ON NEW RATE UPDATE (No 1-min timer)
          // Skip if a full active pair (both legs open) already exists at this exact rate
          const existingPairAtRate = activePairs.find(p => {
            const bOpen = p.buyPosition && p.buyPosition.status === 'OPEN';
            const sOpen = p.sellPosition && p.sellPosition.status === 'OPEN';
            return bOpen && sOpen && (p.buyPosition.entryPrice === priceStep || p.sellPosition.entryPrice === priceStep);
          });
          if (existingPairAtRate) continue;

          // Skip if price rate hasn't changed (idempotent rate guard)
          if (lastProcessedRate === priceStep && activePairs.length > 0) continue;

          // Skip if this rate was already processed
          if (processedRates.has(priceStep)) continue;

          // Skip if max active pairs cap reached
          if (activePairs.length >= maxActivePairs) continue;

          // Create New Pair instantly on NEW RATE!
          const pairSeq = (pairs.length + 1).toString().padStart(4, '0');
          const pairId = `BT-PAIR-${pairSeq}`;
          const bTargetMove = config.buyTargetMove !== undefined && config.buyTargetMove !== null ? Number(config.buyTargetMove) : (config.targetMove || 0.20);
          const sTargetMove = config.sellTargetMove !== undefined && config.sellTargetMove !== null ? Number(config.sellTargetMove) : (config.targetMove || 0.20);

          const buyTarget = bTargetMove ? this.normalizePrice(priceStep + bTargetMove, symbol) : null;
          const sellTarget = sTargetMove ? this.normalizePrice(priceStep - sTargetMove, symbol) : null;

          const buyPosition = {
            positionId: `BT-${pairSeq}-BUY`,
            pairId,
            direction: 'BUY',
            symbol,
            entryTime: new Date(timestamp).toISOString(),
            entryTimestamp: timestamp,
            entryPrice: priceStep,
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
            entryPrice: priceStep,
            quantity: contractQuantity,
            contractMultiplier: multiplier,
            targetExitPrice: sellTarget,
            status: 'OPEN'
          };

          pairs.push({
            pairId,
            symbol,
            createdTime: new Date(timestamp).toISOString(),
            entryRate: priceStep,
            status: 'ACTIVE',
            buyPosition,
            sellPosition
          });

          processedRates.add(priceStep);
          lastProcessedRate = priceStep;
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

  reopenBacktestLeg(pair, direction, entryPrice, timestamp, targetMove, symbol, qty, mult, buyTargetMove, sellTargetMove) {
    const seq = pair.pairId.replace('BT-PAIR-', '');
    const legSeq = `${seq}-${direction}-${Date.now().toString().slice(-4)}`;

    const bMove = buyTargetMove !== undefined && buyTargetMove !== null ? Number(buyTargetMove) : (targetMove || 0.20);
    const sMove = sellTargetMove !== undefined && sellTargetMove !== null ? Number(sellTargetMove) : (targetMove || 0.20);

    if (direction === 'BUY') {
      const buyTarget = bMove ? this.normalizePrice(entryPrice + bMove, symbol) : null;
      pair.buyPosition = {
        positionId: `BT-${legSeq}`,
        pairId: pair.pairId,
        direction: 'BUY',
        symbol,
        entryTime: new Date(timestamp).toISOString(),
        entryTimestamp: timestamp,
        entryPrice,
        quantity: qty,
        contractMultiplier: mult,
        targetExitPrice: buyTarget,
        status: 'OPEN'
      };
    } else {
      const sellTarget = sMove ? this.normalizePrice(entryPrice - sMove, symbol) : null;
      pair.sellPosition = {
        positionId: `BT-${legSeq}`,
        pairId: pair.pairId,
        direction: 'SELL',
        symbol,
        entryTime: new Date(timestamp).toISOString(),
        entryTimestamp: timestamp,
        entryPrice,
        quantity: qty,
        contractMultiplier: mult,
        targetExitPrice: sellTarget,
        status: 'OPEN'
      };
    }
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
