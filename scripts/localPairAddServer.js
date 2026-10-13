/**
 * LOCAL PAIR-ADD SIMULATOR & BALANCER SERVER
 * Dedicated Standalone Local Server for pair_add testing & simulation.
 * Completely isolated from Railway production live engine.
 * Run locally via: npm run pair-add
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');

const rateFeed = require('../src/engine/rateFeed');
const pairAddEngine = require('../src/engine/pairAddEngine');

const app = express();
const PORT = process.env.PAIR_ADD_PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve static assets from public directory
app.use(express.static(path.join(__dirname, '../public')));

// Root route: Directly serve pair_add.html
app.get(['/', '/pair-add', '/pair_add', '/pair_add.html', '/pair-add.html'], (req, res) => {
  res.sendFile(path.join(__dirname, '../public/pair_add.html'));
});

// SSE Live Stream for Rate Ticks & Pair-Add Metrics
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Immediate initial snapshot
  const initialTick = rateFeed.getCurrentRate('CLUSDT');
  const metrics = pairAddEngine.getDashboardMetrics();
  res.write(`event: tick\ndata: ${JSON.stringify(initialTick)}\n\n`);
  res.write(`event: metrics\ndata: ${JSON.stringify(metrics)}\n\n`);

  const onTick = (type, tick) => {
    try {
      res.write(`event: tick\ndata: ${JSON.stringify(tick)}\n\n`);
      const updatedMetrics = pairAddEngine.getDashboardMetrics();
      res.write(`event: metrics\ndata: ${JSON.stringify(updatedMetrics)}\n\n`);
    } catch (e) {}
  };

  rateFeed.subscribe(onTick);

  req.on('close', () => {
    rateFeed.unsubscribe(onTick);
  });
});

// Metrics endpoint
app.get('/api/metrics', (req, res) => {
  try {
    const metrics = pairAddEngine.getDashboardMetrics();
    res.json({ success: true, data: metrics });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Rates Inspector
app.get('/api/rates-inspector', (req, res) => {
  try {
    const symbol = req.query.symbol || 'CLUSDT';
    const data = pairAddEngine.getActiveRatesInspector(symbol);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Pair-Add Trade Placement
app.post(['/api/pair-add', '/api/pair-add/trade', '/api/manual-trade'], (req, res) => {
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

// Toggle Engine State
app.post('/api/pair-add/toggle-engine', (req, res) => {
  try {
    const isRunning = pairAddEngine.toggleEngine();
    res.json({ success: true, isEngineRunning: isRunning });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reset Engine State
app.post('/api/pair-add/reset', (req, res) => {
  try {
    const result = pairAddEngine.resetEngine();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update Settings
app.post('/api/settings', (req, res) => {
  try {
    pairAddEngine.updateSettings(req.body);
    res.json({ success: true, data: pairAddEngine.settings });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`\n============================================================`);
  console.log(`⚡ LOCAL PAIR-ADD SIMULATOR & BALANCER SERVER RUNNING`);
  console.log(`📍 URL: http://localhost:${PORT}`);
  console.log(`🛡️ 100% Isolated from Railway production Live Engine`);
  console.log(`============================================================\n`);
});
