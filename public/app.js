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
  const btDate = document.getElementById('btDate');
  if (btDate) btDate.value = today;
  const btFromDate = document.getElementById('btFromDate');
  if (btFromDate) btFromDate.value = today;
  const btToDate = document.getElementById('btToDate');
  if (btToDate) btToDate.value = today;

  updateTargetDropdownOptions('CLUSDT', '0.20');
  makeDockDraggable();
  initRealtimeStream();
  checkMudrexAuthStatus();

  window.toggleEngineState = toggleEngineState;
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

let fallbackInterval = null;

function initRealtimeStream() {
  const isMudrexLivePage = window.location.pathname.includes('mudrex_live') || !!document.getElementById('mudrexStartEngineMainBtn');
  const streamUrl = isMudrexLivePage ? '/api/stream?mode=mudrex_live' : '/api/stream';

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
  const isMudrexLivePage = window.location.pathname.includes('mudrex_live') || !!document.getElementById('mudrexStartEngineMainBtn');
  const endpoint = isMudrexLivePage ? '/api/mudrex/metrics' : '/api/metrics';

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

    ctx.fillText(`$${val.toFixed(2)}`, w - paddingRight + 8, y + 4);
  }

  // Gradient under curve
  const isUp = tickHistory[tickHistory.length - 1].price >= tickHistory[0].price;
  const strokeColor = isUp ? '#10b981' : '#38bdf8';

  const areaGrad = ctx.createLinearGradient(0, paddingTop, 0, h - paddingBottom);
  areaGrad.addColorStop(0, isUp ? 'rgba(16, 185, 129, 0.3)' : 'rgba(56, 189, 248, 0.3)');
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
    ctx.fillText(`🎯 BUY $${nearestBuyTarget.toFixed(2)}`, w - paddingRight + 8, buyY + 4);
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
    ctx.fillText(`🎯 SELL $${nearestSellTarget.toFixed(2)}`, w - paddingRight + 8, sellY + 4);
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
  ctx.fillText(`$${tickHistory[lastI].price.toFixed(2)}`, w - paddingRight + 8, lastY + 4);
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

  // Main Engine Control Button
  const mainStartBtn = document.getElementById('mudrexStartEngineMainBtn') || document.getElementById('mudrexLiveStartBtn');

  if (isEngineRunning) {
    if (mainStartBtn) {
      mainStartBtn.innerHTML = '<span>⏸ PAUSE ENGINE</span>';
      mainStartBtn.style.background = 'linear-gradient(135deg, #ef4444, #b91c1c)';
      mainStartBtn.style.border = '1px solid #f87171';
      mainStartBtn.style.boxShadow = '0 0 16px rgba(239, 68, 68, 0.5)';
    }
  } else {
    if (mainStartBtn) {
      mainStartBtn.innerHTML = '<span>🚀 START ENGINE</span>';
      mainStartBtn.style.background = 'linear-gradient(135deg, #10b981, #047857)';
      mainStartBtn.style.border = '1px solid #34d399';
      mainStartBtn.style.boxShadow = '0 0 16px rgba(16, 185, 129, 0.5)';
    }
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
  
  const mTradesCount = document.getElementById('modalTradesCount');
  if (mTradesCount) mTradesCount.innerText = `Total: ${summary.closedPositionsCount} | Wins: ${summary.winCount} | Losses: ${summary.lossCount}`;

  if (document.getElementById('kpiTotalEquity')) document.getElementById('kpiTotalEquity').innerText = `₹${summary.totalEquityINR.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (document.getElementById('kpiEquitySubtext')) document.getElementById('kpiEquitySubtext').innerText = `Virtual Capital: ₹${summary.startingCapitalINR.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  if (document.getElementById('kpiRealizedBalance')) document.getElementById('kpiRealizedBalance').innerText = `₹${summary.realizedBalanceINR.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const realizedNetEl = document.getElementById('kpiRealizedNet');
  if (realizedNetEl) {
    realizedNetEl.innerText = `₹${summary.realizedNetINR.toFixed(2)}`;
    realizedNetEl.className = `kpi-value ${summary.realizedNetINR >= 0 ? 'text-green' : 'text-red'}`;
  }
  if (document.getElementById('kpiRealizedGrossSubtext')) document.getElementById('kpiRealizedGrossSubtext').innerText = `Gross: $${summary.realizedGrossUSD.toFixed(2)} | Charges: ₹${summary.realizedChargesINR.toFixed(2)}`;

  const floatNetEl = document.getElementById('kpiFloatingNet');
  if (floatNetEl) {
    floatNetEl.innerText = `₹${summary.floatingNetINR.toFixed(2)}`;
    floatNetEl.className = `kpi-value ${summary.floatingNetINR >= 0 ? 'text-green' : 'text-red'}`;
  }
  if (document.getElementById('kpiFloatingSubtext')) document.getElementById('kpiFloatingSubtext').innerText = `Gross: $${summary.floatingGrossUSD.toFixed(2)} | Charges: ₹${summary.floatingChargesINR.toFixed(2)}`;

  if (document.getElementById('kpiActivePairs')) document.getElementById('kpiActivePairs').innerText = `${summary.activePairsCount} / ${summary.maxActivePairs}`;
  if (document.getElementById('kpiUniqueRatesCount')) document.getElementById('kpiUniqueRatesCount').innerText = `Processed Rates: ${processedRatesCount} unique`;

  if (document.getElementById('kpiAvailableMargin')) document.getElementById('kpiAvailableMargin').innerText = `₹${summary.availableMarginINR.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  if (document.getElementById('kpiMarginUsed')) document.getElementById('kpiMarginUsed').innerText = `Locked Margin: ₹${summary.marginUsedINR.toFixed(2)} (${settings.leverage}x)`;

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
  if (usdInrInput) usdInrInput.value = settings.usdInrRate || rateFeedInfo.usdInrRate;

  // Tabs count badges
  const actTab = document.getElementById('tabActiveCount');
  if (actTab) actTab.innerText = openPositions.length;
  const clsTab = document.getElementById('tabClosedCount');
  if (clsTab) clsTab.innerText = closedPositions.length;

  // Calculate Next Exit Targets (Nearest BUY exit above market, Nearest SELL exit below market)
  const livePrice = rateFeedInfo.price;
  const priceDec = currentSymbol === 'BTCUSDT' ? 2 : (currentSymbol === 'XAGUSDT' ? 4 : 2);
  
  let nearestBuyTarget = null;
  let nearestSellTarget = null;
  let distBuy = null;
  let distSell = null;

  if (livePrice && openPositions && openPositions.length > 0) {
    openPositions.forEach(pos => {
      if (!pos.targetExitPrice) return;
      if (pos.direction === 'BUY') {
        if (pos.targetExitPrice > livePrice) {
          if (nearestBuyTarget === null || pos.targetExitPrice < nearestBuyTarget) {
            nearestBuyTarget = pos.targetExitPrice;
          }
        }
      } else if (pos.direction === 'SELL') {
        if (pos.targetExitPrice < livePrice) {
          if (nearestSellTarget === null || pos.targetExitPrice > nearestSellTarget) {
            nearestSellTarget = pos.targetExitPrice;
          }
        }
      }
    });

    if (nearestBuyTarget !== null) distBuy = nearestBuyTarget - livePrice;
    if (nearestSellTarget !== null) distSell = livePrice - nearestSellTarget;
  }

  if (newPrice) {
    recordPriceTick(newPrice);
  }

  const liveRateStr = livePrice ? `$${livePrice.toFixed(priceDec)}` : 'FETCHING...';
  const buyTargetStr = nearestBuyTarget !== null ? `$${nearestBuyTarget.toFixed(priceDec)}` : 'No Target';
  const buyDistStr = distBuy !== null ? `(+$${distBuy.toFixed(priceDec)})` : '';
  const sellTargetStr = nearestSellTarget !== null ? `$${nearestSellTarget.toFixed(priceDec)}` : 'No Target';
  const sellDistStr = distSell !== null ? `(-$${distSell.toFixed(priceDec)})` : '';
  const floatNetStr = `₹${summary.floatingNetINR.toFixed(2)}`;
  const floatNetClass = summary.floatingNetINR >= 0 ? 'text-green' : 'text-red';

  // Update Main CLUSDT Live Rate Text (VERY LARGE BOLD TEXT)
  const mainCrudeRateEl = document.getElementById('mainCrudeLiveRate');
  if (mainCrudeRateEl) {
    mainCrudeRateEl.innerText = liveRateStr;
    mainCrudeRateEl.style.color = (tickHistory.length >= 2 && tickHistory[tickHistory.length - 1].price >= tickHistory[0].price) ? '#38bdf8' : '#38bdf8';
  }
  const mainCrudeRateIndexEl = document.getElementById('mainCrudeLiveRateIndex');
  if (mainCrudeRateIndexEl) mainCrudeRateIndexEl.innerText = liveRateStr;

  const symbolLabelText = `🛢️ ${symbolLabels[currentSymbol] || currentSymbol} LIVE RATE`;
  if (document.getElementById('unifiedSymbolLabel')) document.getElementById('unifiedSymbolLabel').innerText = symbolLabelText;
  if (document.getElementById('unifiedSymbolLabelIndex')) document.getElementById('unifiedSymbolLabelIndex').innerText = symbolLabelText;

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

  const buyTargetFull = distBuy !== null ? `${buyTargetStr} ${buyDistStr}` : buyTargetStr;
  if (document.getElementById('unifiedBuyTarget')) document.getElementById('unifiedBuyTarget').innerText = buyTargetFull;
  if (document.getElementById('unifiedBuyTargetIndex')) document.getElementById('unifiedBuyTargetIndex').innerText = buyTargetFull;

  const sellTargetFull = distSell !== null ? `${sellTargetStr} ${sellDistStr}` : sellTargetStr;
  if (document.getElementById('unifiedSellTarget')) document.getElementById('unifiedSellTarget').innerText = sellTargetFull;
  if (document.getElementById('unifiedSellTargetIndex')) document.getElementById('unifiedSellTargetIndex').innerText = sellTargetFull;

  // Render Canvas Charts
  drawLiveCanvasChart('livePriceCanvas', livePrice, nearestBuyTarget, nearestSellTarget);
  drawLiveCanvasChart('livePriceCanvasIndex', livePrice, nearestBuyTarget, nearestSellTarget);

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
  renderActivePositions(openPositions, settings.instrument);
  renderClosedPositions(closedPositions, settings.instrument);
  
  if (document.getElementById('tabLogs').classList.contains('active')) {
    renderAuditLogs(auditLogs);
  }
}

let activeSortKey = null;
let activeSortDir = 'desc';

let closedSortKey = null;
let closedSortDir = 'desc';

function sortTable(tableType, key) {
  if (tableType === 'active') {
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
      closedSortDir = ['grossProfitUSD', 'netProfitINR', 'totalChargesINR', 'entryPrice', 'exitPrice', 'holdingDurationSec'].includes(key) ? 'desc' : 'asc';
    }
  }

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

function renderActivePositions(positions, symbol) {
  const buyTbody = document.getElementById('buyPositionsTbody');
  const sellTbody = document.getElementById('sellPositionsTbody');
  const buyBadge = document.getElementById('buyPositionsBadge');
  const sellBadge = document.getElementById('sellPositionsBadge');
  const buyNetPlEl = document.getElementById('buyPositionsNetPL');
  const sellNetPlEl = document.getElementById('sellPositionsNetPL');
  const singleTbody = document.getElementById('activePositionsTbody');

  const buyPositions = (positions || []).filter(p => p.direction === 'BUY');
  const sellPositions = (positions || []).filter(p => p.direction === 'SELL');

  const totalBuyNetINR = buyPositions.reduce((sum, p) => sum + (typeof p.floatingNetINR === 'number' ? p.floatingNetINR : 0), 0);
  const totalSellNetINR = sellPositions.reduce((sum, p) => sum + (typeof p.floatingNetINR === 'number' ? p.floatingNetINR : 0), 0);

  if (buyBadge) buyBadge.innerText = `${buyPositions.length} Active`;
  if (sellBadge) sellBadge.innerText = `${sellPositions.length} Active`;

  if (buyNetPlEl) {
    buyNetPlEl.innerHTML = `NET P/L: <strong class="${totalBuyNetINR >= 0 ? 'text-green' : 'text-red'}">₹${totalBuyNetINR >= 0 ? '+' : ''}${totalBuyNetINR.toFixed(2)}</strong>`;
  }
  if (sellNetPlEl) {
    sellNetPlEl.innerHTML = `NET P/L: <strong class="${totalSellNetINR >= 0 ? 'text-green' : 'text-red'}">₹${totalSellNetINR >= 0 ? '+' : ''}${totalSellNetINR.toFixed(2)}</strong>`;
  }

  // Sort by Next Exit target distance ascending (closest target exit first)
  buyPositions.sort((a, b) => getDistToExit(a) - getDistToExit(b));
  sellPositions.sort((a, b) => getDistToExit(a) - getDistToExit(b));

  const priceDecimals = symbol === 'BTCUSDT' ? 2 : (symbol === 'XAGUSDT' ? 4 : 2);

  const renderSideRows = (posList, isBuyTable) => {
    if (posList.length === 0) {
      return `<tr><td colspan="5" style="text-align: center; color: var(--text-dim); padding: 18px;">No active ${isBuyTable ? 'BUY' : 'SELL'} positions.</td></tr>`;
    }
    let rowsHtml = '';
    for (const pos of posList) {
      const entryPrice = typeof pos.entryPrice === 'number' ? pos.entryPrice : 0;
      const currentPrice = typeof pos.currentPrice === 'number' ? pos.currentPrice : entryPrice;
      const targetPrice = typeof pos.targetExitPrice === 'number' ? pos.targetExitPrice : null;
      const floatingNetINR = typeof pos.floatingNetINR === 'number' ? pos.floatingNetINR : 0;

      const dist = targetPrice !== null ? Math.abs(targetPrice - currentPrice) : null;
      const netClass = floatingNetINR >= 0 ? 'text-green' : 'text-red';

      rowsHtml += `
        <tr>
          <td>
            <strong style="font-size:0.85rem;">${pos.pairId || 'N/A'}</strong>
            <span style="display:block;"><code style="color:var(--accent-cyan); font-size:0.75rem;">${pos.positionId || 'N/A'}</code></span>
            ${pos.apiStatus && !pos.apiStatus.includes('REAL_ORDERS_DISABLED') ? `<span style="display:block; font-size:0.62rem; color:${pos.apiStatus.includes('TRANSMITTED') ? '#a7f3d0' : (pos.apiStatus.includes('SENDING') ? '#38bdf8' : '#f87171')}; font-weight:700;">📡 ${pos.apiStatus}</span>` : ''}
          </td>
          <td>
            <div style="font-size:0.78rem; color:var(--text-muted);">$${entryPrice.toFixed(priceDecimals)}</div>
            <div style="font-size:0.88rem; font-weight:700; color:#fff;">➔ $${currentPrice.toFixed(priceDecimals)}</div>
          </td>
          <td>
            ${targetPrice !== null ? `
              <div style="font-size:1.05rem; font-weight:800; color:#f59e0b; font-family:monospace;">$${targetPrice.toFixed(priceDecimals)}</div>
              <div style="font-size:0.7rem; color:var(--text-muted);">$${dist.toFixed(priceDecimals)} to exit</div>
            ` : '<span style="color:var(--text-dim)">DISABLED</span>'}
          </td>
          <td style="text-align: right;">
            <div class="${netClass}" style="font-size:1.08rem; font-weight:800; font-family:monospace;">₹${floatingNetINR >= 0 ? '+' : ''}${floatingNetINR.toFixed(2)}</div>
            <div style="font-size:0.68rem; color:var(--text-muted);">NET P/L (INR)</div>
          </td>
          <td style="text-align: center;">
            <button class="btn btn-danger" style="padding: 3px 8px; font-size: 0.72rem; font-weight:700;" onclick="manualClose('${pos.positionId}')">Close</button>
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

function renderClosedPositions(positions, symbol) {
  updateTableHeaderClasses('closedPositionsTable', closedSortKey, closedSortDir);
  const tbody = document.getElementById('closedPositionsTbody');
  if (!tbody) return;

  let html = '';
  if (!positions || positions.length === 0) {
    html = `<tr><td colspan="13" style="text-align: center; color: var(--text-dim); padding: 24px;">No closed positions recorded yet.</td></tr>`;
  } else {
    const sortedPositions = sortDataArray(positions, closedSortKey, closedSortDir);
    const priceDecimals = symbol === 'BTCUSDT' ? 2 : (symbol === 'XAGUSDT' ? 4 : 2);

    for (const pos of sortedPositions) {
      const isBuy = pos.direction === 'BUY';
      const entryPrice = typeof pos.entryPrice === 'number' ? pos.entryPrice : 0;
      const exitPrice = typeof pos.exitPrice === 'number' ? pos.exitPrice : entryPrice;
      const targetPrice = typeof pos.targetExitPrice === 'number' ? pos.targetExitPrice : null;
      const grossProfitUSD = typeof pos.grossProfitUSD === 'number' ? pos.grossProfitUSD : 0;
      const totalChargesINR = typeof pos.totalChargesINR === 'number' ? pos.totalChargesINR : 0;
      const netProfitINR = typeof pos.netProfitINR === 'number' ? pos.netProfitINR : 0;

      const grossClass = grossProfitUSD >= 0 ? 'text-green' : 'text-red';
      const netClass = netProfitINR >= 0 ? 'text-green' : 'text-red';

      html += `
        <tr>
          <td><strong>${pos.pairId || 'N/A'}</strong></td>
          <td><code style="color:var(--accent-cyan);">${pos.positionId || 'N/A'}</code></td>
          <td><span class="badge-direction ${isBuy ? 'buy' : 'sell'}">${pos.direction || 'BUY'}</span></td>
          <td>${pos.entryTime ? new Date(pos.entryTime).toLocaleTimeString() : 'N/A'}</td>
          <td>${pos.exitTime ? new Date(pos.exitTime).toLocaleTimeString() : 'N/A'}</td>
          <td>$${entryPrice.toFixed(priceDecimals)}</td>
          <td>$${exitPrice.toFixed(priceDecimals)}</td>
          <td>${targetPrice !== null ? `<span class="target-price-badge">$${targetPrice.toFixed(priceDecimals)}</span>` : 'N/A'}</td>
          <td class="${grossClass}">$${grossProfitUSD >= 0 ? '+' : ''}${grossProfitUSD.toFixed(4)}</td>
          <td>₹${totalChargesINR.toFixed(2)}</td>
          <td class="${netClass}" style="font-weight:700;">₹${netProfitINR >= 0 ? '+' : ''}${netProfitINR.toFixed(2)}</td>
          <td><span class="badge-reason">${pos.exitReason || 'TARGET HIT'}</span></td>
          <td class="${netClass}" style="font-size: 1.1rem; font-weight: 800; font-family: monospace; white-space: nowrap; background: rgba(15, 23, 42, 0.6); border-left: 2px solid ${netProfitINR >= 0 ? '#10b981' : '#ef4444'}; text-align: center;">
            <span>₹${netProfitINR >= 0 ? '+' : ''}${netProfitINR.toFixed(2)}</span>
          </td>
        </tr>
      `;
    }
  }

  if (tbody.innerHTML !== html) {
    tbody.innerHTML = html;
  }
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

function resetAllData() {
  fetch('/api/reset-data', { method: 'POST' })
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
  fetch('/api/toggle-engine', { method: 'POST' })
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
        container.innerHTML = `
          <div style="color:#f87171; font-weight:700;">⚠️ MUDREX LIVE API AUTHENTICATION REQUIRED</div>
          <div style="color:var(--text-muted); margin-top:4px; font-size:0.78rem;">${res.error || 'MUDREX_API_SECRET missing in environment.'}</div>
        `;
      }
    })
    .catch(err => {
      container.innerHTML = `<div style="color:#f87171">Error checking auth: ${err.message}</div>`;
    });
}

function saveAndConnectMudrexKeys() {
  const apiKey = (document.getElementById('inputMudrexApiKey')?.value || '').trim();
  const apiSecret = (document.getElementById('inputMudrexApiSecret')?.value || '').trim();

  if (!apiKey && !apiSecret) {
    alert('Please paste your Mudrex API Key and Secret Key.');
    return;
  }

  const container = document.getElementById('mudrexAuthStatusContainer');
  if (container) container.innerHTML = '<span style="color:var(--accent-cyan)">Saving and testing Mudrex API credentials...</span>';

  fetch('/api/mudrex/save-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey, apiSecret })
  })
  .then(r => r.json())
  .then(res => {
    if (res.success && res.auth && res.auth.success) {
      alert('✅ Mudrex API Keys Connected Successfully!');
      checkMudrexAuthStatus();
      fetchMetricsFallback();
    } else {
      const errMsg = (res.auth && res.auth.error) ? res.auth.error : (res.error || 'Invalid API Secret Key');
      alert('⚠️ Mudrex API Connection Failed: ' + errMsg);
      checkMudrexAuthStatus();
    }
  })
  .catch(err => {
    alert('Error connecting API keys: ' + err.message);
  });
}
