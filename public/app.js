let currentMetrics = null;
let eventSource = null;
let backtestRunsHistory = []; // In-memory store for multi-run comparison

const INSTRUMENT_TARGET_OPTIONS_MUDREX = {
  CLUSDT: [
    { value: '0.20', label: '$0.20 Target Move' },
    { value: '0.50', label: '$0.50 Target Move' },
    { value: '1.00', label: '$1.00 Target Move (Crude Standard)' },
    { value: '2.00', label: '$2.00 Target Move' },
    { value: '5.00', label: '$5.00 Target Move' },
    { value: 'DISABLED', label: 'Disabled (No Auto Target)' }
  ],
  XAGUSDT: [
    { value: '0.50', label: '$0.50 Target Move' },
    { value: '1.00', label: '$1.00 Target Move' },
    { value: '2.00', label: '$2.00 Target Move' },
    { value: 'DISABLED', label: 'Disabled (No Auto Target)' }
  ],
  BTCUSDT: [
    { value: '100', label: '$100 Target Move' },
    { value: '200', label: '$200 Target Move' },
    { value: '500', label: '$500 Target Move' },
    { value: 'DISABLED', label: 'Disabled (No Auto Target)' }
  ]
};

const INSTRUMENT_TARGET_OPTIONS_DHAN = {
  CLUSDT: [
    { value: '200', label: '₹200 Target Move' },
    { value: '500', label: '₹500 Target Move' },
    { value: '1000', label: '₹1,000 Target Move (Crude Standard)' },
    { value: '2000', label: '₹2,000 Target Move' },
    { value: 'DISABLED', label: 'Disabled (No Auto Target)' }
  ],
  XAGUSDT: [
    { value: '500', label: '₹500 Target Move' },
    { value: '1000', label: '₹1,000 Target Move (Silver Standard)' },
    { value: '1500', label: '₹1,500 Target Move' },
    { value: '2000', label: '₹2,000 Target Move' },
    { value: '5000', label: '₹5,000 Target Move' },
    { value: 'DISABLED', label: 'Disabled (No Auto Target)' }
  ],
  BTCUSDT: [
    { value: '500', label: '₹500 Target Move' },
    { value: '1000', label: '₹1,000 Target Move' },
    { value: '2000', label: '₹2,000 Target Move' },
    { value: 'DISABLED', label: 'Disabled (No Auto Target)' }
  ]
};

function updateTargetDropdownOptions(symbol, currentTargetValStr) {
  const select = document.getElementById('settingTargetMove');
  if (!select) return;

  const isDhanPage = window.location.pathname.includes('dhan');
  const targetMap = isDhanPage ? INSTRUMENT_TARGET_OPTIONS_DHAN : INSTRUMENT_TARGET_OPTIONS_MUDREX;
  const options = targetMap[symbol] || targetMap.CLUSDT;
  let html = '';
  let matchFound = false;

  const targetStr = currentTargetValStr !== undefined && currentTargetValStr !== null ? currentTargetValStr.toString() : '';
  const targetFloat = parseFloat(targetStr);

  options.forEach(opt => {
    const isSelected = (opt.value === targetStr) || (!isNaN(targetFloat) && parseFloat(opt.value) === targetFloat);
    if (isSelected && !matchFound) {
      matchFound = true;
      html += `<option value="${opt.value}" selected>${opt.label}</option>`;
    } else {
      html += `<option value="${opt.value}">${opt.label}</option>`;
    }
  });

  if (!matchFound && options.length > 0) {
    const defaultVal = isDhanPage ? (symbol === 'XAGUSDT' ? '1000' : '1000') : (symbol === 'XAGUSDT' ? '1.00' : '1.00');
    html = '';
    options.forEach(opt => {
      const isSelected = (opt.value === defaultVal);
      html += `<option value="${opt.value}" ${isSelected ? 'selected' : ''}>${opt.label}</option>`;
    });
  }

  select.innerHTML = html;
}

function onInstrumentSelectChanged() {
  const instSelect = document.getElementById('settingInstrument');
  const instrument = instSelect ? instSelect.value : 'CLUSDT';
  const defaultVal = instrument === 'XAGUSDT' ? '1000' : (instrument === 'CLUSDT' ? '1.00' : '200');
  updateTargetDropdownOptions(instrument, defaultVal);
  
  const btTargetInput = document.getElementById('btTargetMove');
  if (btTargetInput) {
    btTargetInput.value = defaultVal === 'DISABLED' ? '1000' : defaultVal;
  }
  
  applySettingChange();
}

document.addEventListener('DOMContentLoaded', () => {
  const today = new Date().toISOString().split('T')[0];
  const btDate = document.getElementById('btDate');
  if (btDate) btDate.value = today;
  const btFromDate = document.getElementById('btFromDate');
  if (btFromDate) btFromDate.value = today;
  const btToDate = document.getElementById('btToDate');
  if (btToDate) btToDate.value = today;

  const instSelect = document.getElementById('settingInstrument');
  const initialInst = instSelect ? instSelect.value : 'CLUSDT';
  const initialDefault = initialInst === 'XAGUSDT' ? '1000' : (initialInst === 'CLUSDT' ? '1.00' : '200');
  updateTargetDropdownOptions(initialInst, initialDefault);
  makeDockDraggable();
  initRealtimeStream();
  checkMudrexAuthStatus();

  window.toggleEngineState = toggleEngineState;
  const dhanBtn = document.getElementById('dhanStartEngineMainBtn');
  if (dhanBtn) dhanBtn.addEventListener('click', toggleEngineState);
  const mainBtn = document.getElementById('mudrexStartEngineMainBtn');
  if (mainBtn) mainBtn.addEventListener('click', toggleEngineState);
  const toggleBtn = document.getElementById('toggleEngineBtn');
  if (toggleBtn) toggleBtn.addEventListener('click', toggleEngineState);
});

function openAccountDetailsModal() {
  const modal = document.getElementById('accountDetailsModal');
  if (modal) modal.style.display = 'flex';
}

function closeAccountDetailsModal() {
  const modal = document.getElementById('accountDetailsModal');
  if (modal) modal.style.display = 'none';
}

window.openAccountDetailsModal = openAccountDetailsModal;
window.closeAccountDetailsModal = closeAccountDetailsModal;

function makeDockDraggable() {
  const dock = document.getElementById('quickGlanceDock');
  if (!dock) return;

  let isDragging = false;
  let offsetX = 0;
  let offsetY = 0;

  const onStart = (e) => {
    isDragging = true;
    const clientX = e.clientX || (e.touches && e.touches[0].clientX);
    const clientY = e.clientY || (e.touches && e.touches[0].clientY);
    const rect = dock.getBoundingClientRect();
    offsetX = clientX - rect.left;
    offsetY = clientY - rect.top;
    dock.style.transition = 'none';
  };

  const onMove = (e) => {
    if (!isDragging) return;
    const clientX = e.clientX || (e.touches && e.touches[0].clientX);
    const clientY = e.clientY || (e.touches && e.touches[0].clientY);
    
    let left = clientX - offsetX;
    let top = clientY - offsetY;

    // Constrain within window viewport
    left = Math.max(10, Math.min(left, window.innerWidth - dock.offsetWidth - 10));
    top = Math.max(10, Math.min(top, window.innerHeight - dock.offsetHeight - 10));

    dock.style.left = `${left}px`;
    dock.style.top = `${top}px`;
    dock.style.bottom = 'auto';
    dock.style.right = 'auto';
  };

  const onEnd = () => {
    isDragging = false;
  };

  dock.addEventListener('mousedown', onStart);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onEnd);

  dock.addEventListener('touchstart', onStart, { passive: true });
  document.addEventListener('touchmove', onMove, { passive: true });
  document.addEventListener('touchend', onEnd);
}

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

function isPairAddContext() {
  const p = window.location.pathname.toLowerCase();
  return p.includes('pair_add') || p.includes('pair-add');
}

function isMudrexLiveContext() {
  const p = window.location.pathname.toLowerCase();
  if (isPairAddContext()) return false;
  return (p.includes('mudrex') || !!document.getElementById('mudrexLiveStartBtn')) && !p.includes('calc');
}

let fallbackInterval = null;

function initRealtimeStream() {
  let streamUrl = '/api/stream';
  if (isPairAddContext()) {
    streamUrl = '/api/stream?mode=pair_add';
  } else if (isMudrexLiveContext()) {
    streamUrl = '/api/stream?mode=mudrex_live';
  }

  // Fetch immediately on page load so UI is updated without waiting
  fetchMetricsFallback();

  try {
    eventSource = new EventSource(streamUrl);

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
      console.warn('SSE Stream event warning, fallback polling active.');
      if (!fallbackInterval) {
        fallbackInterval = setInterval(fetchMetricsFallback, 2000);
      }
    };
  } catch (e) {
    console.warn('EventSource not supported or failed to init:', e);
    if (!fallbackInterval) {
      fallbackInterval = setInterval(fetchMetricsFallback, 2000);
    }
  }
}

function fetchMetricsFallback() {
  let endpoint = '/api/metrics';
  if (isPairAddContext()) {
    endpoint = '/api/pair-add/metrics';
  } else if (isMudrexLiveContext()) {
    endpoint = '/api/mudrex/metrics';
  }

  fetch(endpoint)
    .then(r => r.json())
    .then(res => {
      if (res && res.success && res.data) {
        currentMetrics = res.data;
        renderDashboard(res.data);
      }
    })
    .catch(e => console.error('Metrics fetch error:', e));
}

let tickHistory = [];

function recordPriceTick(price) {
  if (typeof price !== 'number' || isNaN(price) || price <= 0) return;
  const now = Date.now();
  if (tickHistory.length === 0 || tickHistory[tickHistory.length - 1].price !== price || (now - tickHistory[tickHistory.length - 1].time) > 2000) {
    tickHistory.push({ time: now, price });
    if (tickHistory.length > 150) {
      tickHistory.shift();
    }
  }
}

