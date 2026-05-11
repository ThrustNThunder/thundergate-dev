// ThunderBrowser DOM read actions (TB-1-3).
//
// Three actions:
//   read.query  — find elements by CSS selector, ARIA role, or accessible
//                 name. Returns up to `limit` matches as compact descriptors
//                 (tag, role, name, text, attrs, ref). Default limit 20, max 200.
//   read.text   — read the visible text content of a single element (by
//                 ref or selector). Strips whitespace runs, returns at most
//                 8 KB of text.
//   read.url    — return the current document URL plus referrer/title and
//                 a coarse "in iframe?" flag.
//
// Writes (click/fill/scroll/navigate) live in their own action files —
// TB-1-4 onwards. Keeping the read surface separate makes the redaction
// audit easier: nothing in this file is allowed to leak input values.

(function attachRead() {
  if (globalThis.__tb && globalThis.__tb.read) return;
  const bus = globalThis.__tb && globalThis.__tb.bus;
  if (!bus) {
    console.warn('[tb] dom-read loaded before message-bus — skipping registration');
    return;
  }

  const DEFAULT_LIMIT = 20;
  const MAX_LIMIT = 200;
  const MAX_TEXT_BYTES = 8 * 1024;
  const MAX_NAME_LEN = 256;
  const MAX_TEXT_PER_DESC = 200;

  // ── Matchers ────────────────────────────────────────────────────────────
  //
  // The agent specifies one of three matcher shapes in args.matcher:
  //   { selector: "css" }
  //   { role: "button", name?: "exact or substring" }
  //   { name: "exact or substring of accessible name" }
  //
  // `name` is matched case-insensitively. `selector` falls through directly
  // to querySelectorAll — invalid selectors return an error rather than
  // throwing, so a typo on the agent side surfaces cleanly.

  function findBySelector(selector, limit) {
    let nodes;
    try {
      nodes = document.querySelectorAll(selector);
    } catch (err) {
      return { error: 'invalid_selector', detail: err.message };
    }
    return { nodes: take(nodes, limit) };
  }

  function findByRole(role, name, limit) {
    const r = String(role).toLowerCase();
    // Cheap implicit-role mapping for the common interactive tags. The
    // full ARIA in HTML mapping table is enormous — we cover the cases
    // the AA + PBS fixtures actually use.
    const implicitTags = {
      button: ['button', 'input[type="submit"]', 'input[type="button"]', 'input[type="reset"]'],
      link: ['a[href]'],
      textbox: ['input:not([type])', 'input[type="text"]', 'input[type="email"]', 'input[type="password"]', 'input[type="search"]', 'input[type="tel"]', 'input[type="url"]', 'textarea'],
      checkbox: ['input[type="checkbox"]'],
      radio: ['input[type="radio"]'],
      combobox: ['select'],
      heading: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
      img: ['img']
    };
    const selectors = ['[role="' + cssEscape(r) + '"]'].concat(implicitTags[r] || []);
    const candidates = document.querySelectorAll(selectors.join(','));
    const filter = name ? buildNameFilter(name) : null;
    const matches = [];
    for (const el of candidates) {
      if (filter && !filter(el)) continue;
      matches.push(el);
      if (matches.length >= limit) break;
    }
    return { nodes: matches };
  }

  function findByName(name, limit) {
    const filter = buildNameFilter(name);
    const candidates = document.querySelectorAll(
      'a,button,input,textarea,select,[role],[aria-label],[aria-labelledby],label,h1,h2,h3,h4,h5,h6'
    );
    const matches = [];
    for (const el of candidates) {
      if (!filter(el)) continue;
      matches.push(el);
      if (matches.length >= limit) break;
    }
    return { nodes: matches };
  }

  function buildNameFilter(want) {
    const norm = String(want).trim().toLowerCase();
    return (el) => {
      const name = (accessibleName(el) || '').toLowerCase();
      if (!name) return false;
      // Exact match takes priority, substring is the fallback. Agents
      // can disambiguate by passing the full accessible name verbatim.
      return name === norm || name.includes(norm);
    };
  }

  function accessibleName(el) {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return clip(aria.trim(), MAX_NAME_LEN);
    const labeledby = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labeledby) {
      const parts = labeledby.split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => n.textContent || '');
      const joined = parts.join(' ').trim();
      if (joined) return clip(joined, MAX_NAME_LEN);
    }
    if (el.id) {
      const lbl = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
      if (lbl && lbl.textContent) return clip(lbl.textContent.trim(), MAX_NAME_LEN);
    }
    if (el.tagName === 'INPUT' && el.getAttribute('placeholder')) {
      return clip(el.getAttribute('placeholder').trim(), MAX_NAME_LEN);
    }
    if (el.tagName === 'BUTTON' || el.tagName === 'A') {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return clip(t, MAX_NAME_LEN);
    }
    return null;
  }

  function take(list, n) {
    const out = [];
    for (let i = 0; i < list.length && out.length < n; i++) {
      out.push(list[i]);
    }
    return out;
  }

  function describe(el) {
    const desc = {
      tag: el.tagName.toLowerCase(),
      ref: bus.mintRef(el)
    };
    const role = el.getAttribute('role');
    if (role) desc.role = role;
    const name = accessibleName(el);
    if (name) desc.name = name;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) desc.text = clip(text, MAX_TEXT_PER_DESC);
    // A small, fixed set of attrs that help the agent reason about the
    // match without bloating the response. Keep this list short — it's
    // shipped on every result row.
    const attrs = {};
    for (const a of ['id', 'name', 'type', 'href', 'value', 'aria-label', 'data-testid']) {
      const v = el.getAttribute(a);
      if (v != null) attrs[a] = clip(v, 200);
    }
    if (Object.keys(attrs).length) desc.attrs = attrs;
    desc.visible = isVisible(el);
    return desc;
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    if (el.hidden) return false;
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function clip(s, n) {
    if (!s) return s;
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function clampLimit(n) {
    let v = typeof n === 'number' ? n : DEFAULT_LIMIT;
    if (!Number.isFinite(v) || v <= 0) v = DEFAULT_LIMIT;
    if (v > MAX_LIMIT) v = MAX_LIMIT;
    return Math.floor(v);
  }

  // ── Handlers ────────────────────────────────────────────────────────────

  async function readQuery(args = {}) {
    const matcher = args.matcher || {};
    const limit = clampLimit(args.limit);
    let result;
    if (typeof matcher.selector === 'string') {
      result = findBySelector(matcher.selector, limit);
    } else if (typeof matcher.role === 'string') {
      result = findByRole(matcher.role, matcher.name, limit);
    } else if (typeof matcher.name === 'string') {
      result = findByName(matcher.name, limit);
    } else {
      return { error: 'matcher_required', detail: 'pass {selector} or {role} or {name}' };
    }
    if (result.error) return result;
    const descriptors = result.nodes.map(describe);
    return {
      count: descriptors.length,
      truncated: descriptors.length >= limit,
      limit,
      results: descriptors
    };
  }

  async function readText(args = {}) {
    let el = null;
    if (typeof args.ref === 'string') {
      el = bus.resolveRef(args.ref);
      if (!el) return { error: 'ref_stale', detail: args.ref };
    } else if (typeof args.selector === 'string') {
      try {
        el = document.querySelector(args.selector);
      } catch (err) {
        return { error: 'invalid_selector', detail: err.message };
      }
      if (!el) return { error: 'not_found', detail: args.selector };
    } else {
      return { error: 'target_required', detail: 'pass {ref} or {selector}' };
    }
    const raw = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    // Byte-cap (not char-cap) so multi-byte scripts don't blow the
    // envelope budget on the way back up the bridge.
    const enc = new TextEncoder();
    let bytes = enc.encode(raw);
    let truncated = false;
    if (bytes.length > MAX_TEXT_BYTES) {
      bytes = bytes.slice(0, MAX_TEXT_BYTES);
      truncated = true;
    }
    const text = new TextDecoder().decode(bytes);
    return {
      text,
      truncated,
      length: text.length,
      visible: isVisible(el)
    };
  }

  async function readUrl() {
    return {
      url: location.href,
      origin: location.origin,
      pathname: location.pathname,
      search: location.search || null,
      hash: location.hash || null,
      title: document.title || null,
      referrer: document.referrer || null,
      // Surface whether we're running inside a frame so the agent can
      // pick targeting strategy (cross-frame messaging will need the
      // frame id from the SW, not just the URL).
      in_iframe: window.top !== window.self,
      ready_state: document.readyState
    };
  }

  bus.register('read.query', readQuery);
  bus.register('read.text', readText);
  bus.register('read.url', readUrl);

  globalThis.__tb.read = { readQuery, readText, readUrl };
})();
