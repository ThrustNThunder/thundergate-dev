# ThunderBrowser (dev)

Phase 0 scaffold of the ThunderBrowser Chrome extension. See
`THUNDERBROWSER_EXTENSION_DESIGN.md` and `THUNDERBROWSER_PHASE01_TICKETS.md`
in `cli-jon-context` for the spec.

## Layout

```
extensions/thunderbrowser/
├── manifest.json                # MV3 (TB-0-1)
├── background/service-worker.js # SW + alarm heartbeat + WSS client (TB-0-4/5/6/8)
├── content/content.js           # CS stub (TB-0-1; full bus lands in TB-1-1)
├── popup/                       # Status pill + run label (TB-0-6)
├── options/                     # Storage + device key + pairing UI (TB-0-7/8)
├── lib/storage.js               # IndexedDB schema + helpers (TB-0-2)
├── lib/platform.js              # chrome/browser shim (TB-0-3)
├── lib/qrcode.js                # Minimal QR encoder used by the pairing UI
├── lib/vendor/browser-polyfill.js
├── icons/                       # 16/32/48/128
├── dev-chrome.sh                # Dev launcher (TB-0-9)
├── mock-tg/                     # Mock ThunderGate WSS server (TB-0-10)
└── fixture-site/                # Local AA fixture site (TB-0-11)
```

## Quick start

```bash
# Terminal 1 — mock ThunderGate (port 9876)
cd extensions/thunderbrowser/mock-tg
node mock-server.js

# Terminal 2 — fixture AA portal (port 7860)
cd extensions/thunderbrowser/fixture-site
node server.js

# Terminal 3 — launch dev Chrome with the extension loaded
./extensions/thunderbrowser/dev-chrome.sh
```

The dev profile lives at `/tmp/thunderbrowser-dev-profile` (overridable via
`TB_DEV_PROFILE`). Wipe it any time:

```bash
rm -rf /tmp/thunderbrowser-dev-profile
```

## Pairing flow (TB-0-8)

1. Open the options page (right-click toolbar icon → Options).
2. Click **Pair with ThunderGate**.
3. The QR encodes `{extensionPairId, pubKeyFingerprint, pairingCode, gateway_hint}`.
   The mock TG REPL can accept it via `scenario pair <code>`, or you can hit
   **Simulate confirm (dev)** to mark the extension as paired without a TG.
4. The popup will reflect the paired state on its next 2s poll.

## Mock TG REPL (TB-0-10)

After starting `mock-tg/mock-server.js`, type at the prompt:

| Command                       | Effect                                                |
| ----------------------------- | ----------------------------------------------------- |
| `scenario navigate`           | Sends a navigate command                              |
| `scenario snapshot`           | Sends a snapshot_dom command                          |
| `scenario click`              | Sends a click command (dummy ref)                     |
| `scenario scope <label>`      | Mints a fake scope token and announces the run label  |
| `scenario pair <code>`        | Confirms pairing for the given 6-digit code           |
| `scenario hello`              | Re-sends the hello event                              |
| `list`                        | Lists connected extensions                            |
| `help`                        | Shows this table                                      |
| `quit`                        | Shuts down                                            |

Events from the extension are logged to stdout with timestamps.

## Fixture site (TB-0-11)

`fixture-site/server.js` runs on port 7860 and serves the AA portal state
pages from `fixture-site/pages/`:

- `/` → login
- `/dashboard`
- `/travel-planner`
- `/results`
- `/confirm` (precision-click target)
- `/confirmed`
- `/password-expired`
- `/captcha`
- `/timeout`

Each page links to the others through a consistent nav so the extension can
walk the FSM during Phase 1 fixture tests.

## Cross-talk guard

TB-0-9 acceptance includes a dev↔prod refusal. The SW currently hard-codes
`ws://localhost:9876/browser`; the manifest carries `"name": "ThunderBrowser
(dev)"`. The prod build (Phase 5) will set its own constants and refuse a
`gateway-dev` host. Both checks live in `service-worker.js` once the prod
build path lands.

## Phase 0 exit gate

See `THUNDERBROWSER_PHASE01_TICKETS.md` §1 "Phase 0 exit gate" — Doctor-green
before Phase 1 starts.
