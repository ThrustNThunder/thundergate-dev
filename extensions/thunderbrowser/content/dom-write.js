// ThunderBrowser DOM write actions (TB-1-3 write half).
//
// Four actions:
//   click     — Locate by ref or selector, scroll into view, dispatch a
//               composed pointerdown/mousedown/mouseup/click sequence.
//               Returns the element's bounding-rect at click time so the
//               caller can correlate with screenshots.
//   fill      — Set the value of an input/textarea or contenteditable with
//               the native setter (so React's onChange fires), then emit
//               `input` and `change` events. `secret=true` causes the
//               value to be redacted in the action log returned to the SW
//               — the value still goes onto the page, but neither the
//               bus nor any audit chain ever sees the cleartext.
//   scroll_to — Run `element.scrollIntoView({block: 'center'})` and
//               report whether the element is now in the visible viewport.
//   press_key — Dispatch a synthesized KeyboardEvent on the active
//               element (or document.body if none) with optional
//               modifiers. Useful for `Enter` to submit a form without a
//               separate click target.
//
// All four go through the same `resolveTarget` helper so the agent can
// pass either `{ref: "..."}` (preferred — stable across re-renders within
// one snapshot) or `{selector: "..."}` (cheap to author, fragile under
// SPA churn). Mixing both is allowed; ref wins.
//
// Visibility + stability check (TB-1-5 contract): before clicking we
// confirm the element is connected, visible, and has been at its current
// bounding rect for at least 2 consecutive RAFs. This catches the common
// failure mode of clicking a button mid-fade-in where the click lands on
// whatever pixel sits behind it.

