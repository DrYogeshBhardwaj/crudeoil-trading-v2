const fs = require('fs');
const path = require('path');

const srcPath = path.join(__dirname, '../public/crude_live_mudrex_pro.html');
const dstPath = path.join(__dirname, '../public/solana_live_mudrex.html');

let html = fs.readFileSync(srcPath, 'utf8');

// 1. Title & Favicon
html = html.replace(
  '<title>Crude-Live-Mudrex-Pro — Live Pair Trading Desk & Performance Analytics</title>',
  '<title>Crude-Live-Mudrex-Solana — Solana (SOL) Live Pair Trading Desk & Performance Analytics</title>'
);

html = html.replace(
  /<link rel="icon" type="image\/svg\+xml" href="[^"]+">/,
  '<link rel="icon" type="image/svg+xml" href="/solana-favicon.svg">'
);

// 2. Solana Logo SVG in Header
const solanaLogoSvg = `
<svg width="24" height="24" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M 28 32 L 95 32 C 98 32 101 34.5 99.5 37.5 L 94 47 C 93 49 90.5 50 88 50 L 21 50 C 18 50 15 47.5 16.5 44.5 L 22 35 C 23 33 25.5 32 28 32 Z" fill="url(#solLogoGrad)" />
  <path d="M 22 59 L 89 59 C 91.5 59 94 60 95 62 L 100.5 71.5 C 102 74.5 99 77 96 77 L 29 77 C 26.5 77 24 76 23 74 L 17.5 64.5 C 16 61.5 19 59 22 59 Z" fill="url(#solLogoGrad)" />
  <path d="M 28 86 L 95 86 C 98 86 101 88.5 99.5 91.5 L 94 101 C 93 103 90.5 104 88 104 L 21 104 C 18 104 15 101.5 16.5 98.5 L 22 89 C 23 87 25.5 86 28 86 Z" fill="url(#solLogoGrad)" />
  <defs>
    <linearGradient id="solLogoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#00FFA3" />
      <stop offset="50%" stop-color="#03E1FF" />
      <stop offset="100%" stop-color="#DC1FFF" />
    </linearGradient>
  </defs>
</svg>
`;

html = html.replace(
  '<div class="brand-logo-badge">🛢️</div>',
  `<div class="brand-logo-badge" style="background: linear-gradient(135deg, #1e1b4b, #0f172a); border: 1px solid rgba(0, 255, 163, 0.4);">${solanaLogoSvg.trim()}</div>`
);

// 3. Header Title & Subtitle
html = html.replace(
  'Crude-Live-Mudrex-Pro <span class="page-tag">PRO DESK</span>',
  'Crude-Live-Mudrex-Solana <span class="page-tag" style="background: rgba(168, 85, 247, 0.15); border-color: rgba(168, 85, 247, 0.4); color: #c084fc;">SOLANA PRO DESK · SIMULATOR</span>'
);

html = html.replace(
  'Mudrex Futures Engine — CLUSDT Hedged Pair Strategy & Exchange Sync',
  'Solana Futures Simulation Engine — SOLUSDT Hedged Pair Strategy & Mudrex Rate Sync (₹1.5 Lakh Capital)'
);

// 4. Rate Ticker Hero Banner
html = html.replace(
  'CLUSDT CRUDE OIL LIVE RATE',
  'SOLUSDT SOLANA LIVE RATE'
);

html = html.replace(
  'Mark: $92.90 | USD/INR: 102.00 | 2.00 Lot',
  'Mark: $106.30 | USD/INR: 102.00 | 2.00 SOL Lot'
);

// 5. Margin card label
html = html.replace(
  'MUDREX AVAILABLE MARGIN',
  'MUDREX AVAILABLE MARGIN (SOL)'
);

// 6. Barrels to SOL across HTML strings
html = html.replace(/2 Barrels/g, '2 SOL');
html = html.replace(/2\.0 Barrels/g, '2.0 SOL');
html = html.replace(/BARRELS/g, 'SOL');
html = html.replace(/BBL/g, 'SOL');

// 7. API URLs
html = html.replace(
  /\/api\/crude-live-mudrex\/data/g,
  '/api/solana-live-mudrex/data'
);
html = html.replace(
  /\/api\/crude-live-mudrex-pro\/data/g,
  '/api/solana-live-mudrex/data'
);

html = html.replace(
  /\/api\/crude-live-mudrex\/action/g,
  '/api/solana-live-mudrex/action'
);
html = html.replace(
  /\/api\/crude-live-mudrex-pro\/action/g,
  '/api/solana-live-mudrex/action'
);

// 8. Default Instrument
html = html.replace(/'CLUSDT'/g, "'SOLUSDT'");
html = html.replace(/"CLUSDT"/g, '"SOLUSDT"');

// 9. Initial Defaults in JS
html = html.replace(/contractQty = [0-9.]+/g, 'contractQty = 2.0');
html = html.replace(/targetMove = [0-9.]+/g, 'targetMove = 0.50');

// 10. Update initial placeholder prices
html = html.replace(/id="heroLiveRate">\$[0-9.]+/g, 'id="heroLiveRate">$106.30');

// Save the generated file
fs.writeFileSync(dstPath, html, 'utf8');
console.log(`[Generate] Successfully generated ${dstPath} (Size: ${html.length} bytes).`);
