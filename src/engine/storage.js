const db = require('./db');

class StorageManager {
  loadState() {
    return db.loadState();
  }

  saveState(state) {
    return db.saveState(state);
  }

  resetAll() {
    return db.resetAll();
  }
}

module.exports = new StorageManager();