(function attachWrite() {
  if (globalThis.__tb && globalThis.__tb.write) return;
  const bus = globalThis.__tb && globalThis.__tb.bus;
  if (!bus) {
    console.warn('[tb] dom-write loaded before message-bus — skipping registration');
    return;
  }

  const STABILITY_MS = 80;
  const STABILITY_FRAMES = 2;
  const REDACTED = '[REDACTED]';

  // ── Target resolution ──────────────────────────────────────────────────
  function resolveTarget(args) {
    if (typeof args.ref === 'string') {
      const el = bus.resolveRef(args.ref);
      if (!el) return { error: 'ref_stale', detail: args.ref };
      return { el };
    }
    if (typeof args.selector === 'string') {
      let el = null;
      try { el = document.querySelector(args.selector); }
      catch (err) { return { error: 'invalid_selector', detail: err.message }; }
      if (!el) return { error: 'not_found', detail: args.selector };
      return { el };
    }
    return { error: 'target_required', detail: 'pass {ref} or {selector}' };
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    if (el.hidden) return false;
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function rectSummary(el) {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height)
    };
  }

  function rectsEqual(a, b) {
    return a && b
      && Math.round(a.x) === Math.round(b.x)
      && Math.round(a.y) === Math.round(b.y)
      && Math.round(a.width) === Math.round(b.width)
      && Math.round(a.height) === Math.round(b.height);
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  /**
   * Returns once the element's rect has been identical for
   * STABILITY_FRAMES consecutive RAFs, or once stabilityTimeoutMs passes
   * (in which case we report `stable: false` and let the caller decide
   * whether to proceed).
   */
  async function awaitStable(el, stabilityTimeoutMs) {
    const deadline = Date.now() + Math.max(stabilityTimeoutMs, STABILITY_MS);
    let lastRect = el.getBoundingClientRect();
    let streak = 1;
    while (Date.now() < deadline) {
      await nextFrame();
      const cur = el.getBoundingClientRect();
      if (rectsEqual(lastRect, cur)) {
        streak += 1;
        if (streak >= STABILITY_FRAMES) return { stable: true, rect: cur };
      } else {
        streak = 1;
        lastRect = cur;
      }
    }
    return { stable: false, rect: lastRect };
  }

  function inViewport(rect) {
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
  }

  // ── click ──────────────────────────────────────────────────────────────
  async function actClick(args = {}) {
    const tgt = resolveTarget(args);
    if (tgt.error) return tgt;
    const el = tgt.el;
    if (!isVisible(el)) return { error: 'not_visible', detail: rectSummary(el) };

    // Bring the element into view first so coordinates we synthesize match
    // what a human would see. Honor `behavior: 'instant'` so the stability
    // wait isn't fighting a smooth-scroll animation.
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }
    catch (_) { el.scrollIntoView(); }

    const stableTimeout = typeof args.stabilityTimeoutMs === 'number' ? args.stabilityTimeoutMs : 750;
    const stab = await awaitStable(el, stableTimeout);
    if (!stab.stable && args.allowUnstable !== true) {
      return { error: 'not_stable', detail: rectSummary(el) };
    }

    const rect = stab.rect;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    // Composed event sequence — synthetic events with `isTrusted: false`
    // don't unlock all browser features (no clipboard write, no FS access)
    // but they fire normal listeners. Good enough for almost every form
    // and SPA button on the modern web.
    const dispatchPointer = (type, init) => {
      const Ctor = window.PointerEvent || window.MouseEvent;
      const ev = new Ctor(type, {
        bubbles: true, cancelable: true, composed: true, view: window,
        button: 0, buttons: 1, clientX: cx, clientY: cy,
        pointerType: 'mouse', isPrimary: true,
        ...(init || {})
      });
      el.dispatchEvent(ev);
    };

    dispatchPointer('pointerdown');
    el.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, composed: true, view: window,
      button: 0, buttons: 1, clientX: cx, clientY: cy
    }));
    dispatchPointer('pointerup', { buttons: 0 });
    el.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, cancelable: true, composed: true, view: window,
      button: 0, buttons: 0, clientX: cx, clientY: cy
    }));
    // `click()` on the element triggers the synthesized click *and* honors
    // form-submit / label-for / anchor-follow semantics that a bare
    // dispatchEvent doesn't.
    try { el.click(); }
    catch (_) {
      el.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, composed: true, view: window,
        button: 0, clientX: cx, clientY: cy
      }));
    }

    return {
      clicked: true,
      tag: el.tagName.toLowerCase(),
      ref: bus.mintRef(el),
      rect: rectSummary(el),
      inViewport: inViewport(el.getBoundingClientRect()),
      stable: stab.stable
    };
  }

  // ── fill ───────────────────────────────────────────────────────────────
  //
  // React (and any framework that proxies the native value setter) needs
  // the underlying prototype setter, not just `el.value = ...`. Setting
  // through the proto cleans the dirty-flag the framework uses to detect
  // user-driven changes.
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && typeof descriptor.set === 'function') {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  async function actFill(args = {}) {
    const tgt = resolveTarget(args);
    if (tgt.error) return tgt;
    const el = tgt.el;
    if (!isVisible(el)) return { error: 'not_visible' };

    const value = typeof args.value === 'string' ? args.value : null;
    if (value === null) return { error: 'value_required' };

    const secret = args.secret === true;
    const tag = el.tagName.toLowerCase();
    const isInput = tag === 'input' || tag === 'textarea';
    const isContentEditable = el.isContentEditable === true;

    if (!isInput && !isContentEditable) {
      return { error: 'not_fillable', detail: { tag } };
    }

    try { el.focus(); } catch (_) { /* ignore */ }

    if (isInput) {
      setNativeValue(el, value);
    } else {
      // Contenteditable — clear then insert. We don't try to preserve
      // existing inline ranges; the agent is expected to read first if
      // it cares about pre-existing content.
      el.textContent = value;
    }

    // Fire `input` and `change`. React listens on `input`; classic forms
    // listen on `change` for blur-equivalent semantics, so we fire both
    // to cover the common cases without an explicit blur (which would
    // close native datepickers/autocomplete and surprise the user).
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

    return {
      filled: true,
      tag,
      ref: bus.mintRef(el),
      length: value.length,
      // Audit-safe value field — never returns the cleartext for secrets.
      // The bus + audit chain see only this value; the cleartext is
      // already on the page but never leaves the content-script realm.
      value: secret ? REDACTED : value,
      secret
    };
  }

  // ── scroll_to ──────────────────────────────────────────────────────────
  async function actScrollTo(args = {}) {
    const tgt = resolveTarget(args);
    if (tgt.error) return tgt;
    const el = tgt.el;
    const block = args.block === 'start' || args.block === 'end' || args.block === 'nearest'
      ? args.block : 'center';
    try {
      el.scrollIntoView({ block, inline: 'center', behavior: 'instant' });
    } catch (_) {
      el.scrollIntoView();
    }
    // One RAF for the scroll to land before we measure.
    await nextFrame();
    const rect = el.getBoundingClientRect();
    return {
      scrolled: true,
      ref: bus.mintRef(el),
      rect: rectSummary(el),
      inViewport: inViewport(rect)
    };
  }

  // ── press_key ──────────────────────────────────────────────────────────
  //
  // Keyboard synthesis is famously fiddly — `KeyboardEvent` constructed in
  // JS has `keyCode = 0` and many sites still test on `keyCode`. We set
  // both `key` and `code`, and use `Object.defineProperty` to override
  // `keyCode`/`which` after construction so legacy listeners trip.
  function makeKeyEvent(type, key, modifiers) {
    const init = {
      bubbles: true, cancelable: true, composed: true, view: window,
      key,
      code: typeof modifiers.code === 'string' ? modifiers.code : keyToCode(key),
      ctrlKey: modifiers.ctrl === true,
      shiftKey: modifiers.shift === true,
      altKey: modifiers.alt === true,
      metaKey: modifiers.meta === true,
      repeat: false
    };
    const ev = new KeyboardEvent(type, init);
    const kc = keyToKeyCode(key);
    if (kc) {
      try {
        Object.defineProperty(ev, 'keyCode', { get: () => kc });
        Object.defineProperty(ev, 'which', { get: () => kc });
      } catch (_) { /* read-only on some engines — accept best-effort */ }
    }
    return ev;
  }

  function keyToCode(key) {
    if (!key) return '';
    if (key === 'Enter') return 'Enter';
    if (key === 'Tab') return 'Tab';
    if (key === 'Escape' || key === 'Esc') return 'Escape';
    if (key === ' ' || key === 'Space') return 'Space';
    if (key.length === 1 && /[a-zA-Z]/.test(key)) return 'Key' + key.toUpperCase();
    if (key.length === 1 && /[0-9]/.test(key)) return 'Digit' + key;
    return '';
  }

  function keyToKeyCode(key) {
    if (!key) return 0;
    if (key === 'Enter') return 13;
    if (key === 'Tab') return 9;
    if (key === 'Escape' || key === 'Esc') return 27;
    if (key === ' ' || key === 'Space') return 32;
    if (key === 'ArrowLeft') return 37;
    if (key === 'ArrowUp') return 38;
    if (key === 'ArrowRight') return 39;
    if (key === 'ArrowDown') return 40;
    if (key.length === 1) return key.toUpperCase().charCodeAt(0);
    return 0;
  }

  async function actPressKey(args = {}) {
    const key = typeof args.key === 'string' ? args.key : null;
    if (!key) return { error: 'key_required' };
    const modifiers = (args.modifiers && typeof args.modifiers === 'object') ? args.modifiers : {};

    // Target: explicit ref/selector, otherwise the focused element, else body.
    let target = null;
    if (args.ref || args.selector) {
      const tgt = resolveTarget(args);
      if (tgt.error) return tgt;
      target = tgt.el;
      try { target.focus(); } catch (_) { /* ignore */ }
    } else {
      target = document.activeElement || document.body;
    }

    target.dispatchEvent(makeKeyEvent('keydown', key, modifiers));
    target.dispatchEvent(makeKeyEvent('keypress', key, modifiers));
    target.dispatchEvent(makeKeyEvent('keyup', key, modifiers));

    return {
      pressed: true,
      key,
      modifiers: {
        ctrl: modifiers.ctrl === true,
        shift: modifiers.shift === true,
        alt: modifiers.alt === true,
        meta: modifiers.meta === true
      },
      targetTag: target && target.tagName ? target.tagName.toLowerCase() : null
    };
  }

  bus.register('click', actClick);
  bus.register('fill', actFill);
  bus.register('scroll_to', actScrollTo);
  bus.register('press_key', actPressKey);

  globalThis.__tb.write = { actClick, actFill, actScrollTo, actPressKey };
})();
