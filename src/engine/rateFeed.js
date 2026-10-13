const WebSocket = require('ws');
const http = require('https');

class RateFeedManager {
  constructor() {
    this.rates = {
      CLUSDT: { price: null, lastTime: 0, receivedTime: 0, status: 'INITIALIZING', source: 'NONE' },
      XAGUSDT: { price: null, lastTime: 0, receivedTime: 0, status: 'INITIALIZING', source: 'NONE' },
      BTCUSDT: { price: null, lastTime: 0, receivedTime: 0, status: 'INITIALIZING', source: 'NONE' }
    };

    this.activeSymbol = 'CLUSDT';
    this.usdInrRate = 102.00; // Fixed Mudrex INR Futures Rate (1 USD = 102.00 INR)
    this.usdInrLastUpdated = new Date().toISOString();
    this.staleThresholdMs = 25000; // 25 seconds stale threshold
    this.wsConnections = {};
    this.listeners = [];
    this.isPollingFallbackActive = false;
    this.pollingInterval = null;
  }

  setUSDINRRate(rate) {
    if (rate && rate > 0) {
      this.usdInrRate = Number(rate);
      this.usdInrLastUpdated = new Date().toISOString();
      this.notifyListeners('usd_inr_updated', { usdInrRate: this.usdInrRate });
    }
  }

  setActiveSymbol(symbol) {
    if (this.rates[symbol]) {
      this.activeSymbol = symbol;
      this.notifyListeners('symbol_changed', { symbol: this.activeSymbol });
    }
  }

  subscribe(listener) {
    this.listeners.push(listener);
  }

  notifyListeners(type, data) {
    for (const listener of this.listeners) {
      try {
        listener(type, data);
      } catch (err) {
        console.error('Error in rateFeed listener:', err);
      }
    }
  }

  start() {
    console.log('[RateFeed] Starting Live Market Rate Feed...');
    this.initWebSockets();
    this.pollRestPrices();
    this.startPollingFallback();
    this.startStaleCheckTimer();
    this.fetchUsdInrRate();
  }

  stop() {
    if (this.pollingInterval) clearInterval(this.pollingInterval);
    for (const sym in this.wsConnections) {
      if (this.wsConnections[sym]) {
        try { this.wsConnections[sym].close(); } catch(e){}
      }
    }
  }

  initWebSockets() {
    const symbols = ['clusdt', 'xagusdt', 'btcusdt'];
    for (const symbolLower of symbols) {
      const symbolUpper = symbolLower.toUpperCase();
      this.connectSymbolWebSocket(symbolUpper, symbolLower);
    }
  }

  connectSymbolWebSocket(symbolUpper, symbolLower) {
    const wsUrl = `wss://fstream.binance.com/ws/${symbolLower}@ticker`;
    
    try {
      const ws = new WebSocket(wsUrl);
      this.wsConnections[symbolUpper] = ws;

      ws.on('open', () => {
        console.log(`[RateFeed] WS Connected for ${symbolUpper}`);
        this.rates[symbolUpper].status = 'CONNECTED';
      });

      ws.on('message', (data) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.c) { // 'c' is last price in ticker stream
            const price = parseFloat(parsed.c);
            const time = parsed.E || Date.now();
            this.updateRate(symbolUpper, price, time, 'BINANCE_FUTURES_WS');
          }
        } catch (e) {
          console.error(`[RateFeed] WS JSON Parse error for ${symbolUpper}:`, e);
        }
      });

      ws.on('error', (err) => {
        console.warn(`[RateFeed] WS Error for ${symbolUpper}:`, err.message);
        this.rates[symbolUpper].status = 'ERROR';
      });

      ws.on('close', () => {
        console.warn(`[RateFeed] WS Closed for ${symbolUpper}. Reconnecting in 5s...`);
        this.rates[symbolUpper].status = 'RECONNECTING';
        setTimeout(() => {
          this.connectSymbolWebSocket(symbolUpper, symbolLower);
        }, 5000);
      });
    } catch (err) {
      console.error(`[RateFeed] Failed to instantiate WS for ${symbolUpper}:`, err);
    }
  }

  startPollingFallback() {
    this.pollingInterval = setInterval(() => {
      this.pollRestPrices();
    }, 2000);
  }

  pollRestPrices() {
    const symbols = ['CLUSDT', 'XAGUSDT', 'BTCUSDT'];
    for (const symbol of symbols) {
      // If WebSocket is quiet for > 4 seconds, poll REST
      if (Date.now() - this.rates[symbol].lastTime > 4000) {
        this.fetchRestPrice(symbol);
      }
    }
  }

  fetchRestPrice(symbol) {
    const futuresUrl = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`;
    http.get(futuresUrl, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.price) {
            const price = parseFloat(data.price);
            const time = data.time || Date.now();
            this.updateRate(symbol, price, time, 'BINANCE_FUTURES_REST');
            return;
          }
        } catch (e) {}
        this.fetchSpotRestPrice(symbol);
      });
    }).on('error', () => {
      this.fetchSpotRestPrice(symbol);
    });
  }

  fetchSpotRestPrice(symbol) {
    const spotUrl = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
    http.get(spotUrl, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.price) {
            const price = parseFloat(data.price);
            const time = Date.now();
            this.updateRate(symbol, price, time, 'BINANCE_SPOT_REST');
          }
        } catch (e) {}
      });
    }).on('error', () => {});
  }

  fetchUsdInrRate() {
    const url = 'https://api.exchangerate-api.com/v4/latest/USD';
    http.get(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.rates && data.rates.INR) {
            this.setUSDINRRate(data.rates.INR);
          }
        } catch (e) {}
      });
    }).on('error', () => {});
  }

  updateRate(symbol, price, time, source) {
    if (!price || isNaN(price)) return;
    const now = Date.now();

    this.rates[symbol] = {
      price,
      lastTime: time,
      receivedTime: now,
      status: 'LIVE',
      source
    };

    this.notifyListeners('tick', {
      symbol,
      price,
      time,
      receivedTime: now,
      status: 'LIVE',
      source,
      usdInrRate: this.usdInrRate
    });
  }

  startStaleCheckTimer() {
    setInterval(() => {
      const now = Date.now();
      for (const symbol in this.rates) {
        const item = this.rates[symbol];
        if (item.lastTime > 0 && now - item.lastTime > this.staleThresholdMs) {
          if (item.status !== 'STALE') {
            console.warn(`[RateFeed] Rate feed for ${symbol} is STALE!`);
            item.status = 'STALE';
            if (symbol === this.activeSymbol) {
              this.notifyListeners('feed_stale', { symbol, lastTime: item.lastTime });
            }
          }
        }
      }
    }, 2000);
  }

  getCurrentRate(symbol = this.activeSymbol) {
    const data = this.rates[symbol];
    const now = Date.now();
    const isStale = !data || !data.price || (now - data.lastTime > this.staleThresholdMs);
    const tickAgeMs = data && data.lastTime ? (now - data.lastTime) : null;

    return {
      symbol,
      price: data ? data.price : null,
      lastTime: data ? data.lastTime : 0,
      lastTickTimeString: data && data.lastTime ? new Date(data.lastTime).toLocaleTimeString() : 'N/A',
      receivedTime: data ? data.receivedTime : 0,
      tickAgeMs,
      source: data ? data.source : 'NONE',
      status: isStale ? 'STALE' : (data ? data.status : 'NO_DATA'),
      isStale,
      usdInrRate: this.usdInrRate,
      usdInrLastUpdated: this.usdInrLastUpdated
    };
  }
}

module.exports = new RateFeedManager();
