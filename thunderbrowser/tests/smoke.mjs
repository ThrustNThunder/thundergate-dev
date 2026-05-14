// Headless smoke test: brings up the fixture server, the bridge, and
// validates that the protocol envelope helpers + state-pack JSON are sane.
// This is *not* an end-to-end Chrome test — that requires the dev Chrome
// launcher and a human or Puppeteer. The smoke test guards the wire format
// and the state-pack schema so they don't drift.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

let fails = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ok  " + msg); }
  else { console.log("  FAIL " + msg); fails++; }
}

// 1) State pack is valid JSON with the expected shape.
const pack = JSON.parse(readFileSync(resolve(ROOT, "extension/src/state-packs/aa-v1.json"), "utf8"));
console.log("state pack aa-v1:");
assert(pack.pack_id === "aa-v1", "pack_id");
assert(pack.version >= 1, "version >= 1");
assert(Array.isArray(pack.states) && pack.states.length >= 9, "≥9 states");
for (const s of pack.states) {
  assert(typeof s.id === "string", `state has id (${s.id})`);
  assert(Array.isArray(s.entry_detectors), `${s.id} has entry_detectors`);
}

// 2) Envelope helper validation.
const { envelope, validateEnvelope, PROTOCOL_VERSION } = await import(resolve(ROOT, "extension/src/shared/protocol.js"));
console.log("envelope helper:");
const ev = envelope({ type: "event", body: { kind: "ping" } });
assert(ev.v === PROTOCOL_VERSION, "version stamped");
assert(typeof ev.id === "string" && ev.id.length > 0, "id assigned");
assert(validateEnvelope(ev) === null, "valid envelope passes");
assert(validateEnvelope({ type: "event" }) !== null, "missing fields rejected");
assert(validateEnvelope({ v: 999, id: "x", ts: 1, type: "event" }) === "version_mismatch", "bad version rejected");

// 3) Manifest references files that actually exist.
const manifest = JSON.parse(readFileSync(resolve(ROOT, "extension/manifest.json"), "utf8"));
const { existsSync } = await import("node:fs");
console.log("manifest references:");
assert(existsSync(resolve(ROOT, "extension", manifest.background.service_worker)), "SW exists");
for (const cs of manifest.content_scripts) {
  for (const js of cs.js) {
    assert(existsSync(resolve(ROOT, "extension", js)), `content script ${js} exists`);
  }
}

// 4) Bridge module loads cleanly.
console.log("bridge module:");
try {
  await import(resolve(ROOT, "bridge/server.mjs"));
  assert(true, "bridge module imports");
} catch (e) {
  assert(false, "bridge module imports: " + e.message);
}

console.log(`\n${fails === 0 ? "PASS" : "FAIL"}: smoke (${fails} failures)`);
process.exit(fails === 0 ? 0 : 1);
