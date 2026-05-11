// ThunderBrowser IndexedDB schema + typed storage helpers (TB-0-2).
//
// Single database: "thunderbrowser". Object stores per the Phase 0-1 ticket
// spec. This module is the only place that opens the database; all other code
// goes through openDb() + the get/put/delete/scan helpers below.
//
// Conventions:
//   - All store keys are explicit (keyPath where the shape carries an id;
//     in-line for stores that have a stable singleton id like "device" or
//     "current"). No autoIncrement — every record carries an addressable id.
//   - Indexes are created in onupgradeneeded only. Adding an index later
//     requires a version bump and a migration arm.
//   - Migrations log a version delta to the SW console so future schema
//     evolution is debuggable (per TB-0-2 acceptance criteria).

export const DB_NAME = 'thunderbrowser';
export const SCHEMA_VERSION = 1;

// Single source of truth for the schema. Each entry describes a store:
//   keyPath:  property used as the primary key (null means out-of-line keys).
//   indexes:  [{ name, keyPath, options }] — created during upgrade only.
//   cap:      soft cap enforced by put(); helpers may trim oldest by an index.
//
// Stores listed in order they appear in the design.
const SCHEMA = {
  keypair: {
    keyPath: 'id',
    indexes: [],
    // Records:
    //   { id: "device", publicKeyJwk, createdAt, privateKeyRef? }
    // The private key lives as a non-extractable CryptoKey persisted under the
    // same key path; structured-clone keeps the handle alive across SW restarts
    // (see TB-0-7).
  },
  pairing: {
    keyPath: 'id',
    indexes: [],
    // Records:
    //   { id: "current", extensionPairId, paired_at,
    //     tg_kid_pubkeys: [{kid, alg, pubkeyJwk, signed_by?}],
    //     bundle_hash }
  },
  scope: {
    keyPath: 'id',
    indexes: [{ name: 'by_issued_at', keyPath: 'issued_at', options: {} }],
    cap: 10,
    // Records:
    //   { id, jwt, payload (decoded), actions_used, issued_at, expires_at }
  },
  runs: {
    keyPath: 'run_id',
    indexes: [
      { name: 'by_state', keyPath: 'state', options: {} },
      { name: 'by_started_at', keyPath: 'started_at', options: {} },
    ],
    // Records:
    //   { run_id, scope_id, label, started_at, ended_at?, state,
    //     expected_actions?, actions_dispatched, last_action_id_acked }
  },
  audit: {
    keyPath: 'action_id',
    indexes: [
      { name: 'by_run_id', keyPath: 'run_id', options: {} },
      { name: 'by_server_acked', keyPath: 'server_acked', options: {} },
      { name: 'by_ts_completed', keyPath: 'ts_completed', options: {} },
    ],
    // Records: see design §4.4 — Action Record plus prev_hash, signature,
    // server_acked: bool.
  },
  state_pack: {
    keyPath: 'pack_id',
    indexes: [{ name: 'by_version', keyPath: 'version', options: {} }],
    // Records: versioned state-detector ruleset blobs (TB-1-15).
  },
  settings: {
    keyPath: 'key',
    indexes: [],
    // Records: { key: "allowlist" | "redactor_denylist" | "kill_switch"
    //          | "last_reconnect_attempts" | ..., value }
  },
};

// ── Connection ─────────────────────────────────────────────────────────────

let _dbPromise = null;

export function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, SCHEMA_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const fromVersion = ev.oldVersion;
      const toVersion = ev.newVersion;
      // Log the delta so the migration is auditable. TB-0-2 acceptance: this
      // must appear in the SW console when the version changes.
      console.log(
        `[tb.storage] upgrading IndexedDB "${DB_NAME}" v${fromVersion} → v${toVersion}`
      );
      for (const [name, def] of Object.entries(SCHEMA)) {
        let store;
        if (!db.objectStoreNames.contains(name)) {
          store = db.createObjectStore(name, { keyPath: def.keyPath });
        } else {
          // For v1 there's no in-place mutation; future versions reach in here.
          store = req.transaction.objectStore(name);
        }
        for (const idx of def.indexes || []) {
          if (!store.indexNames.contains(idx.name)) {
            store.createIndex(idx.name, idx.keyPath, idx.options || {});
          }
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another connection'));
  });
  return _dbPromise;
}

