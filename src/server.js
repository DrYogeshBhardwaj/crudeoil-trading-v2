const express = require('express');
const cors = require('cors');
const path = require('path');
const rateFeed = require('./engine/rateFeed');
const paperEngine = require('./engine/paperEngine');
const pairAddEngine = require('./engine/pairAddEngine');
const backtest = require('./engine/backtest');
const mcxBacktest = require('./engine/mcxBacktest');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
app.get(['/mudrex-crude-calc', '/mudrex_crude_calc', '/mudrex_crude_calc.html', '/mudrex-crude-calc.html'], (req, res) => res.sendFile(path.join(__dirname, '../public/mudrex_crude_calc.html')));
app.get(['/pair-add', '/pair_add', '/pair_add.html', '/pair-add.html'], (req, res) => res.sendFile(path.join(__dirname, '../public/pair_add.html')));

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
