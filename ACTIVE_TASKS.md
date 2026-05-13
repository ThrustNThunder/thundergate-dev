# Active Tasks — 2026-05-11 (Burn Run)

> Local working copy. The canonical task list lives in the
> `cli-jon-context` repo's `ACTIVE_TASKS.md`. Sync the changes below
> upstream after this branch lands.

## 🟡 ACTIVE / NEXT

### ThunderCommo iOS — DM shared-context fix (2026-05-11)
- `routeShows(message:)` `.direct` case in
  `apps/ios/ThunderCommIOS/ThunderCommStore.swift` rewritten to filter on
  sender identity rather than channel: shows messages where
  `senderType == .human` and sender matches `localParticipantID`/`senderName`
  (Michael) OR `senderType == .agent` and `agentId`/canonical participantID
  matches `directAgentId` (target agent, e.g. Jon).
- Effect: DM view now shows the same continuous context as `#tnt`,
  filtered to Michael + target agent only; other agents' messages hidden.
  Outbound send logic and subscription/auth untouched (per brief).
- `xcodebuild -scheme ThunderCommIOS -configuration Debug -sdk
  iphonesimulator -destination "generic/platform=iOS Simulator"` →
  **BUILD SUCCEEDED** on Michael@100.78.229.40 with Xcode 17 / iOS 17 SDK.
- Per brief rules: no archive, no git push.
- Completion summary at `/tmp/dm-shared-context-complete.txt`.

### Ghost Jon 7-Day Clock
- Day 1 = May 10 (FK fix deployed). Need 7 consecutive clean days before cutover.
- May 11 pressure test passed clean (54 paired entries, 0 FK errors, median 705ms).
- Monitor daily with `ghost status`. Promote when 7 consecutive clean days reached.
- Daily health check at 08:00 UTC flags err > 10%, missing score rows, and
  any FK regression newer than the deploy.

### ThunderCommo Build 29 — combined fix run COMPLETE (2026-05-11)
- 9 bug-regression fixes verified (A: watermark light-mode opacity
  0.055→0.08, B: thinking-dots expiry 8s→60s, plus 7 prior fixes
  re-verified intact in source: `channel: String` decoding,
  `deliveryWatchdogs`, SQLite store, ComposerBar shape, channel display,
  profileSaved flow).
- **APNs wiring landed**: `.openChannel` + `.notificationsDeclined`
  Notification.Names; `UNUserNotificationCenterDelegate` on AppDelegate
  with foreground-banner presentation and tap-to-channel routing;
  in-app declined banner in `ContentView` with Open Settings deep-link;
  decline-event post from `APNsManager.requestUserAuthorization`.
- **Bug #10 (afterTimestamp replay) fixed**: store now exposes
  `lastMessageTimestamp(for:)` (in-memory max OR persisted UserDefaults
  snapshot), persists per-channel ts on every `merge()`, and the
  WebSocket client carries `afterTimestamp` on both `federation_auth`
  and `subscribe` payloads via the new `onResolveAfterTimestamp`
  callback.
- Source files touched live on `Michael@100.78.229.40` under
  `~/.openclaw/workspace-mack/repos/thundergate-sparse/apps/ios/`.
  `xcodebuild Debug iphonesimulator` → **BUILD SUCCEEDED**, 0 errors,
  pre-existing single warning unrelated to this build.
- `MACK_MANUAL_STEPS.md` written to `apps/ios/` covering the Xcode-only
  steps (Push Notifications capability, Background Modes → Remote
  notifications, Info.plist sanity, .p8 key on relay) and the
  conservative-choice notes (existing `/api/devices/token` endpoint
  kept; afterTimestamp added to BOTH auth + subscribe payloads).
- Per brief rules: no archive, no git push.
- Completion summary at `/tmp/build29-combined-complete.txt`.

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

## ✅ DONE (Build 31 run, 2026-05-11)

