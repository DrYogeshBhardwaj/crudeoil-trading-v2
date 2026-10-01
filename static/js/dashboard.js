/**
 * Live Web Dashboard Client Script.
 * Periodically polls /api/state and updates the UI dynamically.
 */

async function updateDashboard() {
    try {
        const response = await fetch('/api/state');
        if (!response.ok) return;

        const data = await response.json();

        // 1. Header & Live Price
        document.getElementById('inst-name').textContent = data.instrument || 'CRUDEOILM';
        document.getElementById('inst-exchange').textContent = data.exchange || 'MCX';
        
        const priceElem = document.getElementById('live-price');
        priceElem.textContent = `₹${data.current_price.toFixed(2)}`;
        
        const tickTimeStr = data.last_tick_time_ist || data.last_tick_time || '-';
        document.getElementById('last-tick').textContent = `Last Tick (IST): ${tickTimeStr}`;
        const replayTimeElem = document.getElementById('replay-ist-time');
        if (replayTimeElem) {
            replayTimeElem.textContent = `Replay Tick: ${tickTimeStr}`;
        }

        // Feed Health & Mode Badge
        const healthBadge = document.getElementById('feed-health');
        if (healthBadge) {
            const feedLabel = data.feed_mode_label || (data.feed_health === 'LIVE' ? 'LIVE DHAN FEED' : 'PAPER REPLAY / NO LIVE FEED');
            const isLive = data.feed_health === 'LIVE' && data.websocket_connected;
            healthBadge.textContent = feedLabel;
            healthBadge.style.background = isLive ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)';
            healthBadge.style.color = isLive ? '#22c55e' : '#ef4444';
            healthBadge.style.borderColor = isLive ? '#22c55e' : '#ef4444';
        }

        // System Status Pill
        const statusElem = document.getElementById('system-status');
        statusElem.textContent = data.system_status || 'WATCHING';
        statusElem.className = 'status-pill ';
        if (data.system_status === 'PAPER ACTIVE') {
            statusElem.classList.add('status-active');
        } else if (data.system_status === 'PAUSED') {
            statusElem.classList.add('status-paused');
        } else {
            statusElem.classList.add('status-watching');
        }

        // 2. MTF Alignment Badges
        updateTFBadge('tf-1h', data.tf_1h_state);
        updateTFBadge('tf-15m', data.tf_15m_state);
        updateTFBadge('tf-5m', data.tf_5m_state);

        // 3. Action Signal & AI Evaluation
        const sig = data.signal || {};
        const actionElem = document.getElementById('action-signal');
        actionElem.textContent = sig.action || 'WAIT';
        actionElem.className = 'action-pill ';
        if (sig.action === 'BUY') actionElem.classList.add('action-buy');
        else if (sig.action === 'SELL') actionElem.classList.add('action-sell');
        else actionElem.classList.add('action-wait');

        document.getElementById('trend-state').textContent = sig.trend_state || 'RANGE';

        const confScore = sig.confidence || 0;
        document.getElementById('confidence-score').textContent = `${confScore} / 100`;
        document.getElementById('confidence-bar').style.width = `${confScore}%`;

        // AI Factual Reasons List
        const reasonsList = document.getElementById('reasons-list');
        reasonsList.innerHTML = '';
        if (sig.reasons && sig.reasons.length > 0) {
            sig.reasons.forEach(r => {
                const li = document.createElement('li');
                li.textContent = r;
                reasonsList.appendChild(li);
            });
        } else {
            const li = document.createElement('li');
            li.textContent = 'Monitoring market structure...';
            reasonsList.appendChild(li);
        }

        // 4. Active Paper Position
        const posStatusElem = document.getElementById('pos-status');
        const pos = data.active_position;
        if (pos) {
            posStatusElem.textContent = `${pos.direction} ACTIVE`;
            posStatusElem.style.background = pos.direction === 'BUY' ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)';
            
            document.getElementById('pos-id').textContent = pos.trade_id;
            document.getElementById('pos-dir').textContent = pos.direction;
            document.getElementById('pos-entry').textContent = `₹${pos.entry_price.toFixed(1)}`;
            document.getElementById('pos-sl').textContent = `₹${pos.stop_loss.toFixed(1)}`;
            document.getElementById('pos-tgt').textContent = `₹${pos.target_1.toFixed(1)} / ₹${pos.target_2.toFixed(1)}`;

            const unpnlElem = document.getElementById('unrealized-pnl');
            const pnlVal = pos.unrealized_pnl || 0;
            unpnlElem.textContent = `₹${pnlVal >= 0 ? '+' : ''}${pnlVal.toFixed(2)}`;
            unpnlElem.className = `unrealized-val ${pnlVal >= 0 ? 'pnl-positive' : 'pnl-negative'}`;
        } else {
            posStatusElem.textContent = 'NO ACTIVE POSITION';
            posStatusElem.style.background = 'rgba(255, 255, 255, 0.05)';
            
            document.getElementById('pos-id').textContent = '-';
            document.getElementById('pos-dir').textContent = '-';
            document.getElementById('pos-entry').textContent = '-';
            document.getElementById('pos-sl').textContent = '-';
            document.getElementById('pos-tgt').textContent = '-';
            
            const unpnlElem = document.getElementById('unrealized-pnl');
            unpnlElem.textContent = '₹0.00';
            unpnlElem.className = 'unrealized-val';
        }

        // 5. Virtual Account & Capital Metrics
        const startCap = data.starting_virtual_capital || 200000;
        const availCap = data.available_virtual_capital || 200000;
        const netPnlVal = data.realized_pnl || data.daily_realized_pnl || 0;

        document.getElementById('starting-capital').textContent = `₹${startCap.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
        document.getElementById('available-capital').textContent = `₹${availCap.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;

        const netPnlElem = document.getElementById('daily-net-pnl');
        netPnlElem.textContent = `₹${netPnlVal >= 0 ? '+' : ''}${netPnlVal.toFixed(2)}`;
        netPnlElem.className = `val-pnl ${netPnlVal >= 0 ? 'pnl-positive' : 'pnl-negative'}`;

        document.getElementById('total-charges').textContent = `₹${(data.total_charges || 0).toFixed(2)}`;
        document.getElementById('daily-trades-count').textContent = data.total_trades_count || 0;
        document.getElementById('win-rate').textContent = `${data.win_rate_percent || 0.0}%`;
        document.getElementById('profit-factor').textContent = data.profit_factor_str || '0.00';
        document.getElementById('max-drawdown').textContent = `₹${(data.max_drawdown_inr || 0).toFixed(2)}`;

        // 6. Paper Trade Audit Ledger Table
        const ledger = data.trade_ledger || [];
        document.getElementById('ledger-count').textContent = `${ledger.length} Trades Recorded`;
        
        const tbody = document.getElementById('ledger-tbody');
        if (ledger.length === 0) {
            tbody.innerHTML = '<tr><td colspan="12" class="empty-msg">No executed paper trades yet. Waiting for high-confidence trend signals...</td></tr>';
        } else {
            tbody.innerHTML = '';
            ledger.forEach(t => {
                const tr = document.createElement('tr');
                const pnlClass = t.net_pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
                tr.innerHTML = `
                    <td><strong>${t.trade_id}</strong></td>
                    <td>${t.entry_time}</td>
                    <td><span class="tf-badge ${t.direction === 'BUY' ? 'tf-bullish' : 'tf-bearish'}">${t.direction}</span></td>
                    <td>₹${t.entry_price.toFixed(1)}</td>
                    <td>${t.exit_price ? '₹' + t.exit_price.toFixed(1) : '-'}</td>
                    <td>${t.exit_reason || '-'}</td>
                    <td>${t.trend_state}</td>
                    <td>${t.confidence}%</td>
                    <td>₹${t.gross_pnl.toFixed(2)}</td>
                    <td>₹${t.charges.toFixed(2)}</td>
                    <td>₹${t.slippage.toFixed(2)}</td>
                    <td class="${pnlClass}"><strong>₹${t.net_pnl >= 0 ? '+' : ''}${t.net_pnl.toFixed(2)}</strong></td>
                `;
                tbody.appendChild(tr);
            });
        }

    } catch (err) {
        console.error('Error fetching dashboard state:', err);
    }
}

function updateTFBadge(elemId, state) {
    const elem = document.getElementById(elemId);
    elem.textContent = state || 'RANGE';
    elem.className = 'tf-badge ';
    if (state === 'BULLISH') elem.classList.add('tf-bullish');
    else if (state === 'BEARISH') elem.classList.add('tf-bearish');
    else elem.classList.add('tf-range');
}

function updateISTClock() {
    const clockElem = document.getElementById('live-ist-clock');
    if (!clockElem) return;
    const now = new Date();
    const options = { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' };
    const istStr = new Intl.DateTimeFormat('en-IN', options).format(now);
    clockElem.textContent = `${istStr} IST`;
}

// Initial fetch, IST clock interval, and dashboard polling
updateISTClock();
setInterval(updateISTClock, 1000);
updateDashboard();
setInterval(updateDashboard, 2000);
