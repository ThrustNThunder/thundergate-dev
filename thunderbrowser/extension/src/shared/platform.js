// Thin shim so the rest of the extension never imports chrome.* directly.
// At Safari conversion time this re-exports browser.* via webextension-polyfill.

const api = typeof browser !== "undefined" ? browser : chrome;

export const runtime = api.runtime;
export const tabs = api.tabs;
export const scripting = api.scripting;
export const alarms = api.alarms;
export const storage = api.storage;
export const cookies = api.cookies;
export const windows = api.windows;
export const webNavigation = api.webNavigation;
