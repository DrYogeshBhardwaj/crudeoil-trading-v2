let currentMetrics = null;
let eventSource = null;
let backtestRunsHistory = []; // In-memory store for multi-run comparison

const INSTRUMENT_TARGET_OPTIONS = {
  CLUSDT: [
    { value: '0.05', label: '$0.05 Target Move' },
    { value: '0.10', label: '$0.10 Target Move' },
    { value: '0.15', label: '$0.15 Target Move' },
    { value: '0.20', label: '$0.20 Target Move (Crude Standard)' },
    { value: '0.25', label: '$0.25 Target Move' },
    { value: '0.50', label: '$0.50 Target Move' },
    { value: '1.00', label: '$1.00 Target Move' },
    { value: 'DISABLED', label: 'Disabled (No Auto Target)' }
  ],
  XAGUSDT: [
    { value: '0.05', label: '$0.05 Target Move' },
    { value: '0.10', label: '$0.10 Target Move' },
    { value: '0.15', label: '$0.15 Target Move' },
    { value: '0.25', label: '$0.25 Target Move' },
    { value: '0.50', label: '$0.50 Target Move' },
    { value: '1.00', label: '$1.00 Target Move' },
    { value: '1.15', label: '$1.15 Target Move (Silver Standard)' },
    { value: '1.50', label: '$1.50 Target Move' },
    { value: '2.00', label: '$2.00 Target Move' },
    { value: 'DISABLED', label: 'Disabled (No Auto Target)' }
  ],
  BTCUSDT: [
    { value: '10.00', label: '$10.00 Target Move' },
    { value: '25.00', label: '$25.00 Target Move' },
    { value: '50.00', label: '$50.00 Target Move' },
    { value: '100.00', label: '$100.00 Target Move' },
    { value: '250.00', label: '$250.00 Target Move' },
    { value: '500.00', label: '$500.00 Target Move' },
    { value: 'DISABLED', label: 'Disabled (No Auto Target)' }
  ]
};

function updateTargetDropdownOptions(symbol, currentTargetValStr) {
  const select = document.getElementById('settingTargetMove');
  if (!select) return;

  const options = INSTRUMENT_TARGET_OPTIONS[symbol] || INSTRUMENT_TARGET_OPTIONS.CLUSDT;
  let html = '';
  let matchFound = false;

  const targetStr = currentTargetValStr !== undefined && currentTargetValStr !== null ? currentTargetValStr.toString() : '';

  options.forEach(opt => {
    const isSelected = (opt.value === targetStr);
    if (isSelected) matchFound = true;
    html += `<option value="${opt.value}" ${isSelected ? 'selected' : ''}>${opt.label}</option>`;
  });

  if (!matchFound && options.length > 0) {
    const defaultVal = symbol === 'XAGUSDT' ? '1.15' : (symbol === 'CLUSDT' ? '0.20' : '50.00');
    html = '';
    options.forEach(opt => {
      const isSelected = (opt.value === defaultVal);
      html += `<option value="${opt.value}" ${isSelected ? 'selected' : ''}>${opt.label}</option>`;
    });
  }

  select.innerHTML = html;
}

function onInstrumentSelectChanged() {
  const instrument = document.getElementById('settingInstrument').value;
  const defaultVal = instrument === 'XAGUSDT' ? '1.15' : (instrument === 'CLUSDT' ? '0.20' : '50.00');
  updateTargetDropdownOptions(instrument, defaultVal);
  
  const btTargetInput = document.getElementById('btTargetMove');
  if (btTargetInput) {
    btTargetInput.value = defaultVal === 'DISABLED' ? '0.20' : defaultVal;
  }
  
  applySettingChange();
}

document.addEventListener('DOMContentLoaded', () => {
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('btDate').value = today;
  document.getElementById('btFromDate').value = today;
  document.getElementById('btToDate').value = today;

  updateTargetDropdownOptions('CLUSDT', '0.20');
  initRealtimeStream();
});

