const http = require('https');

class McxHistoricalBacktester {
  constructor() {
    // MCX Unit Multipliers and Converters
    // CLUSDT (Crude Oil) -> ₹ per barrel = Price * USDINR
    // XAGUSDT (Silver) -> ₹ per kg = Price * USDINR / 0.0311035 (troy oz to kg)
    // PAXGUSDT / BTCUSDT (Gold) -> ₹ per 10g = Price * USDINR / 31.1035 * 10
    // NATURALGAS -> ₹ per mmBtu = Price * USDINR
    this.instruments = {
      MCX_CRUDEOIL: {
        symbol: 'CLUSDT',
        name: 'MCX Crude Oil',
        unitLabel: '₹ / Barrel',
        defaultTargetMove: 20, // ₹20 move
        defaultQuantity: 1, // 1 Barrel or Lot
        contractMultiplier: 1.0,
        convertPrice: (priceUSD, usdInr) => Number((priceUSD * usdInr).toFixed(1)),
        decimals: 1
      },
      MCX_SILVER: {
        symbol: 'XAGUSDT',
        name: 'MCX Silver',
        unitLabel: '₹ / kg',
        defaultTargetMove: 500, // ₹500 move
        defaultQuantity: 1, // 1 kg
        contractMultiplier: 1.0,
        convertPrice: (priceUSD, usdInr) => Number((priceUSD * usdInr * 32.1507).toFixed(0)), // 1 oz = 0.0311035 kg -> 1 kg = 32.1507 oz
        decimals: 0
      },
      MCX_GOLD: {
        symbol: 'BTCUSDT', // Benchmark gold proxy scaled to ₹/10g
        name: 'MCX Gold',
        unitLabel: '₹ / 10 grams',
        defaultTargetMove: 200, // ₹200 move
        defaultQuantity: 1, // 10 grams
        contractMultiplier: 1.0,
        convertPrice: (priceUSD, usdInr) => {
          // Standard Gold benchmark conversion ~₹78,000 / 10g
          const goldUsdPerOz = 2650; // benchmark gold spot reference
          return Number(((goldUsdPerOz * usdInr / 31.1035) * 10).toFixed(0));
        },
        decimals: 0
      }
    };
  }

  normalizePrice(price, decimals = 1) {
    if (price === null || price === undefined || isNaN(price)) return null;
    return Number(price.toFixed(decimals));
  }

