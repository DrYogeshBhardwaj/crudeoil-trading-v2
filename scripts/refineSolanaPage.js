const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../public/solana_live_mudrex.html');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Title
content = content.replace(
  /<title>.*?<\/title>/,
  '<title>Crude-Live-Mudrex-Solana — Solana Futures Simulator &amp; Live Pair Desk</title>'
);

// 2. Header Title & Badge
content = content.replace(
  /<h1>\s*Crude-Live-Mudrex-Pro\s*<span class="page-tag">PRO DESK<\/span>\s*<\/h1>/,
  `<h1>
            Crude-Live-Mudrex-Solana
            <span class="page-tag" style="background: linear-gradient(135deg, rgba(0, 255, 163, 0.2), rgba(3, 225, 255, 0.2)); border: 1px solid #00ffa3; color: #00ffa3; font-weight: 800;">SOLANA SIMULATOR</span>
          </h1>`
);

// 3. Fallback header subtitle if needed
content = content.replace(
  'Crude-Live-Mudrex-Pro',
  'Crude-Live-Mudrex-Solana'
);

// 4. Initial Realized Net Profit HTML
content = content.replace(
  '<div class="kpi-val-primary" style="color: var(--accent-green-bright);" id="kpiRealizedNetINR">+₹2,540.90</div>',
  '<div class="kpi-val-primary" style="color: var(--accent-green-bright);" id="kpiRealizedNetINR">+₹0.00</div>'
);
content = content.replace(
  '<div class="kpi-val-secondary" id="kpiRealizedNetUSD">+ $26.21 Net (33 Trades)</div>',
  '<div class="kpi-val-secondary" id="kpiRealizedNetUSD">+ $0.00 Net (0 Trades)</div>'
);

// 5. In JS, fix realized PnL fallback logic so 0 is correctly respected
content = content.replace(
  'const rINR = pnl.totalRealizedINR || 2540.90;',
  'const rINR = Number.isFinite(pnl.totalRealizedINR) ? pnl.totalRealizedINR : (Number.isFinite(pnl.realizedNetINR) ? pnl.realizedNetINR : 0);'
);
content = content.replace(
  'const rUSD = pnl.totalRealizedUSD || 26.21;',
  'const rUSD = Number.isFinite(pnl.totalRealizedUSD) ? pnl.totalRealizedUSD : (Number.isFinite(pnl.realizedNetUSD) ? pnl.realizedNetUSD : 0);'
);
content = content.replace(
  '${pnl.closedTradesCount || 33} Trades',
  '${Number.isFinite(pnl.totalClosedTrades) ? pnl.totalClosedTrades : (Number.isFinite(pnl.closedTradesCount) ? pnl.closedTradesCount : 0)} Trades'
);

// 6. Table headers: Barrels -> SOL
content = content.replace(/>Barrels </g, '>SOL <');
content = content.replace(/<th>Barrels<\/th>/g, '<th>SOL</th>');
content = content.replace(/<th>Volume \(Barrels\)<\/th>/g, '<th>Volume (SOL)</th>');
content = content.replace(/Trading Volume \(Barrels\)/g, 'Trading Volume (SOL)');
content = content.replace(/Lot Size \(Barrels\)/g, 'Lot Size (SOL)');

// 7. Initial Mudrex nav badge: 109 SOL -> 0 SOL
content = content.replace(
  '<span class=\"badge\" id=\"navMudrexBadge\" style=\"background: rgba(0,0,0,0.4); font-size: 0.72rem; padding: 2px 6px; border-radius: 4px; margin-left: 4px;\">109 SOL</span>',
  '<span class=\"badge\" id=\"navMudrexBadge\" style=\"background: rgba(0,0,0,0.4); font-size: 0.72rem; padding: 2px 6px; border-radius: 4px; margin-left: 4px;\">0 SOL</span>'
);

// 8. Hero active pairs subtext
content = content.replace(
  '2.0 B/Leg | 5x Lev | Auto-Add: ACTIVE',
  '2.0 SOL/Leg | 5x Lev | Simulator: ACTIVE'
);

// 9. Initial hero subtext
content = content.replace(
  'Entry: $93.74 | Liq: $110.61',
  'Entry: -- | Liq: --'
);
content = content.replace(
  'SHORT 16 SOL',
  'LONG 0 SOL'
);

fs.writeFileSync(filePath, content, 'utf8');
console.log('Successfully refined public/solana_live_mudrex.html!');