function toggleBtModeDisplay() {
  const mode = document.getElementById('btMode').value;
  const singleGroup = document.getElementById('btSingleDateGroup');
  const fromGroup = document.getElementById('btFromDateGroup');
  const toGroup = document.getElementById('btToDateGroup');

  if (mode === 'RANGE') {
    singleGroup.style.display = 'none';
    fromGroup.style.display = 'flex';
    toGroup.style.display = 'flex';
  } else {
    singleGroup.style.display = 'flex';
    fromGroup.style.display = 'none';
    toGroup.style.display = 'none';
  }
}

function initRealtimeStream() {
  eventSource = new EventSource('/api/stream');

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      currentMetrics = data;
      renderDashboard(data);
    } catch (e) {
      console.error('Error parsing SSE message:', e);
    }
  };

  eventSource.onerror = (err) => {
    console.warn('SSE Stream error. Reconnecting fallback polling...', err);
    fetchMetricsFallback();
  };
}

function fetchMetricsFallback() {
  fetch('/api/metrics')
    .then(r => r.json())
    .then(res => {
      if (res.success) {
        currentMetrics = res.data;
        renderDashboard(res.data);
      }
    })
    .catch(e => console.error('Fallback fetch error:', e));
}

function renderDashboard(data) {
  const { rateFeedInfo, summary, settings, engineStatus, pauseReason, isEngineRunning, lastProcessedRate, processedRatesCount, openPositions, closedPositions, auditLogs } = data;

  const currentSymbol = settings.instrument;
  const symbolLabels = {
    CLUSDT: 'CLUSDT — Crude Oil',
    XAGUSDT: 'XAGUSDT — Silver',
    BTCUSDT: 'BTCUSDT — Bitcoin'
  };
  document.getElementById('currentSymbolLabel').innerText = symbolLabels[currentSymbol] || currentSymbol;

  const priceDecimals = currentSymbol === 'BTCUSDT' ? 2 : (currentSymbol === 'XAGUSDT' ? 4 : 2);
  const tickerPriceEl = document.getElementById('liveTickerPrice');
  const oldPrice = parseFloat(tickerPriceEl.innerText.replace('$', '')) || 0;
  const newPrice = rateFeedInfo.price;

  if (newPrice) {
    tickerPriceEl.innerText = '$' + newPrice.toFixed(priceDecimals);
    if (newPrice > oldPrice) {
      tickerPriceEl.className = 'ticker-value up';
    } else if (newPrice < oldPrice) {
      tickerPriceEl.className = 'ticker-value down';
    }
  } else {
    tickerPriceEl.innerText = 'FETCHING...';
    tickerPriceEl.className = 'ticker-value';
  }

  const tickTimeStr = rateFeedInfo.lastTickTimeString || 'N/A';
  const ageMs = rateFeedInfo.tickAgeMs !== null && rateFeedInfo.tickAgeMs !== undefined ? rateFeedInfo.tickAgeMs : 0;
  const ageSec = (ageMs / 1000).toFixed(1);
  document.getElementById('tickTimeAgeDisplay').innerText = `${tickTimeStr} (${ageMs < 2000 ? ageMs + 'ms' : ageSec + 's'})`;

  document.getElementById('lastProcessedRateDisplay').innerText = lastProcessedRate ? `$${lastProcessedRate.toFixed(priceDecimals)}` : 'NONE';
  document.getElementById('usdInrDisplay').innerText = `₹${rateFeedInfo.usdInrRate.toFixed(2)}`;

  // Feed Status Badge
  const feedBadge = document.getElementById('feedStatusBadge');
  const feedText = document.getElementById('feedStatusText');
  const statusStr = rateFeedInfo.status;

  if (statusStr === 'LIVE') {
    feedBadge.className = 'status-badge live';
    feedText.innerText = 'LIVE FEED';
  } else if (statusStr === 'STALE') {
    feedBadge.className = 'status-badge stale';
    feedText.innerText = 'STALE FEED';
  } else {
    feedBadge.className = 'status-badge stale';
    feedText.innerText = statusStr;
  }

  // Header Toggle Button
  const toggleBtn = document.getElementById('toggleEngineBtn');
  const toggleText = document.getElementById('toggleEngineBtnText');
  if (isEngineRunning) {
    toggleBtn.className = 'btn btn-warning';
    toggleText.innerText = 'PAUSE ENGINE';
  } else {
    toggleBtn.className = 'btn btn-primary';
    toggleText.innerText = 'START ENGINE';
  }

  // Engine Pause Alert Banner
  const alertBanner = document.getElementById('engineAlertBanner');
  const alertText = document.getElementById('engineAlertText');
  if (engineStatus === 'PAUSED' || !isEngineRunning) {
    alertBanner.style.display = 'flex';
    alertText.innerText = `⚠️ ENGINE STATUS: ${pauseReason || (isEngineRunning ? 'PAUSED' : 'STOPPED')}`;
  } else {
    alertBanner.style.display = 'none';
  }

  // KPI Cards
  document.getElementById('kpiTotalEquity').innerText = `₹${summary.totalEquityINR.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  document.getElementById('kpiEquitySubtext').innerText = `Capital: ₹${summary.startingCapitalINR.toLocaleString('en-IN')}`;

  document.getElementById('kpiRealizedBalance').innerText = `₹${summary.realizedBalanceINR.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const realizedNetEl = document.getElementById('kpiRealizedNet');
  realizedNetEl.innerText = `₹${summary.realizedNetINR.toFixed(2)}`;
  realizedNetEl.className = `kpi-value ${summary.realizedNetINR >= 0 ? 'text-green' : 'text-red'}`;
  document.getElementById('kpiRealizedGrossSubtext').innerText = `Gross: $${summary.realizedGrossUSD.toFixed(2)} | Charges: ₹${summary.realizedChargesINR.toFixed(2)}`;

  const floatNetEl = document.getElementById('kpiFloatingNet');
  floatNetEl.innerText = `₹${summary.floatingNetINR.toFixed(2)}`;
  floatNetEl.className = `kpi-value ${summary.floatingNetINR >= 0 ? 'text-green' : 'text-red'}`;
  document.getElementById('kpiFloatingSubtext').innerText = `Gross: $${summary.floatingGrossUSD.toFixed(2)} | Charges: ₹${summary.floatingChargesINR.toFixed(2)}`;

  document.getElementById('kpiActivePairs').innerText = `${summary.activePairsCount} / ${summary.maxActivePairs}`;
  document.getElementById('kpiUniqueRatesCount').innerText = `Processed Rates: ${processedRatesCount} unique`;

  document.getElementById('kpiAvailableMargin').innerText = `₹${summary.availableMarginINR.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  document.getElementById('kpiMarginUsed').innerText = `Margin Used: ₹${summary.marginUsedINR.toFixed(2)} (${settings.leverage}x)`;

  const dailyLossEl = document.getElementById('kpiDailyLoss');
  dailyLossEl.innerText = `₹${summary.dailyRealizedLossINR.toFixed(2)}`;
  dailyLossEl.className = `kpi-value ${summary.dailyRealizedLossINR >= summary.dailyLossLimitINR ? 'text-red' : 'text-yellow'}`;
  document.getElementById('kpiDailyLimit').innerText = `Circuit Limit: ₹${summary.dailyLossLimitINR.toLocaleString('en-IN')}`;

  document.getElementById('kpiWinRate').innerText = `${summary.winRate}%`;
  document.getElementById('kpiTradesCount').innerText = `Total: ${summary.closedPositionsCount} | Wins: ${summary.winCount} | Losses: ${summary.lossCount}`;

  // Controls sync
  document.getElementById('settingInstrument').value = settings.instrument;
  const targetValStr = settings.targetDisabled ? 'DISABLED' : settings.profitTargetMove.toString();
  updateTargetDropdownOptions(settings.instrument, targetValStr);
  document.getElementById('settingMaxPairs').value = settings.maxActivePairs;
  document.getElementById('settingDailyLoss').value = settings.dailyLossCircuitBreakerINR;
  document.getElementById('settingUsdInr').value = settings.usdInrRate || rateFeedInfo.usdInrRate;

  // Tabs count badges
  document.getElementById('tabActiveCount').innerText = openPositions.length;
  document.getElementById('tabClosedCount').innerText = closedPositions.length;

  // Render Tables
  renderActivePositions(openPositions, settings.instrument);
  renderClosedPositions(closedPositions, settings.instrument);
  
  if (document.getElementById('tabLogs').classList.contains('active')) {
    renderAuditLogs(auditLogs);
  }
}

function renderActivePositions(positions, symbol) {
  const tbody = document.getElementById('activePositionsTbody');
  if (!positions || positions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12" style="text-align: center; color: var(--text-dim); padding: 24px;">No active open positions. Engine will open 1 pair per unique market rate.</td></tr>`;
    return;
  }

  let html = '';
  const priceDecimals = symbol === 'BTCUSDT' ? 2 : (symbol === 'XAGUSDT' ? 4 : 2);

  for (const pos of positions) {
    const isBuy = pos.direction === 'BUY';
    const grossClass = pos.floatingGrossUSD >= 0 ? 'text-green' : 'text-red';
    const netClass = pos.floatingNetINR >= 0 ? 'text-green' : 'text-red';

    html += `
      <tr>
        <td><strong>${pos.pairId}</strong></td>
        <td><code style="color:var(--accent-cyan);">${pos.positionId}</code></td>
        <td><span class="badge-direction ${isBuy ? 'buy' : 'sell'}">${pos.direction}</span></td>
        <td>${new Date(pos.entryTime).toLocaleTimeString()}</td>
        <td>$${pos.entryPrice.toFixed(priceDecimals)}</td>
        <td>$${pos.currentPrice.toFixed(priceDecimals)}</td>
        <td>${pos.targetExitPrice ? '$' + pos.targetExitPrice.toFixed(priceDecimals) : '<span style="color:var(--text-dim)">DISABLED</span>'}</td>
        <td class="${grossClass}">$${pos.floatingGrossUSD >= 0 ? '+' : ''}${pos.floatingGrossUSD.toFixed(4)}</td>
        <td>₹${pos.floatingChargesINR.toFixed(2)}</td>
        <td class="${netClass}" style="font-weight:700;">₹${pos.floatingNetINR >= 0 ? '+' : ''}${pos.floatingNetINR.toFixed(2)}</td>
        <td><span class="status-badge live" style="padding:2px 6px; font-size:0.7rem;">OPEN</span></td>
        <td>
          <button class="btn btn-danger" style="padding: 2px 8px; font-size: 0.72rem;" onclick="manualClose('${pos.positionId}')">Close</button>
        </td>
      </tr>
    `;
  }
  tbody.innerHTML = html;
}