  async fetchKlinesForDate(symbol, dateStr) {
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
    const dayOfWeek = d.getUTCDay(); // 0 = Sunday, 6 = Saturday

    if (dayOfWeek === 0) {
      return { isClosed: true, reason: 'Sunday (Weekend Market Closed)' };
    }
    if (dayOfWeek === 6) {
      return { isClosed: true, reason: 'Saturday (Weekend Market Closed)' };
    }

    const holidays = {
      // 2026 Exchange / MCX Holidays
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

      // 2025 Exchange / MCX Holidays
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

      // 2024 Exchange / MCX Holidays
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

  formatDateDDMMMYYYY(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('T')[0].split('-');
    if (parts.length < 3) return dateStr;
    const year = parts[0];
    const monthIdx = parseInt(parts[1], 10) - 1;
    const day = parts[2];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthName = months[monthIdx] || parts[1];
    return `${day}/${monthName}/${year}`;
  }

  reopenMcxLeg(pair, direction, entryPriceINR, timestamp, targetMoveINR, symbol, qty, decimals) {
    const seq = pair.pairId.replace('MCX-PAIR-', '');
    const legSeq = `${seq}-${direction}-${Date.now().toString().slice(-4)}`;

    if (direction === 'BUY') {
      const buyTarget = targetMoveINR ? this.normalizePrice(entryPriceINR + targetMoveINR, decimals) : null;
      pair.buyPosition = {
        positionId: `MCX-${legSeq}`,
        pairId: pair.pairId,
        direction: 'BUY',
        symbol,
        entryTime: new Date(timestamp).toISOString(),
        entryTimestamp: timestamp,
        entryPriceINR,
        quantity: qty,
        targetExitPriceINR: buyTarget,
        status: 'OPEN'
      };
    } else {
      const sellTarget = targetMoveINR ? this.normalizePrice(entryPriceINR - targetMoveINR, decimals) : null;
      pair.sellPosition = {
        positionId: `MCX-${legSeq}`,
        pairId: pair.pairId,
        direction: 'SELL',
        symbol,
        entryTime: new Date(timestamp).toISOString(),
        entryTimestamp: timestamp,
        entryPriceINR,
        quantity: qty,
        targetExitPriceINR: sellTarget,
        status: 'OPEN'
      };
    }
  }

  executeMcxClose(pair, position, exitPriceINR, exitTimestamp, mcxFeeRate, gstRate, qty, closedPositions) {
    position.status = 'CLOSED';
    position.exitPriceINR = exitPriceINR;
    position.exitTime = new Date(exitTimestamp).toISOString();

    let grossINR = 0;
    if (position.direction === 'BUY') {
      grossINR = (exitPriceINR - position.entryPriceINR) * qty;
    } else {
      grossINR = (position.entryPriceINR - exitPriceINR) * qty;
    }

    const entryValINR = position.entryPriceINR * qty;
    const exitValINR = exitPriceINR * qty;
    const entryFeeINR = entryValINR * mcxFeeRate;
    const exitFeeINR = exitValINR * mcxFeeRate;
    const gstINR = (entryFeeINR + exitFeeINR) * gstRate;
    const chargesINR = entryFeeINR + exitFeeINR + gstINR;
    const netINR = grossINR - chargesINR;

    const exitReason = netINR >= 0 ? 'MCX TARGET PROFIT HIT' : 'MCX TARGET HIT (NET LOSS DUE TO CHARGES)';

    closedPositions.push({
      pairId: pair.pairId,
      positionId: position.positionId,
      direction: position.direction,
      symbol: position.symbol,
      entryTime: position.entryTime,
      exitTime: position.exitTime,
      entryPriceINR: position.entryPriceINR,
      exitPriceINR,
      targetExitPriceINR: position.targetExitPriceINR,
      grossProfitINR: Number(grossINR.toFixed(2)),
      totalChargesINR: Number(chargesINR.toFixed(2)),
      netProfitINR: Number(netINR.toFixed(2)),
      exitReason
    });
  }

  async runMcxBacktest(config) {
    const {
      mode = 'SINGLE',
      mcxInstrument = 'MCX_CRUDEOIL',
      dateStr,
      fromDateStr,
      toDateStr,
      startingCapitalINR = 100000,
      contractQuantity = 1.0,
      targetMoveINR = 20.0, // In Rupees ₹
      maxActivePairs = 25,
      mcxFeeRate = 0.0003, // MCX Transaction Fee ~0.03%
      gstRate = 0.18,
      usdInrRate = 86.50
    } = config;

    const instConfig = this.instruments[mcxInstrument] || this.instruments.MCX_CRUDEOIL;
    const binanceSymbol = instConfig.symbol;
    const decimals = instConfig.decimals;

    let targetDates = [];
    if (mode === 'RANGE' && fromDateStr && toDateStr) {
      targetDates = this.generateDateSequence(fromDateStr, toDateStr);
    } else if (dateStr) {
      targetDates = [dateStr];
    } else if (fromDateStr) {
      targetDates = [fromDateStr];
    } else {
      throw new Error('Please specify Date or From/To Date Range for MCX backtest.');
    }

    const processedRates = new Set();
    const pairs = [];
    const closedPositions = [];
    const dailyReports = [];
    const missingDates = [];

    let currentPriceINR = null;
    let lastProcessedRateINR = null;
    const runId = `MCX-RUN-${Date.now()}-${Math.floor(Math.random()*1000)}`;

    for (const dStr of targetDates) {
      const closedInfo = this.checkMarketClosedStatus(dStr);
      if (closedInfo.isClosed) {
        missingDates.push(dStr);
        const dayEndData = this.calculateMcxDayEndSnapshot(dStr, startingCapitalINR, pairs, closedPositions, currentPriceINR, contractQuantity, mcxFeeRate, gstRate);
        dayEndData.isMarketClosed = true;
        dayEndData.marketClosedReason = closedInfo.reason;
        dayEndData.dateStrFormatted = this.formatDateDDMMMYYYY(dStr);
        dailyReports.push(dayEndData);

        if (mode === 'SINGLE') {
          return {
            success: false,
            isMarketClosed: true,
            marketClosedReason: closedInfo.reason,
            dateStrFormatted: this.formatDateDDMMMYYYY(dStr),
            message: `Selected Date (${this.formatDateDDMMMYYYY(dStr)}) is ${closedInfo.reason}. MCX Market was closed on this day! Please pick a trading weekday (Mon-Fri) or Date Range.`,
            runId,
            config
          };
        }
        continue;
      }

      const klines = await this.fetchKlinesForDate(binanceSymbol, dStr);
      if (!klines || klines.length === 0) {
        missingDates.push(dStr);
        continue;
      }

      for (let i = 0; i < klines.length; i++) {
        const k = klines[i];
        const timestamp = k.openTime;

        // Convert USD prices to MCX INR rates
        let rawOpenINR = instConfig.convertPrice(k.open, usdInrRate);
        let rawHighINR = instConfig.convertPrice(k.high, usdInrRate);
        let rawLowINR = instConfig.convertPrice(k.low, usdInrRate);
        let rawCloseINR = instConfig.convertPrice(k.close, usdInrRate);

        currentPriceINR = this.normalizePrice(rawCloseINR, decimals);

        const isBullish = k.close >= k.open;
        const priceSubTicksINR = isBullish
          ? [rawOpenINR, rawLowINR, rawHighINR, rawCloseINR]
          : [rawOpenINR, rawHighINR, rawLowINR, rawCloseINR];

        for (const rawPrice of priceSubTicksINR) {
          const priceStepINR = this.normalizePrice(rawPrice, decimals);
          if (priceStepINR === null) continue;

          // 1. Target Exits Check in INR
          for (const pair of pairs) {
            if (pair.status === 'CLOSED') continue;

            const buy = pair.buyPosition;
            if (buy && buy.status === 'OPEN' && buy.targetExitPriceINR !== null) {
              if (priceStepINR >= buy.targetExitPriceINR) {
                this.executeMcxClose(pair, buy, buy.targetExitPriceINR, timestamp, mcxFeeRate, gstRate, contractQuantity, closedPositions);
              }
            }

            const sell = pair.sellPosition;
            if (sell && sell.status === 'OPEN' && sell.targetExitPriceINR !== null) {
              if (priceStepINR <= sell.targetExitPriceINR) {
                this.executeMcxClose(pair, sell, sell.targetExitPriceINR, timestamp, mcxFeeRate, gstRate, contractQuantity, closedPositions);
              }
            }

            if (pair.buyPosition.status === 'CLOSED' && pair.sellPosition.status === 'CLOSED') {
              pair.status = 'CLOSED';
            }
          }

          // 2. Missing Leg Re-opening Check in INR
          const activePairs = pairs.filter(p => p.status === 'ACTIVE');
          const tolerance = 0.5; // ₹0.50 tolerance for MCX rates
          let legReopened = false;

          for (const pair of activePairs) {
            const buyOpen = pair.buyPosition && pair.buyPosition.status === 'OPEN';
            const sellOpen = pair.sellPosition && pair.sellPosition.status === 'OPEN';

            if (buyOpen && sellOpen) continue;

            if (buyOpen && !sellOpen) {
              if (Math.abs(priceStepINR - pair.buyPosition.entryPriceINR) <= tolerance) {
                this.reopenMcxLeg(pair, 'SELL', priceStepINR, timestamp, targetMoveINR, mcxInstrument, contractQuantity, decimals);
                legReopened = true;
                break;
              }
            }

            if (sellOpen && !buyOpen) {
              if (Math.abs(priceStepINR - pair.sellPosition.entryPriceINR) <= tolerance) {
                this.reopenMcxLeg(pair, 'BUY', priceStepINR, timestamp, targetMoveINR, mcxInstrument, contractQuantity, decimals);
                legReopened = true;
                break;
              }
            }
          }

          if (legReopened) {
            lastProcessedRateINR = priceStepINR;
            continue;
          }

          // 3. NEW PAIR CREATION ON NEW MCX RATE (INR)
          const existingPairAtRate = activePairs.find(p => {
            const bOpen = p.buyPosition && p.buyPosition.status === 'OPEN';
            const sOpen = p.sellPosition && p.sellPosition.status === 'OPEN';
            return bOpen && sOpen && (p.buyPosition.entryPriceINR === priceStepINR || p.sellPosition.entryPriceINR === priceStepINR);
          });
          if (existingPairAtRate) continue;

          if (lastProcessedRateINR === priceStepINR && activePairs.length > 0) continue;
          if (processedRates.has(priceStepINR)) continue;
          if (activePairs.length >= maxActivePairs) continue;

          // Create New MCX Pair in INR!
          const pairSeq = (pairs.length + 1).toString().padStart(4, '0');
          const pairId = `MCX-PAIR-${pairSeq}`;
          const buyTargetINR = targetMoveINR ? this.normalizePrice(priceStepINR + targetMoveINR, decimals) : null;
          const sellTargetINR = targetMoveINR ? this.normalizePrice(priceStepINR - targetMoveINR, decimals) : null;

          const buyPosition = {
            positionId: `MCX-${pairSeq}-BUY`,
            pairId,
            direction: 'BUY',
            symbol: mcxInstrument,
            entryTime: new Date(timestamp).toISOString(),
            entryTimestamp: timestamp,
            entryPriceINR: priceStepINR,
            quantity: contractQuantity,
            targetExitPriceINR: buyTargetINR,
            status: 'OPEN'
          };

          const sellPosition = {
            positionId: `MCX-${pairSeq}-SELL`,
            pairId,
            direction: 'SELL',
            symbol: mcxInstrument,
            entryTime: new Date(timestamp).toISOString(),
            entryTimestamp: timestamp,
            entryPriceINR: priceStepINR,
            quantity: contractQuantity,
            targetExitPriceINR: sellTargetINR,
            status: 'OPEN'
          };

          pairs.push({
            pairId,
            symbol: mcxInstrument,
            createdTime: new Date(timestamp).toISOString(),
            entryRateINR: priceStepINR,
            status: 'ACTIVE',
            buyPosition,
            sellPosition
          });

          processedRates.add(priceStepINR);
          lastProcessedRateINR = priceStepINR;
        }
      }

      // Record Day-End Report
      const dayEndData = this.calculateMcxDayEndSnapshot(dStr, startingCapitalINR, pairs, closedPositions, currentPriceINR, contractQuantity, mcxFeeRate, gstRate);
      dailyReports.push(dayEndData);
    }

    if (dailyReports.length === 0) {
      return {
        success: false,
        message: `No historical MCX kline data available for ${instConfig.name} for the selected dates (${targetDates.join(', ')}).`,
        runId,
        config
      };
    }

    const finalSummary = this.calculateMcxFinalSummary(startingCapitalINR, pairs, closedPositions, dailyReports);
    const remainingOpenPositions = this.getMcxRemainingOpenList(pairs, currentPriceINR, contractQuantity, mcxFeeRate, gstRate);

    return {
      success: true,
      runId,
      mode,
      mcxInstrument,
      instrumentName: instConfig.name,
      unitLabel: instConfig.unitLabel,
      dateStr: mode === 'SINGLE' ? targetDates[0] : `${fromDateStr} to ${toDateStr}`,
      dateStrFormatted: mode === 'SINGLE' ? this.formatDateDDMMMYYYY(targetDates[0]) : `${this.formatDateDDMMMYYYY(fromDateStr)} to ${this.formatDateDDMMMYYYY(toDateStr)}`,
      targetDates,
      missingDates,
      config,
      summary: finalSummary,
      dailyReports,
      trades: closedPositions,
      remainingOpenPositions
    };
  }

  calculateMcxDayEndSnapshot(dateStr, startingCapitalINR, pairs, closedPositions, dayEndPriceINR, qty, mcxFeeRate, gstRate) {
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
    let floatingGrossINR = 0;
    let floatingChargesINR = 0;
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

        let posGrossINR = 0;
        if (dayEndPriceINR) {
          if (pos.direction === 'BUY') posGrossINR = (dayEndPriceINR - pos.entryPriceINR) * qty;
          else posGrossINR = (pos.entryPriceINR - dayEndPriceINR) * qty;
        }

        const entryValINR = pos.entryPriceINR * qty;
        const estExitValINR = (dayEndPriceINR || pos.entryPriceINR) * qty;
        const entryFeeINR = entryValINR * mcxFeeRate;
        const estExitFeeINR = estExitValINR * mcxFeeRate;
        const estGstINR = (entryFeeINR + estExitFeeINR) * gstRate;
        const posChargesINR = entryFeeINR + estExitFeeINR + estGstINR;
        const posNetINR = posGrossINR - posChargesINR;

        floatingGrossINR += posGrossINR;
        floatingChargesINR += posChargesINR;
        floatingNetINR += posNetINR;
      }
    }

    const realizedBalanceINR = startingCapitalINR + cumulativeRealizedNetINR;
    const endOfDayEquityINR = realizedBalanceINR + floatingNetINR;

    return {
      dateStr,
      dateStrFormatted: this.formatDateDDMMMYYYY(dateStr),
      dayEndPriceINR,
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
      floatingGrossINR: Number(floatingGrossINR.toFixed(2)),
      floatingChargesINR: Number(floatingChargesINR.toFixed(2)),
      floatingNetINR: Number(floatingNetINR.toFixed(2)),
      openBuyCount,
      openSellCount,
      totalOpenPositionsCount: openBuyCount + openSellCount,
      activePairsCount,
      completePairsCount,
      incompletePairsCount
    };
  }

