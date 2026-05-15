// ThunderBrowser content script — the page-side responder.
//
// The service worker addresses the page via chrome.tabs.sendMessage. We
// keep the surface tiny: click(selector), fill(selector,value), getState().
// For any page where this script wasn't injected (chrome://, freshly
// opened tabs), the SW falls back to chrome.scripting.executeScript with
// an inline duplicate of these handlers — so behavior must match what
// `inlineDomOp` does in service-worker.js.

(() => {
  if (window.__thunderbrowser_loaded__) return;
  window.__thunderbrowser_loaded__ = true;

  function selectOne(sel) {
    try { return document.querySelector(sel); } catch { return null; }
  }

  function snapshot() {
    return {
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      forms: Array.from(document.forms).map((f) => ({
        id: f.id || null,
        action: f.action || null,
        fields: Array.from(f.elements)
          .filter((el) => el.name)
          .map((el) => ({ name: el.name, type: el.type || el.tagName.toLowerCase() }))
      })),
      links: Array.from(document.links).slice(0, 20).map((a) => ({
        href: a.href,
        text: (a.textContent || '').trim().slice(0, 80)
      }))
    };
  }

  function handle(payload) {
    switch (payload?.op) {
      case 'getState':
        return {
          ok: true,
          portalState: document.body?.dataset?.portalState ?? null,
          snapshot: snapshot()
        };
      case 'click': {
        const el = selectOne(payload.selector);
        if (!el) return { ok: false, error: 'element_not_found' };
        try { el.click(); } catch (e) { return { ok: false, error: e.message }; }
        return { ok: true };
      }
      case 'fill': {
        const el = selectOne(payload.selector);
        if (!el) return { ok: false, error: 'element_not_found' };
        try {
          if ('value' in el) {
            el.focus();
            el.value = payload.value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (el.isContentEditable) {
            el.textContent = payload.value;
          } else {
            return { ok: false, error: 'element_not_fillable' };
          }
        } catch (e) {
          return { ok: false, error: e.message };
        }
        return { ok: true };
      }
      default:
        return { ok: false, error: 'unknown_op' };
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    sendResponse(handle(msg));
    return true;
  });
})();
