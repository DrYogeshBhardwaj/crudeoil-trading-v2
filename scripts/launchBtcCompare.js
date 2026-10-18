const http = require('http');
const { spawn, exec } = require('child_process');
const path = require('path');

const PORT = 3000;
const URL = `http://localhost:${PORT}/btc-compare`;

function openBrowser() {
  const startCmd = process.platform === 'win32' ? `start "" "${URL}"` : `open "${URL}"`;
  exec(startCmd, (err) => {
    if (err) console.error('Failed to open browser:', err);
    else console.log(`[BTC Compare Launcher] Opened ${URL} successfully!`);
    setTimeout(() => process.exit(0), 500);
  });
}

function checkServer(callback) {
  const req = http.get(`http://localhost:${PORT}/health`, (res) => {
    callback(true);
  });
  req.on('error', () => {
    callback(false);
  });
  req.setTimeout(800, () => {
    req.destroy();
    callback(false);
  });
}

checkServer((isRunning) => {
  if (isRunning) {
    console.log(`[BTC Compare Launcher] Server already running on port ${PORT}. Opening browser...`);
    openBrowser();
  } else {
    console.log(`[BTC Compare Launcher] Starting local server in background on port ${PORT}...`);
    const projectDir = path.resolve(__dirname, '..');
    const child = spawn('node', ['src/server.js'], {
      cwd: projectDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();

    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      checkServer((ready) => {
        if (ready) {
          clearInterval(poll);
          console.log(`[BTC Compare Launcher] Server is now ready!`);
          openBrowser();
        } else if (attempts >= 10) {
          clearInterval(poll);
          console.log(`[BTC Compare Launcher] Timeout waiting for server, opening browser anyway...`);
          openBrowser();
        }
      });
    }, 500);
  }
});
