// Popup → SW round trip.
//
// TB-0-1: shows SW reachability + uptime.
// TB-0-5: reads real WSS connected/disconnected state from the SW.
// TB-0-6: polls every 2s, renders run label + scope when available.

import { runtime } from '../lib/platform.js';

const POLL_MS = 2000;

const pill = document.getElementById('status');
const label = document.getElementById('status-label');
const meta = document.getElementById('meta');
const taskRow = document.getElementById('task-row');
const taskLabel = document.getElementById('task-label');

function render(connected, extra, runLabel, scopeLabel) {
  pill.classList.toggle('connected', !!connected);
  pill.classList.toggle('disconnected', !connected);
  label.textContent = connected ? 'Connected' : 'Disconnected';
  meta.textContent = extra || '';
  meta.classList.remove('err');

  if (runLabel || scopeLabel) {
    taskRow.style.display = '';
    taskLabel.textContent = runLabel
      ? `${runLabel}${scopeLabel ? ` · ${scopeLabel}` : ''}`
      : (scopeLabel || '');
  } else {
    taskRow.style.display = 'none';
  }
}

function renderError(message) {
  pill.classList.remove('connected');
  pill.classList.add('disconnected');
  label.textContent = 'Disconnected';
  meta.classList.add('err');
  meta.textContent = message;
  taskRow.style.display = 'none';
}

function poll() {
  try {
    runtime.sendMessage({ type: 'tb.status' }, (resp) => {
      if (runtime.lastError) {
        renderError('SW unreachable: ' + runtime.lastError.message);
        return;
      }
      if (!resp || resp.type !== 'tb.status.reply') {
        renderError('No status reply from SW');
        return;
      }
      const uptime = Math.max(0, resp.now - resp.sw_boot_ts);
      const extra = `WSS ${resp.connected ? '✓' : '×'} • SW up ${Math.round(uptime / 1000)}s`;
      render(!!resp.connected, extra, resp.runId, resp.scopeLabel);
    });
  } catch (e) {
    renderError('Poll error: ' + (e && e.message ? e.message : String(e)));
  }
}

poll();
setInterval(poll, POLL_MS);
