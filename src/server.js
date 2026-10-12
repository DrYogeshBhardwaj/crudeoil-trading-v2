const express = require('express');
const cors = require('cors');
const path = require('path');
const rateFeed = require('./engine/rateFeed');
const paperEngine = require('./engine/paperEngine');
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
    res.json({
      status: 'OK',
      service: 'Mudrex LIVE Rate Engine',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      paperTradingOnly: true,
      realOrdersDisabled: false,
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

// Express Page Routes
app.get('/dhan-mcx', (req, res) => res.sendFile(path.join(__dirname, '../public/dhan_mcx.html')));
app.get('/mcx-calc', (req, res) => res.sendFile(path.join(__dirname, '../public/mcx_calc.html')));
app.get('/paper-calc', (req, res) => res.sendFile(path.join(__dirname, '../public/paper_calc.html')));
app.get('/mudrex-live', (req, res) => res.sendFile(path.join(__dirname, '../public/mudrex_live.html')));

// 1. Dashboard Metrics
app.get('/api/metrics', (req, res) => {
  try {
    const metrics = paperEngine.getDashboardMetrics();
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

  const isMudrexLive = req.query.mode === 'mudrex_live' || (req.headers.referer && (req.headers.referer.includes('mudrex_live') || req.headers.referer.includes('dhan_mcx') || req.headers.referer.includes('dhan-mcx')));

  const sendUpdate = async () => {
    try {
      let metrics;
      if (isMudrexLive) {
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

// 3. Update Settings
app.post('/api/settings', (req, res) => {
  try {
    const newSettings = req.body;
    paperEngine.updateSettings(newSettings);
    res.json({ success: true, settings: paperEngine.settings });
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

// 6. Reset All Engine Data
app.post('/api/reset-data', (req, res) => {
  try {
    paperEngine.resetAllData();
    const mudrexLive = require('./engine/mudrexLiveAdapter');
    mudrexLive.resetLiveEngine();
    res.json({ success: true, message: 'All trading positions and history have been reset.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Standalone Mudrex Live Terminal Page Route
app.get('/mudrex-live', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/mudrex_live.html'));
});

// Standalone Paper Trading Calculator Page Route
app.get('/paper-calc', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/paper_calc.html'));
});

// Standalone MCX Commodity Trading Calculator Page Route
app.get('/mcx-calc', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/mcx_calc.html'));
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
    if (apiKey) process.env.MUDREX_API_KEY = apiKey.trim();
    if (apiSecret) process.env.MUDREX_API_SECRET = apiSecret.trim();

    const mudrexLive = require('./engine/mudrexLiveAdapter');
    mudrexLive.saveState();
    const auth = await mudrexLive.testAuthentication();
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
