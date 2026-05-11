# Active Tasks — 2026-05-11 (Burn Run)

> Local working copy. The canonical task list lives in the
> `cli-jon-context` repo's `ACTIVE_TASKS.md`. Sync the changes below
> upstream after this branch lands.

## 🟡 ACTIVE / NEXT

### Ghost Jon 7-Day Clock
- Day 1 = May 10 (FK fix deployed). Need 7 consecutive clean days before cutover.
- May 11 pressure test passed clean (54 paired entries, 0 FK errors, median 705ms).
- Monitor daily with `ghost status`. Promote when 7 consecutive clean days reached.
- Daily health check at 08:00 UTC flags err > 10%, missing score rows, and
  any FK regression newer than the deploy.

### ThunderCommo Build 28 → 28b
- Build 28 shipped (4 blockers + 4 UX fixes + TNT watermark).
- Build 28b adds APNs registration + delivery, fixes Settings shared-suite
  regression. Brief at `THUNDERCOMMO_BUILD28B_BRIEF.md`.
- Full APNs iOS spec in `THUNDERCOMMO_APNS_IOS_SPEC.md` (Mack reads first,
  then implements `didRegisterForRemoteNotificationsWithDeviceToken` +
  Notification Service Extension).

### ThunderBrowser — Phase 1 in progress
- Phase 0 scaffold (TB-0-1..TB-0-11) complete.
- Phase 1 work landed across two runs:
  - **TB-1-1** content-script + isolated-world message bus + per-tab ref
    registry → `extensions/thunderbrowser/content/message-bus.js`
    + `content/content.js`.
  - **TB-1-2** DOM snapshot with 80 KB byte cap, stable SHA-256 hash,
    truncation fallback → `content/dom-snapshot.js`.
  - **TB-1-3 read** — `read.query` / `read.text` / `read.url` actions
    with selector / role / accessible-name matchers, limit 20 default
    / 200 max → `content/dom-read.js`.
  - **TB-1-2 navigate** (finish run) — `navigate` + `wait_for_load`
    SW-side actions in `background/service-worker.js` with allowlist
    stub (deny file://, chrome://, devtools://), 30s default timeout
    capped at 120s, `tabs.onUpdated` listener + post-timeout
    `tabs.get()` fallback for race-with-complete.
  - **TB-1-3 write** (finish run) — `click` / `fill` / `scroll_to` /
    `press_key` actions in new `content/dom-write.js`. Stability check
    (2 consecutive RAFs identical rect) before click, native-value
    setter via prototype descriptor (React-safe), `secret=true`
    redaction at audit boundary, KeyboardEvent legacy keyCode override
    via defineProperty.
  - SW action dispatcher splits SW-local actions (`navigate`,
    `wait_for_load`) from content-script-relayed actions (`read.*`,
    `click`, `fill`, `scroll_to`, `press_key`, `snapshot`) and returns
    a `cmd_result` envelope to the bridge for every command.
- **ThunderGate browser bridge** (TB-0-6) wired natively as a peer
  channel at `ws://0.0.0.0:9876/browser` →
  `src/channels/browser.ts`. Per-peer command queue, audit ingestion,
  optimistic pair acceptance (Phase 1 will replace with JWT verification
  against pinned pubkey from QR exchange).

### thundercomm-stable Web UI Redesign
- Commit `fb62e6634a` sits on Mac side. Mack handles the push.

## ✅ DONE (this run, 2026-05-11)

- Full workspace doc + repo audit (brief: cli-jon-context/FULL_AUDIT_BRIEF.md).
  Report at `/tmp/full-audit-report.md`. Workspace changes committed on
  `master`. Highlights: `project_jon/THUNDERCOMMO_ROADMAP.md` rewritten
  for Builds 27/28/28b; `THUNDERGATE_DESIGN_PRINCIPLES.md` gained
  Principle 24 (Claude Code Native); six superseded ThunderCommo design
  docs moved to `project_jon/archive/`; four build patch/brief docs
  moved from workspace root to `project_jon/builds/`; `scripts/README.md`
  added as the canonical script index (clarifies
  `aa_reserve_v1.8.py` is current vs. `aa_jumpseat_reserve.py` /
  `aa_checkin.py` being distinct stages, not duplicates). No push.
- APNs iOS spec authored, then in the finish run enhanced with: §3
  Xcode project configuration, §4a AppDelegate canonical Swift snippet
  (with main-thread dispatch + deny-fallback notification post), §4b
  in-app deny banner spec, §5a notification handling (tap-to-channel
  + content-available background wake contract), §5b Bug #9 replay
  prevention (three-layer fix), §9 provisioning & credentials table
  (.p8 storage at `~/.thundergate/apns_auth.p8`, env-var matrix, Apple
  Developer artefacts) (`THUNDERCOMMO_APNS_IOS_SPEC.md`).
- ThunderGate browser bridge implemented + wired into runtime
  (`src/channels/browser.ts`, `src/core/runtime.ts`).
  - Registry now isolates per-channel start failures so a port conflict
    on one channel doesn't block others.
  - Bridge runs on port 9876 with path `/browser`, matching the
    extension SW's `WSS_URL`.
- ThunderBrowser TB-1-1, TB-1-2, TB-1-3 (read) implemented + manifest
  updated to declare declarative content scripts on `<all_urls>` in
  the isolated world.
- Finish run: TB-1-2 navigate + wait_for_load landed in
  `background/service-worker.js`; TB-1-3 write half landed in new
  `content/dom-write.js` with click / fill / scroll_to / press_key,
  registered on the message bus, declared in the manifest content
  scripts in load order between dom-read.js and content.js.
- Build 28b brief authored, then extended with Section L (APNs
  integration tests L-1..L-7), Section M (Bug #9 replay prevention
  M-1..M-5), and Section N (first-launch notification prompt
  N-1..N-5). Gate-blocking subset called out per section. Pressure-
  test gate references new sections + APNs spec §10
  (`THUNDERCOMMO_BUILD28B_BRIEF.md`).
- Type-check clean (`tsc --noEmit` exit 0). Build clean
  (`npm run build` exit 0).
- Finish-run completion summary at `/tmp/finish-run-complete.txt`.

## ✅ DONE EARLIER (2026-05-10 → 2026-05-11)

- Ghost Jon pressure test PASSED (commit `5a5d2bf`).
- ThunderGate hardening (DB FK, ghost status, systemd, pairing timing,
  channel-conflict logging) — commits `1a483c7`, `b167d6b`.
- Build 27 reports pushed (commit `0d19a51`).
- `thundermind_price_watch.py` fixed (Newegg direct scrape, trusted
  domain whitelist, median-of-3 decision price).

## 🔵 STILL TO DO

### Brave API Key Missing on ThunderBase
- `~/.openclaw/openclaw.json → tools.web.search.apiKey` is empty.
- Without it the price-watch Amazon / Micro Center fallback returns
  nothing. Newegg direct scrape covers the primary parts; key should be
  restored.

### Enable thundergate systemd Service
- Unit file exists but `systemctl status thundergate` shows inactive
  (dead). `sudo systemctl enable thundergate && sudo systemctl start
  thundergate` when ready.

### ThunderBrowser Phase 1 — remaining tickets
- TB-1-4 navigate + load-wait. _Implemented as part of finish run
  (SW-side `navigate` / `wait_for_load`); see DONE list above. Closing
  ticket pending real-site smoke test._
- TB-1-5 click with visibility + stability check. _Implemented in
  `dom-write.js` (RAF-stability gate, scroll-into-view, composed
  pointer/mouse sequence). Closing pending smoke test._
- TB-1-6 fill with native value setter. _Implemented in `dom-write.js`
  (proto-descriptor setter, secret redaction). Closing pending smoke
  test._
- TB-1-7 scroll-to. _Implemented in `dom-write.js`. Closing pending
  smoke test._
- TB-1-8..TB-1-11 modal/error/loading/login detectors.
- TB-1-12 local audit chain with sha-256 linking + device signatures.
- TB-1-13 two-layer domain allowlist (manifest + SW immutability).
  _SW-side `DENY_SCHEMES` stub in place; replaces with full allowlist
  before any production cut._
- TB-1-14 input redactor in content script (pre-transmission).
- TB-1-15..TB-1-18 state packs (AA + PBS), fixtures, recording mode.

## Important Rules
- Never push to `thundercomm-stable` from ThunderBase — that's Mack's
  repo on Mac.
- No unsolicited changes to `openclaw.json` or gateway config.
- Pressure-test gate is non-negotiable for Build 26+.
- `<all_urls>` content-script matcher is the Phase 1 dev posture only —
  TB-1-13 (allowlist) replaces it with the manifest-immutable allowlist
  before any production cut.
