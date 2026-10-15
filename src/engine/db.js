const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, '../../data');
const DB_FILE = path.join(DATA_DIR, 'trading_engine.db');
const STATE_JSON_FILE = path.join(DATA_DIR, 'engine_state.json');
const TMP_BACKUP_FILE = path.join('/tmp', 'engine_state_backup.json');
const STATE_SEED_FILE = path.join(__dirname, 'state_seed.json');

class DatabaseManager {
  constructor() {
    this.activePriceReservationsFallback = new Map();
    this.usedPriceLevelsFallback = this.activePriceReservationsFallback;
    this.ensureDirectory();
    this.initDatabase();
  }

  ensureDirectory() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  initDatabase() {
    try {
      const { DatabaseSync } = require('node:sqlite');
      this.db = new DatabaseSync(DB_FILE);

      // Create Tables
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS kv_store (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS active_pairs (
          pair_id TEXT PRIMARY KEY,
          symbol TEXT NOT NULL,
          created_time TEXT NOT NULL,
          created_timestamp INTEGER NOT NULL,
          entry_rate REAL NOT NULL,
          status TEXT NOT NULL,
          data TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS closed_positions (
          position_id TEXT PRIMARY KEY,
          pair_id TEXT NOT NULL,
          direction TEXT NOT NULL,
          symbol TEXT NOT NULL,
          entry_price REAL NOT NULL,
          exit_price REAL NOT NULL,
          net_profit_inr REAL NOT NULL,
          data TEXT NOT NULL,
          closed_timestamp INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
          id TEXT PRIMARY KEY,
          timestamp TEXT NOT NULL,
          event TEXT NOT NULL,
          details TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS order_intents (
          intent_id TEXT PRIMARY KEY,
          symbol TEXT NOT NULL,
          side TEXT NOT NULL,
          quantity REAL NOT NULL,
          price REAL,
          status TEXT NOT NULL,
          mudrex_order_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          data TEXT
        );

        CREATE TABLE IF NOT EXISTS circuit_breaker_events (
          id TEXT PRIMARY KEY,
          timestamp TEXT NOT NULL,
          breaker_name TEXT NOT NULL,
          metric_value REAL NOT NULL,
          threshold REAL NOT NULL,
          details TEXT NOT NULL
        );

        DROP TABLE IF EXISTS used_price_levels;

        CREATE TABLE IF NOT EXISTS active_price_reservations (
          instrument TEXT NOT NULL,
          bucket_key TEXT NOT NULL,
          normalized_price REAL NOT NULL,
          pair_id TEXT NOT NULL,
          raw_price REAL NOT NULL,
          bucket_size REAL NOT NULL,
          direction TEXT DEFAULT 'BOTH',
          created_at TEXT NOT NULL,
          PRIMARY KEY (instrument, bucket_key)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_active_price_reservations_norm 
        ON active_price_reservations (instrument, normalized_price);
      `);
      console.log(`[DBMS] SQLite Database initialized successfully at ${DB_FILE}`);
    } catch (err) {
      console.warn('[DBMS] Built-in SQLite initialization notice, using JSON storage fallback:', err.message);
      this.db = null;
    }
  }

  loadState() {
    try {
      let dbState = null;
      // 1. Try loading from SQLite Database first
      if (this.db) {
        const settingsRow = this.db.prepare("SELECT value FROM kv_store WHERE key = 'settings'").get();
        const dailyTrackerRow = this.db.prepare("SELECT value FROM kv_store WHERE key = 'daily_tracker'").get();
        const processedRatesRow = this.db.prepare("SELECT value FROM kv_store WHERE key = 'processed_rates'").get();
        const lastRateRow = this.db.prepare("SELECT value FROM kv_store WHERE key = 'last_processed_rate'").get();
        const engineRunningRow = this.db.prepare("SELECT value FROM kv_store WHERE key = 'is_engine_running'").get();
        const liveOpenRow = this.db.prepare("SELECT value FROM kv_store WHERE key = 'live_open_positions'").get();
        const liveClosedRow = this.db.prepare("SELECT value FROM kv_store WHERE key = 'live_closed_positions'").get();

        const activePairRows = this.db.prepare("SELECT data FROM active_pairs WHERE status = 'ACTIVE'").all();
        const closedPosRows = this.db.prepare("SELECT data FROM closed_positions ORDER BY closed_timestamp ASC").all();
        const auditLogRows = this.db.prepare("SELECT timestamp, event, details FROM audit_logs ORDER BY timestamp ASC LIMIT 500").all();

        if (settingsRow || activePairRows.length > 0 || closedPosRows.length > 0) {
          const settings = settingsRow ? JSON.parse(settingsRow.value) : null;
          const dailyTracker = dailyTrackerRow ? JSON.parse(dailyTrackerRow.value) : null;
          const processedRates = processedRatesRow ? JSON.parse(processedRatesRow.value) : {};
          const lastProcessedRate = lastRateRow ? JSON.parse(lastRateRow.value) : null;
          const isEngineRunning = engineRunningRow ? JSON.parse(engineRunningRow.value) : true;
          const liveOpenPositions = liveOpenRow ? JSON.parse(liveOpenRow.value) : [];
          const liveClosedPositions = liveClosedRow ? JSON.parse(liveClosedRow.value) : [];

          const pairs = activePairRows.map(r => JSON.parse(r.data));
          const closedPositions = closedPosRows.map(r => JSON.parse(r.data));
          const auditLogs = auditLogRows.map(r => ({
            id: `LOG-${new Date(r.timestamp).getTime()}`,
            timestamp: r.timestamp,
            event: r.event,
            details: JSON.parse(r.details)
          }));

          console.log(`[DBMS] Successfully loaded state from SQLite database (${pairs.length} active pairs, ${closedPositions.length} closed trades).`);

          dbState = {
            settings,
            pairs,
            closedPositions,
            liveOpenPositions,
            liveClosedPositions,
            auditLogs,
            processedRates,
            lastProcessedRate,
            dailyTracker,
            isEngineRunning
          };
        }
      }

      // 2. Load seed reference and backup JSON state
      let seedState = null;
      if (fs.existsSync(STATE_SEED_FILE)) {
        try {
          seedState = JSON.parse(fs.readFileSync(STATE_SEED_FILE, 'utf8'));
        } catch (e) {}
      }

      let jsonBackupState = null;
      const jsonBackupPath = [TMP_BACKUP_FILE, STATE_JSON_FILE].find(p => fs.existsSync(p));
      if (jsonBackupPath) {
        try {
          const raw = fs.readFileSync(jsonBackupPath, 'utf8');
          jsonBackupState = JSON.parse(raw);
          console.log(`[DBMS] Loaded state from JSON backup file ${jsonBackupPath} (${jsonBackupState.closedPositions ? jsonBackupState.closedPositions.length : 0} closed positions).`);
        } catch (e) {}
      }

      const isTestEnv = process.env.IS_TEST === 'true' || process.env.NODE_ENV === 'test';
      let finalState = dbState || jsonBackupState || seedState || {};

      // Safeguard: Ensure authoritative closed trades from seedState are ALWAYS merged and preserved in production
      if (seedState && Array.isArray(seedState.closedPositions)) {
        if (!Array.isArray(finalState.closedPositions)) finalState.closedPositions = [];
        const existingIds = new Set(finalState.closedPositions.map(c => c.positionId));
        for (const t of seedState.closedPositions) {
          if (!existingIds.has(t.positionId)) {
            finalState.closedPositions.push(t);
            existingIds.add(t.positionId);
          }
        }
      }

      // Sort closedPositions chronologically and assign persistent slNo (#1 to #N)
      if (Array.isArray(finalState.closedPositions)) {
        finalState.closedPositions.sort((a, b) => {
          const tA = new Date(a.exitTime || a.closedTimestamp || 0).getTime();
          const tB = new Date(b.exitTime || b.closedTimestamp || 0).getTime();
          return tA - tB;
        });
        finalState.closedPositions.forEach((t, idx) => {
          t.slNo = idx + 1;
        });
      }

      // Safeguard: Ensure active pairs from seedState are preserved in production if current state has none or fewer
      if (!isTestEnv && seedState && Array.isArray(seedState.pairs)) {
        if (!Array.isArray(finalState.pairs) || finalState.pairs.length === 0 || finalState.pairs.length < seedState.pairs.length) {
          finalState.pairs = seedState.pairs;
          if (this.db) {
            try {
              const insertPair = this.db.prepare('INSERT OR REPLACE INTO active_pairs (pair_id, symbol, created_time, created_timestamp, entry_rate, status, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
              for (const p of seedState.pairs) {
                insertPair.run(
                  p.pairId,
                  p.symbol || 'CLUSDT',
                  p.createdTime || new Date().toISOString(),
                  p.createdTimestamp || Date.now(),
                  p.entryRate || 0,
                  p.status || 'ACTIVE',
                  JSON.stringify(p)
                );
              }
            } catch (e) {}
          }
        }
      }


      // Filter out legacy 1.0B benchmark pairs from active pairs in production (only 2.0B pairs with entry >= 93.60 are current)
      if (!isTestEnv && Array.isArray(finalState.pairs)) {
        finalState.pairs = finalState.pairs.filter(p => {
          const qty = p.buyPosition?.quantity || p.sellPosition?.quantity || 1.0;
          const rate = p.entryRate || p.buyPosition?.entryPrice || p.sellPosition?.entryPrice || 0;
          return qty >= 2.0 && rate >= 93.60;
        });
      }

      // Preserve verified Real Mudrex Closed Trades if present in seed
      if (seedState && Array.isArray(seedState.realMudrexClosedTrades)) {
        finalState.realMudrexClosedTrades = seedState.realMudrexClosedTrades;
      }

      if (finalState.punarjanmCount === undefined && seedState && seedState.punarjanmCount !== undefined) {
        finalState.punarjanmCount = seedState.punarjanmCount;
      }
      if (!finalState.lastPunarjanmSummary && seedState && seedState.lastPunarjanmSummary) {
        finalState.lastPunarjanmSummary = seedState.lastPunarjanmSummary;
      }

      if (finalState) {
        finalState.isEngineRunning = false;
        if (!finalState.settings) finalState.settings = {};
        finalState.settings.strategyMode = 'ALTERNATING_STAGGERED';
        finalState.settings.maxActivePairs = 10;
        finalState.settings.startingCapitalINR = 119923.61;
        finalState.settings.tradingMode = 'PAPER';
        finalState.settings.realOrdersDisabled = true;
        return finalState;
      }
    } catch (err) {
      console.error('[DBMS] Error loading state from DBMS:', err);
    }
    return null;
  }

  saveState(state) {
    if (!state) return;

    // 1. Save to SQLite Database
    if (this.db) {
      try {
        this.db.exec('BEGIN TRANSACTION;');

        // Save KV items
        const upsertKv = this.db.prepare('INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
        if (state.settings) upsertKv.run('settings', JSON.stringify(state.settings));
        if (state.dailyTracker) upsertKv.run('daily_tracker', JSON.stringify(state.dailyTracker));
        if (state.processedRates) upsertKv.run('processed_rates', JSON.stringify(state.processedRates));
        if (state.lastProcessedRate !== undefined) upsertKv.run('last_processed_rate', JSON.stringify(state.lastProcessedRate));
        if (state.isEngineRunning !== undefined) upsertKv.run('is_engine_running', JSON.stringify(state.isEngineRunning));
        if (state.liveOpenPositions) upsertKv.run('live_open_positions', JSON.stringify(state.liveOpenPositions));
        if (state.liveClosedPositions) upsertKv.run('live_closed_positions', JSON.stringify(state.liveClosedPositions));

        // Sync Active Pairs
        this.db.prepare('DELETE FROM active_pairs').run();
        if (Array.isArray(state.pairs)) {
          const insertPair = this.db.prepare('INSERT OR REPLACE INTO active_pairs (pair_id, symbol, created_time, created_timestamp, entry_rate, status, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
          for (const pair of state.pairs) {
            insertPair.run(
              pair.pairId,
              pair.symbol || 'CLUSDT',
              pair.createdTime || new Date().toISOString(),
              pair.createdTimestamp || Date.now(),
              pair.entryRate || 0,
              pair.status || 'ACTIVE',
              JSON.stringify(pair)
            );
          }
        }

        // Sync Closed Positions
        this.db.prepare('DELETE FROM closed_positions').run();
        if (Array.isArray(state.closedPositions)) {
          const insertClosed = this.db.prepare('INSERT OR REPLACE INTO closed_positions (position_id, pair_id, direction, symbol, entry_price, exit_price, net_profit_inr, data, closed_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
          for (const cp of state.closedPositions) {
            insertClosed.run(
              cp.positionId,
              cp.pairId,
              cp.direction,
              cp.symbol || 'CLUSDT',
              cp.entryPrice || 0,
              cp.exitPrice || 0,
              cp.netProfitINR || 0,
              JSON.stringify(cp),
              cp.exitTimestamp || Date.now()
            );
          }
        }

        // Sync Audit Logs
        if (Array.isArray(state.auditLogs)) {
          const insertLog = this.db.prepare('INSERT OR IGNORE INTO audit_logs (id, timestamp, event, details) VALUES (?, ?, ?, ?)');
          const recentLogs = state.auditLogs.slice(-100);
          for (const log of recentLogs) {
            insertLog.run(
              log.id || `LOG-${Date.now()}`,
              log.timestamp || new Date().toISOString(),
              log.event || 'EVENT',
              JSON.stringify(log.details || {})
            );
          }
        }

        this.db.exec('COMMIT;');
      } catch (err) {
        try { this.db.exec('ROLLBACK;'); } catch (e) {}
        console.error('[DBMS] SQLite Save Transaction Error:', err);
      }
    }

    // 2. Also save atomic JSON backup & git-tracked seed file
    try {
      this.ensureDirectory();
      const tmpPath = `${STATE_JSON_FILE}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmpPath, STATE_JSON_FILE);
      try { fs.writeFileSync(TMP_BACKUP_FILE, JSON.stringify(state, null, 2), 'utf8'); } catch (e) {}
    } catch (err) {
      console.error('[DBMS] JSON Backup Save Error:', err);
    }
  }

  resetAll() {
    // 1. Permanently Archive Closed Positions & Audit Logs before resetting state
    try {
      this.ensureDirectory();
      const archiveFile = path.join(DATA_DIR, 'archive_history.json');
      let existingArchive = [];
      if (fs.existsSync(archiveFile)) {
        try {
          existingArchive = JSON.parse(fs.readFileSync(archiveFile, 'utf8'));
        } catch (e) {}
      }
      const stateToArchive = this.loadState();
      if (stateToArchive && stateToArchive.closedPositions && stateToArchive.closedPositions.length > 0) {
        existingArchive.push({
          archivedAt: new Date().toISOString(),
          startingCapitalINR: stateToArchive.settings ? stateToArchive.settings.startingCapitalINR : 119923.61,
          closedPositionsCount: stateToArchive.closedPositions.length,
          closedPositions: stateToArchive.closedPositions,
          auditLogs: stateToArchive.auditLogs || []
        });
        fs.writeFileSync(archiveFile, JSON.stringify(existingArchive, null, 2), 'utf8');
        console.log(`[DBMS] Archived ${stateToArchive.closedPositions.length} closed positions to ${archiveFile}`);
      }
    } catch (archiveErr) {
      console.error('[DBMS] Archive Error:', archiveErr);
    }

    if (this.db) {
      try {
        this.db.exec(`
          DELETE FROM kv_store;
          DELETE FROM active_pairs WHERE data NOT LIKE '%REAL_MUDREX_POSITION%' AND data NOT LIKE '%mudrexOrderId%';
          DELETE FROM closed_positions WHERE data NOT LIKE '%REAL_MUDREX_POSITION%' AND data NOT LIKE '%mudrexOrderId%';
          DELETE FROM audit_logs;
        `);
      } catch (err) {
        console.error('[DBMS] Reset DB Error:', err);
      }
    }
    if (fs.existsSync(STATE_JSON_FILE)) {
      try { fs.unlinkSync(STATE_JSON_FILE); } catch (e) {}
    }
    if (fs.existsSync(TMP_BACKUP_FILE)) {
      try { fs.unlinkSync(TMP_BACKUP_FILE); } catch (e) {}
    }
    const cleanSeed = {
      settings: {
        startingCapitalINR: 119923.61,
        contractQuantity: 1.0,
        leverage: 5,
        profitTargetMove: 0.45,
        profitTargetMode: "PRICE_MOVE",
        strategyMode: "ALTERNATING_STAGGERED",
        priceMatchingTolerance: 0.0001,
        maxActivePairs: 10,
        gridSpacing: 0.50,
        tradingMode: "PAPER",
        realOrdersDisabled: true,
        instrument: "SOLUSDT",
        takerFeeRate: 0.00075,
        gstRate: 0.18,
        slippageBufferINR: 5.0,
        usdInrRate: 102.00,
        dailyLossCircuitBreakerINR: 2000
      },
      pairs: [],
      closedPositions: [],
      auditLogs: [{
        id: `LOG-${Date.now()}`,
        timestamp: new Date().toISOString(),
        event: "ENGINE_RESET",
        details: "Simulated state reset cleanly. Old simulated data removed, authoritative live positions preserved."
      }],
      processedRates: { SOLUSDT: [], CLUSDT: [], XAGUSDT: [], BTCUSDT: [] },
      lastProcessedRate: null,
      dailyTracker: {
        dateKey: new Date().toISOString().split('T')[0],
        realizedNetLossINR: 0,
        realizedNetProfitINR: 0
      },
      isEngineRunning: false
    };
    try {
      fs.writeFileSync(STATE_JSON_FILE, JSON.stringify(cleanSeed, null, 2), 'utf8');
    } catch (e) {}
  }

  saveOrderIntent(intent) {
    if (!intent || !intent.intentId) return false;
    const now = new Date().toISOString();
    try {
      if (this.db) {
        const stmt = this.db.prepare(`
          INSERT INTO order_intents (intent_id, symbol, side, quantity, price, status, mudrex_order_id, created_at, updated_at, data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(intent_id) DO UPDATE SET
            status = excluded.status,
            mudrex_order_id = COALESCE(excluded.mudrex_order_id, order_intents.mudrex_order_id),
            updated_at = excluded.updated_at,
            data = excluded.data
        `);
        stmt.run(
          intent.intentId,
          intent.symbol || 'SOLUSDT',
          intent.side || 'BUY',
          Number(intent.quantity || 0),
          Number(intent.price || 0),
          intent.status || 'CREATED',
          intent.mudrexOrderId || null,
          intent.createdAt || now,
          now,
          JSON.stringify(intent)
        );
      }
      return true;
    } catch (e) {
      console.warn('[DBMS] Error saving order intent:', e.message);
      return false;
    }
  }

  getOrderIntent(intentId) {
    if (!intentId) return null;
    try {
      if (this.db) {
        const row = this.db.prepare('SELECT data FROM order_intents WHERE intent_id = ?').get(intentId);
        if (row && row.data) return JSON.parse(row.data);
      }
    } catch (e) {}
    return null;
  }

  findMatchingRecentIntent(symbol, side, quantity, windowMs = 60000) {
    try {
      if (this.db) {
        const rows = this.db.prepare('SELECT data, created_at FROM order_intents WHERE symbol = ? AND side = ? ORDER BY created_at DESC LIMIT 20').all(symbol, side);
        const cutoff = Date.now() - windowMs;
        for (const r of rows) {
          const t = new Date(r.created_at).getTime();
          if (t >= cutoff) {
            const parsed = JSON.parse(r.data);
            if (Math.abs(Number(parsed.quantity) - Number(quantity)) < 0.01) {
              return parsed;
            }
          }
        }
      }
    } catch (e) {}
    return null;
  }

  logCircuitBreakerEvent(event) {
    if (!event) return;
    try {
      if (this.db) {
        const stmt = this.db.prepare(`
          INSERT INTO circuit_breaker_events (id, timestamp, breaker_name, metric_value, threshold, details)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          event.id || `CB-${Date.now()}`,
          event.timestamp || new Date().toISOString(),
          event.breakerName || 'UNKNOWN',
          Number(event.metricValue || 0),
          Number(event.threshold || 0),
          typeof event.details === 'string' ? event.details : JSON.stringify(event.details || {})
        );
      }
    } catch (e) {
      console.warn('[DBMS] Error logging circuit breaker event:', e.message);
    }
  }

  getCircuitBreakerEvents(limit = 50) {
    try {
      if (this.db) {
        return this.db.prepare('SELECT * FROM circuit_breaker_events ORDER BY timestamp DESC LIMIT ?').all(limit);
      }
    } catch (e) {}
    return [];
  }

  // ==========================================
  // ACTIVE PRICE-LEVEL UNIQUENESS & RESERVATION
  // ==========================================

  normalizePriceBucket(price, bucketSize = 0.50) {
    const p = Number(price);
    if (!p || isNaN(p) || p <= 0) return null;
    const b = Number(bucketSize) || 0.50;
    const bucketIndex = Math.round(p / b);
    const normalizedPrice = Number((bucketIndex * b).toFixed(4));
    const bucketKey = normalizedPrice.toFixed(4);
    return { bucketIndex, normalizedPrice, bucketKey, bucketSize: b };
  }

  isActivePriceOccupied(symbol, price, bucketSize = 0.50) {
    const norm = this.normalizePriceBucket(price, bucketSize);
    if (!norm) return false;
    const sym = symbol || 'SOLUSDT';

    if (this.db) {
      try {
        const row = this.db.prepare(
          'SELECT 1 FROM active_price_reservations WHERE instrument = ? AND (bucket_key = ? OR normalized_price = ?) LIMIT 1'
        ).get(sym, norm.bucketKey, norm.normalizedPrice);
        if (row) return true;
      } catch (e) {}
    }

    const fallbackKey = `${sym}:${norm.bucketKey}`;
    return this.activePriceReservationsFallback.has(fallbackKey);
  }

  reserveActivePriceLevel(symbol, rawPrice, pairId, bucketSize = 0.50, direction = 'BOTH') {
    const norm = this.normalizePriceBucket(rawPrice, bucketSize);
    if (!norm) {
      return { success: false, reason: 'INVALID_PRICE', rawPrice };
    }
    const sym = symbol || 'SOLUSDT';
    const fallbackKey = `${sym}:${norm.bucketKey}`;
    const now = new Date().toISOString();

    // Check if already active in fallback
    if (this.activePriceReservationsFallback.has(fallbackKey)) {
      return {
        success: false,
        reason: 'PRICE_LEVEL_ACTIVE',
        instrument: sym,
        normalizedPrice: norm.normalizedPrice,
        bucketKey: norm.bucketKey,
        existing: this.activePriceReservationsFallback.get(fallbackKey)
      };
    }

    if (this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO active_price_reservations (instrument, bucket_key, normalized_price, pair_id, raw_price, bucket_size, direction, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          sym,
          norm.bucketKey,
          norm.normalizedPrice,
          pairId || 'UNASSIGNED',
          Number(rawPrice),
          norm.bucketSize,
          direction || 'BOTH',
          now
        );
      } catch (err) {
        // SQLite unique constraint on primary key or index
        return {
          success: false,
          reason: 'PRICE_LEVEL_ACTIVE',
          instrument: sym,
          normalizedPrice: norm.normalizedPrice,
          bucketKey: norm.bucketKey,
          error: err.message
        };
      }
    }

    const record = {
      instrument: sym,
      bucketKey: norm.bucketKey,
      normalizedPrice: norm.normalizedPrice,
      pairId: pairId || 'UNASSIGNED',
      rawPrice: Number(rawPrice),
      bucketSize: norm.bucketSize,
      direction: direction || 'BOTH',
      createdAt: now
    };
    this.activePriceReservationsFallback.set(fallbackKey, record);

    return {
      success: true,
      instrument: sym,
      normalizedPrice: norm.normalizedPrice,
      bucketKey: norm.bucketKey,
      record
    };
  }

  releaseActivePriceLevel(symbol, pairId, bucketKey = null) {
    const sym = symbol || 'SOLUSDT';
    if (this.db) {
      try {
        if (bucketKey) {
          this.db.prepare('DELETE FROM active_price_reservations WHERE instrument = ? AND (pair_id = ? OR bucket_key = ?)').run(sym, pairId || '', String(bucketKey));
        } else if (pairId) {
          this.db.prepare('DELETE FROM active_price_reservations WHERE instrument = ? AND pair_id = ?').run(sym, pairId);
        }
      } catch (e) {}
    }

    for (const [k, v] of this.activePriceReservationsFallback.entries()) {
      if (k.startsWith(`${sym}:`)) {
        if ((pairId && v.pairId === pairId) || (bucketKey && v.bucketKey === bucketKey)) {
          this.activePriceReservationsFallback.delete(k);
        }
      }
    }
    return { success: true };
  }

  syncActivePriceReservations(symbol, activePairs = [], bucketSize = 0.50) {
    const sym = symbol || 'SOLUSDT';
    if (this.db) {
      try {
        this.db.prepare('DELETE FROM active_price_reservations WHERE instrument = ?').run(sym);
      } catch (e) {}
    }

    for (const k of Array.from(this.activePriceReservationsFallback.keys())) {
      if (k.startsWith(`${sym}:`)) {
        this.activePriceReservationsFallback.delete(k);
      }
    }

    if (!Array.isArray(activePairs) || activePairs.length === 0) return 0;

    let synced = 0;
    for (const pair of activePairs) {
      // Check if pair has any open leg
      const bOpen = pair.buyPosition && pair.buyPosition.status === 'OPEN';
      const sOpen = pair.sellPosition && pair.sellPosition.status === 'OPEN';
      const isOpen = pair.status === 'OPEN' || bOpen || sOpen;
      if (!isOpen) continue;

      const price = Number(pair.entryPrice || (pair.buyPosition && pair.buyPosition.entryPrice) || (pair.sellPosition && pair.sellPosition.entryPrice));
      if (!price || isNaN(price) || price <= 0) continue;

      const res = this.reserveActivePriceLevel(sym, price, pair.pairId, bucketSize, 'BOTH');
      if (res.success) synced++;
    }
    return synced;
  }

  getAllActivePriceReservations(symbol = 'SOLUSDT') {
    const sym = symbol || 'SOLUSDT';
    if (this.db) {
      try {
        return this.db.prepare('SELECT * FROM active_price_reservations WHERE instrument = ? ORDER BY normalized_price ASC').all(sym);
      } catch (e) {}
    }
    const results = [];
    for (const [k, v] of this.activePriceReservationsFallback.entries()) {
      if (k.startsWith(`${sym}:`)) results.push(v);
    }
    return results.sort((a, b) => a.normalizedPrice - b.normalizedPrice);
  }

  // --- Backwards Compatibility Aliases ---
  isPriceLevelLocked(symbol, price, bucketSize = 0.50) {
    return this.isActivePriceOccupied(symbol, price, bucketSize);
  }

  reservePriceLevel(symbol, rawPrice, pairId, reason = 'PAIR_ENTRY', bucketSize = 0.50, direction = 'BOTH') {
    return this.reserveActivePriceLevel(symbol, rawPrice, pairId, bucketSize, direction);
  }

  getAllLockedPriceLevels(symbol = 'SOLUSDT') {
    return this.getAllActivePriceReservations(symbol);
  }

  seedExistingPriceLevels(records, symbol = 'SOLUSDT', bucketSize = 0.50) {
    return this.syncActivePriceReservations(symbol, records, bucketSize);
  }
}

module.exports = new DatabaseManager();
