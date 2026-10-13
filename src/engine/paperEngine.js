/**
 * paperEngine.js — Compatibility Alias for liveEngine.js
 * 
 * As requested by the user, the core trading engine has graduated from paper to LIVE real trading!
 * The canonical implementation is now in `liveEngine.js`.
 * This file maintains 100% backwards compatibility for existing imports and test suites.
 */
module.exports = require('./liveEngine');
