// ThunderBrowser DOM snapshot (TB-1-2).
//
// Produces a structured, size-capped JSON view of the current document so
// the agent on the other end of the bridge can reason about page state
// without us shipping raw HTML (XSS / leak surface) or a verbatim
// accessibility tree (oversized + Chrome-only).
//
// Output shape:
//   {
//     url:        "https://example.com/path?…",
//     title:      "Document Title",
//     hash:       "<hex sha-256 of canonical form>",
//     truncated:  false | true,
//     node_count: 1234,
//     root: {
//       tag, role?, name?, text?, attrs?, ref?, children?: [...]
//     }
//   }
//
// Cap: 80 KB of serialized JSON. We measure during the walk and stop
// adding new nodes once we cross the byte budget — the partial tree is
// returned with `truncated: true` so the SW knows to ask for a targeted
// sub-snapshot if it needs more.
//
// Stable hashing: hash is computed over the canonicalized snapshot (the
// JSON we return, minus the `hash` field). Two snapshots of identical
// state on the same URL produce identical hashes — used by the SW to
// skip re-shipping unchanged page state.

(function attachSnapshot() {
  if (globalThis.__tb && globalThis.__tb.snapshot) return;
  const bus = globalThis.__tb && globalThis.__tb.bus;
  if (!bus) {
    console.warn('[tb] dom-snapshot loaded before message-bus — skipping registration');
    return;
  }

  const BYTE_CAP_DEFAULT = 80 * 1024;
  const MAX_TEXT_PER_NODE = 256;     // hard truncation per node text run
  const MAX_ATTR_VALUE = 200;

  // Tags we never recurse into. They either carry no semantic information
  // or are too noisy at scale (every leaf <svg> path balloons the tree).
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH', 'CIRCLE',
    'POLYGON', 'POLYLINE', 'RECT', 'LINE', 'IMG'
  ]);

  // Attributes worth keeping. Everything else is dropped to stay under
  // the byte cap. Boolean / state-bearing attrs only — no inline event
  // handlers (`onclick`, etc.) and no `style` (could be huge).
  const KEEP_ATTRS = new Set([
    'id', 'class', 'name', 'type', 'value', 'href', 'src', 'alt',
    'title', 'placeholder', 'role', 'tabindex', 'disabled', 'checked',
    'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-hidden',
    'aria-expanded', 'aria-current', 'aria-pressed', 'aria-disabled',
    'data-testid', 'data-test', 'data-cy', 'for'
  ]);

  function accessibleName(el) {
    // Cheap accessible-name computation — not a full ARIA algorithm.
    // Order roughly matches the spec but skips text-alternative steps
    // for media (we don't include images in snapshots).
    const aria = el.getAttribute('aria-label');
    if (aria) return clip(aria, MAX_TEXT_PER_NODE);
    const labeledby = el.getAttribute('aria-labelledby');
    if (labeledby) {
      const parts = labeledby.split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => n.textContent || '');
      const joined = parts.join(' ').trim();
      if (joined) return clip(joined, MAX_TEXT_PER_NODE);
    }
    // <label for="…"> resolves to the labeled control's name.
    if (el.id) {
      const lbl = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
      if (lbl && lbl.textContent) return clip(lbl.textContent.trim(), MAX_TEXT_PER_NODE);
    }
    if (el.tagName === 'INPUT') {
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) return clip(placeholder, MAX_TEXT_PER_NODE);
    }
    return null;
  }

  function inlineText(el) {
    // Only the direct text of this node, not its descendants — the tree
    // already recurses, so concatenating descendant text would double-
    // count and inflate the byte total fast.
    let s = '';
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) s += n.nodeValue;
    }
    s = s.replace(/\s+/g, ' ').trim();
    return s ? clip(s, MAX_TEXT_PER_NODE) : null;
  }

  function pickAttrs(el) {
    const out = {};
    for (const a of el.attributes) {
      if (!KEEP_ATTRS.has(a.name)) continue;
      let v = a.value;
      if (v == null) continue;
      if (v.length > MAX_ATTR_VALUE) v = v.slice(0, MAX_ATTR_VALUE) + '…';
      out[a.name] = v;
    }
    return Object.keys(out).length ? out : undefined;
  }

  function clip(s, n) {
    if (!s) return s;
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  // Sha-256 of a string → lowercase hex. WebCrypto is always present in
  // a content script (Chrome 120+), so this is sync-after-await without
  // a polyfill.
  async function sha256Hex(str) {
    const enc = new TextEncoder().encode(str);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    const bytes = new Uint8Array(buf);
    let hex = '';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    return hex;
  }

  /**
   * Build the snapshot tree starting at `root`, stopping once the byte
   * estimate crosses the cap. Returns `{ tree, nodeCount, truncated }`.
   *
   * The byte estimate is conservative — we add 100 bytes per node up
   * front to cover the JSON punctuation/keys, then measure variable-
   * length string contents. This avoids running JSON.stringify() in the
   * hot loop while still keeping us comfortably under the 80 KB cap.
   */
  function buildTree(root, byteCap) {
    let bytes = 0;
    let nodeCount = 0;
    let truncated = false;

    function visit(el, depth) {
      if (truncated) return null;
      if (!(el instanceof Element)) return null;
      if (SKIP_TAGS.has(el.tagName)) return null;

      // Honor `aria-hidden="true"` and the hidden attr — they remove the
      // node from the assistive view, and the agent should see the same.
      if (el.getAttribute('aria-hidden') === 'true') return null;
      if (el.hidden) return null;

      // Estimate this node's cost before adding it.
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || null;
      const name = accessibleName(el);
      const text = inlineText(el);
      const attrs = pickAttrs(el);

      let estBytes = 80; // base envelope ({,},",tag,…) ~80B
      if (role) estBytes += 8 + role.length;
      if (name) estBytes += 8 + name.length;
      if (text) estBytes += 8 + text.length;
      if (attrs) {
        for (const k in attrs) estBytes += 6 + k.length + (attrs[k] || '').length;
      }

      if (bytes + estBytes > byteCap) {
        truncated = true;
        return null;
      }

      const node = { tag };
      if (role) node.role = role;
      if (name) node.name = name;
      if (text) node.text = text;
      if (attrs) node.attrs = attrs;

      // Mint a ref for elements that are likely action targets so the SW
      // doesn't have to re-query for them. Limit to interactive-ish nodes
      // to keep the registry within MAX_REFS for large pages.
      if (isLikelyTarget(el)) {
        node.ref = bus.mintRef(el);
      }

      bytes += estBytes;
      nodeCount += 1;

      // Recurse — children added in DOM order. Bail early as soon as the
      // budget is crossed; partial children better than no node at all.
      const children = [];
      for (const child of el.children) {
        if (truncated) break;
        const sub = visit(child, depth + 1);
        if (sub) children.push(sub);
      }
      if (children.length) node.children = children;
      return node;
    }

    const tree = visit(root, 0);
    return { tree, nodeCount, truncated };
  }

  function isLikelyTarget(el) {
    const tag = el.tagName;
    if (tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    const role = el.getAttribute('role');
    if (role) {
      const r = role.toLowerCase();
      if (r === 'button' || r === 'link' || r === 'textbox' || r === 'checkbox' || r === 'radio' || r === 'menuitem' || r === 'tab') return true;
    }
    if (el.hasAttribute('tabindex')) return true;
    if (el.hasAttribute('data-testid') || el.hasAttribute('data-test') || el.hasAttribute('data-cy')) return true;
    return false;
  }

  async function takeSnapshot(args = {}) {
    const byteCap = typeof args.byteCap === 'number' ? args.byteCap : BYTE_CAP_DEFAULT;
    const t0 = performance.now();
    const { tree, nodeCount, truncated } = buildTree(document.documentElement, byteCap);
    const result = {
      url: location.href,
      title: document.title || null,
      truncated,
      node_count: nodeCount,
      root: tree
    };
    // Hash the canonical form (snapshot minus the `hash` field). Stable
    // across runs on identical state.
    const canonical = JSON.stringify(result);
    const hash = await sha256Hex(canonical);
    result.hash = hash;
    result.took_ms = Math.round(performance.now() - t0);
    return result;
  }

  bus.register('dom.snapshot', takeSnapshot);

  globalThis.__tb.snapshot = { takeSnapshot };
})();
