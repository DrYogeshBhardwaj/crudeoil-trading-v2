const fs = require('fs');
const path = require('path');

const srcPath = path.join(__dirname, '../public/solana_live_mudrex.html');
const dstPath = path.join(__dirname, '../public/btc_live_mudrex_pro.html');

let html = fs.readFileSync(srcPath, 'utf8');

// 1. Page Title & Favicon
html = html.replace(
  /<title>.*?<\/title>/,
  '<title>BTC-Live-Mudrex-Pro — Bitcoin (BTC) Live Pair Trading Desk & Performance Analytics</title>'
);

// 2. Bitcoin Logo SVG in Header
const btcLogoSvg = `
<svg width="24" height="24" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="64" cy="64" r="64" fill="#F7931A"/>
  <path d="M86.8 51.5c1.4-9.3-5.7-14.3-15.4-17.6l3.1-12.6-7.7-1.9-3.1 12.3c-2-.5-4.1-1-6.2-1.5l3.1-12.4-7.7-1.9-3.1 12.6c-1.7-.4-3.4-.8-5-.1l-.1-.4-10.6-2.6-2.1 8.2s5.7 1.3 5.6 1.4c3.1.8 3.7 2.9 3.6 4.6l-3.6 14.5c.2.1.5.1.8.3-.3-.1-.5-.2-.8-.3l-5.1 20.3c-.4 1-.1 2.3-2.3 1.8.1.1-5.6-1.4-5.6-1.4l-3.8 8.8 10 2.5c1.9.5 3.7 1 5.6 1.5l-3.2 12.7 7.7 1.9 3.1-12.5c2.1.6 4.1 1.1 6.1 1.6l-3.1 12.5 7.7 1.9 3.2-12.6c13.2 2.5 23.1 1.5 27.2-10.4 3.4-9.6-.2-15.1-7.1-18.7 5.1-1.2 8.9-4.5 9.9-11.4zm-17.7 24.8c-2.4 9.6-18.6 4.4-23.9 3.1l4.3-17.1c5.3 1.3 22.1 3.9 19.6 14zm2.4-24.9c-2.2 8.7-15.7 4.3-20.1 3.2l3.9-15.5c4.4 1.1 18.5 3.2 16.2 12.3z" fill="#FFF"/>
</svg>
`;

html = html.replace(
  /<div class="brand-logo-badge".*?<\/div>/s,
  `<div class="brand-logo-badge" style="background: linear-gradient(135deg, #2b1800, #451a03); border: 1.5px solid #f59e0b; box-shadow: 0 0 15px rgba(245, 158, 11, 0.4);">${btcLogoSvg.trim()}</div>`
);

// 3. Header Titles & Subtitles
html = html.replace(
  /Solana-Live-Mudrex\s*<span class="page-tag".*?<\/span>/s,
  'BTC-Live-Mudrex-Pro <span class="page-tag" style="background: rgba(245, 158, 11, 0.15); border-color: rgba(245, 158, 11, 0.5); color: #fbbf24; font-weight: 800;">BTC PRO DESK · SIMULATOR</span>'
);

html = html.replace(
  'Solana Futures Simulation Engine — SOLUSDT Hedged Pair Strategy & Mudrex Rate Sync (₹3.0 Lakh Capital)',
  'Bitcoin Futures Simulation Engine — BTCUSDT Hedged Pair Strategy & Mudrex Rate Sync (₹1.0 Lakh Capital)'
);

// 4. Navigation Actions (Add links to Crude, Solana, and BTC Study)
html = html.replace(
  /<div class="nav-actions">[\s\S]*?<button class="btn btn-amber"/,
  `<div class="nav-actions">
        <a href="/Crude-Live-Mudrex-Pro" class="btn btn-outline" style="text-decoration: none; border-color: rgba(56, 189, 248, 0.4); color: #38bdf8;">
          <span>🛢️ CRUDE DESK</span>
        </a>
        <a href="/Solana-Live-Mudrex" class="btn btn-outline" style="text-decoration: none; border-color: rgba(168, 85, 247, 0.4); color: #c084fc;">
          <span>🟣 SOLANA DESK</span>
        </a>
        <a href="/btc-study" class="btn btn-outline" style="text-decoration: none; border-color: rgba(245, 158, 11, 0.4); color: #fbbf24;">
          <span>📚 BTC STUDY</span>
        </a>
        <button class="btn btn-amber"`
);

