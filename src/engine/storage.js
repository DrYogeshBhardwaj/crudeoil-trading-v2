const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, '../../data');
const FILE_PATH = path.join(DATA_DIR, 'engine_state.json');

class StorageManager {
  constructor() {
    this.ensureDirectory();
  }

  ensureDirectory() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  loadState() {
    try {
      if (fs.existsSync(FILE_PATH)) {
        const raw = fs.readFileSync(FILE_PATH, 'utf8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.error('[Storage] Error reading state file:', err);
    }
    return null;
  }

  saveState(state) {
    try {
      this.ensureDirectory();
      const tmpPath = `${FILE_PATH}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmpPath, FILE_PATH);
    } catch (err) {
      console.error('[Storage] Error saving state file:', err);
    }
  }
}

module.exports = new StorageManager();
