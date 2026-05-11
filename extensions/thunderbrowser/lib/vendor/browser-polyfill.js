// webextension-polyfill — vendored minimal stub (TB-0-3).
//
// The upstream Mozilla `webextension-polyfill` is not yet pulled from npm in
// this repo (no node_modules in tree). In Chrome MV3, `chrome.*` already
// returns Promises for modern methods, so the only thing the Safari port will
// need is the `browser` global. This stub provides that by aliasing
// `globalThis.chrome` → `globalThis.browser` when `browser` is undefined.
//
// When upgrading to the full polyfill:
//   1. `npm i webextension-polyfill` and copy the built UMD file in here at
//      a pinned hash.
//   2. Update the pinned hash + version banner in this header.
//   3. Re-run the TB-0-3 acceptance grep: no `chrome.*` references outside
//      `lib/platform.js` and `lib/vendor/`.
//
// This stub is loaded as a classic script (not a module) so it works in both
// the SW (which is a module) via dynamic import and in content scripts via
// manifest declaration. Keeping it side-effect-only (writes a global, exports
// nothing) is intentional — module/classic interop is fragile otherwise.

(function () {
  'use strict';
  if (typeof globalThis === 'undefined') return;
  if (typeof globalThis.browser === 'undefined' && typeof globalThis.chrome !== 'undefined') {
    globalThis.browser = globalThis.chrome;
  }
})();
