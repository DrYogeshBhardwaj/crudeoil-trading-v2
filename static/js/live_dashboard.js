/**
 * Client-Side JavaScript for CRUDEOILM LIVE TEST Dashboard (/live)
 * Polls /api/live/state dynamically and binds live controls.
 */

async function updateLiveDashboard() {
    try {
        const response = await fetch('/api/live/state');
        if (!response.ok) return;

        const data = await response.json();

        // 1. Live Price & Last Tick
        const priceElem = document.getElementById('live-price');
        if (priceElem) {
            if (data.current_price && data.current_price > 0) {
                priceElem.textContent = `₹${data.current_price.toFixed(2)}`;
                priceElem.style.color = '#10b981';
                priceElem.style.fontSize = '1.8rem';
            } else {
                priceElem.textContent = 'NO LIVE FEED / NO TRADE';
                priceElem.style.color = '#f43f5e';
                priceElem.style.fontSize = '0.95rem';
            }
        }

        const tickElem = document.getElementById('last-tick');
        if (tickElem) {
            tickElem.textContent = data.last_tick_time_ist ? `Last Tick: ${data.last_tick_time_ist}` : 'Syncing Live Feed...';
            tickElem.style.color = (data.current_price && data.current_price > 0) ? '#38bdf8' : '#94a3b8';
        }

        // 2. Dhan Status & Client ID
        const dhanStatusElem = document.getElementById('dhan-status-badge');
        if (dhanStatusElem) {
            dhanStatusElem.textContent = `DHAN API: ${data.dhan_connection}`;
            const isConn = data.dhan_connection === 'CONNECTED';
            dhanStatusElem.style.background = isConn ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)';
            dhanStatusElem.style.color = isConn ? '#22c55e' : '#ef4444';
            dhanStatusElem.style.borderColor = isConn ? '#22c55e' : '#ef4444';
        }

        const clientElem = document.getElementById('dhan-client-id');
        if (clientElem) clientElem.textContent = data.dhan_client_id || 'NOT_CONFIGURED';

        const marginElem = document.getElementById('avail-margin');
        if (marginElem) marginElem.textContent = `₹${(data.available_margin_inr || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}`;

        // 3. Market Status Badge
        const marketBadge = document.getElementById('market-status-badge');
        if (marketBadge) {
            const isMktOpen = data.market_status === 'OPEN';
            marketBadge.textContent = `MARKET: ${data.market_status || 'OPEN'}`;
            marketBadge.style.background = isMktOpen ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)';
            marketBadge.style.color = isMktOpen ? '#22c55e' : '#ef4444';
            marketBadge.style.borderColor = isMktOpen ? '#22c55e' : '#ef4444';
        }

        // 4. Continuous Live Engine Status & Strategy Action
        const engineBadge = document.getElementById('engine-status-badge');
        if (engineBadge) engineBadge.textContent = data.engine_status || 'RUNNING 24x7';

        const actionBadge = document.getElementById('strategy-action-badge');
        if (actionBadge && data.latest_evaluation) {
            const act = data.latest_evaluation.action || 'WAIT';
            actionBadge.textContent = `STRATEGY: ${act} (${data.latest_evaluation.trend_state || 'RANGE'})`;
            actionBadge.style.color = act === 'BUY' ? '#10b981' : (act === 'SELL' ? '#ef4444' : '#f59e0b');
        }

        // 5. Daily Loss & Drawdown
        const dailyLossElem = document.getElementById('live-daily-loss');
        if (dailyLossElem) dailyLossElem.textContent = `₹${(data.daily_loss_inr || 0).toFixed(2)}`;

        const netPnlElem = document.getElementById('live-net-pnl');
        if (netPnlElem) {
            const netVal = data.realized_pnl || 0;
            netPnlElem.textContent = `₹${netVal >= 0 ? '+' : ''}${netVal.toFixed(2)}`;
            netPnlElem.className = `val-pnl ${netVal >= 0 ? 'pnl-positive' : 'pnl-negative'}`;
        }

        const tradesCountElem = document.getElementById('live-trades-count');
        if (tradesCountElem) tradesCountElem.textContent = data.total_trades_count || 0;

        // 6. Active Live Position
        const posStatusElem = document.getElementById('live-pos-status');
        const pos = data.active_position;
        if (pos) {
            posStatusElem.textContent = `${pos.direction} LIVE ACTIVE`;
            posStatusElem.style.background = pos.direction === 'BUY' ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)';
            
            document.getElementById('pos-id').textContent = pos.trade_id;
            document.getElementById('pos-order-id').textContent = pos.dhan_order_id || '-';
            document.getElementById('pos-dir').textContent = pos.direction;
            document.getElementById('pos-fill').textContent = `₹${pos.fill_price.toFixed(1)}`;
            document.getElementById('pos-sl').textContent = `₹${pos.stop_loss.toFixed(1)}`;
            document.getElementById('pos-tgt').textContent = `₹${pos.target_1.toFixed(1)} / ₹${pos.target_2.toFixed(1)}`;

            const unpnlElem = document.getElementById('unrealized-pnl');
            const pnlVal = pos.unrealized_pnl || 0;
            unpnlElem.textContent = `₹${pnlVal >= 0 ? '+' : ''}${pnlVal.toFixed(2)}`;
            unpnlElem.className = `unrealized-val ${pnlVal >= 0 ? 'pnl-positive' : 'pnl-negative'}`;
        } else {
            posStatusElem.textContent = 'NO LIVE POSITION';
            posStatusElem.style.background = 'rgba(255, 255, 255, 0.05)';
            
            document.getElementById('pos-id').textContent = '-';
            document.getElementById('pos-order-id').textContent = '-';
            document.getElementById('pos-dir').textContent = '-';
            document.getElementById('pos-fill').textContent = '-';
            document.getElementById('pos-sl').textContent = '-';
            document.getElementById('pos-tgt').textContent = '-';
            
            const unpnlElem = document.getElementById('unrealized-pnl');
            unpnlElem.textContent = '₹0.00';
            unpnlElem.className = 'unrealized-val';
        }

        // 7. Readiness Report Listing
        const reportList = document.getElementById('readiness-list');
        if (reportList && data.readiness_report) {
            reportList.innerHTML = '';
            const rep = data.readiness_report;
            
            const items = [
                `Dhan Auth: ${rep.dhan_authentication.status} (Client ID: ${rep.dhan_authentication.client_id})`,
                `Market Feed: ${rep.market_feed.instrument} ${rep.market_feed.exchange} (Sec ID: ${rep.market_feed.security_id}, Lot Size: ${rep.market_feed.lot_size})`,
                `Available Margin: ₹${rep.account_limits.available_margin_inr.toLocaleString('en-IN')}`,
                `Safety Flag: ${rep.safety_controls.live_test_enable_flag || (data.live_test_enable_flag ? 'TRUE / ACTIVE' : 'FALSE / BLOCKED')}`,
                `Order Placement Status: ${rep.safety_controls.order_placement_status}`,
                `Outbound Server IPv4: ${rep.server_outbound_public_ipv4 || 'FETCHING'} (DYNAMIC EGRESS IP)`,
                `Static IP Requirement: ${rep.safety_controls.static_ip_requirement || '-'}`,
                `Order Reconciliation: ${rep.safety_controls.order_reconciliation}`,
                `Emergency Exit All: ${rep.safety_controls.emergency_exit_all}`,
                `60-Min Auto Stop: ${rep.safety_controls.auto_stop_duration}`
            ];

            items.forEach(itemText => {
                const li = document.createElement('li');
                li.textContent = itemText;
                reportList.appendChild(li);
            });
        }

        // 7b. Strategy Evaluation Stream Card
        const evalCountElem = document.getElementById('eval-count-badge');
        if (evalCountElem) {
            evalCountElem.textContent = `${(data.evaluation_count || 0).toLocaleString()} Live Ticks Evaluated`;
        }

        const evalActionTag = document.getElementById('eval-action-tag');
        const evalTrendTag = document.getElementById('eval-trend-tag');
        const evalReasonsText = document.getElementById('eval-reasons-text');

        if (data.latest_evaluation) {
            const ev = data.latest_evaluation;
            const act = ev.action || 'WAIT';
            if (evalActionTag) {
                evalActionTag.textContent = act;
                evalActionTag.style.color = act === 'BUY' ? '#10b981' : (act === 'SELL' ? '#ef4444' : '#f59e0b');
                evalActionTag.style.borderColor = act === 'BUY' ? '#10b981' : (act === 'SELL' ? '#ef4444' : '#f59e0b');
                evalActionTag.style.background = act === 'BUY' ? 'rgba(16, 185, 129, 0.15)' : (act === 'SELL' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(245, 158, 11, 0.15)');
            }
            if (evalTrendTag) {
                evalTrendTag.textContent = `Trend: ${ev.trend_state || 'RANGE'} (Conf: ${ev.confidence || 0}%) | Time: ${ev.timestamp_ist || '-'}`;
            }
            if (evalReasonsText) {
                const rStr = ev.reasons && ev.reasons.length > 0 ? ev.reasons.join('; ') : 'No entry conditions triggered';
                evalReasonsText.textContent = `Reasons: ${rStr}`;
            }
        } else {
            if (evalReasonsText) {
                evalReasonsText.textContent = data.market_status === 'CLOSED' ? 
                    'Market Session CLOSED (09:00 - 23:30 IST). Strategy evaluation automatically resumes when market opens.' : 
                    'Waiting for live market tick feed...';
            }
        }

        const candleGrid = document.getElementById('candle-counts-grid');
        if (candleGrid && data.candle_status) {
            const c = data.candle_status;
            candleGrid.textContent = `1H: ${c['1h_count'] || 0} | 15M: ${c['15m_count'] || 0} | 5M: ${c['5m_count'] || 0} | 1M: ${c['1m_count'] || 0}`;
        }

        const logsBox = document.getElementById('live-tick-logs-box');
        if (logsBox) {
            const logs = data.latest_evaluation_logs || [];
            if (logs.length === 0) {
                logsBox.innerHTML = `<div>${data.market_status === 'CLOSED' ? 'Market Session CLOSED (MCX Hours: 09:00 - 23:30 IST). Live ticks will stream when market opens at 09:00 AM IST.' : 'No tick logs yet. Waiting for live tick stream...'}</div>`;
            } else {
                logsBox.innerHTML = logs.map(log => `<div>${log}</div>`).join('');
                logsBox.scrollTop = logsBox.scrollHeight;
            }
        }

        // 8. Executed Live Trade Audit Ledger
        const ledger = data.trade_ledger || [];
        document.getElementById('ledger-count').textContent = `${ledger.length} Live Trades Recorded`;
        
        const tbody = document.getElementById('ledger-tbody');
        if (ledger.length === 0) {
            tbody.innerHTML = '<tr><td colspan="12" class="empty-msg">No executed live trades yet. Real money execution is ACTIVE and waiting for a valid BUY/SELL strategy signal.</td></tr>';
        } else {
            tbody.innerHTML = '';
            ledger.forEach(t => {
                const tr = document.createElement('tr');
                const pnlClass = t.net_pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
                tr.innerHTML = `
                    <td><strong>${t.trade_id}</strong></td>
                    <td>${t.dhan_order_id}</td>
                    <td>${t.entry_time}</td>
                    <td>${t.exit_time}</td>
                    <td><span class="tf-badge ${t.direction === 'BUY' ? 'tf-bullish' : 'tf-bearish'}">${t.direction}</span></td>
                    <td>₹${t.entry_price.toFixed(1)}</td>
                    <td>${t.exit_price ? '₹' + t.exit_price.toFixed(1) : '-'}</td>
                    <td>${t.exit_reason || '-'}</td>
                    <td>₹${t.gross_pnl.toFixed(2)}</td>
                    <td>₹${t.charges.toFixed(2)}</td>
                    <td>₹${t.slippage.toFixed(2)}</td>
                    <td class="${pnlClass}"><strong>₹${t.net_pnl >= 0 ? '+' : ''}${t.net_pnl.toFixed(2)}</strong></td>
                `;
                tbody.appendChild(tr);
            });
        }

    } catch (err) {
        console.error('Error polling /api/live/state:', err);
    }
}

async function startTest() {
    try {
        const res = await fetch('/api/live/start_test', { method: 'POST' });
        const data = await res.json();
        alert(`LIVE Test Status: ${data.message || data.status}`);
        updateLiveDashboard();
    } catch (err) {
        alert(`Error starting test: ${err}`);
    }
}

async function stopTest() {
    try {
        const res = await fetch('/api/live/stop_test', { method: 'POST' });
        const data = await res.json();
        alert(`LIVE Test Status: ${data.message || data.status}`);
        updateLiveDashboard();
    } catch (err) {
        alert(`Error stopping test: ${err}`);
    }
}

async function emergencyExitAll() {
    if (!confirm('Are you sure you want to trigger EMERGENCY EXIT ALL for all live positions?')) return;
    try {
        const res = await fetch('/api/live/emergency_exit', { method: 'POST' });
        const data = await res.json();
        alert(`Emergency Exit Status: ${data.message || data.status}`);
        updateLiveDashboard();
    } catch (err) {
        alert(`Error triggering emergency exit: ${err}`);
    }
}

// Initial fetch and polling every 2 seconds
updateLiveDashboard();
setInterval(updateLiveDashboard, 2000);