// 5. Hero Ticker Banner updates
html = html.replace('🟣 SOLUSDT SOLANA LIVE RATE', '🟡 BTCUSDT BITCOIN LIVE RATE');
html = html.replace('USD/INR: ₹102.00 | 3.0 SOL Lot', 'USD/INR: ₹102.00 | 0.001 BTC Lot');
html = html.replace('🎯 BUY TARGET EXIT (+$0.50)', '🎯 BUY TARGET EXIT (+$150)');
html = html.replace('🎯 SELL TARGET EXIT (-$0.50)', '🎯 SELL TARGET EXIT (-$150)');
html = html.replace('3.0 SOL/Leg | 5x Lev | Simulator: ACTIVE', '0.001 BTC/Leg | 10x Lev | Grid: $250');
html = html.replace('LONG 0 SOL', 'LONG 0 BTC');
html = html.replace('0 SOL', '0 BTC');
html = html.replace('SOLANA SIMULATOR', 'BTC PRO SIMULATOR');

// 6. Replace Solana with BTC / Bitcoin across labels
html = html.replace(/SOLUSDT/g, 'BTCUSDT');
html = html.replace(/SOLANA/g, 'BITCOIN');
html = html.replace(/Solana/g, 'Bitcoin');
html = html.replace(/\bSOL\b/g, 'BTC');

// 7. API Endpoints
html = html.replace(/\/api\/solana-live-mudrex\/data/g, '/api/btc-live-mudrex/data');
html = html.replace(/\/api\/solana-live-mudrex\/action/g, '/api/btc-live-mudrex/action');

// 8. Customization Launchpad defaults for BTC
html = html.replace('value="300000"', 'value="100000"');
html = html.replace('value="3.0"', 'value="0.001"');
html = html.replace('value="0.50"', 'value="150"');
html = html.replace('min="0.1" max="100" step="0.5"', 'min="0.0001" max="10" step="0.0005"');
html = html.replace('min="0.05" max="10" step="0.05"', 'min="10" max="5000" step="10"');
html = html.replace(/₹300,000/g, '₹100,000');
html = html.replace(/3\.0 BTC/g, '0.001 BTC');
html = html.replace(/\$0\.50/g, '$150.00');

// 9. Update JavaScript calculation logic for BTC
html = html.replace(
  'const livePrice = (cachedData && cachedData.rate && cachedData.rate.price) || 104.70;',
  'const livePrice = (cachedData && cachedData.rate && cachedData.rate.price) || 82000.00;'
);
html = html.replace(
  'const amount = amountEl ? parseFloat(amountEl.value) || 0 : 300000;',
  'const amount = amountEl ? parseFloat(amountEl.value) || 0 : 100000;'
);
html = html.replace(
  'const solQty = solQtyEl ? parseFloat(solQtyEl.value) || 0 : 3.0;',
  'const solQty = solQtyEl ? parseFloat(solQtyEl.value) || 0 : 0.001;'
);
html = html.replace(
  'const targetMove = targetMoveEl ? parseFloat(targetMoveEl.value) || 0 : 0.50;',
  'const targetMove = targetMoveEl ? parseFloat(targetMoveEl.value) || 0 : 150.00;'
);
html = html.replace(
  'const pairMargin = ((livePrice * solQty * usdInr) / 5) * 2;',
  'const pairMargin = ((livePrice * solQty * usdInr) / 10) * 2;'
);

fs.writeFileSync(dstPath, html, 'utf8');
console.log('Successfully generated public/btc_live_mudrex_pro.html');
