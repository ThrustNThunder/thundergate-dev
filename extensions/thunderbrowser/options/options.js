// ThunderBrowser options page.
//
// Phase 0 surfaces:
//   - TB-0-1: IndexedDB schema introspection (Storage section).
//   - TB-0-7: Device keypair generation + fingerprint display.
//   - TB-0-8: Pairing UI — QR + 6-digit code, IndexedDB pairing state via SW.

import { runtime } from '../lib/platform.js';
import { openDb, SCHEMA_VERSION, listStoreNames, get, put, del } from '../lib/storage.js';
import { renderSvg as renderQrSvg } from '../lib/qrcode.js';

const storageEl = document.getElementById('storage');
const deviceKeyEl = document.getElementById('device-key');

const idleEl = document.getElementById('pairing-idle');
const pendingEl = document.getElementById('pairing-pending');
const pairedEl = document.getElementById('pairing-paired');
const qrHost = document.getElementById('qr-host');
const pairCodeEl = document.getElementById('pair-code');
const extIdEl = document.getElementById('ext-id');
const devFpEl = document.getElementById('dev-fp');
const pairStartedEl = document.getElementById('pair-started');
const pairedEndpointEl = document.getElementById('paired-endpoint');
const pairedFpEl = document.getElementById('paired-fp');
const pairedAtEl = document.getElementById('paired-at');

const btnPair = document.getElementById('btn-pair');
const btnCancel = document.getElementById('btn-cancel');
const btnSimulate = document.getElementById('btn-simulate');
const btnUnpair = document.getElementById('btn-unpair');

let pollTimer = null;

// ── Helpers ────────────────────────────────────────────────────────────────

function fingerprintFromJwk(jwk) {
  if (!jwk || typeof jwk.x !== 'string') return '(no-fingerprint)';
  const b64 = jwk.x.replace(/-/g, '+').replace(/_/g, '/');
  return b64.slice(0, 16);
}

function showPanel(which) {
  idleEl.style.display = which === 'idle' ? '' : 'none';
  pendingEl.style.display = which === 'pending' ? '' : 'none';
  pairedEl.style.display = which === 'paired' ? '' : 'none';
}

function makePairingCode() {
  // 6 decimal digits, zero-padded. Crypto-random so the codespace is fair.
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1_000_000).padStart(6, '0');
}

