const express = require('express');
const cors = require('cors');
const path = require('path');
const rateFeed = require('./engine/rateFeed');
const paperEngine = require('./engine/paperEngine');
const backtest = require('./engine/backtest');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

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
      realOrdersDisabled: true,
      engineStatus: paperEngine.engineStatus,
      isEngineRunning: paperEngine.isEngineRunning,
      activeInstrument: paperEngine.settings.instrument,
      feedStatus: rateInfo.status,
      feedPrice: rateInfo.price
    });
  } catch (err) {
    res.status(500).json({ status: 'ERROR', error: err.message });
  }
});

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
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendUpdate = () => {
    try {
      const metrics = paperEngine.getDashboardMetrics();
      res.write(`data: ${JSON.stringify(metrics)}\n\n`);
    } catch (e) {
      console.error('Error sending SSE update:', e);
    }
  };

  sendUpdate();
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
    paperEngine.manualClosePosition(positionId);
    res.json({ success: true, message: `Position ${positionId} closed successfully.` });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 6. Reset All Paper Trading Data
app.post('/api/reset-data', (req, res) => {
  try {
    paperEngine.resetAllData();
    res.json({ success: true, message: 'All paper trading positions and history have been reset.' });
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
