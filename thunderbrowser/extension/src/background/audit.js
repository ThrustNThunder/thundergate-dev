// Local audit log. Phase 1 wires the chain + upstream flush; Phase 2 will add
// device signing per design §4.4. For now the device "signature" field is a
// placeholder that lets the chain shape settle.

import { canonicalJson, sha256Hex } from "../shared/protocol.js";

const DB_NAME = "thunderbrowser";
const STORE = "audit";

export class Audit {
  constructor() {
    this.db = null;
    this.chainHead = null;
    this.pending = 0;
  }

  async init() {
    if (this.db) return;
    this.db = await openDb();
    // Recompute head from latest record.
    const last = await this._lastRecord();
    this.chainHead = last?.hash ?? null;
    this.pending = await this._countWhere((r) => !r.server_acked);
  }

  pendingCount() { return this.pending; }

  async record({ run_id = null, scope_id = null, action, params, url_before, url_after, dom_before_hash, dom_after_hash, result }) {
    if (!this.db) await this.init();
    const prev_hash = this.chainHead;
    const body = {
      action_id: crypto.randomUUID(),
      run_id, scope_id,
      action,
      params_redacted: params,
      dom_before_hash, dom_after_hash,
      url_before, url_after,
      result,
      ts: Date.now(),
      prev_hash,
    };
    body.hash = await sha256Hex(canonicalJson(body));
    // Placeholder signature — replaced by device-signed value in Phase 2.
    body.signature = `phase1-unsigned:${body.hash.slice(0, 16)}`;
    body.server_acked = false;
    await this._put(body);
    this.chainHead = body.hash;
    this.pending += 1;
    return body;
  }

  async flush(wss) {
    if (!this.db || this.pending === 0) return;
    if (!wss.isOpen()) return;
    const batch = await this._scanWhere((r) => !r.server_acked, 50);
    if (!batch.length) return;
    const chainHead = batch[batch.length - 1].hash;
    await wss.sendEvent("audit", { entries: batch, chain_head: chainHead });
    // Optimistic: mark acked. A real ack handler would wait for last_accepted.
    for (const r of batch) {
      r.server_acked = true;
      await this._put(r);
    }
    this.pending = await this._countWhere((r) => !r.server_acked);
  }

  async _put(record) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async _lastRecord() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, "readonly");
      const idx = tx.objectStore(STORE).index("by_ts");
      const req = idx.openCursor(null, "prev");
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => reject(req.error);
    });
  }

  async _scanWhere(pred, limit) {
    const out = [];
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur || out.length >= limit) return resolve(out);
        if (pred(cur.value)) out.push(cur.value);
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async _countWhere(pred) {
    let n = 0;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve(n);
        if (pred(cur.value)) n += 1;
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "action_id" });
        s.createIndex("by_ts", "ts");
        s.createIndex("by_acked", "server_acked");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
