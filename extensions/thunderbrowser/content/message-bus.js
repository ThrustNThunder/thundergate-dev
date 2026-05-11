// ThunderBrowser content-script ↔ service-worker message bus (TB-1-1).
//
// Common envelope format used by every cross-context message originated
// from a content script. Bridge envelopes (SW ↔ ThunderGate) use the same
// shape on the wire — the bus simply forwards.
//
// Envelope:
//   {
//     v:    1,
//     id:   "<uuid>",
//     ts:   <epoch_ms>,
//     type: "cmd_request" | "cmd_result" | "event" | "error",
//     ref:  "<id of message being responded to>" | undefined,
//     body: { ... }                    // type-specific payload
//   }
//
// Why no ES module imports here: MV3 content scripts on stable Chrome 120
// can't statically import. Each content-script file is loaded as a flat
// script by the manifest in declaration order, and they share the
// content-script isolated world (one realm per frame). We expose the bus
// on `globalThis.__tb` so the action modules (dom-snapshot, dom-read,
// etc.) can find it.

(function attachBus() {
  if (globalThis.__tb && globalThis.__tb.bus) return;

  const WIRE_VERSION = 1;
  const platform =
    (typeof globalThis !== 'undefined' && globalThis.browser) ||
    (typeof globalThis !== 'undefined' && globalThis.chrome) ||
    // eslint-disable-next-line no-undef
    (typeof browser !== 'undefined' ? browser : chrome);
  const runtime = platform.runtime;

  // ── Per-tab reference registry ───────────────────────────────────────────
  //
  // Action modules need to hand stable references to specific DOM nodes
  // back to the SW so a later command (click/fill/etc.) can target the
  // same node. The reference is an opaque string the SW echoes back; the
  // content script resolves it through this registry.
  //
  // The registry is bounded — entries past `MAX_REFS` LRU-evict so a
  // long-running page can't drive the content script OOM. Refs are also
  // dropped on `pagehide` (bfcache eviction) because the resolved
  // element may not be valid after a same-origin navigation.

  const REF_PREFIX = 'tbref:';
  const MAX_REFS = 1024;

  /** @type {Map<string, { el: Element, mintedAt: number }>} */
  const refMap = new Map();
  /** @type {WeakMap<Element, string>} */
  const elToRef = new WeakMap();
  let refSeq = 0;

  function mintRef(el) {
    if (!(el instanceof Element)) return null;
    const existing = elToRef.get(el);
    if (existing && refMap.has(existing)) return existing;
    refSeq += 1;
    const ref = REF_PREFIX + refSeq.toString(36) + '-' + cryptoSuffix();
    refMap.set(ref, { el, mintedAt: Date.now() });
    elToRef.set(el, ref);
    if (refMap.size > MAX_REFS) {
      // Evict oldest. Map preserves insertion order so the first key is
      // the oldest live ref.
      const first = refMap.keys().next().value;
      if (first) refMap.delete(first);
    }
    return ref;
  }

  function resolveRef(ref) {
    if (typeof ref !== 'string' || !ref.startsWith(REF_PREFIX)) return null;
    const rec = refMap.get(ref);
    if (!rec) return null;
    // Element may have been detached from the document tree by a re-render.
    // Surface that as null so callers can return a stable error code.
    if (!rec.el.isConnected) {
      refMap.delete(ref);
      elToRef.delete(rec.el);
      return null;
    }
    return rec.el;
  }

  function clearRefs() {
    refMap.clear();
  }

  function cryptoSuffix() {
    if (globalThis.crypto?.getRandomValues) {
      const buf = new Uint32Array(2);
      globalThis.crypto.getRandomValues(buf);
      return buf[0].toString(36) + buf[1].toString(36);
    }
    return Math.random().toString(36).slice(2, 10);
  }

  // ── Action registry ──────────────────────────────────────────────────────
  //
  // Other content-script files register named action handlers via
  // `__tb.bus.register(name, fn)`. The bus dispatches incoming
  // `cmd_request` envelopes to the matching handler. Handlers return a
  // body object (or a promise of one); the bus wraps it in a `cmd_result`
  // envelope and replies.
  //
  // Unknown actions return a structured error so the SW + bridge log
  // shows the action name that was missing — easier to debug protocol
  // drift between the bridge and the extension.

  /** @type {Map<string, (args: any, ctx: any) => any>} */
  const handlers = new Map();

  function register(name, fn) {
    if (typeof name !== 'string' || typeof fn !== 'function') return;
    handlers.set(name, fn);
  }

  function newId() {
    return 'cs-' + Date.now().toString(36) + '-' + cryptoSuffix();
  }

  function makeEnvelope(type, body, ref) {
    return {
      v: WIRE_VERSION,
      id: newId(),
      ts: Date.now(),
      type,
      ref: ref || undefined,
      body: body || {}
    };
  }

  function makeError(ref, code, detail) {
    return makeEnvelope('error', { code, detail: detail || null }, ref);
  }

  async function dispatch(env) {
    if (!env || typeof env !== 'object' || env.type !== 'cmd_request') {
      return makeError(env && env.id, 'invalid_envelope');
    }
    const body = env.body || {};
    const action = typeof body.action === 'string' ? body.action : null;
    if (!action) {
      return makeError(env.id, 'missing_action');
    }
    const handler = handlers.get(action);
    if (!handler) {
      return makeError(env.id, 'unknown_action', action);
    }
    try {
      const result = await handler(body.args || {}, {
        env,
        mintRef,
        resolveRef
      });
      return makeEnvelope('cmd_result', { action, ok: true, ...(result || {}) }, env.id);
    } catch (err) {
      return makeError(env.id, 'handler_threw', err && err.message ? err.message : String(err));
    }
  }

  // SW → content script. The SW addresses the right tab via tabs.sendMessage;
  // we listen on runtime.onMessage and dispatch the envelope.
  if (runtime && runtime.onMessage && typeof runtime.onMessage.addListener === 'function') {
    runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg !== 'object' || msg.type !== 'cmd_request') return false;
      Promise.resolve(dispatch(msg)).then((reply) => {
        try { sendResponse(reply); } catch (_) { /* port closed */ }
      });
      return true; // async response
    });
  }

  // Content script → SW. Used by events the page surface wants to push
  // (e.g., "I just detected a state transition") rather than respond to.
  function emit(type, body) {
    if (!runtime || !runtime.sendMessage) return;
    try {
      runtime.sendMessage(makeEnvelope(type, body));
    } catch (_) {
      /* SW may be sleeping; the alarm-driven heartbeat will wake it shortly */
    }
  }

  // Drop refs when the page is hidden into bfcache or unloaded — the
  // cached realm may resurrect but our resolved elements won't be the
  // same nodes after a same-origin navigation.
  window.addEventListener('pagehide', clearRefs);

  globalThis.__tb = Object.assign(globalThis.__tb || {}, {
    bus: {
      register,
      dispatch,
      emit,
      makeEnvelope,
      makeError,
      mintRef,
      resolveRef,
      clearRefs,
      REF_PREFIX,
      WIRE_VERSION
    }
  });
})();
