// Unit-style test for the AA state pack. We exercise the detector logic by
// simulating each state's URL + a minimal "DOM presence" map, so the test
// doesn't need a real browser. The detector itself lives in the content
// script (which needs a DOM) — this test validates the *rules* the detector
// reads from.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

let fails = 0;
function ok(m) { console.log("  ok  " + m); }
function bad(m) { console.log("  FAIL " + m); fails++; }

const pack = JSON.parse(readFileSync(resolve(ROOT, "extension/src/state-packs/aa-v1.json"), "utf8"));

// Synthetic fixture cases — each lists a URL and the selectors/text that
// are "present" on the page. We then evaluate each state's detectors against
// that input and assert the best match.
const CASES = [
  { name: "login fixture", url: "http://localhost:7860/aa/login", selectors: ["form[data-aa-login]"], text: "sign in to your aadvantage account", expect: "aa.unauth" },
  { name: "dashboard fixture", url: "http://localhost:7860/aa/dashboard", selectors: ["[data-aa-user]"], text: "welcome michael aadvantage", expect: "aa.dashboard" },
  { name: "travel planner", url: "http://localhost:7860/aa/travel-planner", selectors: ["[data-aa-travel-planner]"], text: "plan your trip", expect: "aa.travel_planner_empty" },
  { name: "results", url: "http://localhost:7860/aa/travel-planner/results", selectors: ["[data-aa-result-row]"], text: "", expect: "aa.search_results" },
  { name: "confirm", url: "http://localhost:7860/aa/travel-planner/confirm", selectors: ["[data-aa-confirm-button]"], text: "", expect: "aa.confirm_review" },
  { name: "confirmed", url: "http://localhost:7860/aa/travel-planner/confirmed", selectors: ["[data-aa-confirmation-code]"], text: "", expect: "aa.confirmed" },
  { name: "timeout", url: "http://localhost:7860/aa/timeout", selectors: ["[data-aa-timeout-modal]"], text: "your session has timed out", expect: "aa.timeout" },
  { name: "password expired", url: "http://localhost:7860/aa/password-expired", selectors: [], text: "your password has expired", expect: "aa.password_change" },
  { name: "captcha", url: "http://localhost:7860/aa/captcha", selectors: ["[data-aa-captcha]"], text: "", expect: "aa.captcha_blocked" },
];

function evaluateDetector(d, fixture) {
  if (d.kind === "url") return new RegExp(d.pattern).test(fixture.url) ? d.weight : 0;
  if (d.kind === "dom") return fixture.selectors.some((s) => s === d.selector || d.selector.split(",").map((x) => x.trim()).includes(s)) ? d.weight : 0;
  if (d.kind === "text") return new RegExp(d.pattern, "i").test(fixture.text) ? d.weight : 0;
  return 0;
}

for (const c of CASES) {
  let best = { id: null, score: 0 };
  for (const s of pack.states) {
    const score = s.entry_detectors.reduce((a, d) => a + evaluateDetector(d, c), 0);
    if (score >= s.min_confidence && score > best.score) best = { id: s.id, score };
  }
  if (best.id === c.expect) ok(`${c.name} → ${best.id} (${best.score.toFixed(2)})`);
  else bad(`${c.name} expected ${c.expect}, got ${best.id} (${best.score.toFixed(2)})`);
}

console.log(`\n${fails === 0 ? "PASS" : "FAIL"}: state-pack (${fails} failures)`);
process.exit(fails === 0 ? 0 : 1);