function renderClosedPositions(positions, symbol) {
  const tbody = document.getElementById('closedPositionsTbody');
  if (!positions || positions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="13" style="text-align: center; color: var(--text-dim); padding: 24px;">No closed positions recorded yet.</td></tr>`;
    return;
  }

  let html = '';
  const priceDecimals = symbol === 'BTCUSDT' ? 2 : (symbol === 'XAGUSDT' ? 4 : 2);

  for (const pos of positions) {
    const isBuy = pos.direction === 'BUY';
    const grossClass = pos.grossProfitUSD >= 0 ? 'text-green' : 'text-red';
    const netClass = pos.netProfitINR >= 0 ? 'text-green' : 'text-red';

    html += `
      <tr>
        <td><strong>${pos.pairId}</strong></td>
        <td><code style="color:var(--accent-cyan);">${pos.positionId}</code></td>
        <td><span class="badge-direction ${isBuy ? 'buy' : 'sell'}">${pos.direction}</span></td>
        <td>${new Date(pos.entryTime).toLocaleTimeString()}</td>
        <td>${new Date(pos.exitTime).toLocaleTimeString()}</td>
        <td>$${pos.entryPrice.toFixed(priceDecimals)}</td>
        <td>$${pos.exitPrice.toFixed(priceDecimals)}</td>
        <td>${pos.targetExitPrice ? '$' + pos.targetExitPrice.toFixed(priceDecimals) : 'N/A'}</td>
        <td class="${grossClass}">$${pos.grossProfitUSD >= 0 ? '+' : ''}${pos.grossProfitUSD.toFixed(4)}</td>
        <td>₹${pos.totalChargesINR.toFixed(2)}</td>
        <td class="${netClass}" style="font-weight:700;">₹${pos.netProfitINR >= 0 ? '+' : ''}${pos.netProfitINR.toFixed(2)}</td>
        <td><span class="badge-reason">${pos.exitReason}</span></td>
        <td>${pos.holdingDurationSec}s</td>
      </tr>
    `;
  }
  tbody.innerHTML = html;
}

function switchTab(tabId) {
  const tabs = document.querySelectorAll('.tab-content');
  const btns = document.querySelectorAll('.tab-btn');

  tabs.forEach(t => t.classList.remove('active'));
  btns.forEach(b => b.classList.remove('active'));

  document.getElementById(tabId).classList.add('active');
  event.target.classList.add('active');

  if (tabId === 'tabLogs' && currentMetrics) {
    renderAuditLogs(currentMetrics.auditLogs);
  }
}

function applySettingChange() {
  const instrument = document.getElementById('settingInstrument').value;
  const targetVal = document.getElementById('settingTargetMove').value;
  const maxActivePairs = parseInt(document.getElementById('settingMaxPairs').value) || 25;
  const dailyLoss = parseFloat(document.getElementById('settingDailyLoss').value) || 2000;

  const body = {
    instrument,
    targetDisabled: targetVal === 'DISABLED',
    profitTargetMove: targetVal === 'DISABLED' ? 0.05 : parseFloat(targetVal),
    maxActivePairs,
    dailyLossCircuitBreakerINR: dailyLoss
  };

  fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  .then(r => r.json())
  .then(res => {
    if (res.success) {
      fetchMetricsFallback();
    }
  });
}

function toggleEngineState() {
  fetch('/api/toggle-engine', { method: 'POST' })
    .then(r => r.json())
    .then(res => {
      fetchMetricsFallback();
    });
}

function manualClose(positionId) {
  if (confirm(`Manually close position ${positionId} at current market price?`)) {
    fetch('/api/manual-close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positionId })
    })
    .then(r => r.json())
    .then(res => {
      if (!res.success) alert(res.error);
      else fetchMetricsFallback();
    });
  }
}

function resetAllDataConfirm() {
  if (confirm('WARNING: Are you sure you want to reset all paper positions, processed rates, and history?')) {
    fetch('/api/reset-data', { method: 'POST' })
      .then(r => r.json())
      .then(res => {
        alert(res.message);
        fetchMetricsFallback();
      });
  }
}

function runBacktestSimulation() {
  const mode = document.getElementById('btMode').value;
  const dateStr = document.getElementById('btDate').value;
  const fromDateStr = document.getElementById('btFromDate').value;
  const toDateStr = document.getElementById('btToDate').value;

  const symbol = document.getElementById('btSymbol').value;
  const targetMove = parseFloat(document.getElementById('btTargetMove').value) || 0.05;
  const maxActivePairs = parseInt(document.getElementById('btMaxPairs').value) || 25;
  const contractQuantity = parseFloat(document.getElementById('btQuantity').value) || 1.0;

  const body = {
    mode,
    symbol,
    dateStr,
    fromDateStr,
    toDateStr,
    targetMove,
    maxActivePairs,
    contractQuantity
  };

  const container = document.getElementById('backtestResultsContainer');
  container.style.display = 'block';
  container.innerHTML = '<p style="color:var(--accent-blue)">Fetching historical data & processing simulation ticks...</p>';

  fetch('/api/backtest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  .then(r => r.json())
  .then(res => {
    if (!res.success) {
      container.innerHTML = `<p style="color:var(--red-glow); font-weight:700;">⚠️ ${res.message || res.error}</p>`;
      return;
    }

    // Add run to history for comparison
    backtestRunsHistory.push(res);
    renderBacktestRunResults(res, container);
    renderBacktestComparisonTable();
  });
}

function renderBacktestRunResults(res, container) {
  const s = res.summary;
  const priceDecimals = res.symbol === 'BTCUSDT' ? 2 : (res.symbol === 'XAGUSDT' ? 4 : 2);

  let html = `
    <h3 style="margin-bottom: 12px; color: var(--accent-cyan);">Historical Performance Summary (${res.dateStr} — ${res.symbol})</h3>
    <div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:16px;">Run ID: <code>${res.runId}</code> | Target: $${res.config.targetMove} | Cap: ${res.config.maxActivePairs} Pairs | Qty: ${res.config.contractQuantity}</div>
    
    <div class="kpi-grid" style="margin-bottom: 20px;">
      <div class="kpi-card">
        <span class="kpi-title">Starting Capital</span>
        <div class="kpi-value text-blue">₹${s.startingCapitalINR.toLocaleString()}</div>
      </div>
      <div class="kpi-card">
        <span class="kpi-title">Realized Balance</span>
        <div class="kpi-value ${s.totalRealizedNetINR >= 0 ? 'text-green' : 'text-red'}">₹${s.realizedBalanceINR.toLocaleString()}</div>
        <div class="kpi-subtext">Capital + Realized Net</div>
      </div>
      <div class="kpi-card">
        <span class="kpi-title">Final End-of-Day Equity</span>
        <div class="kpi-value text-blue" style="font-weight:900;">₹${s.finalEquityINR.toLocaleString()}</div>
        <div class="kpi-subtext">Peak: ₹${s.peakEquityINR.toLocaleString()} | Low: ₹${s.lowestEquityINR.toLocaleString()}</div>
      </div>
      <div class="kpi-card">
        <span class="kpi-title">Closed Net Profit</span>
        <div class="kpi-value ${s.totalRealizedNetINR >= 0 ? 'text-green' : 'text-red'}">₹${s.totalRealizedNetINR.toFixed(2)}</div>
        <div class="kpi-subtext">Trades: ${s.closedPositionsCount} (${s.winRate}% Win)</div>
      </div>
      <div class="kpi-card">
        <span class="kpi-title">Remaining Floating Net P/L</span>
        <div class="kpi-value ${s.remainingFloatingNetINR >= 0 ? 'text-green' : 'text-red'}">₹${s.remainingFloatingNetINR.toFixed(2)}</div>
        <div class="kpi-subtext">Gross: $${s.remainingFloatingGrossUSD.toFixed(2)} | Charges: ₹${s.remainingFloatingChargesINR.toFixed(2)}</div>
      </div>
      <div class="kpi-card">
        <span class="kpi-title">Remaining Open Positions</span>
        <div class="kpi-value text-yellow">${s.remainingOpenPositionsCount}</div>
        <div class="kpi-subtext">Complete: ${s.remainingCompletePairsCount} | Incomplete: ${s.remainingIncompletePairsCount}</div>
      </div>
    </div>
  `;

  // Day-wise Summary Table (If Multi-Day)
  if (res.dailyReports && res.dailyReports.length > 1) {
    html += `
      <h4 style="margin-bottom: 10px; color: var(--accent-cyan);">📅 Day-by-Day Performance Breakdown</h4>
      <table class="data-table" style="margin-bottom: 24px;">
        <thead>
          <tr>
            <th>Date</th>
            <th>Day-End Price</th>
            <th>Realized Net (INR)</th>
            <th>Open Positions</th>
            <th>Floating Net (INR)</th>
            <th>End-of-Day Equity (INR)</th>
            <th>Active Pairs</th>
          </tr>
        </thead>
        <tbody>
    `;

    for (const dr of res.dailyReports) {
      html += `
        <tr>
          <td><strong>${dr.dateStr}</strong></td>
          <td>$${dr.dayEndPrice ? dr.dayEndPrice.toFixed(priceDecimals) : 'N/A'}</td>
          <td class="${dr.realizedNetINR >= 0 ? 'text-green' : 'text-red'}">₹${dr.realizedNetINR.toFixed(2)}</td>
          <td>${dr.totalOpenPositionsCount}</td>
          <td class="${dr.floatingNetINR >= 0 ? 'text-green' : 'text-red'}">₹${dr.floatingNetINR.toFixed(2)}</td>
          <td style="font-weight:700;" class="text-blue">₹${dr.endOfDayEquityINR.toLocaleString()}</td>
          <td>${dr.activePairsCount} (${dr.completePairsCount} Complete / ${dr.incompletePairsCount} Inc)</td>
        </tr>
      `;
    }
    html += `</tbody></table>`;
  }

  // Part A: Closed Trades Table
  html += `
    <h4 style="margin-bottom: 10px; color: var(--text-main);">Part A: Closed Trades History (${res.trades.length})</h4>
    <table class="data-table" style="margin-bottom: 24px;">
      <thead>
        <tr>
          <th>Pair ID</th>
          <th>Position ID</th>
          <th>Type</th>
          <th>Entry Time</th>
          <th>Exit Time</th>
          <th>Entry Price</th>
          <th>Exit Price</th>
          <th>Target</th>
          <th>Gross USD</th>
          <th>Charges (INR)</th>
          <th>Net INR</th>
          <th>Exit Reason</th>
        </tr>
      </thead>
      <tbody>
  `;

  if (res.trades.length === 0) {
    html += `<tr><td colspan="12" style="text-align:center; color:var(--text-dim); padding:16px;">No trades hit target exit during this simulation period.</td></tr>`;
  } else {
    for (const t of res.trades) {
      html += `
        <tr>
          <td>${t.pairId}</td>
          <td><code>${t.positionId}</code></td>
          <td><span class="badge-direction ${t.direction === 'BUY' ? 'buy' : 'sell'}">${t.direction}</span></td>
          <td>${new Date(t.entryTime).toLocaleString()}</td>
          <td>${new Date(t.exitTime).toLocaleString()}</td>
          <td>$${t.entryPrice.toFixed(priceDecimals)}</td>
          <td>$${t.exitPrice.toFixed(priceDecimals)}</td>
          <td>$${t.targetExitPrice ? t.targetExitPrice.toFixed(priceDecimals) : 'N/A'}</td>
          <td class="${t.grossProfitUSD >= 0 ? 'text-green' : 'text-red'}">$${t.grossProfitUSD >= 0 ? '+' : ''}${t.grossProfitUSD.toFixed(4)}</td>
          <td>₹${t.totalChargesINR.toFixed(2)}</td>
          <td class="${t.netProfitINR >= 0 ? 'text-green' : 'text-red'}" style="font-weight:700;">₹${t.netProfitINR >= 0 ? '+' : ''}${t.netProfitINR.toFixed(2)}</td>
          <td><span class="badge-reason">${t.exitReason}</span></td>
        </tr>
      `;
    }
  }
  html += `</tbody></table>`;

  // Part B: Pending / Remaining Open Positions Table
  html += `
    <h4 style="margin-bottom: 10px; color: var(--warning-yellow);">Part B: Pending Open Positions at End of Simulation (${res.remainingOpenPositions.length})</h4>
    <table class="data-table">
      <thead>
        <tr>
          <th>Pair ID</th>
          <th>Position ID</th>
          <th>Type</th>
          <th>Entry Time</th>
          <th>Entry Price</th>
          <th>End Market Price</th>
          <th>Target Price</th>
          <th>Floating Gross USD</th>
          <th>Est. Closing Charges (INR)</th>
          <th>Floating Net INR</th>
          <th>Duration</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
  `;

  if (res.remainingOpenPositions.length === 0) {
    html += `<tr><td colspan="12" style="text-align:center; color:var(--text-dim); padding:16px;">All positions closed by target exits. Zero remaining open positions.</td></tr>`;
  } else {
    for (const op of res.remainingOpenPositions) {
      html += `
        <tr>
          <td>${op.pairId}</td>
          <td><code style="color:var(--accent-cyan);">${op.positionId}</code></td>
          <td><span class="badge-direction ${op.direction === 'BUY' ? 'buy' : 'sell'}">${op.direction}</span></td>
          <td>${new Date(op.entryTime).toLocaleString()}</td>
          <td>$${op.entryPrice.toFixed(priceDecimals)}</td>
          <td>$${op.dayEndMarketPrice.toFixed(priceDecimals)}</td>
          <td>$${op.targetExitPrice ? op.targetExitPrice.toFixed(priceDecimals) : 'N/A'}</td>
          <td class="${op.floatingGrossUSD >= 0 ? 'text-green' : 'text-red'}">$${op.floatingGrossUSD >= 0 ? '+' : ''}${op.floatingGrossUSD.toFixed(4)}</td>
          <td>₹${op.estimatedChargesINR.toFixed(2)}</td>
          <td class="${op.floatingNetINR >= 0 ? 'text-green' : 'text-red'}" style="font-weight:700;">₹${op.floatingNetINR >= 0 ? '+' : ''}${op.floatingNetINR.toFixed(2)}</td>
          <td>${op.holdingDurationHours}</td>
          <td><span class="status-badge stale" style="font-size:0.7rem;">${op.status}</span></td>
        </tr>
      `;
    }
  }

  html += `</tbody></table>`;
  container.innerHTML = html;
}

function renderBacktestComparisonTable() {
  if (backtestRunsHistory.length < 2) return;

  const section = document.getElementById('backtestComparisonSection');
  section.style.display = 'block';

  const headerTr = document.getElementById('btCompHeaderTr');
  const tbody = document.getElementById('btCompTbody');

  let headerHtml = '<th>Metric / Parameter</th>';
  for (let i = 0; i < backtestRunsHistory.length; i++) {
    const run = backtestRunsHistory[i];
    headerHtml += `<th>Run #${i + 1} (${run.config.targetMove} Target)</th>`;
  }
  headerTr.innerHTML = headerHtml;

  const metricsRow = [
    { label: 'Date Range / Date', key: (r) => r.dateStr },
    { label: 'Target Move ($)', key: (r) => `$${r.config.targetMove}` },
    { label: 'Max Active Pair Cap', key: (r) => r.config.maxActivePairs },
    { label: 'Contract Quantity', key: (r) => r.config.contractQuantity },
    { label: 'Closed Net Profit (INR)', key: (r) => `₹${r.summary.totalRealizedNetINR.toFixed(2)}` },
    { label: 'Total Closed Trades', key: (r) => `${r.summary.closedPositionsCount} (${r.summary.winRate}% Win)` },
    { label: 'Remaining Open Positions', key: (r) => r.summary.remainingOpenPositionsCount },
    { label: 'Floating Net P/L (INR)', key: (r) => `₹${r.summary.remainingFloatingNetINR.toFixed(2)}` },
    { label: 'Total Charges Paid (INR)', key: (r) => `₹${r.summary.totalChargesINR.toFixed(2)}` },
    { label: 'End-of-Day Final Equity (INR)', key: (r) => `₹${r.summary.finalEquityINR.toLocaleString()}` }
  ];

  let bodyHtml = '';
  for (const m of metricsRow) {
    bodyHtml += `<tr><td><strong>${m.label}</strong></td>`;
    for (const run of backtestRunsHistory) {
      bodyHtml += `<td style="font-weight:700;">${m.key(run)}</td>`;
    }
    bodyHtml += `</tr>`;
  }
  tbody.innerHTML = bodyHtml;
}