export function listStoreNames(db) {
  return Array.from(db.objectStoreNames).sort();
}

// ── Helpers ────────────────────────────────────────────────────────────────

function assertStore(store) {
  if (!Object.prototype.hasOwnProperty.call(SCHEMA, store)) {
    throw new Error(`Unknown store: ${store}`);
  }
}

function tx(db, store, mode) {
  assertStore(store);
  return db.transaction(store, mode).objectStore(store);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// get(store, key) → record | undefined
export async function get(store, key) {
  const db = await openDb();
  return reqToPromise(tx(db, store, 'readonly').get(key));
}

// put(store, record) → key
// Honors the store's `cap` if set: oldest record (by `by_issued_at` or by
// `by_ts_completed` if defined) is trimmed once the cap is exceeded, unless
// the record carries `server_acked: false` (audit invariant — never drop
// unflushed records; TB-1-12).
export async function put(store, record) {
  assertStore(store);
  const def = SCHEMA[store];
  if (!record || record[def.keyPath] === undefined || record[def.keyPath] === null) {
    throw new Error(`put(${store}): record missing keyPath "${def.keyPath}"`);
  }
  const db = await openDb();
  const t = db.transaction(store, 'readwrite');
  const objStore = t.objectStore(store);
  const key = await reqToPromise(objStore.put(record));
  if (def.cap) {
    await trimToCap(objStore, def);
  }
  await new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('tx aborted'));
  });
  return key;
}

async function trimToCap(objStore, def) {
  const count = await reqToPromise(objStore.count());
  if (count <= def.cap) return;
  const surplus = count - def.cap;
  // Prefer an explicit "oldest" index if present; otherwise fall back to the
  // primary cursor (insertion order is not guaranteed, but for stores that
  // declare a cap we always declare an order index).
  const orderIdx = (def.indexes || []).find(
    (i) => i.name === 'by_issued_at' || i.name === 'by_ts_completed'
  );
  const source = orderIdx ? objStore.index(orderIdx.name) : objStore;
  const cursorReq = source.openCursor();
  let trimmed = 0;
  await new Promise((resolve, reject) => {
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || trimmed >= surplus) return resolve();
      const v = cursor.value;
      // Audit invariant guard — never drop unflushed records.
      if (v && v.server_acked === false) {
        cursor.continue();
        return;
      }
      cursor.delete();
      trimmed += 1;
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

// del(store, key) → void
export async function del(store, key) {
  const db = await openDb();
  await reqToPromise(tx(db, store, 'readwrite').delete(key));
}

// scan(store, { index?, range?, direction?, limit? }) → [record, ...]
// Lightweight cursor walk for the common "give me everything matching X"
// pattern. For large stores, prefer paginating with `limit` + a `range`
// starting after the previous run's last key.
export async function scan(store, opts = {}) {
  assertStore(store);
  const db = await openDb();
  const objStore = tx(db, store, 'readonly');
  const source = opts.index ? objStore.index(opts.index) : objStore;
  const range = opts.range || null;
  const direction = opts.direction || 'next';
  const limit = typeof opts.limit === 'number' ? opts.limit : Infinity;
  const out = [];
  const cursorReq = source.openCursor(range, direction);
  return new Promise((resolve, reject) => {
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || out.length >= limit) return resolve(out);
      out.push(cursor.value);
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

// count(store, { index?, range? }) → number
export async function count(store, opts = {}) {
  const db = await openDb();
  const objStore = tx(db, store, 'readonly');
  const source = opts.index ? objStore.index(opts.index) : objStore;
  return reqToPromise(source.count(opts.range || null));
}

// clearStore(store) — destructive helper, intended for tests + the kill switch.
// Not exported for casual use; surface via the options page only.
export async function clearStore(store) {
  const db = await openDb();
  await reqToPromise(tx(db, store, 'readwrite').clear());
}
