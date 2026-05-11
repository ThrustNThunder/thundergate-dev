// ThunderBrowser platform shim (TB-0-3).
//
// Thin wrapper over `chrome.*` so the Safari port can swap to `browser.*`
// without touching every call site. All extension code MUST import the
// API surfaces it needs from this module — no direct `chrome.*` references
// elsewhere in the source tree (acceptance check: grep returns zero hits
// outside lib/platform.js and lib/vendor/).
//
// The vendored polyfill at `lib/vendor/browser-polyfill.js` ensures
// `globalThis.browser` exists in both Chrome (alias of `chrome`) and Safari
// (native). This module prefers `browser` when available, falls back to
// `chrome` otherwise. Either way, the export shape is identical.

const api =
  (typeof globalThis !== 'undefined' && globalThis.browser) ||
  (typeof globalThis !== 'undefined' && globalThis.chrome) ||
  // eslint-disable-next-line no-undef
  (typeof browser !== 'undefined' ? browser : chrome);

export const runtime = api.runtime;
export const tabs = api.tabs;
export const scripting = api.scripting;
export const alarms = api.alarms;
export const storage = api.storage;
export const cookies = api.cookies;
export const windows = api.windows;
export const webNavigation = api.webNavigation;
export const action = api.action;

export default api;
