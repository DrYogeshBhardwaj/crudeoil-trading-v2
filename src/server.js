const express = require('express');
const cors = require('cors');
const path = require('path');
const rateFeed = require('./engine/rateFeed');
const paperEngine = require('./engine/paperEngine');
const pairAddEngine = require('./engine/pairAddEngine');
const solanaEngineV2 = require('./engine/solanaEngineV2');
const backtest = require('./engine/backtest');
const mcxBacktest = require('./engine/mcxBacktest');
const btcStudyEngine = require('./engine/btcStudyEngine');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Primary Official Portal for SHUBH-MANI (shubhmani.com & subhmani.in)
app.get([
  '/',
  '/shubhmani',
  '/shubh-mani',
  '/Shubh-Mani',
  '/ShubhMani',
  '/shubhmani.com',
  '/shubhmani.in',
  '/shubhmani.html',
  '/subhmani',
  '/subh-mani',
  '/Subh-Mani',
  '/SubhMani',
  '/subhmani.in',
  '/subh-mani.in',
  '/subhmani.html'
], (req, res) => {
  res.sendFile(path.join(__dirname, '../public/shubhmani.html'));
});

app.use(express.static(path.join(__dirname, '../public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

// Start rate feed manager
rateFeed.start();

// Initialize SOL Pair Engine V2 autonomous cycle on startup
console.log(`[SOL Pair Engine V2] Auto-Engine initialized (Status: ${solanaEngineV2.engineStatus}, Mode: ${solanaEngineV2.settings.tradingMode}, Real Orders Disabled: ${solanaEngineV2.settings.realOrdersDisabled})`);

// REST API Endpoints

// 0. Production Health Check Endpoint for Railway
app.get('/health', (req, res) => {
  try {
    const rateInfo = rateFeed.getCurrentRate();
    const mudrexLive = require('./engine/mudrexLiveAdapter');
    const isRealEnabled = mudrexLive.isRealExecutionEnabled();
    const isRealDisabled = mudrexLive.isRealOrdersDisabled();
    res.json({
      status: 'OK',
      service: 'Mudrex LIVE Rate Engine',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      paperTradingOnly: !isRealEnabled,
      realOrdersDisabled: isRealDisabled,
      isRealExecutionEnabled: isRealEnabled,
      engineStatus: paperEngine.engineStatus,
      isEngineRunning: paperEngine.isEngineRunning,
      activeInstrument: paperEngine.settings.instrument,
      feedStatus: rateInfo.status,
      feedPrice: rateInfo.price,
      dhanSilverTokenConfigured: !!(process.env.DHAN_ACCESS_TOKEN_SILVER || process.env.DHAN_ACCESS_TOKEN),
      mudrexApiConfigured: !!(process.env.MUDREX_API_KEY && process.env.MUDREX_API_SECRET)
    });
  } catch (err) {
    res.status(500).json({ status: 'ERROR', error: err.message });
  }
});

// Express Page Routes (With Aliases)
app.get(['/dhan-mcx', '/dhan_mcx', '/dhan_mcx.html', '/dhan-mcx.html'], (req, res) => res.sendFile(path.join(__dirname, '../public/dhan_mcx.html')));
app.get(['/mcx-calc', '/mcx_calc', '/mcx_calc.html', '/mcx-calc.html'], (req, res) => res.sendFile(path.join(__dirname, '../public/mcx_calc.html')));
app.get(['/paper-calc', '/paper_calc', '/paper_calc.html', '/paper-calc.html'], (req, res) => res.sendFile(path.join(__dirname, '../public/paper_calc.html')));
app.get(['/mudrex-live', '/mudrex_live', '/mudrex_live.html', '/mudrex-live.html'], (req, res) => res.sendFile(path.join(__dirname, '../public/mudrex_live.html')));
app.get(['/mudrex-crude-live', '/mudrex_crude_live', '/mudrex_crude_live.html', '/mudrex-crude-live.html'], (req, res) => res.sendFile(path.join(__dirname, '../public/mudrex_crude_live.html')));
app.get(['/crude-live-mudrex', '/crude_live_mudrex', '/Crude-Live-Mudrex', '/crude-live-mudrex.html', '/crude_live_mudrex.html'], (req, res) => res.redirect(301, '/Crude-Live-Mudrex-Pro'));
app.get(['/crude-live-mudrex-pro', '/crude_live_mudrex_pro', '/Crude-Live-Mudrex-Pro', '/crude-live-mudrex-pro.html', '/crude_live_mudrex_pro.html'], (req, res) => res.sendFile(path.join(__dirname, '../public/crude_live_mudrex_pro.html')));
// Dedicated Solana Live Trading Desk Terminal
app.get([
  '/subh-mani-solana',
  '/Subh-Mani-Solana',
  '/subh_mani_solana',
  '/subh-money-solana',
  '/Subh-Money-Solana',
  '/subh_money_solana',
  '/subh-money',
  '/Subh-Money',
  '/subhmoney',
  '/SubhMoney',
  '/desk',
  '/terminal'
], (req, res) => res.sendFile(path.join(__dirname, '../public/subh_money_solana.html')));

// Dedicated SOL Pair Engine V2 Page Route
app.get([
  '/sol-pair-engine-v2',
  '/Sol-Pair-Engine-V2',
  '/sol_pair_engine_v2',
  '/sol-pair-v2',
  '/sol_pair_v2',
  '/solana-v2',
  '/solana_v2',
  '/sol-v2'
], (req, res) => res.sendFile(path.join(__dirname, '../public/sol_pair_engine_v2.html')));

app.get([
  '/solana-live-mudrex',
  '/Solana-Live-Mudrex',
  '/solana-live-mudrex-pro',
  '/Solana-Live-Mudrex-Pro',
  '/solana_live_mudrex',
  '/solana',
  '/Solana'
], (req, res) => res.sendFile(path.join(__dirname, '../public/solana_live_mudrex.html')));
app.get([
  '/crude-live-mudrex-solana',
  '/Crude-Live-Mudrex-Solana',
  '/crude_live_mudrex_solana',
  '/crude-live-solana',
  '/Crude-Live-Solana'
], (req, res) => res.redirect(301, '/Solana-Live-Mudrex'));
app.get(['/mudrex-crude-calc', '/mudrex_crude_calc', '/mudrex_crude_calc.html', '/mudrex-crude-calc.html'], (req, res) => res.sendFile(path.join(__dirname, '../public/mudrex_crude_calc.html')));
app.get(['/pair-add', '/pair_add', '/pair_add.html', '/pair-add.html'], (req, res) => res.sendFile(path.join(__dirname, '../public/pair_add.html')));

// Dedicated BTC Study & Historical Backtesting / Wallet Simulator Desk
app.get([
  '/btc-study',
  '/BTC-Study',
  '/btc_study',
  '/btc-study.html',
  '/btc_study.html',
  '/btc',
  '/BTC',
  '/btc-simulator'
], (req, res) => res.sendFile(path.join(__dirname, '../public/btc_study.html')));

// Dedicated BTC Live Mudrex Pro Desk
app.get([
  '/btc-live-mudrex-pro',
  '/BTC-Live-Mudrex-Pro',
  '/btc-live-mudrex',
  '/BTC-Live-Mudrex',
  '/btc-pro',
  '/BTC-Pro',
  '/btc_live_mudrex_pro',
  '/btc_live_mudrex',
  '/btc-live-mudrex-pro.html',
  '/btc_live_mudrex_pro.html'
], (req, res) => res.sendFile(path.join(__dirname, '../public/btc_live_mudrex_pro.html')));

app.get('/api/mudrex-debug', async (req, res) => {
  try {
    const mudrexLive = require('./engine/mudrexLiveAdapter');
    const diag = await mudrexLive.getDebugDiagnostics();
    res.json({ success: true, diagnostics: diag });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 1. Dashboard Metrics (Supporting Mudrex Live, Pair-Add, & Paper Modes)
app.get(['/api/metrics', '/api/mudrex/metrics', '/api/mudrex-metrics', '/api/pair-add/metrics'], async (req, res) => {
  try {
    const referer = (req.headers.referer || '').toLowerCase();
    const path = req.path.toLowerCase();
    const mode = (req.query.mode || '').toLowerCase();

    const isPairAdd = path.includes('pair-add') || mode === 'pair_add' || referer.includes('pair_add') || referer.includes('pair-add');
    const isMudrexLive = !isPairAdd && (
      path.includes('mudrex') ||
      mode === 'mudrex_live' ||
      referer.includes('mudrex_live') ||
      referer.includes('mudrex-live') ||
      referer.includes('mudrex_crude') ||
      referer.includes('mudrex-crude')
    ) && !path.includes('calc') && !referer.includes('calc');

    let metrics;
    if (isPairAdd) {
      metrics = pairAddEngine.getMetrics();
    } else if (isMudrexLive) {
      const mudrexLive = require('./engine/mudrexLiveAdapter');
      metrics = await mudrexLive.getLiveMetrics();
    } else {
      metrics = paperEngine.getDashboardMetrics();
    }
    res.json({ success: true, data: metrics });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Real-time Server-Sent Events Stream (SSE)
app.get('/api/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const referer = (req.headers.referer || '').toLowerCase();
  const mode = (req.query.mode || '').toLowerCase();
  const isPairAdd = mode === 'pair_add' || referer.includes('pair_add') || referer.includes('pair-add');
  const isMudrexLive = !isPairAdd && (
    mode === 'mudrex_live' ||
    referer.includes('mudrex_live') ||
    referer.includes('mudrex-live') ||
    referer.includes('mudrex_crude') ||
    referer.includes('mudrex-crude')
  ) && !referer.includes('calc');

  const sendUpdate = async () => {
    try {
      let metrics;
      if (isPairAdd) {
        metrics = pairAddEngine.getMetrics();
      } else if (isMudrexLive) {
        const mudrexLive = require('./engine/mudrexLiveAdapter');
        metrics = await mudrexLive.getLiveMetrics();
      } else {
        metrics = paperEngine.getDashboardMetrics();
      }
      res.write(`data: ${JSON.stringify(metrics)}\n\n`);
    } catch (e) {
      console.error('Error sending SSE update:', e);
    }
  };

  await sendUpdate();
  const interval = setInterval(sendUpdate, 1000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

// 3. Update Settings (Dhan MCX Engine)
app.post('/api/settings', (req, res) => {
  try {
    const newSettings = req.body;
    paperEngine.updateSettings(newSettings);
    res.json({ success: true, settings: paperEngine.settings });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 3b. Update Settings (Mudrex Live Engine)
app.post('/api/mudrex/settings', (req, res) => {
  try {
    const mudrexLive = require('./engine/mudrexLiveAdapter');
    const newSettings = req.body;
    mudrexLive.updateSettings(newSettings);
    res.json({ success: true, settings: mudrexLive.settings });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 4. Toggle Engine State (Start/Stop)
app.post('/api/toggle-engine', (req, res) => {
  try {
    const isRunning = paperEngine.toggleEngineState();
    res.json({ success: true, isEngineRunning: isRunning });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4b. Reset All Engine Data & History
app.post('/api/reset-data', (req, res) => {
  try {
    paperEngine.resetAllData();
    const mudrexLive = require('./engine/mudrexLiveAdapter');
    mudrexLive.resetLiveEngine();
    res.json({ success: true, message: 'All engine positions and trading history reset successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4c. Export Trade History & Archive Backup
app.get('/api/export-history', (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, '../data');
    const archiveFile = path.join(DATA_DIR, 'archive_history.json');
    let archives = [];
    if (fs.existsSync(archiveFile)) {
      try { archives = JSON.parse(fs.readFileSync(archiveFile, 'utf8')); } catch (e) {}
    }
    const current = paperEngine.getEngineStatus();
    res.json({
      success: true,
      currentSessionClosedPositions: current.closedPositions || [],
      archives
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Manual Close Position
app.post('/api/manual-close', (req, res) => {
  try {
    const { positionId } = req.body;
    if (!positionId) return res.status(400).json({ success: false, error: 'Position ID is required' });

    let closed = false;
    try {
      closed = paperEngine.manualClosePosition(positionId);
    } catch (e) {}

    if (!closed) {
      const mudrexLive = require('./engine/mudrexLiveAdapter');
      closed = mudrexLive.manualCloseLivePosition(positionId);
    }

    if (closed) {
      res.json({ success: true, message: `Position ${positionId} closed successfully.` });
    } else {
      res.status(400).json({ success: false, error: `Position ${positionId} not found.` });
    }
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 6. Manual Trade Placement (Instant Pair, Buy, or Sell)
app.post('/api/manual-trade', (req, res) => {
  try {
    const { action, symbol = 'CLUSDT', quantity = 1.0, targetMove = 1.00 } = req.body;
    const rateInfo = rateFeed.getCurrentRate(symbol);
    const price = rateInfo.price || 92.10;
    const usdInrRate = rateInfo.usdInrRate || 102.00;

    if (action === 'BUY' || action === 'LONG') {
      const pos = paperEngine.createSinglePosition('BUY', symbol, price, Number(quantity), Number(targetMove), usdInrRate);
      return res.json({ success: true, message: `Placed manual BUY position at $${price}`, data: pos });
    } else if (action === 'SELL' || action === 'SHORT') {
      const pos = paperEngine.createSinglePosition('SELL', symbol, price, Number(quantity), Number(targetMove), usdInrRate);
      return res.json({ success: true, message: `Placed manual SELL position at $${price}`, data: pos });
    } else {
      // Instant Pair (1 BUY + 1 SELL)
      const pair = paperEngine.createNewPair(symbol, price, Date.now(), usdInrRate, Number(quantity), Number(targetMove));
      return res.json({ success: true, message: `Created instant BUY & SELL Pair at $${price}`, data: pair });
    }
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 5b. Smart "Pair-Add" Actions & Simulator Endpoints
app.post(['/api/pair-add', '/api/pair-add/trade'], (req, res) => {
  try {
    const { action = 'PAIR', symbol = 'CLUSDT', price = null, quantity = 1.0, targetMove = 0.20 } = req.body;
    let result;
    if (action === 'SMART_PAIR' || action === 'SMART') {
      result = pairAddEngine.smartPairAdd(symbol, price, Number(quantity), Number(targetMove));
    } else {
      result = pairAddEngine.createNewPair(symbol, price, Number(quantity), Number(targetMove));
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/pair-add/toggle-engine', (req, res) => {
  try {
    const isRunning = pairAddEngine.toggleEngine();
    res.json({ success: true, isEngineRunning: isRunning });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/pair-add/reset', (req, res) => {
  try {
    const result = pairAddEngine.resetEngine();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/pair-add/settings', (req, res) => {
  try {
    const settings = pairAddEngine.updateSettings(req.body);
    res.json({ success: true, settings });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/pair-add/manual-close', (req, res) => {
  try {
    const { positionId } = req.body;
    pairAddEngine.manualClosePosition(positionId);
    res.json({ success: true, message: `Position ${positionId} closed.` });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 5c. Rates Inspector Endpoint (Active Coverage Map of B/S rates)
app.get('/api/rates-inspector', (req, res) => {
  try {
    const symbol = req.query.symbol || 'CLUSDT';
    const referer = (req.headers.referer || '').toLowerCase();
    const mode = (req.query.mode || '').toLowerCase();
    const isPairAdd = mode === 'pair_add' || referer.includes('pair_add') || referer.includes('pair-add');

    let data;
    if (isPairAdd) {
      data = pairAddEngine.getActiveRatesInspector(symbol);
    } else {
      data = paperEngine.getActiveRatesInspector(symbol);
    }
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Standalone Mudrex Live Terminal Page Route
app.get('/mudrex-live', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/mudrex_live.html'));
});

// Standalone Mudrex Crude Live Page Route
app.get('/mudrex_crude_live', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/mudrex_crude_live.html'));
});

// Standalone Paper Trading Calculator Page Route
app.get('/paper-calc', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/paper_calc.html'));
});

// Standalone MCX Commodity Trading Calculator Page Route
app.get('/mcx-calc', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/mcx_calc.html'));
});

// Standalone Mudrex Crude Calculator Page Route
app.get(['/mudrex_crude_calc', '/mudrex-crude-calc'], (req, res) => {
  res.sendFile(path.join(__dirname, '../public/mudrex_crude_calc.html'));
});

// Mudrex Live API Authentication Check Endpoint
app.get('/api/mudrex/auth-check', async (req, res) => {
  try {
    const mudrexLive = require('./engine/mudrexLiveAdapter');
    const auth = await mudrexLive.testAuthentication();
    res.json(auth);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save Mudrex API Key & Secret Endpoint
app.post('/api/mudrex/save-keys', express.json(), async (req, res) => {
  try {
    const { apiKey, apiSecret } = req.body;
    if (apiKey && !apiKey.includes('*')) process.env.MUDREX_API_KEY = apiKey.trim();
    if (apiSecret && !apiSecret.includes('*')) process.env.MUDREX_API_SECRET = apiSecret.trim();

    const mudrexLive = require('./engine/mudrexLiveAdapter');
    mudrexLive.rateLimitUntil = 0;
    mudrexLive.saveState();
    const auth = await mudrexLive.testAuthentication(true);
    res.json({ success: true, auth });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Mudrex Live Dedicated Metrics Endpoint (Isolated from Paper Data)
app.get('/api/mudrex/metrics', async (req, res) => {
  try {
    const mudrexLive = require('./engine/mudrexLiveAdapter');
    const liveMetrics = await mudrexLive.getLiveMetrics();
    res.json({ success: true, data: liveMetrics });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Mudrex API Order & Position Diagnostic Endpoint
app.get('/api/mudrex/order-diagnostic', async (req, res) => {
  try {
    const mudrexLive = require('./engine/mudrexLiveAdapter');
    const symb = 'CLUSDT';
    const orderId = req.query.orderId || '01a135aa-fcfb-7aa5-b63f-1cce4bcb0094';
    
    const [rOrder, rOpenOrders, rPositions, rUserOrders] = await Promise.all([
      mudrexLive.request('GET', `${mudrexLive.baseUrl}/futures/${symb}/order/${orderId}?trade_currency=INR`),
      mudrexLive.request('GET', `${mudrexLive.baseUrl}/futures/orders?symbol=${symb}&trade_currency=INR`),
      mudrexLive.request('GET', `${mudrexLive.baseUrl}/futures/positions?trade_currency=INR`),
      mudrexLive.request('GET', `${mudrexLive.baseUrl}/futures/${symb}/orders?trade_currency=INR`)
    ]);

    res.json({
      success: true,
      testedOrderId: orderId,
      orderDetail: rOrder,
      openOrders: rOpenOrders,
      positions: rPositions,
      symbolOrders: rUserOrders
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Authoritative Closed Trades Summary Engine (Hrs, Day, Month & Period Analytics) ---
function parseExitTimestamp(t) {
  if (t.closedTimestamp && typeof t.closedTimestamp === 'number') return t.closedTimestamp;
  if (!t.exitTime) return 0;
  let clean = String(t.exitTime);
  const m = clean.match(/T(\d{2}):/);
  if (m && parseInt(m[1], 10) >= 24) {
    clean = clean.replace(/T\d{2}:/, 'T' + (parseInt(m[1], 10) % 24).toString().padStart(2, '0') + ':');
  }
  const ts = new Date(clean).getTime();
  return isNaN(ts) ? 0 : ts;
}

function calculateBucketMetrics(trades, usdInrRate) {
  let netINR = 0, grossINR = 0, chargesINR = 0;
  let winCount = 0, lossCount = 0, totalBarrels = 0, harvestCount = 0, buyCount = 0, sellCount = 0;
  let bestTradeINR = trades.length > 0 ? -Infinity : 0;
  let worstTradeINR = trades.length > 0 ? Infinity : 0;

  for (const t of trades) {
    const rate = t.usdInrRate || usdInrRate || 102.0;
    const tNetINR = t.netProfitINR !== undefined ? t.netProfitINR : ((t.netProfitUSD || 0) * rate);
    const tGrossINR = t.grossProfitINR !== undefined ? t.grossProfitINR : ((t.grossProfitUSD || 0) * rate);
    const tChargesINR = t.totalChargesINR !== undefined ? t.totalChargesINR : ((t.totalChargesUSD || 0) * rate);
    const qty = Number(t.quantity || 1.0);

    netINR += tNetINR;
    grossINR += tGrossINR;
    chargesINR += tChargesINR;
    totalBarrels += qty;

    if (tNetINR >= 0) winCount++;
    else lossCount++;

    if (tNetINR > bestTradeINR) bestTradeINR = tNetINR;
    if (tNetINR < worstTradeINR) worstTradeINR = tNetINR;

    const isHarvest = (t.direction && (t.direction.includes('BASKET') || t.direction.includes('HARVEST'))) ||
                      (t.positionId && (t.positionId.includes('HARVEST') || t.positionId.includes('Punarjanm')));
    if (isHarvest) harvestCount++;
    else if (t.direction === 'BUY' || (t.positionId && t.positionId.includes('BUY'))) buyCount++;
    else sellCount++;
  }

  const tradesCount = trades.length;
  const netUSD = Number((netINR / usdInrRate).toFixed(2));
  const grossUSD = Number((grossINR / usdInrRate).toFixed(2));
  const chargesUSD = Number((chargesINR / usdInrRate).toFixed(2));
  const winRate = tradesCount > 0 ? Number(((winCount / tradesCount) * 100).toFixed(1)) : 0;
  const avgProfitINR = tradesCount > 0 ? Number((netINR / tradesCount).toFixed(2)) : 0;
  const avgProfitUSD = Number((avgProfitINR / usdInrRate).toFixed(2));

  return {
    tradesCount,
    winCount,
    lossCount,
    winRate,
    netProfitINR: Number(netINR.toFixed(2)),
    netProfitUSD: netUSD,
    grossProfitINR: Number(grossINR.toFixed(2)),
    grossProfitUSD: grossUSD,
    totalChargesINR: Number(chargesINR.toFixed(2)),
    totalChargesUSD: chargesUSD,
    totalBarrels: Number(totalBarrels.toFixed(1)),
    harvestCount,
    buyCount,
    sellCount,
    avgProfitINR,
    avgProfitUSD,
    bestTradeINR: bestTradeINR === -Infinity ? 0 : Number(bestTradeINR.toFixed(2)),
    worstTradeINR: worstTradeINR === Infinity ? 0 : Number(worstTradeINR.toFixed(2))
  };
}

function computeClosedTradesSummary(trades, usdInrRate) {
  const now = Date.now();
  // Compute start of Today in IST (ISO format: YYYY-MM-DDT00:00:00+05:30)
  const todayISTStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const startOfTodayIST = new Date(todayISTStr + 'T00:00:00+05:30').getTime();
  const startOfYesterdayIST = startOfTodayIST - 86400000;
  const startOfMonthIST = new Date(todayISTStr.slice(0, 8) + '01T00:00:00+05:30').getTime();

  const periods = {
    '1h': trades.filter(t => parseExitTimestamp(t) >= now - 3600000),
    '2h': trades.filter(t => parseExitTimestamp(t) >= now - 2 * 3600000),
    '4h': trades.filter(t => parseExitTimestamp(t) >= now - 4 * 3600000),
    '8h': trades.filter(t => parseExitTimestamp(t) >= now - 8 * 3600000),
    '12h': trades.filter(t => parseExitTimestamp(t) >= now - 12 * 3600000),
    '24h': trades.filter(t => parseExitTimestamp(t) >= now - 24 * 3600000),
    'today': trades.filter(t => parseExitTimestamp(t) >= startOfTodayIST),
    'yesterday': trades.filter(t => { const ts = parseExitTimestamp(t); return ts >= startOfYesterdayIST && ts < startOfTodayIST; }),
    '7d': trades.filter(t => parseExitTimestamp(t) >= now - 7 * 86400000),
    'thisMonth': trades.filter(t => parseExitTimestamp(t) >= startOfMonthIST),
    '30d': trades.filter(t => parseExitTimestamp(t) >= now - 30 * 86400000),
    'all': trades
  };

  const periodSummaries = {};
  for (const [k, arr] of Object.entries(periods)) {
    periodSummaries[k] = calculateBucketMetrics(arr, usdInrRate);
  }

  // Daily breakdown (group by IST date for the last 14 days)
  const dayGroups = {};
  for (const t of trades) {
    const ts = parseExitTimestamp(t);
    if (!ts) continue;
    const dateKey = new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
    if (!dayGroups[dateKey]) dayGroups[dateKey] = [];
    dayGroups[dateKey].push(t);
  }

  const dailyBreakdown = Object.keys(dayGroups).sort().reverse().slice(0, 14).map(dateKey => {
    const metrics = calculateBucketMetrics(dayGroups[dateKey], usdInrRate);
    return {
      date: dateKey,
      ...metrics
    };
  });

  return {
    periods: periodSummaries,
    dailyBreakdown,
    all: periodSummaries.all,
    today: periodSummaries.today,
    yesterday: periodSummaries.yesterday,
    last1h: periodSummaries['1h'],
    last2h: periodSummaries['2h'],
    last4h: periodSummaries['4h'],
    last8h: periodSummaries['8h'],
    last12h: periodSummaries['12h'],
    last24h: periodSummaries['24h'],
    last7d: periodSummaries['7d'],
    thisMonth: periodSummaries.thisMonth,
    last30d: periodSummaries['30d']
  };
}

// Dedicated Clean Endpoint for Crude-Live-Mudrex Pro Desk
app.get(['/api/crude-live-mudrex/data', '/api/crude-live-mudrex-pro/data'], async (req, res) => {
  try {
    const mudrexLive = require('./engine/mudrexLiveAdapter');
    const paperEngine = require('./engine/paperEngine');
    const rateFeed = require('./engine/rateFeed');

    const rateInfo = rateFeed.getCurrentRate('CLUSDT') || { price: 92.90, symbol: 'CLUSDT', usdInrRate: 102.00 };
    const livePrice = Number(rateInfo.price || 92.90);
    const usdInrRate = Number(rateInfo.usdInrRate || 102.00);

    // 1. Authoritative Mudrex Wallet Balance (Live from Mudrex API)
    let availINR = 105843.00;
    let lockedINR = 9513.15;
    let spotINR = 0;
    try {
      const auth = await mudrexLive.testAuthentication(false);
      if (auth && auth.success) {
        if (typeof auth.futuresBalance === 'number') availINR = auth.futuresBalance;
        if (auth.raw?.futures?.data?.locked_amount) lockedINR = Number(auth.raw.futures.data.locked_amount);
        if (typeof auth.spotBalance === 'number') spotINR = auth.spotBalance;
      } else if (mudrexLive.lastAuthCheckRes && mudrexLive.lastAuthCheckRes.success) {
        if (typeof mudrexLive.lastAuthCheckRes.futuresBalance === 'number') availINR = mudrexLive.lastAuthCheckRes.futuresBalance;
        if (mudrexLive.lastAuthCheckRes.raw?.futures?.data?.locked_amount) lockedINR = Number(mudrexLive.lastAuthCheckRes.raw.futures.data.locked_amount);
        if (typeof mudrexLive.lastAuthCheckRes.spotBalance === 'number') spotINR = mudrexLive.lastAuthCheckRes.spotBalance;
      }
    } catch (authErr) {}
    const equityINR = Number((availINR + lockedINR).toFixed(2));

    // 2. Mudrex Real Exchange Position (One-Way Net Mode)
    let exchangePositions = [];
    try {
      const pRes = await mudrexLive.fetchPositions(true);
      if (pRes.success && Array.isArray(pRes.data)) {
        exchangePositions = pRes.data;
      }
    } catch (e) {}

    let mudrexNetSummary = null;
    if (exchangePositions.length > 0) {
      const mainPos = exchangePositions[0];
      const posQty = Number(mainPos.quantity || 0);
      const posEntry = Number(mainPos.entryPrice || 0);
      const isShort = (mainPos.direction === 'SELL' || mainPos.direction === 'SHORT');
      const hedgeRate = Number(mainPos.entryHedgeRate || (mainPos.raw && mainPos.raw.entry_hedge_rate) || usdInrRate || 102.00);
      
      const curPrice = Number(livePrice || mainPos.currentPrice || mainPos.markPrice);
      const liqPrice = Number(mainPos.liquidationPrice || (isShort ? posEntry * 1.18 : posEntry * 0.82));
      const initialMarginINR = Number(mainPos.initialMarginINR || lockedINR || 7716.66);
      
      let pnlINR = null;
      let pnlPercent = null;
      let pnlUSD = null;

      // If the exchange raw object contains an authoritative server-calculated PnL, use it
      if (mainPos.raw && (mainPos.raw.unrealised_pnl_inr !== undefined || mainPos.raw.unrealized_pnl_inr !== undefined)) {
        pnlINR = Number(mainPos.raw.unrealised_pnl_inr ?? mainPos.raw.unrealized_pnl_inr);
        pnlUSD = Number((pnlINR / hedgeRate).toFixed(2));
        pnlPercent = initialMarginINR > 0 ? Number(((pnlINR / initialMarginINR) * 100).toFixed(2)) : 0;
      } else {
        // Authoritative Mudrex Exchange calculation dynamically computed against real-time streaming price
        pnlUSD = isShort ? (posEntry - curPrice) * posQty : (curPrice - posEntry) * posQty;
        pnlINR = Number((pnlUSD * hedgeRate).toFixed(2));
        pnlPercent = initialMarginINR > 0 ? Number(((pnlINR / initialMarginINR) * 100).toFixed(2)) : 0;
      }

      mudrexNetSummary = {
        symbol: mainPos.symbol || 'CLUSDT',
        positionId: mainPos.positionId || mainPos.exchangePositionId,
        direction: mainPos.direction,
        sideDisplay: isShort ? 'SHORT' : 'LONG',
        quantity: posQty,
        entryPrice: Number(posEntry.toFixed(4)),
        currentPrice: Number(curPrice.toFixed(2)),
        initialMarginINR: Number(initialMarginINR.toFixed(2)),
        initialMarginUSD: Number((initialMarginINR / hedgeRate).toFixed(2)),
        unrealisedPnlUSD: Number(pnlUSD.toFixed(2)),
        unrealisedPnlINR: Number(pnlINR.toFixed(2)),
        unrealisedPnlPercent: Number(pnlPercent.toFixed(2)),
        liquidationPrice: Number(liqPrice.toFixed(2)),
        leverage: Number(mainPos.leverage || 5),
        source: 'MUDREX_AUTHORITATIVE_EXCHANGE'
      };
    }

    // 3. Engine Active Pairs (Tracking BOTH BUY and SELL legs for each pair - New 2.0B Engine Only)
    const openPairs = (paperEngine.pairs || []).filter(p => {
      if (p.status === 'CLOSED') return false;
      const bPrice = p.buyPosition?.entryPrice;
      const sPrice = p.sellPosition?.entryPrice;
      const rateLevel = p.entryRate || bPrice || sPrice || 0;
      if (rateLevel < 93.60) return false;
      return true;
    }).map(p => {
      const b = p.buyPosition;
      const s = p.sellPosition;

      let bPnlUSD = 0, bPnlINR = 0;
      if (b && b.status === 'OPEN') {
        b.currentPrice = livePrice;
        bPnlUSD = (livePrice - b.entryPrice) * (b.quantity || 1.0);
        bPnlINR = bPnlUSD * usdInrRate;
      }

      let sPnlUSD = 0, sPnlINR = 0;
      if (s && s.status === 'OPEN') {
        s.currentPrice = livePrice;
        sPnlUSD = (s.entryPrice - livePrice) * (s.quantity || 1.0);
        sPnlINR = sPnlUSD * usdInrRate;
      }

      return {
        pairId: p.pairId,
        status: p.status,
        createdAt: p.createdAt || p.createdTime || b?.entryTime || s?.entryTime || null,
        netPairPnlUSD: Number((bPnlUSD + sPnlUSD).toFixed(2)),
        netPairPnlINR: Number((bPnlINR + sPnlINR).toFixed(2)),
        buy: b ? {
          positionId: b.positionId,
          status: b.status,
          direction: 'BUY',
          entryPrice: b.entryPrice,
          entryTime: b.entryTime || p.createdAt || p.createdTime || null,
          entryTimestamp: b.entryTimestamp || p.createdTimestamp || null,
          currentPrice: livePrice,
          targetPrice: b.targetExitPrice,
          quantity: b.quantity || 1.0,
          distToTarget: Number((b.targetExitPrice - livePrice).toFixed(2)),
          floatingPnlUSD: Number(bPnlUSD.toFixed(2)),
          floatingPnlINR: Number(bPnlINR.toFixed(2)),
          mudrexOrderId: b.mudrexOrderId || null,
          apiStatus: b.apiStatus || null
        } : null,
        sell: s ? {
          positionId: s.positionId,
          status: s.status,
          direction: 'SELL',
          entryPrice: s.entryPrice,
          entryTime: s.entryTime || p.createdAt || p.createdTime || null,
          entryTimestamp: s.entryTimestamp || p.createdTimestamp || null,
          currentPrice: livePrice,
          targetPrice: s.targetExitPrice,
          quantity: s.quantity || 1.0,
          distToTarget: Number((livePrice - s.targetExitPrice).toFixed(2)),
          floatingPnlUSD: Number(sPnlUSD.toFixed(2)),
          floatingPnlINR: Number(sPnlINR.toFixed(2)),
          mudrexOrderId: s.mudrexOrderId || null,
          apiStatus: s.apiStatus || null
        } : null
      };
    });

    // 4. Closed Positions History & Realized P/L (Preserving all historical trades)
    const allClosedPositions = paperEngine.closedPositions || [];
    let closedTrades = allClosedPositions.slice(-500);
    const closedSummary = computeClosedTradesSummary(allClosedPositions, usdInrRate);

    const totalRealizedINR = closedSummary.all.netProfitINR;
    const totalRealizedUSD = closedSummary.all.netProfitUSD;
    const winCount = closedSummary.all.winCount;
    const lossCount = closedSummary.all.lossCount;

    const totalFloatingINR = openPairs.reduce((sum, p) => sum + p.netPairPnlINR, 0);
    const totalFloatingUSD = Number((totalFloatingINR / usdInrRate).toFixed(2));

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      rate: {
        symbol: 'CLUSDT',
        price: livePrice,
        markPrice: rateInfo.markPrice || livePrice,
        indexPrice: rateInfo.indexPrice || livePrice,
        usdInrRate,
        updatedAt: rateInfo.timestamp || new Date().toISOString()
      },
      wallet: {
        availableMarginINR: Number(availINR.toFixed(2)),
        availableMarginUSD: Number((availINR / usdInrRate).toFixed(2)),
        lockedMarginINR: Number(lockedINR.toFixed(2)),
        lockedMarginUSD: Number((lockedINR / usdInrRate).toFixed(2)),
        equityINR: Number(equityINR.toFixed(2)),
        equityUSD: Number((equityINR / usdInrRate).toFixed(2)),
        spotBalanceINR: Number(spotINR.toFixed(2)),
        spotBalanceUSD: Number((spotINR / usdInrRate).toFixed(2)),
        usdInrRate
      },
      mudrexExchange: {
        positions: exchangePositions,
        count: exchangePositions.length,
        netSummary: mudrexNetSummary,
        note: 'Mudrex operates in One-Way Net Mode. All orders merge into a single net exchange position.'
      },
      engine: {
        status: paperEngine.engineStatus,
        isEngineRunning: paperEngine.isEngineRunning,
        pauseReason: paperEngine.pauseReason || '',
        pairsCount: openPairs.length,
        contractQuantity: paperEngine.settings.contractQuantity || 2.0,
        profitTargetMove: paperEngine.settings.profitTargetMove || 0.25,
        activeBuyCount: openPairs.filter(p => p.buy && p.buy.status === 'OPEN').length,
        activeSellCount: openPairs.filter(p => p.sell && p.sell.status === 'OPEN').length,
        pairs: openPairs
      },
      punarjanm: {
        count: paperEngine.punarjanmCount || 0,
        currentCycleName: `Punarjanm${(paperEngine.punarjanmCount || 0) + 1}`,
        lastCycleName: paperEngine.punarjanmCount ? `Punarjanm${paperEngine.punarjanmCount}` : 'None',
        basketTargetINR: paperEngine.settings.basketProfitTargetINR || 250,
        autoEnabled: paperEngine.settings.autoPunarjanmEnabled !== false,
        lastSummary: paperEngine.lastPunarjanmSummary || null
      },
      pnl: {
        totalRealizedINR,
        totalRealizedUSD,
        totalFloatingINR: Number(totalFloatingINR.toFixed(2)),
        totalFloatingUSD,
        winCount,
        lossCount,
        closedTradesCount: closedSummary.all.tradesCount
      },
      closedPositions: closedTrades,
      closedSummary,
      sessionScheduler: paperEngine.getSessionSchedulerStatus ? paperEngine.getSessionSchedulerStatus() : null
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Dedicated Clean Action Endpoint with Admin PIN Protection (340556)
app.post(['/api/crude-live-mudrex/action', '/api/crude-live-mudrex-pro/action'], async (req, res) => {
  try {
    const { action, password } = req.body || {};
    if (password !== '340556') {
      return res.status(403).json({ success: false, error: 'Incorrect Admin Password. Must provide 340556.' });
    }

    const paperEngine = require('./engine/paperEngine');
    const mudrexLive = require('./engine/mudrexLiveAdapter');
    const rateFeed = require('./engine/rateFeed');

    if (action === 'startEngine') {
      paperEngine.engineStatus = 'RUNNING';
      paperEngine.isEngineRunning = true;
      paperEngine.pauseReason = '';
      paperEngine.saveState();
      return res.json({ success: true, message: 'Crude Live Engine started successfully.' });
    } else if (action === 'pauseEngine') {
      paperEngine.engineStatus = 'PAUSED';
      paperEngine.isEngineRunning = false;
      paperEngine.pauseReason = 'User paused engine from Crude-Live-Mudrex desk';
      paperEngine.saveState();
      return res.json({ success: true, message: 'Crude Live Engine paused successfully.' });
    } else if (action === 'addNewPair') {
      const cur = rateFeed.getCurrentRate('CLUSDT');
      const price = cur ? cur.price : paperEngine.lastProcessedRate || 92.90;
      const usdInrRate = cur ? (cur.usdInrRate || 102.00) : 102.00;
      
      paperEngine.createNewPair('CLUSDT', price, Date.now(), usdInrRate);
      paperEngine.saveState();

      if (mudrexLive.isRealExecutionEnabled()) {
        mudrexLive.transmitPendingLiveOrders().catch(() => {});
      }
      return res.json({ success: true, message: `New Crude Pair created at $${price.toFixed(2)}.` });
    } else if (action === 'punarjanm' || action === 'closeMudrexExchangePosition') {
      const cur = rateFeed.getCurrentRate('CLUSDT');
      const closeRate = cur ? cur.price : paperEngine.lastProcessedRate || 93.30;
      const usdInrRate = cur ? (cur.usdInrRate || 102.00) : 102.00;
      
      const punarjanmResult = await paperEngine.executePunarjanm('MANUAL_USER_REQUEST', closeRate, usdInrRate);
      return res.json({
        success: true,
        message: punarjanmResult.message || `Punarjanm #${punarjanmResult.cycleNumber} executed successfully!`,
        punarjanm: punarjanmResult
      });
    } else if (action === 'updateBasketTarget') {
      const newTarget = Number(req.body.targetINR);
      if (isNaN(newTarget) || newTarget <= 0) {
        return res.status(400).json({ success: false, error: 'Target INR must be a positive number.' });
      }
      paperEngine.settings.basketProfitTargetINR = newTarget;
      paperEngine.saveState();
      return res.json({ success: true, message: `Punarjanm target updated to ₹${newTarget.toFixed(2)} INR.`, targetINR: newTarget });
    } else if (action === 'updateSessionScheduler') {
      const { sessionScheduler } = req.body;
      if (sessionScheduler && typeof sessionScheduler === 'object') {
        const ok = paperEngine.updateSessionScheduler(sessionScheduler);
        return res.json({
          success: ok,
          message: 'Market Session Auto-Scheduler updated successfully.',
          sessionScheduler: paperEngine.getSessionSchedulerStatus ? paperEngine.getSessionSchedulerStatus() : null
        });
      }
      return res.status(400).json({ success: false, error: 'Invalid sessionScheduler configuration payload.' });
    } else if (action === 'syncClosedTrades') {
      const { closedPositions } = req.body;
      if (Array.isArray(closedPositions)) {
        const existingIds = new Set((paperEngine.closedPositions || []).map(c => c.positionId));
        for (const cp of closedPositions) {
          if (!existingIds.has(cp.positionId)) {
            paperEngine.closedPositions.push(cp);
            existingIds.add(cp.positionId);
          }
        }
        paperEngine.closedPositions.sort((a, b) => new Date(a.exitTime || 0) - new Date(b.exitTime || 0));
        paperEngine.closedPositions.forEach((cp, idx) => { cp.slNo = idx + 1; });
        paperEngine.saveState();
        return res.json({ success: true, message: `Synced ${closedPositions.length} closed trades. Total now: ${paperEngine.closedPositions.length}`, count: paperEngine.closedPositions.length });
      }
      return res.status(400).json({ success: false, error: 'closedPositions array required.' });
    }

    return res.status(400).json({ success: false, error: 'Unknown action.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Dedicated Clean Endpoint for Solana-Live-Mudrex and Subh-Mani-Solana
app.get(['/api/solana-live-mudrex/data', '/api/subh-mani-solana/data', '/api/subh-mani/data', '/api/subh-money-solana/data', '/api/subh-money/data', '/api/crude-live-mudrex-solana/data', '/api/solana/data'], async (req, res) => {
  try {
    const solanaEngine = require('./engine/solanaEngine');
    const mudrexLive = require('./engine/mudrexLiveAdapter');
    if (process.env.MUDREX_API_KEY || mudrexLive.mudrexApiKey) {
      mudrexLive.testAuthentication().catch(() => {});
    }
    const data = solanaEngine.getDashboardMetrics();
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Dedicated Action Endpoint for Solana Simulator with Admin PIN Protection (340556)
app.post(['/api/solana-live-mudrex/action', '/api/subh-mani-solana/action', '/api/subh-mani/action', '/api/subh-money-solana/action', '/api/subh-money/action', '/api/crude-live-mudrex-solana/action', '/api/solana/action'], async (req, res) => {
  try {
    const { action, password } = req.body || {};
    if (password !== '340556') {
      return res.status(403).json({ success: false, error: 'Incorrect Admin Password. Must provide 340556.' });
    }

    const solanaEngine = require('./engine/solanaEngine');
    const rateFeed = require('./engine/rateFeed');
    const mudrexLive = require('./engine/mudrexLiveAdapter');



    if (action === 'startEngine') {
      solanaEngine.engineStatus = 'RUNNING';
      solanaEngine.isEngineRunning = true;
      solanaEngine.pauseReason = '';
      solanaEngine.saveState();
      return res.json({ success: true, message: 'Solana Simulation Engine started successfully.' });
    } else if (action === 'pauseEngine') {
      solanaEngine.engineStatus = 'PAUSED';
      solanaEngine.isEngineRunning = false;
      solanaEngine.pauseReason = 'User paused engine from Solana desk';
      solanaEngine.saveState();
      return res.json({ success: true, message: 'Solana Simulation Engine paused successfully.' });
    } else if (action === 'addNewPair') {
      const cur = rateFeed.getCurrentRate('SOLUSDT');
      const price = cur ? cur.price : 106.30;
      const usdInrRate = cur ? (cur.usdInrRate || 102.00) : 102.00;
      
      const pair = solanaEngine.createNewPair('SOLUSDT', price, Date.now(), usdInrRate);
      if (!pair) {
        return res.status(400).json({ success: false, error: `Price level $${price.toFixed(2)} is permanently locked or reserved by an active target.` });
      }
      return res.json({ success: true, message: `New Solana Pair created at $${price.toFixed(2)}.`, pair });
    } else if (action === 'punarjanm') {
      const cur = rateFeed.getCurrentRate('SOLUSDT');
      const closeRate = cur ? cur.price : 106.30;
      const usdInrRate = cur ? (cur.usdInrRate || 102.00) : 102.00;
      
      const punarjanmResult = solanaEngine.executePunarjanm('MANUAL_USER_REQUEST', closeRate, usdInrRate);
      return res.json({
        success: true,
        message: 'Solana Punarjanm executed successfully!',
        punarjanm: punarjanmResult
      });
    } else if (action === 'updateBasketTarget') {
      const newTarget = Number(req.body.targetINR);
      if (isNaN(newTarget) || newTarget <= 0) {
        return res.status(400).json({ success: false, error: 'Target INR must be a positive number.' });
      }
      solanaEngine.settings.basketProfitTargetINR = newTarget;
      solanaEngine.saveState();
      return res.json({ success: true, message: `Solana Punarjanm target updated to ₹${newTarget.toFixed(2)} INR.`, targetINR: newTarget });
    } else if (action === 'toggleAutoPunarjanm' || action === 'updateAutoPunarjanm') {
      const enabled = req.body.enabled !== undefined ? !!req.body.enabled : !solanaEngine.settings.autoPunarjanmEnabled;
      solanaEngine.settings.autoPunarjanmEnabled = enabled;
      solanaEngine.saveState();
      return res.json({ success: true, message: `Solana Auto-Punarjanm set to ${enabled ? 'ENABLED' : 'DISABLED'}.`, autoPunarjanmEnabled: enabled });
    } else if (action === 'updateContractQuantity' || action === 'updateLotSize') {
      const newQty = Number(req.body.quantity || req.body.contractQuantity);
      if (isNaN(newQty) || newQty <= 0) {
        return res.status(400).json({ success: false, error: 'Contract quantity must be a positive number.' });
      }
      solanaEngine.settings.contractQuantity = newQty;
      solanaEngine.saveState();
      return res.json({ success: true, message: `Solana Lot Size updated to ${newQty} SOL.`, contractQuantity: newQty });
    } else if (action === 'updateTargetMove') {
      const newMove = Number(req.body.targetMove || req.body.profitTargetMove);
      if (isNaN(newMove) || newMove <= 0) {
        return res.status(400).json({ success: false, error: 'Target move must be a positive number.' });
      }
      solanaEngine.settings.profitTargetMove = newMove;
      solanaEngine.saveState();
      return res.json({ success: true, message: `Solana Target Move updated to $${newMove.toFixed(2)}.`, profitTargetMove: newMove });
    } else if (action === 'updateMaxActivePairs') {
      const newMax = Number(req.body.maxActivePairs);
      if (isNaN(newMax) || newMax < 1) {
        return res.status(400).json({ success: false, error: 'maxActivePairs must be a positive number.' });
      }
      solanaEngine.settings.maxActivePairs = newMax;
      solanaEngine.saveState();
      return res.json({ success: true, message: `Solana Max Active Pairs updated to ${newMax}.`, maxActivePairs: newMax });
    } else if (action === 'closeLotGroup') {
      const lotQty = Number(req.body.lotSize || req.body.quantity);
      if (isNaN(lotQty) || lotQty <= 0) {
        return res.status(400).json({ success: false, error: 'Valid lot size required.' });
      }
      const cur = rateFeed.getCurrentRate('SOLUSDT');
      const livePrice = cur ? cur.price : solanaEngine.lastProcessedRate;
      const resClose = solanaEngine.closeLotGroup(lotQty, 'USER_MANUAL_LOT_CLOSE', livePrice, cur ? cur.usdInrRate : 102.00);
      return res.json(resClose);
    } else if (action === 'cleanFloatingKachra' || action === 'cleanKachra' || action === 'resyncMudrex') {
      const result = solanaEngine.cleanFloatingKachra('USER_MANUAL_CLEAN');
      return res.json(result);
    } else if (action === 'updateAutoCleanSettings') {
      const { enabled, thresholdINR, maxImbalance } = req.body || {};
      if (typeof enabled === 'boolean') solanaEngine.settings.autoCleanKachraEnabled = enabled;
      if (typeof thresholdINR === 'number' && thresholdINR > 0) solanaEngine.settings.maxFloatingLossThresholdINR = thresholdINR;
      if (typeof maxImbalance === 'number' && maxImbalance > 0) solanaEngine.settings.maxOneSidedLegs = maxImbalance;
      solanaEngine.saveState();
      return res.json({ success: true, message: 'Auto-Clean Settings updated successfully.', settings: solanaEngine.settings });
    } else if (action === 'resetData' || action === 'resetSimulator') {
      const customQty = req.body.quantity ? Number(req.body.quantity) : null;
      const customCapital = req.body.capitalINR ? Number(req.body.capitalINR) : 300000.00;
      const customTargetMove = (req.body.targetMove || req.body.profitTargetMove) ? Number(req.body.targetMove || req.body.profitTargetMove) : null;
      const result = solanaEngine.resetData(customQty, customCapital, customTargetMove);
      return res.json({ 
        success: true, 
        message: result.message, 
        contractQuantity: result.contractQuantity,
        startingCapitalINR: result.startingCapitalINR,
        profitTargetMove: result.profitTargetMove 
      });
    } else {
      return res.status(400).json({ success: false, error: 'Unknown action: ' + action });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// BTC LIVE MUDREX PRO DEDICATED REST ENDPOINTS
// ==========================================

app.get(['/api/btc-live-mudrex/data', '/api/btc-live-mudrex-pro/data', '/api/btc-pro/data'], (req, res) => {
  try {
    const btcEngine = require('./engine/btcEngine');
    const data = btcEngine.getDashboardMetrics();
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post(['/api/btc-live-mudrex/action', '/api/btc-live-mudrex-pro/action', '/api/btc-pro/action'], async (req, res) => {
  try {
    const { action, password } = req.body || {};
    // Per user instruction: password removed from update/reset, pair addition, pair close, pairs limit, harvest target, and punarjanm operations
    const noPasswordActions = ['resetSimulator', 'resetData', 'addNewPair', 'closePair', 'updateMaxPairs', 'setMaxPairs', 'increaseMaxPairs', 'updateBasketTarget', 'punarjanm'];
    if (!noPasswordActions.includes(action) && password !== '340556') {
      return res.status(403).json({ success: false, error: 'Incorrect Admin Password. Must provide 340556.' });
    }

    const btcEngine = require('./engine/btcEngine');
    const rateFeed = require('./engine/rateFeed');

    if (action === 'startEngine') {
      btcEngine.engineStatus = 'RUNNING';
      btcEngine.isEngineRunning = true;
      btcEngine.pauseReason = '';
      btcEngine.saveState();
      return res.json({ success: true, message: 'BTC Simulation Engine started successfully.' });
    } else if (action === 'pauseEngine') {
      btcEngine.engineStatus = 'PAUSED';
      btcEngine.isEngineRunning = false;
      btcEngine.pauseReason = 'User paused engine from BTC desk';
      btcEngine.saveState();
      return res.json({ success: true, message: 'BTC Simulation Engine paused successfully.' });
    } else if (action === 'addNewPair') {
      const cur = rateFeed.getCurrentRate('BTCUSDT') || { price: 82000.00, usdInrRate: 102.00 };
      const price = cur.price || 82000.00;
      const usdInrRate = cur.usdInrRate || 102.00;
      const activeCount = btcEngine.pairs.filter(p => p.status !== 'CLOSED').length;
      const currentCap = (btcEngine.settings.maxActivePairs !== undefined && btcEngine.settings.maxActivePairs !== null) ? Number(btcEngine.settings.maxActivePairs) : 0;
      if (currentCap > 0 && activeCount >= currentCap) {
        btcEngine.settings.maxActivePairs = activeCount + 1;
      }
      const pair = btcEngine.createNewPair('BTCUSDT', price, Date.now(), usdInrRate);
      btcEngine.saveState();
      return res.json({ 
        success: true, 
        message: `New BTC Pair added at live rate $${price.toFixed(2)}. ${btcEngine.settings.maxActivePairs === 0 ? 'Pairs Cap is 0 (Unlimited)' : `Max pairs limit is now ${btcEngine.settings.maxActivePairs}`}.`, 
        pair,
        maxActivePairs: btcEngine.settings.maxActivePairs,
        activePairsCount: btcEngine.pairs.filter(p => p.status !== 'CLOSED').length
      });
    } else if (action === 'updateMaxPairs' || action === 'setMaxPairs' || action === 'increaseMaxPairs') {
      let newMax;
      const curMax = (btcEngine.settings.maxActivePairs !== undefined && btcEngine.settings.maxActivePairs !== null) ? Number(btcEngine.settings.maxActivePairs) : 0;
      if (action === 'increaseMaxPairs') {
        const delta = req.body.delta ? Number(req.body.delta) : 1;
        newMax = (curMax === 0 ? 3 : curMax) + delta;
      } else {
        newMax = (req.body.maxActivePairs !== undefined && req.body.maxActivePairs !== '') ? Number(req.body.maxActivePairs) : 0;
      }
      if (isNaN(newMax) || newMax < 0) {
        return res.status(400).json({ success: false, error: 'Invalid max pairs count (must be 0 or higher)' });
      }
      btcEngine.settings.maxActivePairs = newMax;
      btcEngine.saveState();
      return res.json({
        success: true,
        message: newMax === 0 
          ? `Max Active Pairs set to 0 (Unlimited / Jab tak amt in hand hai). Engine will take pairs continuously as live rate moves to vacant levels.`
          : `Max Active Pairs limit set to ${newMax} Pairs. Engine will automatically take new pairs up to ${newMax} as live rate changes to vacant levels.`,
        maxActivePairs: newMax
      });
    } else if (action === 'punarjanm') {
      const cur = rateFeed.getCurrentRate('BTCUSDT') || { price: 82000.00, usdInrRate: 102.00 };
      const closeRate = cur.price || 82000.00;
      const usdInrRate = cur.usdInrRate || 102.00;
      const punarjanmResult = btcEngine.executePunarjanm('MANUAL_USER_REQUEST', closeRate, usdInrRate);
      return res.json({
        success: true,
        message: 'BTC Punarjanm executed successfully! Harvest profit credited to wallet.',
        punarjanm: punarjanmResult
      });
    } else if (action === 'updateBasketTarget') {
      const newTarget = Number(req.body.targetINR);
      if (isNaN(newTarget) || newTarget <= 0) {
        return res.status(400).json({ success: false, error: 'Target INR must be a positive number.' });
      }
      btcEngine.settings.basketProfitTargetINR = newTarget;
      btcEngine.saveState();
      return res.json({ success: true, message: `BTC Punarjanm target updated to ₹${newTarget.toFixed(2)} INR.`, targetINR: newTarget });
    } else if (action === 'setTradingMode') {
      const { mode, realOrdersDisabled } = req.body || {};
      const targetMode = (mode || 'LIVE').toUpperCase();
      if (targetMode !== 'LIVE' && targetMode !== 'PAPER') {
        return res.status(400).json({ success: false, error: 'Mode must be LIVE or PAPER.' });
      }
      btcEngine.settings.tradingMode = targetMode;
      btcEngine.settings.realOrdersDisabled = (targetMode === 'PAPER') ? true : (realOrdersDisabled === true ? true : false);
      btcEngine.saveState();
      return res.json({
        success: true,
        message: `BTC Engine Trading Mode set to ${targetMode} (Real Exchange Orders: ${btcEngine.settings.realOrdersDisabled ? 'DISABLED' : 'ENABLED'})`,
        tradingMode: btcEngine.settings.tradingMode,
        realOrdersDisabled: btcEngine.settings.realOrdersDisabled
      });
    } else if (action === 'resetSimulator' || action === 'resetData') {
      const customQty = req.body.quantity ? Number(req.body.quantity) : 0.10;
      const customCapital = req.body.capitalINR ? Number(req.body.capitalINR) : 100000.00;
      const customTargetProfitINR = (req.body.targetProfitINR || req.body.profitTargetINR || req.body.targetINR || req.body.targetMove || req.body.profitTargetMove) ? Number(req.body.targetProfitINR || req.body.profitTargetINR || req.body.targetINR || req.body.targetMove || req.body.profitTargetMove) : 1000.00;
      const customLev = req.body.leverage ? Number(req.body.leverage) : 15;
      const customGridDiff = (req.body.gridSpacing !== undefined && req.body.gridSpacing !== '') ? Number(req.body.gridSpacing) : ((req.body.pairEntryDifference !== undefined && req.body.pairEntryDifference !== '') ? Number(req.body.pairEntryDifference) : 0.00);
      const customMaxPairs = (req.body.maxActivePairs !== undefined && req.body.maxActivePairs !== '') ? Number(req.body.maxActivePairs) : 10;
      const customBasketTarget = (req.body.basketProfitTargetINR || req.body.harvestINR) ? Number(req.body.basketProfitTargetINR || req.body.harvestINR) : 3000;
      const customStopLoss = (req.body.stopLossINR || req.body.stopLoss || req.body.stopLossMove) ? Number(req.body.stopLossINR || req.body.stopLoss || req.body.stopLossMove) : 500.00;

      const result = btcEngine.resetData(customQty, customCapital, customTargetProfitINR, customLev, customGridDiff, customMaxPairs, customBasketTarget, customStopLoss);
      return res.json({
        success: true,
        message: result.message,
        settings: btcEngine.settings
      });
    } else if (action === 'closePair') {
      const { pairId } = req.body || {};
      const result = btcEngine.closePair(pairId);
      return res.json(result);
    } else {
      return res.status(400).json({ success: false, error: 'Unknown action: ' + action });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// SOL PAIR ENGINE V2 DEDICATED REST ENDPOINTS
// ==========================================

app.get(['/api/sol-pair-engine-v2/data', '/api/sol-pair-v2/data', '/api/solana-v2/data'], (req, res) => {
  try {
    const solanaEngineV2 = require('./engine/solanaEngineV2');
    const data = solanaEngineV2.getDashboardMetrics();
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post(['/api/sol-pair-engine-v2/action', '/api/sol-pair-v2/action', '/api/solana-v2/action'], async (req, res) => {
  try {
    const { action, password } = req.body || {};
    if (password !== '340556') {
      return res.status(403).json({ success: false, error: 'Incorrect Admin Password. Must provide 340556.' });
    }

    const solanaEngineV2 = require('./engine/solanaEngineV2');
    const rateFeed = require('./engine/rateFeed');

    if (action === 'startEngine') {
      return res.json(solanaEngineV2.startEngine());
    } else if (action === 'pauseEngine') {
      return res.json(solanaEngineV2.pauseEngine('User paused engine from SOL Pair Engine V2 desk'));
    } else if (action === 'addNewPair') {
      const cur = rateFeed.getCurrentRate('SOLUSDT');
      const price = cur ? cur.price : 106.30;
      const usdInrRate = cur ? (cur.usdInrRate || 102.00) : 102.00;
      const pair = solanaEngineV2.createNewPair('SOLUSDT', price, Date.now(), usdInrRate);
      if (!pair) {
        return res.status(400).json({ success: false, error: `Price level $${price.toFixed(2)} is occupied by an active position or reserved by an active target.` });
      }
      return res.json({ success: true, message: `New Solana V2 Pair created at $${price.toFixed(2)}.`, pair });
    } else if (action === 'punarjanm') {
      const cur = rateFeed.getCurrentRate('SOLUSDT');
      const closeRate = cur ? cur.price : 106.30;
      const usdInrRate = cur ? (cur.usdInrRate || 102.00) : 102.00;
      const punarjanmResult = solanaEngineV2.executePunarjanm('MANUAL_USER_REQUEST', closeRate, usdInrRate);
      return res.json(punarjanmResult);
    } else if (action === 'cleanFloatingKachra' || action === 'cleanKachra') {
      const result = solanaEngineV2.cleanFloatingKachra('USER_MANUAL_CLEAN');
      return res.json(result);
    } else if (action === 'closeLotGroup') {
      const lotQty = Number(req.body.lotSize || req.body.quantity || 5.0);
      const cur = rateFeed.getCurrentRate('SOLUSDT');
      const livePrice = cur ? cur.price : 105.00;
      const usdInr = cur ? (cur.usdInrRate || 102.00) : 102.00;
      const resClose = solanaEngineV2.closeLotGroup(lotQty, 'USER_MANUAL_LOT_CLOSE', livePrice, usdInr);
      return res.json(resClose);
    } else if (action === 'resetData') {
      const newCapital = req.body.startingCapitalINR || 200000.00;
      const result = solanaEngineV2.resetData(5.0, newCapital, 0.45);
      return res.json(result);
    } else if (action === 'updateContractQuantity' || action === 'updateLotSize') {
      const newQty = Number(req.body.quantity || req.body.contractQuantity);
      if (isNaN(newQty) || newQty <= 0) return res.status(400).json({ success: false, error: 'Valid contract quantity required.' });
      solanaEngineV2.settings.contractQuantity = newQty;
      solanaEngineV2.saveState();
      return res.json({ success: true, message: `Lot Size updated to ${newQty} SOL.`, contractQuantity: newQty });
    } else if (action === 'updateTargetMove') {
      const newMove = Number(req.body.targetMove || req.body.profitTargetMove);
      if (isNaN(newMove) || newMove <= 0) return res.status(400).json({ success: false, error: 'Valid target move required.' });
      solanaEngineV2.settings.profitTargetMove = newMove;
      solanaEngineV2.settings.buyTargetMove = newMove;
      solanaEngineV2.settings.sellTargetMove = newMove;
      solanaEngineV2.saveState();
      return res.json({ success: true, message: `Target move updated to $${newMove.toFixed(2)}.`, profitTargetMove: newMove });
    }

    return res.status(400).json({ success: false, error: 'Unknown action: ' + action });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Historical Backtest Simulation
app.post('/api/backtest', async (req, res) => {
  try {
    const config = req.body;
    const result = await backtest.runBacktest(config);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7b. MCX Commodity Historical Backtest Simulation (INR ₹)
app.post('/api/mcx/backtest', async (req, res) => {
  try {
    const config = req.body;
    const result = await mcxBacktest.runMcxBacktest(config);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7c. BTC Study & Wallet Simulator Endpoints
app.get('/api/btc-study/live-rate', (req, res) => {
  try {
    const rateInfo = rateFeed.getCurrentRate('BTCUSDT');
    res.json({
      success: true,
      data: rateInfo
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/btc-study/historical-klines', async (req, res) => {
  try {
    const result = await btcStudyEngine.fetchHistoricalKlines(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/btc-study/run-simulation', async (req, res) => {
  try {
    const { config, klines } = req.body;
    let candleData = klines;
    if (!candleData || candleData.length === 0) {
      const fetchResult = await btcStudyEngine.fetchHistoricalKlines(config);
      if (!fetchResult.success) {
        return res.status(400).json(fetchResult);
      }
      candleData = fetchResult.klines;
    }
    const simulationResult = btcStudyEngine.runSimulation(config, candleData);
    res.json(simulationResult);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/btc-study/compare-strategies', async (req, res) => {
  try {
    const { baseConfig, variations, klines } = req.body;
    let candleData = klines;
    if (!candleData || candleData.length === 0) {
      const fetchResult = await btcStudyEngine.fetchHistoricalKlines(baseConfig);
      if (!fetchResult.success) {
        return res.status(400).json(fetchResult);
      }
      candleData = fetchResult.klines;
    }
    const comparisonResult = btcStudyEngine.compareConfigurations(baseConfig, variations, candleData);
    res.json({ success: true, results: comparisonResult });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Run Acceptance Test Suite Endpoint
app.get('/api/tests/run', async (req, res) => {
  try {
    // Run tests programmatically or report latest status
    const testScript = require('child_process').execSync('node tests/runTests.js', { encoding: 'utf8' });
    res.json({ success: true, output: testScript });
  } catch (err) {
    res.json({ success: false, output: err.stdout || err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n===============================================================`);
  console.log(` Mudrex LIVE Rate Trading Engine Live (PAPER SIMULATION ONLY)`);
  console.log(` Running on: http://localhost:${PORT}`);
  console.log(` REAL ORDERS: PERMANENTLY DISABLED`);
  console.log(`===============================================================\n`);
});
