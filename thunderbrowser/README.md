# ThunderBrowser

ThunderGate's browser surface. Chrome MV3 extension that lets Jon read and act on Michael's real browser, with a full audit trail and a fail-closed safety model.

This is the Phase 0+1 scaffold from `THUNDERBROWSER_PHASE01_TICKETS.md`. It is dev-only — never point this build at the prod ThunderGate or Michael's real Chrome profile.

## Layout

```
extension/      Chrome MV3 extension (load unpacked from ./extension)
  manifest.json
  src/
    background/     service worker, WSS client, dispatcher, audit
    content/        DOM read/write, state detector, redactor
    popup/          status pill + reconnect/pause/options
    options/        endpoint config, allowlist viewer, audit log
    state-packs/    AA state pack v1
    icons/

bridge/         ThunderGate-side WSS server (production-shaped, JWT stubbed)
mock/           Mock ThunderGate (.tbscript runner + interactive REPL)
fixtures/       Local AA portal fixtures (Node HTTP, served on :7860)
scripts/        Dev Chrome launcher
tests/          Smoke tests
```

## Quickstart

Three terminals.

```sh
# 1. Fixture portal (http://localhost:7860)
npm run fixtures

# 2. Mock ThunderGate (ws://localhost:7861/browser)
npm run mock          # interactive mode
# or:
npm run mock -- mock/scripts/aa_happy_path.tbscript

# 3. Dev Chrome with the extension loaded
npm run dev-chrome
```

The extension auto-connects to `ws://localhost:7861/browser`. Open the
popup to confirm "connected". The fixture pages emit `state_detected`
events as you navigate them, and the mock TG can drive commands via the
REPL (`cmd navigate {"url":"http://localhost:7860/aa/dashboard","new_tab":true}`).

## What works in Phase 1

- WebSocket connect + reconnect + heartbeat (alarm-driven)
- Allowlist enforcement (`localhost:7860`, `*.aa.com`)
- Content script auto-injection, isolated world
- Actions: `navigate`, `wait_for_load`, `get_url`, `snapshot_dom` (structured),
  `query`, `get_text`, `click`, `fill`, `select`, `check`, `scroll_to`,
  `detect_modal`, `detect_error`, `detect_loading`, `is_logged_in`,
  `detect_state`
- State detector with AA state pack (9 fixture states + 3 interstitials)
- Local audit chain (IDB-backed, SHA-256 prev_hash)
- Input redactor for password / cc / ssn fields
- Mock TG `.tbscript` runner with smoke + AA happy-path scripts

## Not yet wired (Phase 2+)

- BYOAA scope tokens + per-action attestation
- Device Ed25519 keypair + JWT auth to bridge
- Pairing flow (QR + ThunderCommo grant)
- ThunderCommo confirmation gate for irrevocable actions
- `recording mode` (`.tbrec` dump)
- Gateway-side audit anchor table in `context.db`
- PBS state pack + fixtures

## Safety posture

Dev only. Allowlist hardcoded to the fixture origin and `*.aa.com`. The bridge
cannot expand the allowlist remotely. Password / credit-card / SSN field
values are blanked by the redactor before any data leaves the content
script. Every action lands in the local audit chain.
