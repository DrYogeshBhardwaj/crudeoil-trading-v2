const http = require('https');

/**
 * BTC Study Engine — Independent Historical Backtester, Live Rate Replay & Wallet Simulator
 * 
 * SAFETY ASSURANCE:
 * - 100% isolated from SOL engine, database, and live order execution.
 * - ZERO real order / exchange dispatch API calls.
 * - Pure simulation and mathematical accounting ledger.
 */
class BTCStudyEngine {
  constructor() {
    this.defaultUsdInrRate = 102.00; // Mudrex standard fixed futures rate
    this.defaultFundingRatePer8h = 0.0001; // 0.01% standard 8-hour perpetual funding rate
    this.defaultMudrexTakerFee = 0.00075; // 0.075%
    this.defaultMudrexMakerFee = 0.0002;  // 0.02%
    this.defaultGstRate = 0.18;           // 18% GST on trading fees
    this.defaultSlippageINR = 5.0;        // ₹5 per trade slippage buffer
  }

  /**
   * Fetch historical klines for BTCUSDT from Binance Futures with Spot fallback.
   * Supports date range, hour range, and candle interval.
   */
  async fetchHistoricalKlines({
    symbol = 'BTCUSDT',
    fromDate,
    toDate,
    fromHour = 0,
    toHour = 23,
    interval = '1m'
  }) {
    if (!fromDate || !toDate) {
      throw new Error('fromDate and toDate (YYYY-MM-DD) are required.');
    }

    const startHourNum = Math.max(0, Math.min(23, parseInt(fromHour, 10) || 0));
    const endHourNum = Math.max(0, Math.min(23, parseInt(toHour, 10) || 23));

    const startTime = new Date(`${fromDate}T${String(startHourNum).padStart(2, '0')}:00:00Z`).getTime();
    const endTime = new Date(`${toDate}T${String(endHourNum).padStart(2, '0')}:59:59.999Z`).getTime();

    if (isNaN(startTime) || isNaN(endTime)) {
      throw new Error('Invalid date/hour format. Use YYYY-MM-DD for dates and 0-23 for hours.');
    }

    if (startTime >= endTime) {
      throw new Error('Start time must be strictly before end time.');
    }

    const now = Date.now();
    if (startTime > now) {
      return {
        success: false,
        error: `Selected date range (${fromDate}) is in the future. Historical data does not exist for future timestamps.`,
        klines: [],
        stats: null
      };
    }

    try {
      const klines = await this._fetchPaginatedKlines(symbol, interval, startTime, endTime);

      if (!klines || klines.length === 0) {
        return {
          success: false,
          error: `No historical BTC candle data found for ${fromDate} (${startHourNum}:00) to ${toDate} (${endHourNum}:59).`,
          klines: [],
          stats: null
        };
      }

      // Compute statistics for the selected historical window
      const startingRate = klines[0].open;
      const endingRate = klines[klines.length - 1].close;
      let highRate = -Infinity;
      let lowRate = Infinity;
      let totalVolume = 0;

      for (const k of klines) {
        if (k.high > highRate) highRate = k.high;
        if (k.low < lowRate) lowRate = k.low;
        totalVolume += k.volume;
      }

      const priceDiff = Number((endingRate - startingRate).toFixed(2));
      const priceDiffPercent = Number(((priceDiff / startingRate) * 100).toFixed(2));

      return {
        success: true,
        symbol,
        interval,
        fromDate,
        toDate,
        fromHour: startHourNum,
        toHour: endHourNum,
        candleCount: klines.length,
        stats: {
          startingRate: Number(startingRate.toFixed(2)),
          endingRate: Number(endingRate.toFixed(2)),
          highRate: Number(highRate.toFixed(2)),
          lowRate: Number(lowRate.toFixed(2)),
          priceDiff,
          priceDiffPercent,
          totalVolume: Number(totalVolume.toFixed(4)),
          firstCandleTime: new Date(klines[0].openTime).toISOString(),
          lastCandleTime: new Date(klines[klines.length - 1].closeTime).toISOString()
        },
        klines
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to fetch historical market data: ${err.message}`,
        klines: [],
        stats: null
      };
    }
  }

  async _fetchPaginatedKlines(symbol, interval, startTime, endTime) {
    const allKlines = [];
    let currentStart = startTime;
    const maxCandlesTotal = 4000; // Cap to keep simulation responsive

    while (currentStart < endTime && allKlines.length < maxCandlesTotal) {
      const batchLimit = Math.min(1000, maxCandlesTotal - allKlines.length);
      const batch = await this._fetchKlinesBatch(symbol, interval, currentStart, endTime, batchLimit);
      
      if (!batch || batch.length === 0) {
        break;
      }

      allKlines.push(...batch);
      const lastCandle = batch[batch.length - 1];
      if (lastCandle.closeTime >= endTime || batch.length < batchLimit) {
        break;
      }
      currentStart = lastCandle.closeTime + 1;
    }

    return allKlines;
  }

  _fetchKlinesBatch(symbol, interval, startTime, endTime, limit = 1000) {
    return new Promise((resolve) => {
      const futuresUrl = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=${limit}`;
      
      this._httpGetJson(futuresUrl)
        .then((data) => {
          if (Array.isArray(data) && data.length > 0) {
            resolve(this._parseBinanceKlines(data));
          } else {
            // Fallback to Binance Spot API
            const spotUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=${limit}`;
            this._httpGetJson(spotUrl)
              .then((spotData) => {
                if (Array.isArray(spotData)) {
                  resolve(this._parseBinanceKlines(spotData));
                } else {
                  resolve([]);
                }
              })
              .catch(() => resolve([]));
          }
        })
        .catch(() => {
          // Fallback to Binance Spot API on network error
          const spotUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=${limit}`;
          this._httpGetJson(spotUrl)
            .then((spotData) => {
              if (Array.isArray(spotData)) {
                resolve(this._parseBinanceKlines(spotData));
              } else {
                resolve([]);
              }
            })
            .catch(() => resolve([]));
        });
    });
  }

  _parseBinanceKlines(data) {
    return data.map(k => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6]
    }));
  }

  _httpGetJson(url) {
    return new Promise((resolve, reject) => {
      http.get(url, { timeout: 8000 }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error('Invalid JSON response'));
          }
        });
      }).on('error', reject).on('timeout', () => reject(new Error('HTTP request timed out')));
    });
  }

  /**
   * Run strategy backtest simulation on candle series.
   * Computes ledger, wallet metrics, equity curve, charges and max drawdown.
   */
  runSimulation(config, klines) {
    if (!klines || klines.length === 0) {
      throw new Error('No candle data available to simulate.');
    }

    const {
      startingCapitalINR = 100000,
      usdInrRate = this.defaultUsdInrRate,
      leverage = 10,
      startingBtcQuantity = 0.001,
      numberOfPairs = 3,
      pairEntryDifference = 250,
      referenceRate = null,
      exitProfitTarget = 150, // USD per pair or total target
      exitTargetType = 'PER_PAIR', // 'PER_PAIR' or 'TOTAL_PORTFOLIO'
      harvestMode = 'TARGET_HIT', // 'TARGET_HIT' or 'HARVEST_ALL'
      lossLimit = 500, // per pair or total portfolio
      lossLimitType = 'PER_PAIR', // 'PER_PAIR' or 'PORTFOLIO'
      direction = 'BOTH', // 'BOTH', 'BUY', 'SELL'
      useMudrexFeeSchedule = true,
      customTakerFeeRate = 0.00075,
      customMakerFeeRate = 0.0002,
      customGstRate = 0.18,
      customSlippageINR = 5.0,
      customFundingRatePer8h = 0.0001
    } = config;

    const takerFeeRate = useMudrexFeeSchedule ? this.defaultMudrexTakerFee : Number(customTakerFeeRate || 0.00075);
    const makerFeeRate = useMudrexFeeSchedule ? this.defaultMudrexMakerFee : Number(customMakerFeeRate || 0.0002);
    const gstRate = useMudrexFeeSchedule ? this.defaultGstRate : Number(customGstRate || 0.18);
    const slippageBufferINR = useMudrexFeeSchedule ? this.defaultSlippageINR : Number(customSlippageINR || 0);
    const fundingRatePer8h = useMudrexFeeSchedule ? this.defaultFundingRatePer8h : Number(customFundingRatePer8h || 0.0001);

    const safeLeverage = Math.max(1, Math.min(100, Number(leverage) || 10));
    const safeQuantity = Math.max(0.0001, Number(startingBtcQuantity) || 0.001);
    const safePairsCap = Math.max(1, Math.min(50, parseInt(numberOfPairs, 10) || 3));
    const safePairDiff = Math.max(1, Number(pairEntryDifference) || 250);
    const safeTarget = Math.max(1, Number(exitProfitTarget) || 150);
    const safeLossLimit = Math.max(0, Number(lossLimit) || 0);

    const activePairs = [];
    const closedTrades = [];
    const equityCurve = [];
    const replaySteps = [];
    const marginRejections = [];

    let pairCounter = 0;
    let initialReferencePrice = referenceRate && referenceRate > 0 ? Number(referenceRate) : klines[0].open;
    let peakEquityINR = Number(startingCapitalINR);
    let maxDrawdownINR = 0;
    let maxDrawdownPct = 0;
    let portfolioHarvested = false;

    // Helper: calculate liquidation price for a position
    const calculateLiquidationPrice = (entryPrice, posDirection, posLeverage) => {
      const maintenanceMarginRate = 0.005; // 0.5% standard maintenance margin for BTC
      if (posDirection === 'BUY') {
        return entryPrice * (1 - (1 / posLeverage) + maintenanceMarginRate);
      } else {
        return entryPrice * (1 + (1 / posLeverage) - maintenanceMarginRate);
      }
    };

    // Helper: compute required margin in INR
    const calculateMarginRequiredINR = (qty, price, lev) => {
      const marginUSD = (qty * price) / lev;
      return marginUSD * usdInrRate;
    };

    // Helper: compute wallet accounting state at any point
    const getWalletState = (currentPrice) => {
      let usedMarginINR = 0;
      let openUnrealizedPnLUSD = 0;
      let estExitFeesUSD = 0;

      for (const pair of activePairs) {
        for (const pos of pair.positions) {
          if (pos.status === 'OPEN') {
            usedMarginINR += pos.marginINR;
            let posUnrealizedUSD = 0;
            if (pos.direction === 'BUY') {
              posUnrealizedUSD = pos.quantity * (currentPrice - pos.entryPrice);
            } else {
              posUnrealizedUSD = pos.quantity * (pos.entryPrice - currentPrice);
            }
            openUnrealizedPnLUSD += posUnrealizedUSD;

            // Estimated exit charges: taker fee + gst + slippage
            const exitFeeUSD = pos.quantity * currentPrice * takerFeeRate;
            const exitGstUSD = exitFeeUSD * gstRate;
            const slippageUSD = slippageBufferINR / usdInrRate;
            estExitFeesUSD += (exitFeeUSD + exitGstUSD + slippageUSD);
          }
        }
      }

      let realizedGrossPnLUSD = 0;
      let realizedTradingFeesUSD = 0;
      let realizedFundingUSD = 0;
      let realizedSlippageUSD = 0;
      let realizedTotalChargesUSD = 0;

      for (const t of closedTrades) {
        realizedGrossPnLUSD += t.grossPnLUSD;
        realizedTradingFeesUSD += (t.entryFeeUSD + t.exitFeeUSD + t.gstUSD);
        realizedFundingUSD += t.fundingUSD;
        realizedSlippageUSD += t.slippageUSD;
        realizedTotalChargesUSD += t.totalChargesUSD;
      }

      const realizedGrossPnLINR = realizedGrossPnLUSD * usdInrRate;
      const realizedTotalChargesINR = realizedTotalChargesUSD * usdInrRate;
      const netRealizedPnLUSD = realizedGrossPnLUSD - realizedTotalChargesUSD;
      const netRealizedPnLINR = netRealizedPnLUSD * usdInrRate;

      const openUnrealizedPnLINR = openUnrealizedPnLUSD * usdInrRate;
      const estExitFeesINR = estExitFeesUSD * usdInrRate;

      // Available margin = Starting Capital + Net Realized PnL - Used Margin
      const availableMarginINR = Math.max(0, Number(startingCapitalINR) + netRealizedPnLINR - usedMarginINR);

      // Estimated Equity = Starting Capital + Net Realized PnL + Unrealized PnL - Estimated Exit Charges
      const currentEstimatedWalletEquityINR = Number(startingCapitalINR) + netRealizedPnLINR + openUnrealizedPnLINR - estExitFeesINR;

      // Estimated Final Wallet Balance if all positions closed at currentPrice
      const estimatedFinalWalletBalanceINR = Number(startingCapitalINR) + netRealizedPnLINR + openUnrealizedPnLINR - estExitFeesINR;

      const totalPnLINR = currentEstimatedWalletEquityINR - Number(startingCapitalINR);
      const totalPnLPercent = startingCapitalINR > 0 ? (totalPnLINR / startingCapitalINR) * 100 : 0;

      return {
        startingCapitalINR: Number(startingCapitalINR),
        usedMarginINR: Number(usedMarginINR.toFixed(2)),
        availableMarginINR: Number(availableMarginINR.toFixed(2)),
        openUnrealizedPnLUSD: Number(openUnrealizedPnLUSD.toFixed(4)),
        openUnrealizedPnLINR: Number(openUnrealizedPnLINR.toFixed(2)),
        realizedGrossPnLUSD: Number(realizedGrossPnLUSD.toFixed(4)),
        realizedGrossPnLINR: Number(realizedGrossPnLINR.toFixed(2)),
        tradingFeesINR: Number((realizedTradingFeesUSD * usdInrRate).toFixed(2)),
        fundingChargesINR: Number((realizedFundingUSD * usdInrRate).toFixed(2)),
        slippageINR: Number((realizedSlippageUSD * usdInrRate).toFixed(2)),
        totalChargesINR: Number(realizedTotalChargesINR.toFixed(2)),
        netRealizedPnLUSD: Number(netRealizedPnLUSD.toFixed(4)),
        netRealizedPnLINR: Number(netRealizedPnLINR.toFixed(2)),
        currentEstimatedWalletEquityINR: Number(currentEstimatedWalletEquityINR.toFixed(2)),
        estimatedFinalWalletBalanceINR: Number(estimatedFinalWalletBalanceINR.toFixed(2)),
        totalPnLINR: Number(totalPnLINR.toFixed(2)),
        totalPnLPercent: Number(totalPnLPercent.toFixed(2))
      };
    };

    // Helper: close a position and update ledger
    const closePosition = (pair, pos, exitPrice, exitTime, reason) => {
      pos.status = 'CLOSED';
      pos.exitPrice = exitPrice;
      pos.exitTime = exitTime;
      pos.exitReason = reason;

      const holdingDurationSec = Math.max(0, Math.floor((exitTime - pos.entryTime) / 1000));
      const holdingHours = holdingDurationSec / 3600;

      let grossPnLUSD = 0;
      if (pos.direction === 'BUY') {
        grossPnLUSD = pos.quantity * (exitPrice - pos.entryPrice);
      } else {
        grossPnLUSD = pos.quantity * (pos.entryPrice - exitPrice);
      }

      const entryNotional = pos.quantity * pos.entryPrice;
      const exitNotional = pos.quantity * exitPrice;

      // Mudrex Exact Fee Schedule:
      // Entry fee = entryNotional * takerFeeRate
      // Exit fee = exitNotional * takerFeeRate (or maker if limit target)
      const isTargetExit = reason.includes('TARGET');
      const exitFeeRate = isTargetExit ? makerFeeRate : takerFeeRate;

      const entryFeeUSD = entryNotional * takerFeeRate;
      const exitFeeUSD = exitNotional * exitFeeRate;
      const gstUSD = (entryFeeUSD + exitFeeUSD) * gstRate;
      const slippageUSD = slippageBufferINR / usdInrRate;

      // Perpetual funding estimate (0.01% per 8h)
      // Long positions pay funding when positive, short positions receive funding
      const fundingCycleUnits = holdingHours / 8;
      let fundingUSD = 0;
      if (pos.direction === 'BUY') {
        fundingUSD = entryNotional * fundingRatePer8h * fundingCycleUnits;
      } else {
        fundingUSD = -(entryNotional * fundingRatePer8h * fundingCycleUnits);
      }

      const totalChargesUSD = entryFeeUSD + exitFeeUSD + gstUSD + slippageUSD + fundingUSD;
      const netPnLUSD = grossPnLUSD - totalChargesUSD;

      const tradeRecord = {
        tradeId: `TRD-${closedTrades.length + 1}`,
        pairId: pair.pairId,
        positionId: pos.id,
        direction: pos.direction,
        entryTime: new Date(pos.entryTime).toISOString(),
        exitTime: new Date(exitTime).toISOString(),
        entryPrice: Number(pos.entryPrice.toFixed(2)),
        exitPrice: Number(exitPrice.toFixed(2)),
        quantity: pos.quantity,
        leverage: safeLeverage,
        marginINR: Number(pos.marginINR.toFixed(2)),
        grossPnLUSD: Number(grossPnLUSD.toFixed(4)),
        grossPnLINR: Number((grossPnLUSD * usdInrRate).toFixed(2)),
        entryFeeUSD: Number(entryFeeUSD.toFixed(4)),
        exitFeeUSD: Number(exitFeeUSD.toFixed(4)),
        gstUSD: Number(gstUSD.toFixed(4)),
        slippageUSD: Number(slippageUSD.toFixed(4)),
        fundingUSD: Number(fundingUSD.toFixed(4)),
        fundingStatus: 'ESTIMATED (0.01% / 8H)',
        totalChargesUSD: Number(totalChargesUSD.toFixed(4)),
        totalChargesINR: Number((totalChargesUSD * usdInrRate).toFixed(2)),
        netPnLUSD: Number(netPnLUSD.toFixed(4)),
        netPnLINR: Number((netPnLUSD * usdInrRate).toFixed(2)),
        exitReason: reason,
        holdingDurationSec
      };

      closedTrades.push(tradeRecord);
      replaySteps.push({
        type: 'POSITION_CLOSED',
        timestamp: exitTime,
        trade: tradeRecord
      });
    };

    // Helper: create a new pair
    const createPair = (entryPrice, entryTime) => {
      const activeLegCount = direction === 'BOTH' ? 2 : 1;
      const perLegMarginINR = calculateMarginRequiredINR(safeQuantity, entryPrice, safeLeverage);
      const totalPairMarginINR = perLegMarginINR * activeLegCount;

      const currentWallet = getWalletState(entryPrice);
      if (currentWallet.availableMarginINR < totalPairMarginINR) {
        marginRejections.push({
          timestamp: entryTime,
          price: entryPrice,
          requiredMarginINR: totalPairMarginINR,
          availableMarginINR: currentWallet.availableMarginINR,
          reason: 'INSUFFICIENT_MARGIN'
        });
        return null;
      }

      pairCounter++;
      const pairId = `PAIR-BTC-${String(pairCounter).padStart(4, '0')}`;
      const positions = [];

      // Determine targets
      const buyTargetPrice = exitTargetType === 'PER_PAIR' ? (entryPrice + safeTarget) : null;
      const sellTargetPrice = exitTargetType === 'PER_PAIR' ? (entryPrice - safeTarget) : null;

      const buyStopLossPrice = (lossLimitType === 'PER_PAIR' && safeLossLimit > 0) ? (entryPrice - safeLossLimit) : null;
      const sellStopLossPrice = (lossLimitType === 'PER_PAIR' && safeLossLimit > 0) ? (entryPrice + safeLossLimit) : null;

      if (direction === 'BOTH' || direction === 'BUY') {
        positions.push({
          id: `${pairId}-BUY`,
          pairId,
          direction: 'BUY',
          entryPrice,
          entryTime,
          quantity: safeQuantity,
          marginUSD: (safeQuantity * entryPrice) / safeLeverage,
          marginINR: perLegMarginINR,
          targetPrice: buyTargetPrice,
          stopLossPrice: buyStopLossPrice,
          liquidationPrice: calculateLiquidationPrice(entryPrice, 'BUY', safeLeverage),
          status: 'OPEN'
        });
      }

      if (direction === 'BOTH' || direction === 'SELL') {
        positions.push({
          id: `${pairId}-SELL`,
          pairId,
          direction: 'SELL',
          entryPrice,
          entryTime,
          quantity: safeQuantity,
          marginUSD: (safeQuantity * entryPrice) / safeLeverage,
          marginINR: perLegMarginINR,
          targetPrice: sellTargetPrice,
          stopLossPrice: sellStopLossPrice,
          liquidationPrice: calculateLiquidationPrice(entryPrice, 'SELL', safeLeverage),
          status: 'OPEN'
        });
      }

      const pair = {
        pairId,
        entryPrice,
        entryTime,
        positions
      };

      activePairs.push(pair);
      replaySteps.push({
        type: 'PAIR_CREATED',
        timestamp: entryTime,
        pairId,
        entryPrice,
        positions: positions.map(p => ({
          id: p.id,
          direction: p.direction,
          targetPrice: p.targetPrice,
          stopLossPrice: p.stopLossPrice,
          liquidationPrice: p.liquidationPrice
        }))
      });

      return pair;
    };

    // Main Candle Iteration
    for (let cIdx = 0; cIdx < klines.length; cIdx++) {
      const candle = klines[cIdx];
      const candleTime = candle.openTime;

      // 1. Evaluate open positions against candle High and Low
      for (const pair of activePairs) {
        for (const pos of pair.positions) {
          if (pos.status !== 'OPEN') continue;

          if (pos.direction === 'BUY') {
            // Check Target Hit
            if (pos.targetPrice && candle.high >= pos.targetPrice) {
              closePosition(pair, pos, pos.targetPrice, candleTime, 'BUY TARGET PROFIT HIT (HARVESTED)');
            }
            // Check Stop Loss
            else if (pos.stopLossPrice && candle.low <= pos.stopLossPrice) {
              closePosition(pair, pos, pos.stopLossPrice, candleTime, 'BUY STOP LOSS HIT');
            }
            // Check Liquidation
            else if (candle.low <= pos.liquidationPrice) {
              closePosition(pair, pos, pos.liquidationPrice, candleTime, 'BUY LIQUIDATION BREACH');
            }
          } else if (pos.direction === 'SELL') {
            // Check Target Hit
            if (pos.targetPrice && candle.low <= pos.targetPrice) {
              closePosition(pair, pos, pos.targetPrice, candleTime, 'SELL TARGET PROFIT HIT (HARVESTED)');
            }
            // Check Stop Loss
            else if (pos.stopLossPrice && candle.high >= pos.stopLossPrice) {
              closePosition(pair, pos, pos.stopLossPrice, candleTime, 'SELL STOP LOSS HIT');
            }
            // Check Liquidation
            else if (candle.high >= pos.liquidationPrice) {
              closePosition(pair, pos, pos.liquidationPrice, candleTime, 'SELL LIQUIDATION BREACH');
            }
          }
        }
      }

      // Clean up fully closed pairs from activePairs
      for (let i = activePairs.length - 1; i >= 0; i--) {
        const p = activePairs[i];
        const allClosed = p.positions.every(pos => pos.status === 'CLOSED');
        if (allClosed) {
          activePairs.splice(i, 1);
        }
      }

      // 2. Check Harvest All or Total Target Trigger
      if ((harvestMode === 'HARVEST_ALL' || exitTargetType === 'TOTAL_PORTFOLIO') && !portfolioHarvested) {
        const walletNow = getWalletState(candle.close);
        if (walletNow.totalPnLINR >= safeTarget) {
          portfolioHarvested = true;
          // Harvest all open positions at candle.close
          for (const pair of [...activePairs]) {
            for (const pos of pair.positions) {
              if (pos.status === 'OPEN') {
                closePosition(pair, pos, candle.close, candleTime, 'HARVEST ALL TARGET HIT');
              }
            }
          }
          activePairs.length = 0;
        }
      }

      // Check Portfolio Loss Limit
      if (lossLimitType === 'PORTFOLIO' && safeLossLimit > 0 && !portfolioHarvested) {
        const walletNow = getWalletState(candle.close);
        if (walletNow.totalPnLINR <= -safeLossLimit) {
          portfolioHarvested = true;
          for (const pair of [...activePairs]) {
            for (const pos of pair.positions) {
              if (pos.status === 'OPEN') {
                closePosition(pair, pos, candle.close, candleTime, 'PORTFOLIO LOSS LIMIT BREACH');
              }
            }
          }
          activePairs.length = 0;
          break; // Halt simulation on portfolio stop loss
        }
      }

      // 3. Grid Pair Creation Logic
      if (!portfolioHarvested && activePairs.length < safePairsCap) {
        if (activePairs.length === 0) {
          // Initial entry
          createPair(candle.open, candleTime);
        } else {
          // Check if distance from all existing active pair entries is >= pairEntryDifference
          let canCreate = true;
          for (const existingPair of activePairs) {
            const distance = Math.abs(candle.open - existingPair.entryPrice);
            if (distance < safePairDiff) {
              canCreate = false;
              break;
            }
          }
          if (canCreate) {
            createPair(candle.open, candleTime);
          }
        }
      }

      // 4. Record Equity Curve sample (sampled every 5 candles or on trade)
      if (cIdx % 5 === 0 || cIdx === klines.length - 1) {
        const stateNow = getWalletState(candle.close);
        if (stateNow.currentEstimatedWalletEquityINR > peakEquityINR) {
          peakEquityINR = stateNow.currentEstimatedWalletEquityINR;
        }
        const drawdownINR = Math.max(0, peakEquityINR - stateNow.currentEstimatedWalletEquityINR);
        const drawdownPct = peakEquityINR > 0 ? (drawdownINR / peakEquityINR) * 100 : 0;
        if (drawdownINR > maxDrawdownINR) maxDrawdownINR = drawdownINR;
        if (drawdownPct > maxDrawdownPct) maxDrawdownPct = drawdownPct;

        equityCurve.push({
          timestamp: candleTime,
          timeStr: new Date(candleTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          price: candle.close,
          equityINR: stateNow.currentEstimatedWalletEquityINR,
          netRealizedINR: stateNow.netRealizedPnLINR,
          unrealizedINR: stateNow.openUnrealizedPnLINR,
          drawdownPct: Number(drawdownPct.toFixed(2))
        });
      }
    }

    // Final Wallet and Ledger Calculation
    const lastPrice = klines[klines.length - 1].close;
    const finalWallet = getWalletState(lastPrice);

    // Trade summary stats
    const totalTrades = closedTrades.length;
    const winningTrades = closedTrades.filter(t => t.netPnLINR > 0).length;
    const losingTrades = closedTrades.filter(t => t.netPnLINR < 0).length;
    const breakEvenTrades = totalTrades - winningTrades - losingTrades;
    const winRatePercent = totalTrades > 0 ? Number(((winningTrades / totalTrades) * 100).toFixed(2)) : 0;

    // Remaining open positions list
    const openPositionsList = [];
    for (const pair of activePairs) {
      for (const pos of pair.positions) {
        if (pos.status === 'OPEN') {
          let unrealizedUSD = 0;
          if (pos.direction === 'BUY') {
            unrealizedUSD = pos.quantity * (lastPrice - pos.entryPrice);
          } else {
            unrealizedUSD = pos.quantity * (pos.entryPrice - lastPrice);
          }
          openPositionsList.push({
            pairId: pair.pairId,
            positionId: pos.id,
            direction: pos.direction,
            entryPrice: Number(pos.entryPrice.toFixed(2)),
            currentPrice: Number(lastPrice.toFixed(2)),
            quantity: pos.quantity,
            marginINR: Number(pos.marginINR.toFixed(2)),
            targetPrice: Number(pos.targetPrice.toFixed(2)),
            stopLossPrice: pos.stopLossPrice ? Number(pos.stopLossPrice.toFixed(2)) : null,
            liquidationPrice: Number(pos.liquidationPrice.toFixed(2)),
            unrealizedPnLUSD: Number(unrealizedUSD.toFixed(4)),
            unrealizedPnLINR: Number((unrealizedUSD * usdInrRate).toFixed(2))
          });
        }
      }
    }

    return {
      success: true,
      simulationMode: 'HISTORICAL_BACKTEST',
      config: {
        startingCapitalINR,
        usdInrRate,
        leverage: safeLeverage,
        startingBtcQuantity: safeQuantity,
        numberOfPairs: safePairsCap,
        pairEntryDifference: safePairDiff,
        exitProfitTarget: safeTarget,
        exitTargetType,
        harvestMode,
        lossLimit: safeLossLimit,
        lossLimitType,
        direction,
        feeSchedule: useMudrexFeeSchedule ? 'MUDREX_PERPETUAL' : 'CUSTOM',
        takerFeeRate,
        makerFeeRate,
        gstRate,
        slippageBufferINR,
        fundingRatePer8h
      },
      summary: {
        ...finalWallet,
        maxDrawdownINR: Number(maxDrawdownINR.toFixed(2)),
        maxDrawdownPercent: Number(maxDrawdownPct.toFixed(2)),
        totalTrades,
        winningTrades,
        losingTrades,
        breakEvenTrades,
        winRatePercent,
        activeOpenPositionsCount: openPositionsList.length,
        marginRejectionsCount: marginRejections.length
      },
      openPositions: openPositionsList,
      tradeLedger: closedTrades,
      equityCurve,
      replaySteps,
      marginRejections
    };
  }

  /**
   * Multi-configuration comparison utility.
   * Runs the exact same historical klines against multiple strategy parameter sets.
   */
  compareConfigurations(baseConfig, variations, klines) {
    if (!klines || klines.length === 0) {
      throw new Error('No historical candles available for comparison.');
    }

    const results = [];
    for (let i = 0; i < variations.length; i++) {
      const mergedConfig = { ...baseConfig, ...variations[i] };
      const sim = this.runSimulation(mergedConfig, klines);
      results.push({
        configId: `CONFIG-${i + 1}`,
        label: variations[i].label || `Config #${i + 1}`,
        leverage: mergedConfig.leverage,
        startingCapitalINR: mergedConfig.startingCapitalINR,
        numberOfPairs: mergedConfig.numberOfPairs,
        pairEntryDifference: mergedConfig.pairEntryDifference,
        exitProfitTarget: mergedConfig.exitProfitTarget,
        direction: mergedConfig.direction,
        finalWalletINR: sim.summary.estimatedFinalWalletBalanceINR,
        netRealizedPnLINR: sim.summary.netRealizedPnLINR,
        totalPnLINR: sim.summary.totalPnLINR,
        totalPnLPercent: sim.summary.totalPnLPercent,
        totalChargesINR: sim.summary.totalChargesINR,
        maxDrawdownPercent: sim.summary.maxDrawdownPercent,
        totalTrades: sim.summary.totalTrades,
        winRatePercent: sim.summary.winRatePercent
      });
    }

    return results;
  }
}

module.exports = new BTCStudyEngine();
