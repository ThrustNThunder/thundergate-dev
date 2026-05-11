// ThunderBrowser content-script entrypoint (TB-1-1).
//
// Loaded into every frame matching the allowlist (manifest content_scripts).
// All real logic lives in the sibling files declared in manifest order:
//   message-bus.js   — common envelope, per-tab ref registry, action registry
//   dom-snapshot.js  — TB-1-2: cap-limited DOM snapshot
//   dom-read.js      — TB-1-3 read half: query / text / url
//   dom-write.js     — TB-1-3 write half: click / fill / scroll_to / press_key
//
// Files share the content-script isolated world via `globalThis.__tb`.
// This file is the last one in the manifest's content_scripts.js array,
// so it can assume the bus and the action modules are attached.
//
// Isolated-world note: declarative content scripts default to the
// isolated world (Chrome's MV3 contract). We never set `world: "MAIN"`
// anywhere — agent code must not run with the page's CSP or have access
// to the page-side JS globals. The DOM is the only shared surface.

(function bootstrap() {
  const bus = globalThis.__tb && globalThis.__tb.bus;
  if (!bus) {
    console.warn('[tb] content.js: message bus not loaded — load order broken in manifest');
    return;
  }

  // Announce content-script presence to the SW so it can keep a per-tab
  // registry without waiting for a command to land. The SW echoes nothing
  // back; this is fire-and-forget.
  bus.emit('event', {
    kind: 'content_script_ready',
    url: location.href,
    in_iframe: window.top !== window.self,
    bundle_hash: 'tb-dev0'
  });

  // Best-effort signal when the page navigates within the same tab (SPA
  // route changes). The SW uses this to invalidate cached snapshots.
  let lastUrl = location.href;
  const sendUrlChange = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    bus.clearRefs();
    bus.emit('event', { kind: 'url_change', url: lastUrl });
  };
  window.addEventListener('popstate', sendUrlChange);
  window.addEventListener('hashchange', sendUrlChange);

  // History API patching is risky in content scripts (it would run in
  // the isolated world only, so page-side pushState wouldn't trigger).
  // We rely on a coarse poller instead — cheap and avoids leaking a
  // monkey-patched History into the page realm.
  setInterval(sendUrlChange, 1000);

  console.log('[tb] content script ready @', location.href);
})();