  calculateMcxFinalSummary(startingCapitalINR, pairs, closedPositions, dailyReports) {
    let realizedGrossINR = 0;
    let realizedChargesINR = 0;
    let realizedNetINR = 0;
    let wins = 0, losses = 0;

    for (const cp of closedPositions) {
      realizedGrossINR += cp.grossProfitINR;
      realizedChargesINR += cp.totalChargesINR;
      realizedNetINR += cp.netProfitINR;
      if (cp.netProfitINR >= 0) wins++;
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
      totalRealizedGrossINR: Number(realizedGrossINR.toFixed(2)),
      totalChargesINR: Number(realizedChargesINR.toFixed(2)),
      totalRealizedNetINR: Number(realizedNetINR.toFixed(2)),
      
      remainingOpenPositionsCount: lastDayReport ? lastDayReport.totalOpenPositionsCount : 0,
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

  getMcxRemainingOpenList(pairs, currentPriceINR, qty, mcxFeeRate, gstRate) {
    const list = [];
    const now = Date.now();

    for (const pair of pairs) {
      if (pair.status === 'CLOSED') continue;

      const positions = [pair.buyPosition, pair.sellPosition];
      for (const pos of positions) {
        if (pos.status !== 'OPEN') continue;

        let floatingGrossINR = 0;
        if (currentPriceINR) {
          if (pos.direction === 'BUY') floatingGrossINR = (currentPriceINR - pos.entryPriceINR) * qty;
          else floatingGrossINR = (pos.entryPriceINR - currentPriceINR) * qty;
        }

        const entryValINR = pos.entryPriceINR * qty;
        const estExitValINR = (currentPriceINR || pos.entryPriceINR) * qty;
        const entryFeeINR = entryValINR * mcxFeeRate;
        const estExitFeeINR = estExitValINR * mcxFeeRate;
        const estGstINR = (entryFeeINR + estExitFeeINR) * gstRate;
        const chargesINR = entryFeeINR + estExitFeeINR + estGstINR;
        const netINR = floatingGrossINR - chargesINR;

        const durationMs = now - pos.entryTimestamp;
        const durationHours = (durationMs / (1000 * 3600)).toFixed(1);

        list.push({
          pairId: pair.pairId,
          positionId: pos.positionId,
          direction: pos.direction,
          symbol: pos.symbol,
          entryTime: pos.entryTime,
          entryPriceINR: pos.entryPriceINR,
          dayEndMarketPriceINR: currentPriceINR || pos.entryPriceINR,
          targetExitPriceINR: pos.targetExitPriceINR,
          floatingGrossINR: Number(floatingGrossINR.toFixed(2)),
          estimatedChargesINR: Number(chargesINR.toFixed(2)),
          floatingNetINR: Number(netINR.toFixed(2)),
          holdingDurationHours: `${durationHours}h`,
          status: 'OPEN AT SIMULATION END'
        });
      }
    }
    return list;
  }
}

module.exports = new McxHistoricalBacktester();