- **Build 31 — APNs + subscribedChannels + Jon thinking dots** (brief:
  `/tmp/build31-brief.md`).
  - **Task 1 (subscribedChannels loop)** — already on disk from the
    Build 30 DM-routing run; `subscribedChannels` in
    `ThunderCommStore.swift` (lines ~1172-1185) iterates over
    `availableDirectAgents` and emits `direct:jon`, `direct:mack`,
    `direct:rex` plus `tnt` / `jmab` (+ active custom channel). Verified
    against the brief diff; no further source edit needed.
  - **Task 2 (APNs iOS)** — `APNsManager.swift` + `AppDelegate.swift`
    already cover authorization, decline banner via
    `.notificationsDeclined`, device-token registration, foreground
    banner presentation, and tap-to-channel routing via `.openChannel`.
    Verified line-by-line. `MACK_MANUAL_STEPS_BUILD31.md` written to
    `apps/ios/` capturing the source verification + the Xcode-only
    steps (Push Notifications, Background Modes, Info.plist sanity,
    .p8 key on relay) + the smoke test plan + the choices CLI Jon kept
    conservative (endpoint still `/api/devices/token` via
    `account.httpURL` rather than the raw `:18794/register` route).
  - **Task 3 (Jon thinking dots)** — `bridge.mjs` at
    `/home/ubuntu/thundergate/extensions/thundercomm/bridge.mjs` now
    emits Mack-format `typing` events to the federation relay:
    - In `dispatchToAgent()`, immediately after the local
      `broadcast({ type: 'thinking', agentId })`, a `typing: true`
      event is sent to `federationWs` with `participantId`, `agentId`,
      `channel` (`lastDispatchChannel || 'tnt'`), `timestamp`, `model`
      (from `resolveDefaultModel()`), `thinking: 'off'`,
      `originPeer: thunderbase-${AGENT_ID_SELF}`, and a fresh `id`.
    - In `broadcastAgentMessage()`, right after the existing
      `federation_message` send, a `typing: false` event is sent with
      the same channel + originPeer to clear the indicator the instant
      the reply lands.
    - Both sends are wrapped in try/catch so any relay-side hiccup
      cannot block the actual dispatch path (the previous attempt at
      this caused a regression per the brief).
  - Build: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
    xcodebuild -scheme ThunderCommIOS -configuration Debug -sdk
    iphonesimulator -destination 'generic/platform=iOS Simulator' build`
    → **BUILD SUCCEEDED**, single pre-existing AppIntents warning
    unrelated to this run.
  - Per brief rules: no archive, no git push.
  - Completion summary at `/tmp/build31-complete.txt`.

## ✅ DONE (earlier 2026-05-11 runs)

- **DM routing fix on iOS ThunderCommo** (brief:
  `/tmp/dm-routing-brief.md`). Three fixes applied to Mack's iOS source
  at `Michael@100.78.229.40:~/.openclaw/workspace-mack/repos/thundergate-sparse/apps/ios/ThunderCommIOS/`:
  - **Fix A — multi-channel auth on (re)connect.** New `subscribedChannels`
    computed property on `ThunderCommStore` builds `["tnt", "jmab",
    "direct:jon", "direct:mack", "direct:rex"]` (plus the current custom
    channel when in `.channel` route) and is passed to
    `client.connect(channels:)`. The WebSocket client's `ActiveConnection`
    now stores `channels: [String]` instead of a single `channel`, and
    the auth handshake sends the full set.
  - **Fix B — auto-route on incoming DM.** New
    `autoRouteIfDirect(_ message:)` on the store flips
    `currentRoute → .direct` and `directAgentId` to the matching agent
    when a live `direct:<agent>` message arrives and the user isn't
    already in that thread. Hooked from `append(_:)` only, so bulk
    history replay does NOT yank the route. Skips self-sent messages.
  - **Fix C — re-auth on DM peer switch.** New `reauth(channels:)`
    method on `ThunderCommWebSocketClient` resends the auth payload
    without dropping the socket. Called from
    `setRoute(.direct, agentId:)` when already connected.
  - Build: `xcodebuild -scheme ThunderCommIOS -configuration Debug -sdk
    iphonesimulator` → **BUILD SUCCEEDED**, no warnings tied to the
    two edited files. Files touched (net delta):
    `ThunderCommStore.swift` (+65 lines),
    `ThunderCommWebSocketClient.swift` (+20 lines). Per brief: no
    archive, no push. Completion summary at `/tmp/dm-fix-complete.txt`.

- **Build 28 pressure test (source-level)** against Mack's iOS at
  `~/.openclaw/workspace-mack/repos/thundergate-sparse/apps/ios/`
  on Mac (100.78.229.40, branch `thundercomm-ios`). All four blockers
  (#1 DM routing, #2 watchdog, #3 DM context, #6 settings save) PASS
  at source. Bugs #4, #5, #7, #8 PASS with notes. **Section I (TNT
  logo watermark) FAIL** — not present in `ContentView.swift`, asset
  missing from `Assets.xcassets`. Five warnings logged. Verdict:
  HOLD under zero-exceptions rule; CONDITIONAL PASS under brief's
  verdict floor (5-line fix). Full result at
  `/tmp/build28-pressure-test-result.txt`.

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