function randomId(prefix) {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  const hex = Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}`;
}

async function loadOrGenerateDeviceKeypair() {
  const existing = await get('keypair', 'device');
  if (existing && existing.publicKeyJwk) {
    return { record: existing, generated: false };
  }
  const kp = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    false,
    ['sign', 'verify']
  );
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const record = {
    id: 'device',
    publicKeyJwk,
    privateKey: kp.privateKey,
    createdAt: Date.now(),
  };
  await put('keypair', record);
  return { record, generated: true };
}

function renderDeviceKey({ record, generated, error }) {
  if (error) {
    deviceKeyEl.textContent = 'Device key error: ' + error;
    return;
  }
  const fp = fingerprintFromJwk(record.publicKeyJwk);
  const created = new Date(record.createdAt).toISOString();
  const status = generated ? 'generated' : 'loaded';
  deviceKeyEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.fontSize = '13px';
  wrap.style.color = '#d1d2d3';
  wrap.innerHTML =
    '<div style="margin-bottom:8px;">' +
    '<span style="color:#7b7d82;">Public-key fingerprint:</span> ' +
    '<code>' + fp + '</code>' +
    '</div>' +
    '<div style="margin-bottom:6px;">' +
    '<span style="color:#7b7d82;">Algorithm:</span> Ed25519 (non-extractable private key)' +
    '</div>' +
    '<div style="margin-bottom:6px;">' +
    '<span style="color:#7b7d82;">Created:</span> ' + created +
    '</div>' +
    '<div style="color:#7b7d82;">Status: ' + status + '</div>';
  deviceKeyEl.appendChild(wrap);
}

// ── Pairing (TB-0-8) ───────────────────────────────────────────────────────

function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    try {
      runtime.sendMessage(msg, (resp) => {
        if (runtime.lastError) return reject(new Error(runtime.lastError.message));
        resolve(resp);
      });
    } catch (e) { reject(e); }
  });
}

function renderPending(rec) {
  pairCodeEl.textContent = rec.pairingCode || '------';
  extIdEl.textContent = rec.extensionPairId || '(unknown)';
  devFpEl.textContent = rec.pubKeyFingerprint || '(none)';
  pairStartedEl.textContent = rec.started_at ? new Date(rec.started_at).toLocaleTimeString() : '—';
  // QR payload — encode the same shape the real ThunderGate pair-init endpoint
  // will accept (see THUNDERBROWSER_PHASE01_TICKETS.md §TB-0-8). In Phase 0
  // it just needs to be machine-readable and stable.
  const payload = JSON.stringify({
    v: 1,
    extensionPairId: rec.extensionPairId,
    pubKeyFingerprint: rec.pubKeyFingerprint,
    pairingCode: rec.pairingCode,
    gateway_hint: 'ws://localhost:9876/browser',
  });
  try {
    qrHost.innerHTML = renderQrSvg(payload, 5, 2);
  } catch (e) {
    qrHost.textContent = 'QR error: ' + (e && e.message ? e.message : String(e));
  }
  showPanel('pending');
}

function renderPaired(rec) {
  pairedEndpointEl.textContent = rec.endpoint || '(none)';
  pairedFpEl.textContent = rec.pubKeyFingerprint || '(none)';
  pairedAtEl.textContent = rec.paired_at ? new Date(rec.paired_at).toLocaleString() : '—';
  showPanel('paired');
}

async function refreshPairingFromSW() {
  const resp = await sendMessage({ type: 'tb.pairing.status' });
  const rec = resp && resp.record;
  if (!rec || !rec.status || rec.status === 'idle') {
    showPanel('idle');
    return null;
  }
  if (rec.status === 'pending') renderPending(rec);
  else if (rec.status === 'paired') renderPaired(rec);
  return rec;
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const rec = await refreshPairingFromSW();
      if (rec && rec.status === 'paired') stopPolling();
    } catch (e) {
      console.log('pairing poll error', e && e.message ? e.message : String(e));
    }
  }, 2000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function beginPairing(devKey) {
  const code = makePairingCode();
  const extensionPairId = randomId('extpair');
  const fp = fingerprintFromJwk(devKey.publicKeyJwk);
  const resp = await sendMessage({
    type: 'tb.pairing.set',
    pairingCode: code,
    extensionPairId,
    pubKeyFingerprint: fp,
  });
  if (!resp || !resp.ok) throw new Error('SW pairing.set failed: ' + (resp && resp.error));
  renderPending(resp.record);
  startPolling();
}

async function simulateConfirm() {
  const resp = await sendMessage({ type: 'tb.pairing.simulate_confirm' });
  if (!resp || !resp.ok) throw new Error('SW simulate_confirm failed: ' + (resp && resp.error));
  renderPaired(resp.record);
  stopPolling();
}

async function unpair() {
  // Dev-only: wipe the pairing record so we can re-test from a clean slate.
  // Goes through the storage helper directly because the SW path doesn't
  // expose unpair until Phase 2 (revoke flow).
  await del('pairing', 'current');
  stopPolling();
  showPanel('idle');
}

async function cancelPairing() {
  await del('pairing', 'current');
  stopPolling();
  showPanel('idle');
}

// ── Boot ───────────────────────────────────────────────────────────────────

let cachedDeviceKey = null;

btnPair.addEventListener('click', () => {
  if (!cachedDeviceKey) {
    alert('Device key not ready yet. Reload the page.');
    return;
  }
  beginPairing(cachedDeviceKey).catch((e) => {
    alert('Pair error: ' + (e && e.message ? e.message : String(e)));
  });
});
btnCancel.addEventListener('click', () => { cancelPairing().catch(() => {}); });
btnSimulate.addEventListener('click', () => {
  simulateConfirm().catch((e) => {
    alert('Simulate error: ' + (e && e.message ? e.message : String(e)));
  });
});
btnUnpair.addEventListener('click', () => { unpair().catch(() => {}); });

(async () => {
  try {
    const db = await openDb();
    const stores = listStoreNames(db);
    storageEl.textContent =
      `IndexedDB "${db.name}" v${db.version} ready. Stores: ${stores.join(', ')}.`;
  } catch (e) {
    storageEl.textContent = 'IndexedDB error: ' + (e && e.message ? e.message : String(e));
    return;
  }

  try {
    const result = await loadOrGenerateDeviceKeypair();
    cachedDeviceKey = result.record;
    renderDeviceKey(result);
    void SCHEMA_VERSION;
  } catch (e) {
    renderDeviceKey({ error: e && e.message ? e.message : String(e) });
  }

  try {
    await refreshPairingFromSW();
  } catch (e) {
    console.log('initial pairing fetch error', e && e.message ? e.message : String(e));
    showPanel('idle');
  }
})();