function drawLiveCanvasChart(canvasId, livePrice, nearestBuyTarget, nearestSellTarget) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;

  const isMcx = window.location.pathname.includes('dhan') || (currentMetrics && currentMetrics.settings && currentMetrics.settings.instrument === 'XAGUSDT');
  const currPrefix = isMcx ? '₹' : '$';

  const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
  bgGrad.addColorStop(0, '#090d16');
  bgGrad.addColorStop(1, '#05070c');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, w, h);

  if (tickHistory.length < 2) {
    ctx.fillStyle = '#64748b';
    ctx.font = '600 13px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('⚡ Connecting to Live Stream & Plotting Ticks...', w / 2, h / 2);
    return;
  }

  const paddingRight = 95;
  const paddingTop = 20;
  const paddingBottom = 25;
  const paddingLeft = 15;

  const chartWidth = w - paddingLeft - paddingRight;
  const chartHeight = h - paddingTop - paddingBottom;

  let minPrice = Infinity;
  let maxPrice = -Infinity;

  tickHistory.forEach(t => {
    if (t.price < minPrice) minPrice = t.price;
    if (t.price > maxPrice) maxPrice = t.price;
  });

  if (nearestBuyTarget && nearestBuyTarget > maxPrice) maxPrice = nearestBuyTarget;
  if (nearestSellTarget && nearestSellTarget < minPrice) minPrice = nearestSellTarget;

  const priceRange = maxPrice - minPrice || 0.40;
  minPrice = Math.max(0, minPrice - priceRange * 0.12);
  maxPrice = maxPrice + priceRange * 0.12;

  const getX = (i) => paddingLeft + (i / (tickHistory.length - 1)) * chartWidth;
  const getY = (p) => paddingTop + (1 - (p - minPrice) / (maxPrice - minPrice)) * chartHeight;

  // Horizontal Grid Lines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1;
  ctx.font = '11px monospace';
  ctx.fillStyle = '#64748b';
  ctx.textAlign = 'left';

  const gridSteps = 4;
  for (let step = 0; step <= gridSteps; step++) {
    const val = minPrice + (step / gridSteps) * (maxPrice - minPrice);
    const y = getY(val);

    ctx.beginPath();
    ctx.moveTo(paddingLeft, y);
    ctx.lineTo(w - paddingRight, y);
    ctx.stroke();

    ctx.fillText(`${currPrefix}${val.toFixed(2)}`, w - paddingRight + 8, y + 4);
  }

  // Gradient under curve
  const isUp = tickHistory[tickHistory.length - 1].price >= tickHistory[0].price;
  const strokeColor = isUp ? '#10b981' : '#00d09c';

  const areaGrad = ctx.createLinearGradient(0, paddingTop, 0, h - paddingBottom);
  areaGrad.addColorStop(0, isUp ? 'rgba(16, 185, 129, 0.3)' : 'rgba(0, 208, 156, 0.3)');
  areaGrad.addColorStop(1, 'rgba(15, 23, 42, 0.0)');

  ctx.beginPath();
  ctx.moveTo(getX(0), getY(tickHistory[0].price));
  for (let i = 1; i < tickHistory.length; i++) {
    ctx.lineTo(getX(i), getY(tickHistory[i].price));
  }
  ctx.lineTo(getX(tickHistory.length - 1), h - paddingBottom);
  ctx.lineTo(getX(0), h - paddingBottom);
  ctx.closePath();
  ctx.fillStyle = areaGrad;
  ctx.fill();

  // Price Line
  ctx.beginPath();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 2.5;
  ctx.moveTo(getX(0), getY(tickHistory[0].price));
  for (let i = 1; i < tickHistory.length; i++) {
    ctx.lineTo(getX(i), getY(tickHistory[i].price));
  }
  ctx.stroke();

  // Draw BUY Target Line
  if (nearestBuyTarget) {
    const buyY = getY(nearestBuyTarget);
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(paddingLeft, buyY);
    ctx.lineTo(w - paddingRight, buyY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#10b981';
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.fillText(`🎯 BUY ${currPrefix}${nearestBuyTarget.toFixed(2)}`, w - paddingRight + 8, buyY + 4);
  }

  // Draw SELL Target Line
  if (nearestSellTarget) {
    const sellY = getY(nearestSellTarget);
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(paddingLeft, sellY);
    ctx.lineTo(w - paddingRight, sellY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#ef4444';
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.fillText(`🎯 SELL ${currPrefix}${nearestSellTarget.toFixed(2)}`, w - paddingRight + 8, sellY + 4);
  }

  // Current Live Price Pulse Point
  const lastI = tickHistory.length - 1;
  const lastX = getX(lastI);
  const lastY = getY(tickHistory[lastI].price);

  ctx.beginPath();
  ctx.arc(lastX, lastY, 5, 0, Math.PI * 2);
  ctx.fillStyle = strokeColor;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  // Live Price Badge on Y-Axis
  ctx.fillStyle = strokeColor;
  ctx.fillRect(w - paddingRight + 2, lastY - 11, 84, 22);

  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 12px monospace';
  ctx.fillText(`${currPrefix}${tickHistory[lastI].price.toFixed(2)}`, w - paddingRight + 8, lastY + 4);
}

function renderDashboard(data) {
  const { rateFeedInfo, summary, settings, engineStatus, pauseReason, isEngineRunning, lastProcessedRate, processedRatesCount, openPositions, closedPositions, auditLogs } = data;

  const isDhanPage = window.location.pathname.includes('dhan');
  const isMudrexPage = window.location.pathname.includes('mudrex') || !isDhanPage;

  const currentSymbol = settings ? (settings.instrument || 'CLUSDT') : 'CLUSDT';
  const usdInrRate = (rateFeedInfo && rateFeedInfo.usdInrRate) || (settings && settings.usdInrRate) || 86.50;

  let pricePrefix = '$';
  let priceMultiplier = 1;
  let priceDecimals = currentSymbol === 'BTCUSDT' ? 2 : (currentSymbol === 'XAGUSDT' ? 4 : 2);

  const symbolLabelsMudrex = {
    CLUSDT: 'CLUSDT — Crude Oil',
    XAGUSDT: 'XAGUSDT — Silver',
    BTCUSDT: 'BTCUSDT — Bitcoin'
  };

  const symbolLabelsDhan = {
    CLUSDT: 'MCX CRUDE OIL (CRUDEOIL 1 BBL)',
    XAGUSDT: 'MCX SILVER (SILVERM 1kg)',
    BTCUSDT: 'MCX GOLD (GOLD 10g)'
  };

  const symbolLabels = isDhanPage ? symbolLabelsDhan : symbolLabelsMudrex;

  if (isDhanPage) {
    pricePrefix = '₹';
    if (currentSymbol === 'CLUSDT') {
      priceMultiplier = usdInrRate; // Crude Oil in INR per barrel (e.g. $90.86 * 86.50 = ₹7,859.39)
      priceDecimals = 2;
    } else if (currentSymbol === 'XAGUSDT') {
      priceMultiplier = usdInrRate * 32.1507; // Silver in INR per kg
      priceDecimals = 0;
    } else if (currentSymbol === 'BTCUSDT') {
      priceMultiplier = usdInrRate / 3.11035; // Gold in INR per 10g
      priceDecimals = 0;
    } else {
      priceMultiplier = usdInrRate;
      priceDecimals = 2;
    }
  } else {
    pricePrefix = '$';
    priceMultiplier = 1;
    priceDecimals = currentSymbol === 'BTCUSDT' ? 2 : (currentSymbol === 'XAGUSDT' ? 4 : 2);
  }

  const symbolLblEl = document.getElementById('currentSymbolLabel');
  if (symbolLblEl) symbolLblEl.innerText = symbolLabels[currentSymbol] || currentSymbol;

  const tickerPriceEl = document.getElementById('liveTickerPrice');
  if (tickerPriceEl) {
    const rawPrice = rateFeedInfo.price;
    if (rawPrice) {
      const displayPrice = rawPrice * priceMultiplier;
      const oldPrice = parseFloat(tickerPriceEl.innerText.replace(/[$₹,]/g, '')) || 0;
      tickerPriceEl.innerText = pricePrefix + (priceDecimals === 0 ? Math.round(displayPrice).toLocaleString('en-IN') : displayPrice.toFixed(priceDecimals));
      if (displayPrice > oldPrice) {
        tickerPriceEl.className = 'ticker-value up';
      } else if (displayPrice < oldPrice) {
        tickerPriceEl.className = 'ticker-value down';
      }
    } else {
      tickerPriceEl.innerText = 'FETCHING...';
      tickerPriceEl.className = 'ticker-value';
    }
  }

  const tickTimeStr = rateFeedInfo.lastTickTimeString || 'N/A';
  const ageMs = rateFeedInfo.tickAgeMs !== null && rateFeedInfo.tickAgeMs !== undefined ? rateFeedInfo.tickAgeMs : 0;
  const ageSec = (ageMs / 1000).toFixed(1);
  const tickTimeEl = document.getElementById('tickTimeAgeDisplay');
  if (tickTimeEl) tickTimeEl.innerText = `${tickTimeStr} (${ageMs < 2000 ? ageMs + 'ms' : ageSec + 's'})`;

  const lastProcEl = document.getElementById('lastProcessedRateDisplay');
  if (lastProcEl) {
    const rawProc = lastProcessedRate;
    if (rawProc) {
      const dispProc = rawProc * priceMultiplier;
      lastProcEl.innerText = `${pricePrefix}${priceDecimals === 0 ? Math.round(dispProc).toLocaleString('en-IN') : dispProc.toFixed(priceDecimals)}`;
    } else {
      lastProcEl.innerText = 'NONE';
    }
  }

  const usdInrEl = document.getElementById('usdInrDisplay');
  if (usdInrEl) usdInrEl.innerText = `₹${usdInrRate.toFixed(2)}`;

  // Feed Status Badge
  const feedBadge = document.getElementById('feedStatusBadge');
  const feedText = document.getElementById('feedStatusText');
  const statusStr = rateFeedInfo.status;

  if (feedBadge && feedText) {
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
  }

  // Main Engine Control Button
  const mainStartBtn = document.getElementById('mudrexStartEngineMainBtn') || document.getElementById('mudrexLiveStartBtn') || document.getElementById('toggleEngineBtn');

  if (isEngineRunning) {
    if (mainStartBtn) {
      mainStartBtn.innerHTML = isDhanPage ? '<span>⏸ PAUSE DHAN ENGINE</span>' : '<span>⏸ PAUSE ENGINE</span>';
      mainStartBtn.style.background = 'linear-gradient(135deg, #ef4444, #b91c1c)';
      mainStartBtn.style.border = '1px solid #f87171';
      mainStartBtn.style.boxShadow = '0 0 16px rgba(239, 68, 68, 0.5)';
    }
  } else {
    if (mainStartBtn) {
      mainStartBtn.innerHTML = isDhanPage ? '<span>🚀 START DHAN ENGINE</span>' : '<span>🚀 START ENGINE</span>';
      mainStartBtn.style.background = isDhanPage ? 'linear-gradient(135deg, #00d09c, #008765)' : 'linear-gradient(135deg, #10b981, #047857)';
      mainStartBtn.style.border = '1px solid #34d399';
      mainStartBtn.style.boxShadow = isDhanPage ? '0 0 16px var(--dhan-glow)' : '0 0 16px rgba(16, 185, 129, 0.5)';
    }
  }

  // Header Engine Status Indicator Badge
  const engineIndicatorText = document.getElementById('engineStatusIndicatorText');
  const engineIndicatorBadge = document.getElementById('engineStatusIndicatorBadge');
  const headerEngineToggleBtn = document.getElementById('headerEngineToggleBtn');
  if (engineIndicatorText) {
    if (isEngineRunning) {
      engineIndicatorText.innerText = 'RUNNING';
      if (engineIndicatorBadge) {
        engineIndicatorBadge.style.color = '#34d399';
        engineIndicatorBadge.style.borderColor = 'rgba(16, 185, 129, 0.4)';
        engineIndicatorBadge.style.background = 'rgba(16, 185, 129, 0.12)';
      }
      if (headerEngineToggleBtn) {
        headerEngineToggleBtn.style.color = '#34d399';
        headerEngineToggleBtn.style.borderColor = '#10b981';
        headerEngineToggleBtn.style.background = 'rgba(16, 185, 129, 0.15)';
        headerEngineToggleBtn.title = 'Engine is RUNNING. Click to Pause.';
      }
    } else {
      engineIndicatorText.innerText = 'PAUSED';
      if (engineIndicatorBadge) {
        engineIndicatorBadge.style.color = '#f87171';
        engineIndicatorBadge.style.borderColor = 'rgba(239, 68, 68, 0.4)';
        engineIndicatorBadge.style.background = 'rgba(239, 68, 68, 0.12)';
      }
      if (headerEngineToggleBtn) {
        headerEngineToggleBtn.style.color = '#f87171';
        headerEngineToggleBtn.style.borderColor = '#ef4444';
        headerEngineToggleBtn.style.background = 'rgba(239, 68, 68, 0.15)';
        headerEngineToggleBtn.title = 'Engine is PAUSED. Click to Start.';
      }
    }
  }

  // Sync main profit exit target select with settings
  const mainProfitExitSelect = document.getElementById('mainProfitExitSelect');
  if (mainProfitExitSelect && settings && settings.profitTargetMove) {
    if (document.activeElement !== mainProfitExitSelect) {
      const tgtVal = parseFloat(settings.profitTargetMove).toFixed(2);
      mainProfitExitSelect.value = tgtVal;
    }
  }

  if (typeof updateAdminButtonState === 'function') {
    updateAdminButtonState();
  }

  // Engine Pause Alert Banner (Disabled per user request)
  const alertBanner = document.getElementById('engineAlertBanner');
  if (alertBanner) {
    alertBanner.style.display = 'none';
  }

  const heroBal = document.getElementById('heroWalletBal');
  if (heroBal) {
    heroBal.innerText = `₹${summary.startingCapitalINR.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  const heroSub = document.getElementById('heroWalletSubtext');
  if (heroSub) {
    heroSub.innerText = `Locked Margin: ₹${summary.marginUsedINR.toFixed(2)} (Held by Exchange)`;
  }

  // Account Details Modal
  const mWalBal = document.getElementById('modalWalletBal');
  if (mWalBal) mWalBal.innerText = `₹${summary.startingCapitalINR.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  
  const mTotEq = document.getElementById('modalTotalEquity');
  if (mTotEq) mTotEq.innerText = `₹${summary.totalEquityINR.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  
  const mRealBal = document.getElementById('modalRealizedBalance');
  if (mRealBal) mRealBal.innerText = `₹${summary.realizedBalanceINR.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  
  const mWinRate = document.getElementById('modalWinRate');
  if (mWinRate) mWinRate.innerText = `${summary.winRate}%`;
  
  // Use existing usdInrRate declared at top of updateDashboardUI
  const realizedNetINR = summary.realizedNetINR || 0;
  const realizedNetUSD = summary.realizedNetUSD !== undefined ? summary.realizedNetUSD : (realizedNetINR / usdInrRate);
  const realizedGrossUSD = summary.realizedGrossUSD || 0;
  const realizedChargesINR = summary.realizedChargesINR || 0;
  const realizedChargesUSD = summary.realizedChargesUSD !== undefined ? summary.realizedChargesUSD : (realizedChargesINR / usdInrRate);

  const floatingNetINR = summary.floatingNetINR || 0;
  const floatingNetUSD = summary.floatingNetUSD !== undefined ? summary.floatingNetUSD : (floatingNetINR / usdInrRate);
  const floatingGrossUSD = summary.floatingGrossUSD || 0;
  const floatingChargesUSD = (summary.floatingChargesINR || 0) / usdInrRate;

  const estTotalNetINR = realizedNetINR + floatingNetINR;
  const estTotalNetUSD = estTotalNetINR / usdInrRate;

  const availableMarginINR = summary.availableMarginINR || 0;
  const availableMarginUSD = availableMarginINR / usdInrRate;
  const totalEquityINR = summary.totalEquityINR || 0;
  const totalEquityUSD = totalEquityINR / usdInrRate;
  const marginUsedINR = summary.marginUsedINR || 0;
  const marginUsedUSD = marginUsedINR / usdInrRate;

  if (document.getElementById('kpiTotalEquity')) {
    document.getElementById('kpiTotalEquity').innerHTML = `₹${totalEquityINR.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span style="font-size: 1.0rem; opacity: 0.85; font-weight: 700;">($${totalEquityUSD.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})</span>`;
  }
  if (document.getElementById('kpiEquitySubtext')) {
    document.getElementById('kpiEquitySubtext').innerText = `Virtual Capital: ₹${summary.startingCapitalINR.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ($${(summary.startingCapitalINR / usdInrRate).toFixed(2)})`;
  }

  if (document.getElementById('kpiRealizedBalance')) {
    document.getElementById('kpiRealizedBalance').innerHTML = `₹${summary.realizedBalanceINR.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span style="font-size: 1.0rem; opacity: 0.85; font-weight: 700;">($${(summary.realizedBalanceINR / usdInrRate).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})</span>`;
  }

  // 1. Realized Net P/L Card
  const realizedNetEl = document.getElementById('kpiRealizedNet');
  if (realizedNetEl) {
    const rSign = realizedNetINR >= 0 ? '+' : '-';
    const rLabel = realizedNetINR >= 0 ? 'PROFIT' : 'LOSS';
    const inrStr = Math.abs(realizedNetINR).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const usdStr = Math.abs(realizedNetUSD).toFixed(2);
    realizedNetEl.innerHTML = `${rSign}₹${inrStr} <span style="font-size: 1.05rem; opacity: 0.85; font-weight: 700;">(${rSign}$${usdStr})</span> <span style="font-size: 0.85rem; font-weight: 800;">${rLabel}</span>`;
    realizedNetEl.className = `kpi-value ${realizedNetINR >= 0 ? 'text-green' : 'text-red'}`;
  }
  if (document.getElementById('kpiRealizedGrossSubtext')) {
    const grossINR = summary.realizedGrossINR || (realizedGrossUSD * usdInrRate);
    const chargesINR = summary.realizedChargesINR || (realizedChargesUSD * usdInrRate);
    document.getElementById('kpiRealizedGrossSubtext').innerText = `Gross: +₹${grossINR.toFixed(2)} (+$${realizedGrossUSD.toFixed(2)}) | Charges: -₹${chargesINR.toFixed(2)} (-$${realizedChargesUSD.toFixed(2)})`;
  }

  // 2. Floating Net P/L Card
  const floatNetEl = document.getElementById('kpiFloatingNet');
  if (floatNetEl) {
    const fSign = floatingNetINR >= 0 ? '+' : '-';
    const fLabel = floatingNetINR >= 0 ? 'PROFIT' : 'LOSS';
    const inrStr = Math.abs(floatingNetINR).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const usdStr = Math.abs(floatingNetUSD).toFixed(2);
    floatNetEl.innerHTML = `${fSign}₹${inrStr} <span style="font-size: 1.05rem; opacity: 0.85; font-weight: 700;">(${fSign}$${usdStr})</span> <span style="font-size: 0.85rem; font-weight: 800;">${fLabel}</span>`;
    floatNetEl.className = `kpi-value ${floatingNetINR >= 0 ? 'text-green' : 'text-red'}`;
  }
  if (document.getElementById('kpiFloatingSubtext')) {
    const floatGrossINR = summary.floatingGrossINR || (floatingGrossUSD * usdInrRate);
    const floatChargesINR = summary.floatingChargesINR || (floatingChargesUSD * usdInrRate);
    document.getElementById('kpiFloatingSubtext').innerText = `Gross: ${floatingGrossUSD >= 0 ? '+' : '-'}₹${Math.abs(floatGrossINR).toFixed(2)} (${floatingGrossUSD >= 0 ? '+' : ''}$${floatingGrossUSD.toFixed(2)}) | Charges: -₹${floatChargesINR.toFixed(2)}`;
  }

  // 3. Estimated Total P/L Card (Realized + Floating)
  const estNetEl = document.getElementById('kpiEstTotalNet');
  if (estNetEl) {
    const eSign = estTotalNetINR >= 0 ? '+' : '-';
    const eLabel = estTotalNetINR >= 0 ? 'PROFIT' : 'LOSS';
    const inrStr = Math.abs(estTotalNetINR).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const usdStr = Math.abs(estTotalNetUSD).toFixed(2);
    estNetEl.innerHTML = `${eSign}₹${inrStr} <span style="font-size: 1.05rem; opacity: 0.85; font-weight: 700;">(${eSign}$${usdStr})</span> <span style="font-size: 0.85rem; font-weight: 800;">${eLabel}</span>`;
    estNetEl.className = `kpi-value ${estTotalNetINR >= 0 ? 'text-green' : 'text-red'}`;
  }
  if (document.getElementById('kpiEstTotalSubtext')) {
    document.getElementById('kpiEstTotalSubtext').innerText = `Realized (${realizedNetINR >= 0 ? '+' : ''}₹${realizedNetINR.toFixed(2)}) + Floating (${floatingNetINR >= 0 ? '+' : ''}₹${floatingNetINR.toFixed(2)})`;
  }

  // 4. Active Pairs / Cap Card
  if (document.getElementById('kpiActivePairs')) {
    document.getElementById('kpiActivePairs').innerText = `${summary.activePairsCount} / ${summary.maxActivePairs} Pairs`;
  }
  if (document.getElementById('kpiUniqueRatesCount')) {
    const totalBarrels = openPositions ? openPositions.reduce((sum, p) => sum + (p.quantity || 1.0), 0) : 0;
    document.getElementById('kpiUniqueRatesCount').innerText = `${totalBarrels} Barrels Open (${summary.activeBuyCount || 0} BUY / ${summary.activeSellCount || 0} SELL)`;
  }

  // 5. Simulated Margin & Equity Callout Bar
  if (document.getElementById('kpiAvailableMargin')) {
    document.getElementById('kpiAvailableMargin').innerHTML = `₹${availableMarginINR.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span style="font-size: 1.0rem; opacity: 0.8; font-weight: 700;">($${availableMarginUSD.toFixed(2)})</span>`;
  }
  if (document.getElementById('kpiSimulatedEquity')) {
    document.getElementById('kpiSimulatedEquity').innerHTML = `₹${totalEquityINR.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span style="font-size: 0.95rem; opacity: 0.8; font-weight: 700;">($${totalEquityUSD.toFixed(2)})</span>`;
  }
  if (document.getElementById('kpiMarginUsed')) {
    document.getElementById('kpiMarginUsed').innerText = `Locked Margin: ₹${marginUsedINR.toFixed(2)} ($${marginUsedUSD.toFixed(2)}) (${settings.leverage || 5}x)`;
  }

  if (document.getElementById('kpiWinRate')) document.getElementById('kpiWinRate').innerText = `${summary.winRate}%`;
  if (document.getElementById('kpiTradesCount')) document.getElementById('kpiTradesCount').innerText = `Total: ${summary.closedPositionsCount} | Wins: ${summary.winCount} | Losses: ${summary.lossCount}`;

  // Controls sync
  const instEl = document.getElementById('settingInstrument');
  if (instEl) instEl.value = settings.instrument;
  const targetValStr = settings.targetDisabled ? 'DISABLED' : settings.profitTargetMove.toString();
  updateTargetDropdownOptions(settings.instrument, targetValStr);
  const maxP = document.getElementById('settingMaxPairs');
  if (maxP) maxP.value = settings.maxActivePairs;
  const usdInrInput = document.getElementById('settingUsdInr');
  if (usdInrInput) usdInrInput.value = settings.usdInrRate || usdInrRate;
  const qtyEl = document.getElementById('modalContractQuantity');
  if (qtyEl) qtyEl.value = (settings.contractQuantity !== undefined && settings.contractQuantity !== null) ? settings.contractQuantity.toString() : '5.0';

  // Tabs count badges
  const actTab = document.getElementById('tabActiveCount');
  if (actTab) actTab.innerText = openPositions.length;
  const clsTab = document.getElementById('tabClosedCount');
  if (clsTab) clsTab.innerText = closedPositions.length;

  // Calculate Next Exit Targets
  const rawLivePrice = rateFeedInfo.price;
  const livePrice = rawLivePrice ? rawLivePrice * priceMultiplier : null;
  
  let nearestBuyTarget = null;
  let nearestSellTarget = null;
  let distBuy = null;
  let distSell = null;

  if (rawLivePrice && openPositions && openPositions.length > 0) {
    openPositions.forEach(pos => {
      if (!pos.targetExitPrice) return;
      if (pos.direction === 'BUY') {
        if (pos.targetExitPrice > rawLivePrice) {
          if (nearestBuyTarget === null || pos.targetExitPrice < nearestBuyTarget) {
            nearestBuyTarget = pos.targetExitPrice;
          }
        }
      } else if (pos.direction === 'SELL') {
        if (pos.targetExitPrice < rawLivePrice) {
          if (nearestSellTarget === null || pos.targetExitPrice > nearestSellTarget) {
            nearestSellTarget = pos.targetExitPrice;
          }
        }
      }
    });

    if (nearestBuyTarget !== null) distBuy = (nearestBuyTarget - rawLivePrice) * priceMultiplier;
    if (nearestSellTarget !== null) distSell = (rawLivePrice - nearestSellTarget) * priceMultiplier;
  }

  if (livePrice) {
    recordPriceTick(livePrice);
  }

  const dispBuyTarget = nearestBuyTarget !== null ? nearestBuyTarget * priceMultiplier : null;
  const dispSellTarget = nearestSellTarget !== null ? nearestSellTarget * priceMultiplier : null;

  const liveRateStr = livePrice ? `${pricePrefix}${priceDecimals === 0 ? Math.round(livePrice).toLocaleString('en-IN') : livePrice.toFixed(priceDecimals)}` : 'FETCHING...';
  const buyTargetStr = dispBuyTarget !== null ? `${pricePrefix}${priceDecimals === 0 ? Math.round(dispBuyTarget).toLocaleString('en-IN') : dispBuyTarget.toFixed(priceDecimals)}` : 'No Target';
  const sellTargetStr = dispSellTarget !== null ? `${pricePrefix}${priceDecimals === 0 ? Math.round(dispSellTarget).toLocaleString('en-IN') : dispSellTarget.toFixed(priceDecimals)}` : 'No Target';
  const floatNetStr = `₹${summary.floatingNetINR.toFixed(2)}`;
  const floatNetClass = summary.floatingNetINR >= 0 ? 'text-green' : 'text-red';

  // Update Dhan MCX Specific Chart Header Callouts
  const chartTitleEl = document.getElementById('chartSymbolTitle');
  if (chartTitleEl) {
    const symbolChartTitles = {
      CLUSDT: 'MCX CRUDE OIL (1 BBL) LIVE RATE CHART',
      XAGUSDT: 'MCX SILVER (1 kg) LIVE RATE CHART',
      BTCUSDT: 'MCX GOLD (10g) LIVE RATE CHART'
    };
    chartTitleEl.innerText = symbolChartTitles[currentSymbol] || `${currentSymbol} LIVE RATE CHART`;
  }
  const chartCurEl = document.getElementById('chartCurrentPriceDisplay');
  if (chartCurEl) chartCurEl.innerText = liveRateStr;
  const chartBuyEl = document.getElementById('chartBuyTargetDisplay');
  if (chartBuyEl) chartBuyEl.innerText = buyTargetStr;
  const chartSellEl = document.getElementById('chartSellTargetDisplay');
  if (chartSellEl) chartSellEl.innerText = sellTargetStr;

  // Update 3 Large 2.4rem Callouts
  const mainCrudeRateEl = document.getElementById('mainCrudeLiveRate');
  if (mainCrudeRateEl) mainCrudeRateEl.innerText = liveRateStr;
  const mainCrudeRateIndexEl = document.getElementById('mainCrudeLiveRateIndex');
  if (mainCrudeRateIndexEl) mainCrudeRateIndexEl.innerText = liveRateStr;

  const symbolLabelText = `🛢️ ${symbolLabels[currentSymbol] || currentSymbol} LIVE RATE`;
  if (document.getElementById('unifiedSymbolLabel')) document.getElementById('unifiedSymbolLabel').innerText = symbolLabelText;
  if (document.getElementById('unifiedSymbolLabelIndex')) document.getElementById('unifiedSymbolLabelIndex').innerText = symbolLabelText;

  // Green BUY Target Exit Callout
  if (document.getElementById('mainBuyTargetRate')) document.getElementById('mainBuyTargetRate').innerText = buyTargetStr;
  if (document.getElementById('mainBuyTargetRateIndex')) document.getElementById('mainBuyTargetRateIndex').innerText = buyTargetStr;
  const buyDistText = distBuy !== null ? `+${pricePrefix}${priceDecimals === 0 ? Math.round(distBuy).toLocaleString('en-IN') : distBuy.toFixed(priceDecimals)} to exit` : '--';
  if (document.getElementById('mainBuyTargetDist')) document.getElementById('mainBuyTargetDist').innerText = buyDistText;
  if (document.getElementById('mainBuyTargetDistIndex')) document.getElementById('mainBuyTargetDistIndex').innerText = buyDistText;

  // Red SELL Target Exit Callout
  if (document.getElementById('mainSellTargetRate')) document.getElementById('mainSellTargetRate').innerText = sellTargetStr;
  if (document.getElementById('mainSellTargetRateIndex')) document.getElementById('mainSellTargetRateIndex').innerText = sellTargetStr;
  const sellDistText = distSell !== null ? `-${pricePrefix}${priceDecimals === 0 ? Math.round(distSell).toLocaleString('en-IN') : distSell.toFixed(priceDecimals)} to exit` : '--';
  if (document.getElementById('mainSellTargetDist')) document.getElementById('mainSellTargetDist').innerText = sellDistText;
  if (document.getElementById('mainSellTargetDistIndex')) document.getElementById('mainSellTargetDistIndex').innerText = sellDistText;

  // Single Line Unified Metrics
  const uFloatEl = document.getElementById('unifiedFloatingNet');
  if (uFloatEl) {
    uFloatEl.innerText = floatNetStr;
    uFloatEl.className = floatNetClass;
  }
  const uFloatIndexEl = document.getElementById('unifiedFloatingNetIndex');
  if (uFloatIndexEl) {
    uFloatIndexEl.innerText = floatNetStr;
    uFloatIndexEl.className = floatNetClass;
  }

  const actPairsText = `${summary.activePairsCount} / ${summary.maxActivePairs}`;
  if (document.getElementById('unifiedActivePairs')) document.getElementById('unifiedActivePairs').innerText = actPairsText;
  if (document.getElementById('unifiedActivePairsIndex')) document.getElementById('unifiedActivePairsIndex').innerText = actPairsText;

  // Render Canvas Charts
  drawLiveCanvasChart('livePriceCanvas', livePrice, dispBuyTarget, dispSellTarget);
  drawLiveCanvasChart('livePriceCanvasIndex', livePrice, dispBuyTarget, dispSellTarget);
  drawLiveCanvasChart('liveChartCanvas', livePrice, dispBuyTarget, dispSellTarget);

  // Closed Positions History Top Summary Bar
  if (document.getElementById('closedSummaryCount')) document.getElementById('closedSummaryCount').innerText = `${summary.closedPositionsCount}`;
  if (document.getElementById('closedSummaryWinLoss')) document.getElementById('closedSummaryWinLoss').innerText = `Wins: ${summary.winCount} | Losses: ${summary.lossCount} | Win Rate: ${summary.winRate}%`;
  if (document.getElementById('closedSummaryGrossINR')) document.getElementById('closedSummaryGrossINR').innerText = `₹${summary.realizedGrossINR.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  if (document.getElementById('closedSummaryGrossUSD')) document.getElementById('closedSummaryGrossUSD').innerText = `$${summary.realizedGrossUSD.toFixed(4)} Gross`;
  if (document.getElementById('closedSummaryChargesINR')) document.getElementById('closedSummaryChargesINR').innerText = `₹${summary.realizedChargesINR.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  if (document.getElementById('closedSummaryChargesUSD')) document.getElementById('closedSummaryChargesUSD').innerText = `$${summary.realizedChargesUSD.toFixed(4)} Charges`;
  
  const cNetEl = document.getElementById('closedSummaryNetINR');
  if (cNetEl) {
    cNetEl.innerText = `₹${summary.realizedNetINR.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    cNetEl.className = `summary-value ${summary.realizedNetINR >= 0 ? 'text-green' : 'text-red'}`;
  }
  if (document.getElementById('closedSummaryNetUSD')) document.getElementById('closedSummaryNetUSD').innerText = `$${summary.realizedNetUSD.toFixed(4)} Net`;

  // Render Tables
  renderActivePositions(openPositions, settings.instrument, isDhanPage, pricePrefix, priceMultiplier, priceDecimals);
  renderClosedPositions(closedPositions, settings.instrument, isDhanPage, pricePrefix, priceMultiplier, priceDecimals);
  
  const logsTab = document.getElementById('tabLogs') || document.getElementById('tabContentAuditLogs');
  if (logsTab && logsTab.classList.contains('active')) {
    renderAuditLogs(auditLogs);
  }
}

let buySortKey = 'distToExit';
let buySortDir = 'asc';

let sellSortKey = 'distToExit';
let sellSortDir = 'asc';

let activeSortKey = null;
let activeSortDir = 'desc';

let closedSortKey = 'exitTime';
let closedSortDir = 'desc';

function formatISTDate(isoStr) {
  if (!isoStr) return '<span style="color:var(--text-dim);">N/A</span>';
  const date = new Date(isoStr);
  if (isNaN(date.getTime())) return '<span style="color:var(--text-dim);">N/A</span>';

  const timeStr = date.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });

  const dateStr = date.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short'
  });

  return `<div style="font-size:0.85rem; font-weight:800; color:#fff; font-family:monospace;">${timeStr}</div><div style="font-size:0.72rem; color:#94a3b8; font-weight:700;">${dateStr} IST</div>`;
}

function sortTable(tableType, key) {
  if (tableType === 'buy') {
    if (buySortKey === key) {
      buySortDir = buySortDir === 'asc' ? 'desc' : 'asc';
    } else {
      buySortKey = key;
      buySortDir = ['floatingNetINR', 'floatingGrossUSD', 'entryPrice', 'currentPrice', 'targetExitPrice'].includes(key) ? 'desc' : 'asc';
    }
  } else if (tableType === 'sell') {
    if (sellSortKey === key) {
      sellSortDir = sellSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sellSortKey = key;
      sellSortDir = ['floatingNetINR', 'floatingGrossUSD', 'entryPrice', 'currentPrice', 'targetExitPrice'].includes(key) ? 'desc' : 'asc';
    }
  } else if (tableType === 'active') {
    if (activeSortKey === key) {
      activeSortDir = activeSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      activeSortKey = key;
      activeSortDir = ['floatingGrossUSD', 'floatingNetINR', 'floatingChargesINR', 'entryPrice', 'currentPrice', 'targetExitPrice'].includes(key) ? 'desc' : 'asc';
    }
  } else if (tableType === 'closed') {
    if (closedSortKey === key) {
      closedSortDir = closedSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      closedSortKey = key;
      closedSortDir = ['grossProfitUSD', 'netProfitINR', 'netProfitUSD', 'totalChargesINR', 'totalChargesUSD', 'entryPrice', 'exitPrice', 'holdingDurationSec'].includes(key) ? 'desc' : 'asc';
    }
  }

  if (currentMetrics && currentMetrics.data) {
    updateDashboardUI(currentMetrics.data);
  }
}

function onActiveSortDropdownChanged(val) {
  if (!val) return;
  const parts = val.split('_');
  const key = parts[0];
  const dir = parts[1] || 'asc';
  buySortKey = key;
  buySortDir = dir;
  sellSortKey = key;
  sellSortDir = dir;
  if (currentMetrics && currentMetrics.data) {
    updateDashboardUI(currentMetrics.data);
  }
}

function sortDataArray(arr, key, dir) {
  if (!key || !arr || arr.length === 0) return arr;
  return arr.slice().sort((a, b) => {
    let valA = a[key];
    let valB = b[key];

    if (valA === null || valA === undefined) valA = '';
    if (valB === null || valB === undefined) valB = '';

    if (typeof valA === 'string' && typeof valB === 'string') {
      const isDateA = !isNaN(Date.parse(valA));
      const isDateB = !isNaN(Date.parse(valB));
      if (isDateA && isDateB) {
        valA = new Date(valA).getTime();
        valB = new Date(valB).getTime();
      } else {
        const cmp = valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' });
        return dir === 'asc' ? cmp : -cmp;
      }
    }

    if (valA < valB) return dir === 'asc' ? -1 : 1;
    if (valA > valB) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

function updateTableHeaderClasses(tableId, activeKey, activeDir) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const ths = table.querySelectorAll('th.sortable');
  ths.forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.getAttribute('data-key') === activeKey) {
      th.classList.add(activeDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
    }
  });
}

function getDistToExit(pos) {
  if (!pos || typeof pos.targetExitPrice !== 'number') return 999999;
  const curr = typeof pos.currentPrice === 'number' ? pos.currentPrice : pos.entryPrice;
  return Math.abs(pos.targetExitPrice - curr);
}

function renderActivePositions(positions, symbol, isDhanPage = false, pricePrefix = '₹', priceMultiplier = 1, priceDecimals = 2) {
  updateTableHeaderClasses('buyPositionsTable', buySortKey, buySortDir);
  updateTableHeaderClasses('sellPositionsTable', sellSortKey, sellSortDir);

  const buyTbody = document.getElementById('buyPositionsTbody');
  const sellTbody = document.getElementById('sellPositionsTbody');
  const buyBadge = document.getElementById('buyPositionsBadge');
  const sellBadge = document.getElementById('sellPositionsBadge');
  const buyNetPlEl = document.getElementById('buyPositionsNetPL');
  const sellNetPlEl = document.getElementById('sellPositionsNetPL');

  const buyPositions = (positions || []).filter(p => p.direction === 'BUY');
  const sellPositions = (positions || []).filter(p => p.direction === 'SELL');

  const usdRate = (window.lastMetricsData?.data?.rateFeedInfo?.usdInrRate) || 102.00;
  buyPositions.forEach(p => {
    if (typeof p.floatingNetINR !== 'number' || (p.floatingNetINR === 0 && p.entryPrice && p.currentPrice && p.entryPrice !== p.currentPrice)) {
      const rawE = p.entryPrice || 0;
      const rawC = p.currentPrice || rawE;
      const q = p.quantity || 1.0;
      const grossUSD = (rawC - rawE) * q;
      const grossINR = grossUSD * usdRate;
      const chargesUSD = (rawE * q * 0.00075 + rawC * q * 0.00075) * 1.18 + (2.5 / usdRate);
      p.floatingNetINR = Number((grossINR - (chargesUSD * usdRate)).toFixed(2));
    }
  });
  sellPositions.forEach(p => {
    if (typeof p.floatingNetINR !== 'number' || (p.floatingNetINR === 0 && p.entryPrice && p.currentPrice && p.entryPrice !== p.currentPrice)) {
      const rawE = p.entryPrice || 0;
      const rawC = p.currentPrice || rawE;
      const q = p.quantity || 1.0;
      const grossUSD = (rawE - rawC) * q;
      const grossINR = grossUSD * usdRate;
      const chargesUSD = (rawE * q * 0.00075 + rawC * q * 0.00075) * 1.18 + (2.5 / usdRate);
      p.floatingNetINR = Number((grossINR - (chargesUSD * usdRate)).toFixed(2));
    }
  });

  const totalBuyNetINR = buyPositions.reduce((sum, p) => sum + (typeof p.floatingNetINR === 'number' ? p.floatingNetINR : 0), 0);
  const totalSellNetINR = sellPositions.reduce((sum, p) => sum + (typeof p.floatingNetINR === 'number' ? p.floatingNetINR : 0), 0);

  const buyCounts = {};
  buyPositions.forEach(p => {
    const q = p.quantity || 5.0;
    buyCounts[q] = (buyCounts[q] || 0) + 1;
  });
  const sellCounts = {};
  sellPositions.forEach(p => {
    const q = p.quantity || 5.0;
    sellCounts[q] = (sellCounts[q] || 0) + 1;
  });

  const buyDetailStr = Object.entries(buyCounts).map(([q, count]) => `${count}x ${q}-B`).join(', ');
  const sellDetailStr = Object.entries(sellCounts).map(([q, count]) => `${count}x ${q}-B`).join(', ');

  if (buyBadge) {
    buyBadge.innerText = buyPositions.length > 0 ? `${buyPositions.length} Active (${buyDetailStr})` : `0 Active`;
  }
  if (sellBadge) {
    sellBadge.innerText = sellPositions.length > 0 ? `${sellPositions.length} Active (${sellDetailStr})` : `0 Active`;
  }

  const totalBuyNetUSD = totalBuyNetINR / usdRate;
  const totalSellNetUSD = totalSellNetINR / usdRate;

  if (buyNetPlEl) {
    const bSign = totalBuyNetUSD >= 0 ? '+' : '-';
    const bLabel = totalBuyNetUSD >= 0 ? 'PROFIT' : 'LOSS';
    const bColor = totalBuyNetUSD >= 0 ? '#34d399' : '#f87171';
    buyNetPlEl.innerHTML = `BUY FLOATING P/L: <strong style="color:${bColor}; font-size: 1.35rem; font-family: monospace;">${bSign}$${Math.abs(totalBuyNetUSD).toFixed(2)} ${bLabel}</strong>`;
  }
  if (sellNetPlEl) {
    const sSign = totalSellNetUSD >= 0 ? '+' : '-';
    const sLabel = totalSellNetUSD >= 0 ? 'PROFIT' : 'LOSS';
    const sColor = totalSellNetUSD >= 0 ? '#34d399' : '#f87171';
    sellNetPlEl.innerHTML = `SELL FLOATING P/L: <strong style="color:${sColor}; font-size: 1.35rem; font-family: monospace;">${sSign}$${Math.abs(totalSellNetUSD).toFixed(2)} ${sLabel}</strong>`;
  }

  // Apply sorting to buyPositions
  if (buySortKey === 'distToExit') {
    buyPositions.sort((a, b) => buySortDir === 'asc' ? getDistToExit(a) - getDistToExit(b) : getDistToExit(b) - getDistToExit(a));
  } else {
    const sortedBuy = sortDataArray(buyPositions, buySortKey, buySortDir);
    buyPositions.length = 0;
    buyPositions.push(...sortedBuy);
  }

  // Apply sorting to sellPositions
  if (sellSortKey === 'distToExit') {
    sellPositions.sort((a, b) => sellSortDir === 'asc' ? getDistToExit(a) - getDistToExit(b) : getDistToExit(b) - getDistToExit(a));
  } else {
    const sortedSell = sortDataArray(sellPositions, sellSortKey, sellSortDir);
    sellPositions.length = 0;
    sellPositions.push(...sortedSell);
  }

  const renderSideRows = (posList, isBuyTable) => {
    if (posList.length === 0) {
      return `<tr><td colspan="6" style="text-align: center; color: var(--text-dim); padding: 18px;">No active ${isBuyTable ? 'BUY' : 'SELL'} positions.</td></tr>`;
    }
    let rowsHtml = '';
    for (const pos of posList) {
      const rawEntry = typeof pos.entryPrice === 'number' ? pos.entryPrice : 0;
      const rawCurrent = typeof pos.currentPrice === 'number' ? pos.currentPrice : rawEntry;
      const rawTarget = typeof pos.targetExitPrice === 'number' ? pos.targetExitPrice : null;

      const entryPrice = rawEntry * priceMultiplier;
      const currentPrice = rawCurrent * priceMultiplier;
      const targetPrice = rawTarget !== null ? rawTarget * priceMultiplier : null;
      const floatingNetINR = typeof pos.floatingNetINR === 'number' ? pos.floatingNetINR : 0;
      const posFloatingNetUSD = floatingNetINR / usdRate;

      const qtyVal = typeof pos.quantity === 'number' ? pos.quantity : 5.0;
      const qtyLabel = `${qtyVal} Barrel${qtyVal > 1 ? 's' : ''}`;
      const qtyBg = qtyVal >= 5 ? 'rgba(245, 158, 11, 0.25)' : 'rgba(56, 189, 248, 0.25)';
      const qtyColor = qtyVal >= 5 ? '#f59e0b' : '#38bdf8';

      const dist = targetPrice !== null ? Math.abs(targetPrice - currentPrice) : null;
      const distUSD = dist !== null ? (dist / priceMultiplier) : null;
      const netClass = posFloatingNetUSD >= 0 ? 'text-green' : 'text-red';
      const posSign = posFloatingNetUSD >= 0 ? '+' : '-';
      const posLabel = posFloatingNetUSD >= 0 ? 'PROFIT' : 'LOSS';

      const fmtP = (v) => priceDecimals === 0 ? Math.round(v).toLocaleString('en-IN') : v.toFixed(priceDecimals);

      rowsHtml += `
        <tr>
          <td>
            <div style="display: flex; align-items: center; gap: 6px;">
              <strong style="font-size:0.95rem;">${pos.pairId || 'N/A'}</strong>
              <span style="font-size:0.7rem; padding: 2px 6px; border-radius: 4px; background: ${qtyBg}; color: ${qtyColor}; font-weight: 800;">${qtyLabel}</span>
            </div>
            <span style="display:block; margin-top: 2px;"><code style="color:var(--accent-cyan); font-size:0.8rem;">${pos.positionId || 'N/A'}</code></span>
            ${(() => {
              if (!pos.apiStatus || pos.apiStatus.includes('REAL_ORDERS_DISABLED') || pos.apiStatus.includes('LIVE_ENGINE')) return '';
              let s = pos.apiStatus;
              if (s.includes('{') || s.includes('5002') || s.includes('rate limit') || s.includes('request_id') || s.length > 40) return '';
              const color = s.includes('REAL_MUDREX') ? '#a7f3d0' : (s.includes('TRANSMITTED') || s.includes('SENDING') ? '#38bdf8' : '#fbbf24');
              return `<span style="display:block; font-size:0.65rem; color:${color}; font-weight:700; margin-top:2px;">📡 ${s}</span>`;
            })()}
          </td>
          <td>
            ${formatISTDate(pos.entryTime)}
          </td>
          <td>
            <div style="font-size:1.25rem; font-weight:900; color:#38bdf8; font-family:monospace;">$${fmtP(entryPrice)}</div>
            <div style="font-size:0.72rem; color:var(--text-dim); font-weight:800; letter-spacing:0.5px;">${isBuyTable ? 'BUY AT' : 'SELL AT'}</div>
          </td>
          <td>
            ${targetPrice !== null ? `
              <div style="font-size:1.15rem; font-weight:900; color:#f59e0b; font-family:monospace;">$${fmtP(targetPrice)}</div>
              <div style="font-size:1.0rem; color:${isBuyTable ? '#34d399' : '#f87171'}; font-weight:800;">${isBuyTable ? '⬆️ UP' : '⬇️ DOWN'} ($${distUSD !== null ? distUSD.toFixed(2) : '--'} to exit)</div>
            ` : '<span style="color:var(--text-dim)">DISABLED</span>'}
          </td>
          <td style="text-align: right;">
            <div class="${netClass}" style="font-size:1.15rem; font-weight:900; font-family:monospace;">${posSign}₹${Math.abs(floatingNetINR).toFixed(2)} <span style="font-size:0.85rem; opacity:0.85; font-weight:700;">(${posSign}$${Math.abs(posFloatingNetUSD).toFixed(2)})</span> ${posLabel}</div>
            <div style="font-size:0.75rem; color:var(--text-muted);">NET FLOATING P/L (₹ / $)</div>
          </td>
          <td style="text-align: center;">
            <button class="btn btn-danger" style="padding: 4px 10px; font-size: 0.8rem; font-weight:800; border-radius: 6px; cursor: pointer;" onclick="manualClose('${pos.positionId}')">Close</button>
          </td>
        </tr>
      `;
    }
    return rowsHtml;
  };

  if (buyTbody) {
    const buyHtml = renderSideRows(buyPositions, true);
    if (buyTbody.innerHTML !== buyHtml) buyTbody.innerHTML = buyHtml;
  }
  if (sellTbody) {
    const sellHtml = renderSideRows(sellPositions, false);
    if (sellTbody.innerHTML !== sellHtml) sellTbody.innerHTML = sellHtml;
  }
}

function renderClosedPositions(positions, symbol, isDhanPage = false, pricePrefix = '₹', priceMultiplier = 1, priceDecimals = 2) {
  updateTableHeaderClasses('closedPositionsTable', closedSortKey, closedSortDir);
  const tbody = document.getElementById('closedPositionsTbody');
  if (!tbody) return;

  let html = '';
  if (!positions || positions.length === 0) {
    html = `<tr><td colspan="13" style="text-align: center; color: var(--text-dim); padding: 24px;">No closed positions recorded yet.</td></tr>`;
  } else {
    const sortedPositions = sortDataArray(positions, closedSortKey, closedSortDir);

    const fmtP = (v) => priceDecimals === 0 ? Math.round(v).toLocaleString('en-IN') : v.toFixed(priceDecimals);

    for (const pos of sortedPositions) {
      const isBuy = pos.direction === 'BUY';
      const rawEntry = typeof pos.entryPrice === 'number' ? pos.entryPrice : 0;
      const rawExit = typeof pos.exitPrice === 'number' ? pos.exitPrice : rawEntry;
      const rawTarget = typeof pos.targetExitPrice === 'number' ? pos.targetExitPrice : null;

      const entryPrice = rawEntry * priceMultiplier;
      const exitPrice = rawExit * priceMultiplier;
      const targetPrice = rawTarget !== null ? rawTarget * priceMultiplier : null;

      const rateRef = pos.usdInrRate || 96.96;
      const grossProfitUSD = typeof pos.grossProfitUSD === 'number' ? pos.grossProfitUSD : 0;
      const totalChargesUSD = typeof pos.totalChargesUSD === 'number' ? pos.totalChargesUSD : ((pos.totalChargesINR || 0) / rateRef);
      const netProfitUSD = typeof pos.netProfitUSD === 'number' ? pos.netProfitUSD : ((pos.netProfitINR || 0) / rateRef);
      const netProfitINR = typeof pos.netProfitINR === 'number' ? pos.netProfitINR : (netProfitUSD * rateRef);
      const grossProfitINR = typeof pos.grossProfitINR === 'number' ? pos.grossProfitINR : (grossProfitUSD * rateRef);
      const totalChargesINR = typeof pos.totalChargesINR === 'number' ? pos.totalChargesINR : (totalChargesUSD * rateRef);

      const grossClass = grossProfitUSD >= 0 ? 'text-green' : 'text-red';
      const netClass = netProfitUSD >= 0 ? 'text-green' : 'text-red';

      html += `
        <tr>
          <td><strong>${pos.pairId || 'N/A'}</strong></td>
          <td><code style="color:var(--accent-cyan); font-weight: 700;">${pos.positionId || 'N/A'}</code></td>
          <td><span class="badge-direction ${isBuy ? 'buy' : 'sell'}">${pos.direction || 'BUY'}</span></td>
          <td>${formatISTDate(pos.entryTime)}</td>
          <td>${formatISTDate(pos.exitTime)}</td>
          <td style="font-family: monospace;">$${fmtP(entryPrice)}</td>
          <td style="font-family: monospace;">$${fmtP(exitPrice)}</td>
          <td>${targetPrice !== null ? `<span class="target-price-badge" style="font-family: monospace;">$${fmtP(targetPrice)}</span>` : 'N/A'}</td>
          <td class="${grossClass}" style="font-weight: 800; font-family: monospace;">+₹${grossProfitINR.toFixed(2)} <span style="font-size:0.75rem; opacity:0.8;">(+$${grossProfitUSD.toFixed(2)})</span></td>
          <td style="color: #f87171; font-weight: 800; font-family: monospace;">-₹${totalChargesINR.toFixed(2)} <span style="font-size:0.75rem; opacity:0.8;">(-$${totalChargesUSD.toFixed(2)})</span></td>
          <td class="${netClass}" style="font-weight: 900; font-family: monospace;">${netProfitINR >= 0 ? '+' : '-'}₹${Math.abs(netProfitINR).toFixed(2)} <span style="font-size:0.8rem; opacity:0.85;">(${netProfitUSD >= 0 ? '+' : '-'}$${Math.abs(netProfitUSD).toFixed(2)})</span></td>
          <td style="font-size: 0.82rem; color: var(--text-muted); font-weight: 700;">₹${rateRef}</td>
          <td><span class="badge-reason">${pos.exitReason || 'TARGET HIT'}</span></td>
        </tr>
      `;
    }
  }

  if (tbody.innerHTML !== html) {
    tbody.innerHTML = html;
  }
}

function switchTab(tabId) {
  let targetId = tabId;
  if (!document.getElementById(targetId)) {
    if (tabId === 'activePositions') targetId = 'tabContentActivePositions';
    else if (tabId === 'closedHistory') targetId = 'tabContentClosedHistory';
    else if (tabId === 'historicalBacktest') targetId = 'tabContentHistoricalBacktest';
    else if (tabId === 'testRunner') targetId = 'tabContentTestRunner';
    else if (tabId === 'auditLogs') targetId = 'tabContentAuditLogs';
  }

  const targetEl = document.getElementById(targetId);
  if (!targetEl) return;

  const parent = targetEl.parentElement;
  if (parent) {
    const tabs = parent.querySelectorAll('.tab-content');
    tabs.forEach(t => t.classList.remove('active'));
  }

  targetEl.classList.add('active');

  if (window.event && window.event.currentTarget) {
    const btnContainer = window.event.currentTarget.parentElement;
    if (btnContainer) {
      const btns = btnContainer.querySelectorAll('.tab-btn');
      btns.forEach(b => b.classList.remove('active'));
    }
    window.event.currentTarget.classList.add('active');
  }

  if ((targetId.includes('Audit') || targetId === 'tabLogs') && currentMetrics) {
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


function manualClose(positionId) {
  if (confirm(`Manually close position ${positionId} at current market price?`)) {
    const endpoint = isPairAddContext() ? '/api/pair-add/manual-close' : '/api/manual-close';
    fetch(endpoint, {
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

function resetAllData() {
  const endpoint = isPairAddContext() ? '/api/pair-add/reset' : '/api/reset-data';
  fetch(endpoint, { method: 'POST' })
    .then(r => r.json())
    .then(res => {
      alert('✅ ' + (res.message || 'Engine reset successfully!'));
      fetchMetricsFallback();
    })
    .catch(err => alert('Reset error: ' + err.message));
}

function resetAllDataConfirm() {
  if (confirm('⚠️ Are you SURE you want to reset all trading engine data and clear position history? This action cannot be undone!')) {
    resetAllData();
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

function toggleEngineState() {
  const endpoint = isPairAddContext() ? '/api/pair-add/toggle-engine' : '/api/toggle-engine';
  fetch(endpoint, { method: 'POST' })
    .then(r => r.json())
    .then(res => {
      if (res && res.success) {
        fetchMetricsFallback();
      } else {
        alert('Engine toggle failed: ' + (res.error || 'Unknown error'));
      }
    })
    .catch(err => {
      console.error('Error toggling engine:', err);
      alert('Network error while toggling engine state.');
    });
}
window.toggleEngineState = toggleEngineState;

window.updateProfitExitTarget = async function(val) {
  const targetMove = parseFloat(val) || 0.20;
  try {
    if (isPairAddContext()) {
      await fetch('/api/pair-add/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profitTargetMove: targetMove })
      });
    } else {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profitTargetMove: targetMove })
      });
      await fetch('/api/mudrex/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profitTargetMove: targetMove })
      }).catch(() => {});
    }

    const modalTarget = document.getElementById('tradeTargetSelect');
    if (modalTarget) modalTarget.value = targetMove.toFixed(2);
    if (typeof updateModalCalculations === 'function') updateModalCalculations();
    alert(`🎯 Main Profit Exit Target set to $${targetMove.toFixed(2)} move!\n\nEngine ab sabhi naye trades ko $${targetMove.toFixed(2)} target par profit book karke close karega.`);
    fetchMetricsFallback();
  } catch (err) {
    alert('Error setting profit exit value: ' + err.message);
  }
};

function openSettingsModal() {
  document.getElementById('settingsModal').style.display = 'flex';
}

function closeSettingsModal() {
  document.getElementById('settingsModal').style.display = 'none';
}

function applySettingChange() {
  const targetSelect = document.getElementById('settingTargetMove');
  const strategyModeSelect = document.getElementById('settingStrategyMode');
  const instSelect = document.getElementById('settingInstrument');
  const maxPairsInput = document.getElementById('settingMaxPairs');
  const usdInrInput = document.getElementById('settingUsdInr');

  const targetVal = targetSelect ? targetSelect.value : '0.20';
  const targetDisabled = targetVal === 'DISABLED';
  const profitTargetMove = targetDisabled ? 0.20 : (parseFloat(targetVal) || 0.20);
  const strategyMode = strategyModeSelect ? strategyModeSelect.value : 'ALTERNATING_STAGGERED';
  const autoAiTargetMode = (strategyMode === 'AI_DYNAMIC');
  const instrument = instSelect ? instSelect.value : 'CLUSDT';
  const maxActivePairs = maxPairsInput ? parseInt(maxPairsInput.value) || 50 : 50;
  const usdInrRate = usdInrInput ? parseFloat(usdInrInput.value) || 86.5 : 86.5;

  const isMudrexPage = window.location.pathname.includes('mudrex') || !!document.getElementById('mudrexLiveStartBtn');
  const endpoint = isMudrexPage ? '/api/mudrex/settings' : '/api/settings';

  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instrument,
      strategyMode,
      autoAiTargetMode,
      profitTargetMove,
      targetDisabled,
      maxActivePairs,
      usdInrRate
    })
  })
  .then(r => r.json())
  .then(res => {
    if (res && res.success) {
      fetchMetricsFallback();
    }
  });
}
window.applySettingChange = applySettingChange;

function saveModalSettings() {
  const capitalInput = document.getElementById('modalStartingCapital');
  const qtyInput = document.getElementById('modalContractQuantity');
  const levInput = document.getElementById('modalLeverage');
  const targetSelect = document.getElementById('settingTargetMove');
  const strategyModeSelect = document.getElementById('settingStrategyMode');
  const instSelect = document.getElementById('settingInstrument');
  const maxPairsInput = document.getElementById('settingMaxPairs');
  const usdInrInput = document.getElementById('settingUsdInr');

  const capital = capitalInput ? parseFloat(capitalInput.value) || 350000 : 350000;
  const qty = qtyInput ? parseFloat(qtyInput.value) || 5.0 : 5.0;
  const lev = levInput ? parseInt(levInput.value) || 5 : 5;
  const targetVal = targetSelect ? targetSelect.value : '0.20';
  const targetDisabled = targetVal === 'DISABLED';
  const profitTargetMove = targetDisabled ? 0.20 : (parseFloat(targetVal) || 0.20);
  const strategyMode = strategyModeSelect ? strategyModeSelect.value : 'ALTERNATING_STAGGERED';
  const autoAiTargetMode = (strategyMode === 'AI_DYNAMIC');
  const instrument = instSelect ? instSelect.value : 'CLUSDT';
  const maxActivePairs = maxPairsInput ? parseInt(maxPairsInput.value) || 50 : 50;
  const usdInrRate = usdInrInput ? parseFloat(usdInrInput.value) || 86.5 : 86.5;

  const isMudrexPage = window.location.pathname.includes('mudrex') || !!document.getElementById('mudrexLiveStartBtn');
  const endpoint = isMudrexPage ? '/api/mudrex/settings' : '/api/settings';

  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instrument,
      strategyMode,
      autoAiTargetMode,
      profitTargetMove,
      targetDisabled,
      maxActivePairs,
      usdInrRate,
      startingCapitalINR: capital,
      contractQuantity: qty,
      leverage: lev
    })
  })
  .then(r => r.json())
  .then(res => {
    closeSettingsModal();
    fetchMetricsFallback();
  })
  .catch(() => {
    closeSettingsModal();
  });
}
window.saveModalSettings = saveModalSettings;

function openMudrexLiveModal() {
  document.getElementById('mudrexLiveModal').style.display = 'flex';
  checkMudrexAuthStatus();
}

function closeMudrexLiveModal() {
  const modal = document.getElementById('mudrexLiveModal');
  if (modal) modal.style.display = 'none';
}

// Global Modal Dismiss listeners
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMudrexLiveModal();
    if (typeof closeSettingsModal === 'function') closeSettingsModal();
  }
});

function checkMudrexAuthStatus() {
  const container = document.getElementById('mudrexAuthStatusContainer');
  if (!container) return;
  container.innerHTML = '<span style="color:var(--accent-cyan)">Connecting to Mudrex Live API...</span>';

  fetch('/api/mudrex/auth-check')
    .then(r => r.json())
    .then(res => {
      if (res.success) {
        const totalBal = res.totalPortfolioBalance || res.balance || 0;
        const spotBal = res.spotBalance || 0;
        const futBal = res.futuresBalance || 0;

        const totalStr = `₹${Number(totalBal).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
        const spotStr = `₹${Number(spotBal).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
        const futStr = `₹${Number(futBal).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

        const hBal = document.getElementById('heroWalletBal');
        if (hBal) hBal.innerText = totalStr;
        const mBal = document.getElementById('mudrexLiveWalletBalDisplay');
        if (mBal) mBal.innerText = `${totalStr} (Spot: ${spotStr} | Futures: ${futStr})`;

        container.innerHTML = `
          <div style="color:#a7f3d0; font-weight:700;">✅ MUDREX API AUTHENTICATION SUCCESSFUL!</div>
          <div style="color:#fff; margin-top:6px; font-size:1.1rem;">Est. Total Account Value: <strong style="color:#a7f3d0;">${totalStr}</strong></div>
          <div style="color:var(--text-muted); margin-top:4px; font-size:0.8rem;">
            INR Funds (Spot): <strong style="color:#fff">${spotStr}</strong> &nbsp;|&nbsp; 
            INR Futures Margin: <strong style="color:#38bdf8">${futStr}</strong>
          </div>
        `;
      } else {
        if (typeof res.error === 'string' && (res.error.includes('RATE_LIMIT_COOLDOWN') || res.error.includes('rate limit'))) {
          container.innerHTML = `
            <div style="color:#a7f3d0; font-weight:700;">✅ MUDREX API KEYS CONNECTED & ACTIVE!</div>
            <div style="color:var(--text-muted); margin-top:4px; font-size:0.8rem;">Mudrex API rate limit cooldown active for 30s. Real order execution is enabled.</div>
          `;
        } else {
          let cleanErr = 'Mudrex Real API not connected.';
          if (typeof res.error === 'string') {
            if (res.error.includes('3100') || res.error.includes('Invalid Authentication')) {
              cleanErr = 'Invalid Mudrex API Secret Key. Please verify your Secret Key.';
            } else if (res.error.includes('MUDREX_API_SECRET missing')) {
              cleanErr = 'Mudrex Real API keys missing.';
            } else {
              cleanErr = res.error;
            }
          }
          container.innerHTML = `
            <div style="color:#fbbf24; font-weight:700;">💡 PURE PAPER SIMULATION ACTIVE (MUDREX REAL API NOT CONNECTED)</div>
            <div style="color:var(--text-muted); margin-top:4px; font-size:0.8rem;">${cleanErr} Click <strong>🔑 Mudrex API Keys</strong> above to connect your Mudrex Account for Real Execution.</div>
          `;
        }
      }
    })
    .catch(err => {
      container.innerHTML = `<div style="color:#f87171">Error checking auth: ${err.message}</div>`;
    });
}

function saveAndConnectMudrexKeys() {
  const apiKey = (document.getElementById('inputMudrexApiKey')?.value || '').trim();
  const apiSecret = (document.getElementById('inputMudrexApiSecret')?.value || '').trim();

  const container = document.getElementById('mudrexAuthStatusContainer');

  if (!apiKey && !apiSecret) {
    if (container) container.innerHTML = '<div style="color:#f87171; font-weight:700;">⚠️ Please enter both Mudrex API Key and Secret Key.</div>';
    return;
  }

  if (apiSecret.includes('*')) {
    if (container) container.innerHTML = '<div style="color:#f87171; font-weight:700;">⚠️ Please paste your actual Mudrex API Secret Key. The Secret Key box contains asterisks (***) from browser auto-fill.</div>';
    return;
  }

  if (container) container.innerHTML = '<span style="color:var(--accent-cyan)">Saving and testing Mudrex API credentials...</span>';

  fetch('/api/mudrex/save-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey, apiSecret })
  })
  .then(r => r.json())
  .then(res => {
    if (res.success && res.auth && res.auth.success) {
      if (container) {
        container.innerHTML = `<div style="color:#10b981; font-weight:700;">✅ Mudrex API Keys Connected & Verified Successfully!</div>`;
      }
      checkMudrexAuthStatus();
      fetchMetricsFallback();
    } else {
      const errMsg = (res.auth && res.auth.error) ? res.auth.error : (res.error || 'Invalid API Secret Key');
      if (container) {
        container.innerHTML = `<div style="color:#f87171; font-weight:700;">⚠️ Mudrex API Error: ${errMsg}</div>`;
      }
    }
  })
  .catch(err => {
    if (container) {
      container.innerHTML = `<div style="color:#f87171; font-weight:700;">Error connecting API keys: ${err.message}</div>`;
    }
  });
}

window.manualClose = async function(positionId) {
  if (!positionId) return;
  if (!confirm(`Are you sure you want to close position ${positionId}?`)) return;

  try {
    const res = await fetch('/api/manual-close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positionId })
    });
    const data = await res.json();
    if (data.success) {
      if (typeof fetchMetricsFallback === 'function') fetchMetricsFallback();
      if (typeof fetchDashboardMetrics === 'function') fetchDashboardMetrics();
    } else {
      alert('Failed to close position: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Error closing position: ' + err.message);
  }
};

// --- PAIR & SMART PAIR TRADING CONTROLS ---
let currentModalTradeMode = 'PAIR';
let modalSelectedBarrels = 10;
let modalLivePrice = 91.17;
let modalUsdInrRate = 95.91;
let modalRateScanState = null;

window.syncSelectedBarrels = function(val) {
  const q = parseFloat(val) || 10;
  modalSelectedBarrels = q;
  const headerSelect = document.getElementById('quickBarrelsSelect');
  if (headerSelect) headerSelect.value = q;
  const inputEl = document.getElementById('tradeQtyInput');
  if (inputEl) inputEl.value = q;
  updateModalQtyButtons(q);
  updateModalCalculations();
};

window.openPairModalWithMode = async function(mode = 'PAIR') {
  currentModalTradeMode = mode;
  const modal = document.getElementById('tradeModal');
  if (modal) modal.style.display = 'flex';

  // Read header barrels
  const headerSelect = document.getElementById('quickBarrelsSelect');
  if (headerSelect) {
    modalSelectedBarrels = parseFloat(headerSelect.value) || 10;
  }
  const inputEl = document.getElementById('tradeQtyInput');
  if (inputEl) inputEl.value = modalSelectedBarrels;
  updateModalQtyButtons(modalSelectedBarrels);

  // Read live rate & USD rate
  const liveRateEl = document.getElementById('mainCrudeLiveRate') || document.getElementById('liveTickerPrice');
  if (liveRateEl) {
    const parsed = parseFloat(liveRateEl.textContent.replace(/[^0-9.]/g, ''));
    if (!isNaN(parsed) && parsed > 0) modalLivePrice = parsed;
  }
  const usdRateEl = document.getElementById('usdInrRateDisplay');
  if (usdRateEl) {
    const parsedUSD = parseFloat(usdRateEl.textContent.replace(/[^0-9.]/g, ''));
    if (!isNaN(parsedUSD) && parsedUSD > 0) modalUsdInrRate = parsedUSD;
  }

  const modalRateEl = document.getElementById('modalTradeLiveRate');
  if (modalRateEl) modalRateEl.textContent = `$${modalLivePrice.toFixed(2)}`;
  const modalUsdEl = document.getElementById('modalTradeUsdInr');
  if (modalUsdEl) modalUsdEl.textContent = `₹${modalUsdInrRate.toFixed(2)}`;

  await switchTradeModalMode(mode);
};

window.openTradeModal = function() {
  openPairModalWithMode('PAIR');
};

window.closeTradeModal = function() {
  const modal = document.getElementById('tradeModal');
  if (modal) modal.style.display = 'none';
};

window.switchTradeModalMode = async function(mode) {
  currentModalTradeMode = mode;
  const tabPair = document.getElementById('tabModePair');
  const tabSmart = document.getElementById('tabModeSmartPair');
  const titleEl = document.getElementById('modalTradeTitle');
  const subtitleEl = document.getElementById('modalTradeSubtitle');
  const iconEl = document.getElementById('modalTitleIcon');
  const scanBox = document.getElementById('smartPairScanBox');
  const execBtn = document.getElementById('modalExecuteBtn');

  if (mode === 'SMART_PAIR') {
    if (tabSmart) {
      tabSmart.style.background = '#10b981';
      tabSmart.style.color = '#fff';
      tabSmart.style.borderColor = '#34d399';
      tabSmart.style.boxShadow = '0 0 12px rgba(16, 185, 129, 0.4)';
    }
    if (tabPair) {
      tabPair.style.background = '#1e293b';
      tabPair.style.color = '#94a3b8';
      tabPair.style.borderColor = 'rgba(255,255,255,0.15)';
      tabPair.style.boxShadow = 'none';
    }
    if (titleEl) titleEl.innerText = '⚡ Smart Pair Trading Window';
    if (subtitleEl) subtitleEl.innerText = 'Auto B/S Detection: Rate par check karke missing leg ya full pair lega';
    if (iconEl) iconEl.innerText = '⚡';
    if (scanBox) scanBox.style.display = 'block';

    // Scan position state at live rate
    await scanRateLegStatus(modalLivePrice);
  } else {
    if (tabPair) {
      tabPair.style.background = '#0284c7';
      tabPair.style.color = '#fff';
      tabPair.style.borderColor = '#38bdf8';
      tabPair.style.boxShadow = '0 0 12px rgba(56, 189, 248, 0.4)';
    }
    if (tabSmart) {
      tabSmart.style.background = '#1e293b';
      tabSmart.style.color = '#94a3b8';
      tabSmart.style.borderColor = 'rgba(255,255,255,0.15)';
      tabSmart.style.boxShadow = 'none';
    }
    if (titleEl) titleEl.innerText = '➕ Pair Trading Window';
    if (subtitleEl) subtitleEl.innerText = 'Mudrex Crude Oil: 1 BUY + 1 SELL instant Hedged Pair';
    if (iconEl) iconEl.innerText = '➕';
    if (scanBox) scanBox.style.display = 'none';
    if (execBtn) {
      execBtn.innerText = `🚀 Instant Pair Kharidein (${modalSelectedBarrels} Barrels)`;
      execBtn.style.background = 'linear-gradient(135deg, #0284c7, #0369a1)';
      execBtn.style.borderColor = '#38bdf8';
    }
  }

  updateModalCalculations();
};

async function scanRateLegStatus(price) {
  const scanBadge = document.getElementById('smartScanBadge');
  const scanText = document.getElementById('smartScanDecisionText');
  const execBtn = document.getElementById('modalExecuteBtn');
  if (scanBadge) { scanBadge.innerText = 'SCANNING...'; scanBadge.className = 'badge-status'; scanBadge.style.color = '#94a3b8'; }
  if (scanText) scanText.innerHTML = '🔍 Live rate par BUY/SELL position check ki ja rahi hai...';

  try {
    const res = await fetch('/api/rates-inspector?symbol=CLUSDT');
    const j = await res.json();
    if (!j.success) return;
    const rates = j.data.ratesList || [];
    const liveRate = j.data.currentPrice || price;
    modalLivePrice = liveRate;

    const matched = rates.find(r => Math.abs(r.rate - liveRate) <= 0.02);
    modalRateScanState = matched;

    if (!matched) {
      if (scanBadge) { scanBadge.innerText = 'NO ACTIVE LEG'; scanBadge.className = 'badge-status badge-balanced'; }
      if (scanText) scanText.innerHTML = `💡 <strong>Auto-Detected:</strong> Rate <strong>$${liveRate.toFixed(2)}</strong> par abhi koi position open nahi hai.<br>Click karne par <strong>Poora Naya BUY + SELL Pair</strong> (${modalSelectedBarrels} Barrels) khareeda jayega.`;
      if (execBtn) {
        execBtn.innerText = `⚡ Execute Smart Pair (BUY + SELL: ${modalSelectedBarrels} Barrels)`;
        execBtn.style.background = 'linear-gradient(135deg, #10b981, #059669)';
        execBtn.style.borderColor = '#34d399';
      }
    } else if (matched.hasBuy && !matched.hasSell) {
      if (scanBadge) { scanBadge.innerText = 'ONLY BUY OPEN'; scanBadge.className = 'badge-status badge-onlybuy'; }
      if (scanText) scanText.innerHTML = `⚡ <strong>Auto-Detected:</strong> Rate <strong>$${matched.rate.toFixed(2)}</strong> par BUY active hai (${matched.buyQty}B) aur SELL end ho gaya hai.<br>Click karne par <strong>Sirf Missing SELL leg</strong> (${modalSelectedBarrels} Barrels) add hogi taaki pair wapas balance ho sake!`;
      if (execBtn) {
        execBtn.innerText = `⚡ Execute Smart Pair (Add Missing SELL Leg: ${modalSelectedBarrels} Barrels)`;
        execBtn.style.background = 'linear-gradient(135deg, #ef4444, #b91c1c)';
        execBtn.style.borderColor = '#f87171';
      }
    } else if (!matched.hasBuy && matched.hasSell) {
      if (scanBadge) { scanBadge.innerText = 'ONLY SELL OPEN'; scanBadge.className = 'badge-status badge-onlysell'; }
      if (scanText) scanText.innerHTML = `⚡ <strong>Auto-Detected:</strong> Rate <strong>$${matched.rate.toFixed(2)}</strong> par SELL active hai (${matched.sellQty}B) aur BUY end ho gaya hai.<br>Click karne par <strong>Sirf Missing BUY leg</strong> (${modalSelectedBarrels} Barrels) add hogi taaki pair wapas balance ho sake!`;
      if (execBtn) {
        execBtn.innerText = `⚡ Execute Smart Pair (Add Missing BUY Leg: ${modalSelectedBarrels} Barrels)`;
        execBtn.style.background = 'linear-gradient(135deg, #10b981, #047857)';
        execBtn.style.borderColor = '#34d399';
      }
    } else {
      if (scanBadge) { scanBadge.innerText = 'ALREADY HEDGED'; scanBadge.className = 'badge-status badge-balanced'; }
      if (scanText) scanText.innerHTML = `✅ <strong>Auto-Detected:</strong> Rate <strong>$${matched.rate.toFixed(2)}</strong> par BUY aur SELL dono already active hain.<br>Click karne par <strong>Additional Hedged Pair</strong> add hoga.`;
      if (execBtn) {
        execBtn.innerText = `⚡ Execute Smart Pair (Additional Pair: ${modalSelectedBarrels} Barrels)`;
        execBtn.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
        execBtn.style.borderColor = '#fbbf24';
      }
    }
  } catch (e) {
    console.error('Error scanning rate leg status:', e);
  }
}

window.setModalBarrels = function(qty) {
  modalSelectedBarrels = parseFloat(qty) || 1;
  const headerSelect = document.getElementById('quickBarrelsSelect');
  if (headerSelect) headerSelect.value = modalSelectedBarrels;
  const inputEl = document.getElementById('tradeQtyInput');
  if (inputEl) inputEl.value = modalSelectedBarrels;
  updateModalQtyButtons(modalSelectedBarrels);
  updateModalCalculations();

  const execBtn = document.getElementById('modalExecuteBtn');
  if (execBtn) {
    if (currentModalTradeMode === 'SMART_PAIR') {
      if (modalRateScanState && modalRateScanState.hasBuy && !modalRateScanState.hasSell) {
        execBtn.innerText = `⚡ Execute Smart Pair (Add Missing SELL Leg: ${modalSelectedBarrels} Barrels)`;
      } else if (modalRateScanState && !modalRateScanState.hasBuy && modalRateScanState.hasSell) {
        execBtn.innerText = `⚡ Execute Smart Pair (Add Missing BUY Leg: ${modalSelectedBarrels} Barrels)`;
      } else {
        execBtn.innerText = `⚡ Execute Smart Pair (${modalSelectedBarrels} Barrels)`;
      }
    } else {
      execBtn.innerText = `🚀 Instant Pair Kharidein (${modalSelectedBarrels} Barrels)`;
    }
  }
};

window.onModalCustomQtyChange = function(val) {
  const q = parseFloat(val) || 1;
  modalSelectedBarrels = q;
  document.querySelectorAll('.modal-qty-btn').forEach(b => b.classList.remove('active'));
  updateModalCalculations();
};

function updateModalQtyButtons(qty) {
  document.querySelectorAll('.modal-qty-btn').forEach(b => {
    b.classList.remove('active');
    if (b.innerText.trim() === `${qty} B` || b.innerText.trim() === `${qty} Barrels`) {
      b.classList.add('active');
    }
  });
}

window.updateModalCalculations = function() {
  const p = modalLivePrice || 91.17;
  const usdInr = modalUsdInrRate || 95.91;
  const qty = modalSelectedBarrels || 10;
  const leverage = 5;

  const legMarginUSD = (p * qty) / leverage;
  const legMarginINR = legMarginUSD * usdInr;
  const pairMarginUSD = legMarginUSD * 2;
  const pairMarginINR = legMarginINR * 2;

  const targetSelect = document.getElementById('tradeTargetSelect');
  const targetMove = targetSelect ? parseFloat(targetSelect.value) || 0.20 : 0.20;

  const profitUSD = targetMove * qty;
  const profitINR = profitUSD * usdInr;

  const marginDisplay = document.getElementById('modalRequiredMarginDisplay');
  if (marginDisplay) {
    if (currentModalTradeMode === 'SMART_PAIR' && modalRateScanState && ((modalRateScanState.hasBuy && !modalRateScanState.hasSell) || (!modalRateScanState.hasBuy && modalRateScanState.hasSell))) {
      marginDisplay.innerText = `₹${Math.round(legMarginINR).toLocaleString('en-IN')} ($${legMarginUSD.toFixed(2)}) [1 Leg]`;
    } else {
      marginDisplay.innerText = `₹${Math.round(pairMarginINR).toLocaleString('en-IN')} ($${pairMarginUSD.toFixed(2)}) [Full Pair]`;
    }
  }

  const profitDisplay = document.getElementById('modalProjectedProfitDisplay');
  if (profitDisplay) {
    profitDisplay.innerText = `+₹${profitINR.toFixed(2)} (+$${profitUSD.toFixed(2)})`;
  }
};

window.executePairTradeModal = async function() {
  const targetSelect = document.getElementById('tradeTargetSelect');
  const targetMove = targetSelect ? parseFloat(targetSelect.value) || 0.20 : 0.20;
  const quantity = modalSelectedBarrels || 10;
  const price = modalLivePrice;

  const execBtn = document.getElementById('modalExecuteBtn');
  if (execBtn) {
    execBtn.disabled = true;
    execBtn.innerText = `⏳ Order Processing (${quantity} Barrels)...`;
  }

  try {
    let res, data;
    if (isPairAddContext()) {
      const action = currentModalTradeMode === 'SMART_PAIR' ? 'SMART_PAIR' : 'PAIR';
      res = await fetch('/api/pair-add/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, symbol: 'CLUSDT', price, quantity, targetMove })
      });
      data = await res.json();
    } else if (currentModalTradeMode === 'SMART_PAIR') {
      res = await fetch('/api/pair-add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'CLUSDT', price, quantity, targetMove })
      });
      data = await res.json();
    } else {
      res = await fetch('/api/manual-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'PAIR', symbol: 'CLUSDT', quantity, targetMove })
      });
      data = await res.json();
    }

    if (data.success) {
      alert(`✅ Trade Executed Successfully!\n\n${data.message}`);
      closeTradeModal();
      if (typeof fetchMetricsFallback === 'function') fetchMetricsFallback();
      if (typeof fetchDashboardMetrics === 'function') fetchDashboardMetrics();
    } else {
      alert(`❌ Trade Failed: ${data.error || 'Unknown error'}`);
    }
  } catch (err) {
    alert(`❌ Request Error: ${err.message}`);
  } finally {
    if (execBtn) {
      execBtn.disabled = false;
      if (currentModalTradeMode === 'SMART_PAIR') {
        execBtn.innerText = `⚡ Execute Smart Pair (${quantity} Barrels)`;
      } else {
        execBtn.innerText = `🚀 Instant Pair Kharidein (${quantity} Barrels)`;
      }
    }
  }
};

// --- ADMIN PORTAL SECURITY (Password: 340556) ---
const ADMIN_PASSWORD = '340556';

function isAdminAuthenticated() {
  return sessionStorage.getItem('mudrex_admin_authed') === ADMIN_PASSWORD;
}

function updateAdminButtonState() {
  const btn = document.getElementById('adminPortalBtn');
  const label = document.getElementById('adminBtnLabel');
  if (!btn || !label) return;
  if (isAdminAuthenticated()) {
    label.innerText = '🔓 Admin (Active)';
    btn.style.background = 'linear-gradient(135deg, #10b981, #059669)';
    btn.style.borderColor = '#34d399';
    btn.style.boxShadow = '0 0 16px rgba(16, 185, 129, 0.45)';
    btn.style.color = '#fff';
  } else {
    label.innerText = '🔐 Admin';
    btn.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
    btn.style.borderColor = '#fbbf24';
    btn.style.boxShadow = '0 0 15px rgba(245, 158, 11, 0.4)';
    btn.style.color = '#000';
  }
}

function openAdminPortal() {
  if (isAdminAuthenticated()) {
    openAdminControlCenter();
  } else {
    openAdminPasswordModal();
  }
}

function openAdminPasswordModal() {
  const modal = document.getElementById('adminPasswordModal');
  const input = document.getElementById('adminPasswordInput');
  const err = document.getElementById('adminPasswordError');
  if (modal) {
    modal.style.display = 'flex';
    if (input) {
      input.value = '';
      setTimeout(() => input.focus(), 150);
    }
    if (err) err.style.display = 'none';
  }
}

function closeAdminPasswordModal() {
  const modal = document.getElementById('adminPasswordModal');
  if (modal) modal.style.display = 'none';
}

function verifyAdminPassword() {
  const input = document.getElementById('adminPasswordInput');
  const err = document.getElementById('adminPasswordError');
  const val = input ? input.value.trim() : '';
  if (val === ADMIN_PASSWORD) {
    sessionStorage.setItem('mudrex_admin_authed', ADMIN_PASSWORD);
    updateAdminButtonState();
    closeAdminPasswordModal();
    openAdminControlCenter();
  } else {
    if (err) {
      err.innerText = '❌ Galat Password! Access Denied. Sahi password dalein.';
      err.style.display = 'block';
    }
    if (input) {
      input.value = '';
      input.focus();
    }
  }
}

function openAdminControlCenter() {
  const modal = document.getElementById('adminControlCenterModal');
  if (modal) {
    modal.style.display = 'flex';
  }
}

function closeAdminControlCenter() {
  const modal = document.getElementById('adminControlCenterModal');
  if (modal) {
    modal.style.display = 'none';
  }
}

function lockAdminPortal() {
  sessionStorage.removeItem('mudrex_admin_authed');
  updateAdminButtonState();
  closeAdminControlCenter();
  alert('🔒 Admin panel lock kar diya gaya hai.');
}

window.openAdminPortal = openAdminPortal;
window.openAdminPasswordModal = openAdminPasswordModal;
window.closeAdminPasswordModal = closeAdminPasswordModal;
window.verifyAdminPassword = verifyAdminPassword;
window.openAdminControlCenter = openAdminControlCenter;
window.closeAdminControlCenter = closeAdminControlCenter;
window.lockAdminPortal = lockAdminPortal;
window.isAdminAuthenticated = isAdminAuthenticated;
window.updateAdminButtonState = updateAdminButtonState;

// Secure Reset Data (Always Protected by Password: 340556)
window.resetAllDataConfirm = async function() {
  if (!isAdminAuthenticated()) {
    const entered = prompt('🔐 Admin Password dalein (Required: 340556) to reset engine data:');
    if (entered !== ADMIN_PASSWORD) {
      alert('❌ Access Denied: Galat Admin Password! Data Reset Cancelled.');
      return;
    }
    sessionStorage.setItem('mudrex_admin_authed', ADMIN_PASSWORD);
    updateAdminButtonState();
  }

  if (!confirm('⚠️ Kya aap Engine Data Reset karke sabhi purane trades aur positions clear karna chahte hain?\n\n(Naya clean dashboard fresh settings ke sath shuru hoga)')) {
    return;
  }

  try {
    const res = await fetch('/api/reset-data', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      alert('✅ Engine Data Reset Successful!\n\nSabhi purane trades aur positions clear kar diye gaye hain. Dashboard ab bilkul fresh shuru ho gaya hai.');
      if (typeof fetchMetricsFallback === 'function') fetchMetricsFallback();
      if (typeof fetchDashboardMetrics === 'function') fetchDashboardMetrics();
    } else {
      alert('❌ Reset failed: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('❌ Error resetting data: ' + err.message);
  }
};
window.resetData = window.resetAllDataConfirm;

// Init admin button state on load
document.addEventListener('DOMContentLoaded', () => {
  updateAdminButtonState();
});
