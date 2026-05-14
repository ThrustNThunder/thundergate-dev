// ThunderBrowser content script — isolated world, declarative + programmatic.
// Owns: DOM read/write, state detection, modal/error detectors, input redaction.
// Talks to the SW over chrome.runtime.sendMessage; receives commands via
// chrome.runtime.onMessage. Envelope shape mirrors the WSS layer.

(() => {
  if (window.__thunderbrowser_cs_loaded) return;
  window.__thunderbrowser_cs_loaded = true;

  const PROTOCOL_VERSION = 1;

  // --- Element reference registry --------------------------------------------
  // ref ("el#N") -> WeakRef<Element>. Validated on lookup against a quick
  // lineage hash so a different element occupying the same DOM slot doesn't
  // silently inherit a ref.
  const refMap = new Map();
  let refCounter = 0;

  function captureRef(el) {
    const ref = `el#${++refCounter}`;
    refMap.set(ref, new WeakRef(el));
    return ref;
  }

  function resolveRef(ref) {
    const wr = refMap.get(ref);
    if (!wr) return null;
    const el = wr.deref();
    if (!el || !document.contains(el)) {
      refMap.delete(ref);
      return null;
    }
    return el;
  }

  // --- Envelope helpers -------------------------------------------------------
  function reply(refId, body, type = "result") {
    return { v: PROTOCOL_VERSION, id: uuid(), ts: Date.now(), type, ref: refId, scope: null, body };
  }
  function errorReply(refId, code, message, retriable = false) {
    return reply(refId, { code, message, retriable }, "error");
  }
  function uuid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return Math.random().toString(36).slice(2);
  }

  // --- Redactor ---------------------------------------------------------------
  // Runs BEFORE any data crosses the CS->SW boundary.
  const SECRET_FIELD_PATTERNS = [
    { test: (el) => el.type === "password", tag: "password" },
    { test: (el) => /^cc-/i.test(el.getAttribute("autocomplete") || ""), tag: "cc" },
    { test: (el) => /(card|cvv|cvc)/i.test(el.name || ""), tag: "cc" },
    { test: (el) => /ssn/i.test(el.getAttribute("autocomplete") || ""), tag: "ssn" },
  ];
  function redactValue(el, value) {
    for (const p of SECRET_FIELD_PATTERNS) {
      try { if (p.test(el)) return `[REDACTED:${p.tag}]`; } catch {}
    }
    return value;
  }

  // --- DOM snapshot (structured mode) ----------------------------------------
  // §3.2 — keep interactive + landmark + text-bearing nodes, prune the rest.
  const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "FORM"]);
  const LANDMARK_TAGS = new Set(["MAIN", "NAV", "HEADER", "FOOTER", "ASIDE"]);
  const WHITELIST_ATTRS = new Set([
    "id", "name", "type", "href", "placeholder", "disabled", "checked",
    "readonly", "required", "role", "value",
    "data-testid", "data-aa-user", "data-pbs-pilot", "data-pbs-grid",
  ]);

  function isInteresting(el) {
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    if (LANDMARK_TAGS.has(el.tagName)) return true;
    if (el.hasAttribute("role")) return true;
    if (el.hasAttribute("tabindex")) return true;
    if (el.hasAttribute("onclick")) return true;
    const text = (el.textContent || "").trim();
    if (text && text.length < 400 && el.children.length === 0) return true;
    return false;
  }

  function snapshotNode(el, budget) {
    if (budget.bytes > 80_000) {
      budget.truncated = true;
      return null;
    }
    const rect = el.getBoundingClientRect();
    const attrs = {};
    for (const name of WHITELIST_ATTRS) {
      if (el.hasAttribute(name)) attrs[name] = el.getAttribute(name);
    }
    // Form values: redact + length.
    if (INTERACTIVE_TAGS.has(el.tagName) && "value" in el) {
      const v = redactValue(el, el.value ?? "");
      attrs.value = v;
      if (v.startsWith("[REDACTED")) attrs.value_len = (el.value ?? "").length;
    }
    const role = el.getAttribute("role") || implicitRole(el);
    const accessibleName = computeAccessibleName(el);
    let textNode = null;
    if (el.children.length === 0 && el.textContent) {
      textNode = el.textContent.trim().slice(0, 2048);
    }
    const ref = captureRef(el);
    const node = {
      ref,
      tag: el.tagName.toLowerCase(),
      role,
      accessible_name: accessibleName,
      text: textNode,
      attrs,
      bbox: { x: rect.x | 0, y: rect.y | 0, w: rect.width | 0, h: rect.height | 0 },
      children: [],
    };
    budget.bytes += JSON.stringify(node).length;
    for (const child of el.children) {
      if (isInteresting(child) || child.children.length > 0) {
        const sub = snapshotNode(child, budget);
        if (sub) node.children.push(sub);
      }
    }
    return node;
  }

  function implicitRole(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      const t = (el.type || "text").toLowerCase();
      if (["submit", "button"].includes(t)) return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      return "textbox";
    }
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    return null;
  }

  function computeAccessibleName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const ids = labelledby.split(/\s+/);
      const parts = ids.map((id) => document.getElementById(id)?.textContent?.trim()).filter(Boolean);
      if (parts.length) return parts.join(" ");
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      const id = el.id;
      if (id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lbl) return lbl.textContent.trim();
      }
      const parentLabel = el.closest("label");
      if (parentLabel) return parentLabel.textContent.trim();
      if (el.placeholder) return el.placeholder;
    }
    return (el.textContent || "").trim().slice(0, 200);
  }

  // --- Query ------------------------------------------------------------------
  function queryDom({ selector, text, role, name, limit = 20 }) {
    if (!selector && !text && !role && !name) {
      throw mkErr("BAD_PARAMS", "selector, text, or role+name required", false);
    }
    let candidates;
    if (selector) {
      candidates = Array.from(document.querySelectorAll(selector));
    } else {
      candidates = Array.from(document.querySelectorAll(
        "a,button,input,select,textarea,[role],[tabindex]"
      ));
    }
    const lowText = text?.toLowerCase();
    const matches = [];
    for (const el of candidates) {
      if (role) {
        const r = el.getAttribute("role") || implicitRole(el);
        if (r !== role) continue;
      }
      if (name) {
        const aname = computeAccessibleName(el);
        if (aname.toLowerCase() !== name.toLowerCase() &&
            !aname.toLowerCase().includes(name.toLowerCase())) continue;
      }
      if (lowText) {
        const t = (el.textContent || "").toLowerCase();
        if (!t.includes(lowText)) continue;
      }
      const rect = el.getBoundingClientRect();
      matches.push({
        ref: captureRef(el),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || implicitRole(el),
        text: (el.textContent || "").trim().slice(0, 200),
        bbox: { x: rect.x | 0, y: rect.y | 0, w: rect.width | 0, h: rect.height | 0 },
        attrs: {
          id: el.id || undefined,
          name: el.name || undefined,
          type: el.type || undefined,
          href: el.href || undefined,
        },
      });
      if (matches.length >= limit) break;
    }
    return { matches };
  }

  // --- Action handlers --------------------------------------------------------
  async function snapshotDom({ mode = "structured" }) {
    const budget = { bytes: 0, truncated: false };
    const tree = snapshotNode(document.documentElement, budget);
    return {
      tree,
      url: location.href,
      title: document.title,
      scroll_pos: { x: window.scrollX, y: window.scrollY },
      truncated: budget.truncated,
    };
  }

  async function clickAction({ ref, expect_navigation, precision, timeout_ms = 10_000 }) {
    const el = resolveRef(ref);
    if (!el) throw mkErr("ELEMENT_NOT_FOUND", `ref ${ref} stale`, false);
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) throw mkErr("OUT_OF_VIEW", "zero bbox", true);
    const style = getComputedStyle(el);
    if (style.pointerEvents === "none" || el.disabled) {
      throw mkErr("NOT_CLICKABLE", "disabled or pointer-events:none", false);
    }
    el.scrollIntoView({ block: "center", behavior: "instant" });
    if (precision) {
      await sleep(250);
      // Stability re-check: same element still resolvable?
      if (!document.contains(el)) throw mkErr("ELEMENT_UNSTABLE", "el detached after delay", true);
    }
    const before = { url: location.href };
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    if (expect_navigation) {
      const start = Date.now();
      while (Date.now() - start < timeout_ms) {
        if (location.href !== before.url) return { navigated: true, final_url: location.href };
        await sleep(100);
      }
      return { navigated: false, final_url: location.href };
    }
    return { navigated: false, final_url: location.href };
  }

  async function fillAction({ ref, value }) {
    const el = resolveRef(ref);
    if (!el) throw mkErr("ELEMENT_NOT_FOUND", `ref ${ref} stale`, false);
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
      throw mkErr("NOT_FILLABLE", `${el.tagName} not fillable`, false);
    }
    if (el.readOnly) throw mkErr("READONLY", "input is readonly", false);
    if (el.disabled) throw mkErr("NOT_FILLABLE", "input disabled", false);
    el.focus();
    // React/Vue controlled-input shim: bypass the synthetic value setter.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, value_hash: await sha256Hex(value) };
  }

  async function selectAction({ ref, value, label, index }) {
    const el = resolveRef(ref);
    if (!el || !(el instanceof HTMLSelectElement)) {
      throw mkErr("NOT_FILLABLE", "not a select", false);
    }
    if (index !== undefined) {
      el.selectedIndex = index;
    } else if (value !== undefined) {
      el.value = value;
    } else if (label !== undefined) {
      const opt = Array.from(el.options).find((o) => o.text === label);
      if (!opt) throw mkErr("OPTION_NOT_FOUND", `no option with label ${label}`, false);
      el.value = opt.value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { selected_value: el.value };
  }

  async function checkAction({ ref, checked }) {
    const el = resolveRef(ref);
    if (!el || !(el instanceof HTMLInputElement) || !["checkbox", "radio"].includes(el.type)) {
      throw mkErr("NOT_FILLABLE", "not a checkbox/radio", false);
    }
    el.checked = !!checked;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, checked: el.checked };
  }

  async function scrollToAction({ ref, x, y }) {
    if (ref) {
      const el = resolveRef(ref);
      if (!el) throw mkErr("ELEMENT_NOT_FOUND", `ref ${ref} stale`, false);
      el.scrollIntoView({ block: "center", behavior: "instant" });
    } else {
      window.scrollTo(x ?? 0, y ?? 0);
    }
    return { scroll_pos: { x: window.scrollX, y: window.scrollY } };
  }

  async function detectModal() {
    const candidates = Array.from(document.querySelectorAll("*")).filter((el) => {
      const style = getComputedStyle(el);
      if (!["fixed", "absolute"].includes(style.position)) return false;
      const z = parseInt(style.zIndex, 10);
      if (!isFinite(z) || z < 100) return false;
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      const viewArea = window.innerWidth * window.innerHeight;
      if (area < 0.05 * viewArea && !el.matches('[role="dialog"], [role="alertdialog"]')) return false;
      return true;
    });
    const modals = candidates.map((el) => classifyModal(el)).filter(Boolean);
    return { modals };
  }

  function classifyModal(el) {
    const text = (el.textContent || "").trim().slice(0, 500);
    const low = text.toLowerCase();
    let classification = "unknown";
    let confidence = 0.5;
    if (/cookie|consent|gdpr|privacy/.test(low)) { classification = "cookie_banner"; confidence = 0.95; }
    else if (/sign in|log in|session.*expired|please log/i.test(low)) { classification = "auth_required"; confidence = 0.9; }
    else if (/no thanks|later|maybe later/.test(low) && /sign up|subscribe|join/.test(low)) { classification = "marketing"; confidence = 0.8; }
    else if (/error|sorry|went wrong/.test(low)) { classification = "error"; confidence = 0.85; }
    else if (/are you sure|confirm|please confirm/.test(low)) { classification = "confirmation"; confidence = 0.85; }
    return {
      ref: captureRef(el),
      classification,
      confidence,
      dismissible: !!el.querySelector("button, [role=button]"),
      text_summary: text.slice(0, 200),
    };
  }

  async function detectError() {
    const text = document.body?.textContent?.toLowerCase() || "";
    if (/session.*expired|please log in again|your session/.test(text)) {
      return { kind: "login_expired", evidence: { matched_text: "session/login pattern", url: location.href } };
    }
    if (/access denied|not authorized|forbidden/.test(text) && !location.pathname.includes("/login")) {
      return { kind: "access_denied", evidence: { url: location.href } };
    }
    if (/page not found|404/.test(text) && document.title.match(/404|not found/i)) {
      return { kind: "http_4xx", evidence: { url: location.href } };
    }
    if (/server error|500|something went wrong/.test(text)) {
      return { kind: "http_5xx", evidence: { url: location.href } };
    }
    return { kind: "none", evidence: { url: location.href } };
  }

  async function detectLoading() {
    const signals = [];
    if (document.readyState !== "complete") signals.push("readystate");
    if (document.querySelector('[role="progressbar"], .spinner, .loading, .loader')) {
      signals.push("spinner");
    }
    return { loading: signals.length > 0, signals };
  }

  async function isLoggedIn({ domain }) {
    // CS-side check only; SW-side cookie presence layer is in a future ticket.
    const anchors = [
      '[data-aa-user]',
      '[data-pbs-pilot]',
      'a[href*="aadvantage"]',
    ];
    let evidence = "none";
    for (const sel of anchors) {
      if (document.querySelector(sel)) { evidence = "dom"; break; }
    }
    return { logged_in: evidence !== "none", evidence };
  }

  // --- State detector (TB-1-15) ----------------------------------------------
  // Ships with an inline AA pack; in Phase 2 the SW will hot-push state-packs.
  const STATE_PACKS = {
    "aa-v1": null,
  };

  async function loadStatePacks() {
    if (STATE_PACKS["aa-v1"]) return;
    try {
      const url = chrome.runtime.getURL("src/state-packs/aa-v1.json");
      const resp = await fetch(url);
      STATE_PACKS["aa-v1"] = await resp.json();
    } catch (e) {
      console.warn("[ThunderBrowser] state-pack load failed", e);
      STATE_PACKS["aa-v1"] = { pack_id: "aa-v1", version: 0, states: [] };
    }
  }

  function evaluateDetector(d) {
    if (d.kind === "url") return new RegExp(d.pattern).test(location.href) ? d.weight : 0;
    if (d.kind === "dom") return document.querySelector(d.selector) ? d.weight : 0;
    if (d.kind === "text") return new RegExp(d.pattern, "i").test(document.body?.textContent || "") ? d.weight : 0;
    return 0;
  }

  async function detectState() {
    await loadStatePacks();
    const pack = STATE_PACKS["aa-v1"];
    let best = { id: null, confidence: 0 };
    for (const s of pack?.states || []) {
      const score = (s.entry_detectors || []).reduce((a, d) => a + evaluateDetector(d), 0);
      if (score >= (s.min_confidence ?? 0.8) && score > best.confidence) {
        best = { id: s.id, confidence: score, expected_actions: s.expected_actions };
      }
    }
    return { state: best.id, confidence: best.confidence, expected_actions: best.expected_actions || [] };
  }

  // --- Mutation observer: emit state_detected on coalesced changes ----------
  let mutationTimer = null;
  let lastReportedState = null;
  const observer = new MutationObserver(() => {
    if (mutationTimer) return;
    mutationTimer = setTimeout(async () => {
      mutationTimer = null;
      const s = await detectState();
      if (s.state && s.state !== lastReportedState) {
        lastReportedState = s.state;
        chrome.runtime.sendMessage({
          v: PROTOCOL_VERSION, id: uuid(), ts: Date.now(),
          type: "event", scope: null, ref: null,
          body: { kind: "state_detected", state: s.state, confidence: s.confidence, url: location.href },
        });
      }
    }, 250);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });

  // --- Wait-for-load (CS side) -----------------------------------------------
  async function waitForLoad({ condition, timeout_ms }) {
    const start = Date.now();
    while (Date.now() - start < timeout_ms) {
      if (condition === "domcontentloaded" && document.readyState !== "loading") {
        return { ready_state: document.readyState };
      }
      if (condition === "network_idle") {
        // Crude: stable readyState + 500ms of no resource entries.
        if (document.readyState === "complete") {
          await sleep(500);
          return { ready_state: "complete" };
        }
      }
      await sleep(50);
    }
    throw mkErr("TIMEOUT", "wait_for_load timed out", true);
  }

  // --- Dispatcher -------------------------------------------------------------
  const HANDLERS = {
    ping: async () => ({ ok: true }),
    snapshot_dom: snapshotDom,
    query: queryDom,
    get_text: ({ ref }) => {
      const el = resolveRef(ref);
      if (!el) throw mkErr("ELEMENT_NOT_FOUND", ref, false);
      return { text: (el.textContent || "").slice(0, 8192) };
    },
    click: clickAction,
    fill: fillAction,
    select: selectAction,
    check: checkAction,
    scroll_to: scrollToAction,
    detect_modal: detectModal,
    detect_error: detectError,
    detect_loading: detectLoading,
    is_logged_in: isLoggedIn,
    detect_state: detectState,
    _wait_for_load: waitForLoad,
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.v !== PROTOCOL_VERSION) {
      sendResponse(errorReply(msg?.id, "BAD_ENVELOPE", "bad version", false));
      return true;
    }
    if (msg.type !== "command") {
      sendResponse({ ok: true });
      return true;
    }
    const action = msg.body?.action;
    const handler = HANDLERS[action];
    if (!handler) {
      sendResponse(errorReply(msg.id, "UNKNOWN_ACTION", action || "(none)", false));
      return true;
    }
    (async () => {
      try {
        const result = await handler(msg.body);
        sendResponse(reply(msg.id, result));
      } catch (e) {
        sendResponse(errorReply(msg.id, e.code || "ACTION_ERROR", e.message || String(e), e.retriable !== false));
      }
    })();
    return true;
  });

  // Announce readiness so the SW knows it can dispatch.
  chrome.runtime.sendMessage({
    v: PROTOCOL_VERSION, id: uuid(), ts: Date.now(), type: "event", scope: null, ref: null,
    body: { kind: "cs_ready", url: location.href },
  });

  // --- Utilities --------------------------------------------------------------
  function mkErr(code, message, retriable) {
    const e = new Error(message);
    e.code = code;
    e.retriable = !!retriable;
    return e;
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  async function sha256Hex(s) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
})();