function runAcceptanceTests() {
  const container = document.getElementById('testOutputContainer');
  container.innerHTML = '<p style="color:var(--accent-cyan)">Running 10 Acceptance Tests (Unique Rate Rule)...</p>';

  fetch('/api/tests/run')
    .then(r => r.json())
    .then(res => {
      container.innerHTML = `<pre style="white-space:pre-wrap;">${res.output}</pre>`;
    })
    .catch(err => {
      container.innerHTML = `<p style="color:var(--red-glow)">Error running test suite: ${err.message}</p>`;
    });
}

function renderAuditLogs(logs) {
  const container = document.getElementById('auditLogList');
  if (!logs || logs.length === 0) {
    container.innerHTML = '<p style="color:var(--text-dim)">No system events logged yet.</p>';
    return;
  }

  let html = '';
  for (const log of logs.slice().reverse()) {
    html += `
      <div class="audit-log-item">
        <span style="color:var(--text-muted); font-size:0.7rem;">[${new Date(log.timestamp).toLocaleTimeString()}]</span>
        <strong style="color:var(--accent-cyan); margin-left:6px;">${log.event}:</strong>
        <span style="color:#e5e7eb; margin-left:6px;">${typeof log.details === 'string' ? log.details : JSON.stringify(log.details)}</span>
      </div>
    `;
  }
  container.innerHTML = html;
}

function openSettingsModal() {
  document.getElementById('settingsModal').style.display = 'flex';
}

function closeSettingsModal() {
  document.getElementById('settingsModal').style.display = 'none';
}

function saveModalSettings() {
  const capital = parseFloat(document.getElementById('modalStartingCapital').value) || 50000;
  const qty = parseFloat(document.getElementById('modalContractQuantity').value) || 1.0;
  const lev = parseInt(document.getElementById('modalLeverage').value) || 5;

  fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startingCapitalINR: capital,
      contractQuantity: qty,
      leverage: lev
    })
  })
  .then(r => r.json())
  .then(res => {
    closeSettingsModal();
    fetchMetricsFallback();
  });
}
