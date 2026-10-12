const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, '../../data');
const DB_FILE = path.join(DATA_DIR, 'trading_engine.db');
const STATE_JSON_FILE = path.join(DATA_DIR, 'engine_state.json');
const TMP_BACKUP_FILE = path.join('/tmp', 'engine_state_backup.json');
const STATE_SEED_FILE = path.join(__dirname, 'state_seed.json');

class DatabaseManager {
  constructor() {
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

      // 2. Load from JSON backups and merge if DB missing records
      let jsonBackupState = null;
      const jsonBackupPath = [TMP_BACKUP_FILE, STATE_JSON_FILE, STATE_SEED_FILE].find(p => fs.existsSync(p));
      if (jsonBackupPath) {
        try {
          const raw = fs.readFileSync(jsonBackupPath, 'utf8');
          jsonBackupState = JSON.parse(raw);
          console.log(`[DBMS] Loaded state from JSON backup file ${jsonBackupPath} (${jsonBackupState.closedPositions ? jsonBackupState.closedPositions.length : 0} closed positions).`);
        } catch (e) {}
      }

      let finalState = dbState || jsonBackupState;
      if (finalState) {
        finalState.isEngineRunning = true;
        if (!finalState.settings) finalState.settings = {};
        finalState.settings.strategyMode = 'ALTERNATING_STAGGERED';
        finalState.settings.maxActivePairs = 500;
        finalState.settings.startingCapitalINR = 82978;
        finalState.settings.tradingMode = 'LIVE';
        finalState.settings.realOrdersDisabled = false;
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
      try { fs.writeFileSync(STATE_SEED_FILE, JSON.stringify(state, null, 2), 'utf8'); } catch (e) {}
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
          startingCapitalINR: stateToArchive.settings ? stateToArchive.settings.startingCapitalINR : 82978,
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
          DELETE FROM active_pairs;
          DELETE FROM closed_positions;
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
        startingCapitalINR: 82978,
        contractQuantity: 5.0,
        leverage: 5,
        profitTargetMove: 1.0,
        profitTargetMode: "PRICE_MOVE",
        strategyMode: "ALTERNATING_STAGGERED",
        priceMatchingTolerance: 0.0001,
        maxActivePairs: 500,
        tradingMode: "LIVE",
        realOrdersDisabled: false,
        instrument: "CLUSDT",
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
        details: "All engine positions, processed rates, and history reset to ₹82,978 capital. LIVE Mudrex API trading mode activated."
      }],
      processedRates: { CLUSDT: [], XAGUSDT: [], BTCUSDT: [] },
      lastProcessedRate: null,
      dailyTracker: {
        dateKey: new Date().toISOString().split('T')[0],
        realizedNetLossINR: 0,
        realizedNetProfitINR: 0
      },
      isEngineRunning: true
    };
    try {
      fs.writeFileSync(STATE_SEED_FILE, JSON.stringify(cleanSeed, null, 2), 'utf8');
      fs.writeFileSync(STATE_JSON_FILE, JSON.stringify(cleanSeed, null, 2), 'utf8');
    } catch (e) {}
  }
}

module.exports = new DatabaseManager();
