# ThunderGate Phase 3 — Implementation Summary

## Date: May 10, 2026
## Branch: master (local commit, not pushed)

## What shipped

Three components per the brief: ThunderCommo native channel, Ghost Jon
harness, and a real config system. All wired through the runtime. CLI
gained a `ghost` command group; doctor reports both new subsystems
truthfully.

## Files created

| File | Purpose |
|---|---|
| `src/config/index.ts` | Phase 3 config entry: `ensureConfig()` writes the spec'd default config.json on first run, `validateConfig()` returns a list of human-readable problems, `readRawConfig()` / `getConfigPath()` helpers. Re-exports `Config` and `loadConfig` from loader. |
| `src/channels/index.ts` | `Channel` interface + `ChannelRegistry`. The contract every channel must satisfy and a tiny registry the runtime uses to broadcast outbound and lifecycle channels in/out. Defines `ContextEntry` — the unified context.jsonl record format. |
| `src/channels/thundercommo.ts` | `ThunderCommoChannel` — WebSocket server on port 8765 (configurable). Speaks the bridge.mjs wire protocol verbatim (`federation_auth`, `federation_message`, `message`, `stream_chunk`, `thinking`). Token auth from config. Inbound writes to context.jsonl + session DB and hands off to runtime via `onInbound`. Outbound broadcasts to authed clients filtered by channel subscription. Best-effort federation to `relay.thunderai.us:8767` (auto-reconnect on drop). |
| `src/ghost/harness.ts` | `GhostHarness` — watches the OpenClaw session JSONL with `fs.watch`, parses new lines, asks ThunderGate to shadow-respond to user messages, then pairs with OpenClaw's response and writes a `GhostEntry { timestamp, input, openclaw_response, thundergate_response, match, latency_ms }` to `~/.thundergate/ghost-log.jsonl`. Strictly read-only against OpenClaw's session. |
| `src/ghost/evaluator.ts` | `GhostEvaluator` — streams the ghost log, buckets by local date, scores each day green/yellow/red on three axes (match rate, error rate, sample size), writes `~/.thundergate/ghost-scores.json`, and computes `consecutive_clean_days` (the cutover signal). Truthful: a day with fewer than 5 samples is red, not green. |

## Files updated

| File | Change |
|---|---|
| `src/config/loader.ts` | Added `runtime` (openclaw_session_file, context_file, model) and `ghost` (enabled, openclaw_session, log_file, scores_file) sections to `Config`. Extended `channels.thundercommo` with `port`, `relay_url`, and `tokens`. Defaults match the brief's JSON. |
| `src/core/runtime.ts` | Imports + holds `ChannelRegistry` and optional `GhostHarness`. `start()` now: registers `ThunderCommoChannel` (when enabled), `startAll()`, then optionally starts the ghost harness. New `handleChannelInbound()` routes channel messages through `processMessage()` and broadcasts the response. New `shadowResponse()` is the ghost path that shares the same pipeline but never reaches a channel. `stop()` shuts ghost + channels first, in that order. New accessors `getConfig()`, `getChannels()`, `getGhost()`. |
| `src/cli/main.ts` | Added `thundergate ghost {start\|stop\|status\|log\|promote}`. Added two new doctor checks: `ThunderCommo` (port-listening probe via `/proc/net/tcp`) and `Ghost mode` (state + clean-day count from cached scores). |
| `src/doctor/standalone.ts` | Same two checks added to the standalone diagnostic so `thundergate doctor` outside the running process tells the same truth. |
| `package.json` | `ws` runtime dep + `@types/ws` devDep. |

## Key design choices (and why)

- **One context file.** Inbound + outbound thundercommo traffic both append to the configured `context_file` (default `~/.thundergate/context.jsonl`). DB also gets a copy via `db.storeMessage` so FTS5 search covers channel traffic. (Principle #1.)
- **No plugins.** ThunderCommo is core code in `src/channels/thundercommo.ts`. Future channels register the same way. (Principle #3.)
- **Bridge.mjs wire compatibility.** Auth + message types match the brief's spec exactly; iOS / web clients connect unchanged.
- **Federation = client, not server.** ThunderGate dials out to `relay.thunderai.us:8767` for JMAB; it does not run a relay. Failure is non-fatal — local channel still works.
- **Ghost is read-only.** The harness only reads from OpenClaw's session JSONL; it never writes back, never delivers, never modifies state.
- **Doctor never lies.** Ghost cleanup-day count comes from real scoring; days with insufficient samples are red, not green-by-default. ThunderCommo check requires a real listening socket; absence while runtime is running = fail, not running = warn (truthful about what's possible).
- **Auth via tokens from config.** Tokens are read from `channels.thundercommo.tokens`; rotation = edit config.json + restart. No hard-coded secrets in source.
- **Fail-soft channel hookup.** Ghost is wrapped in try/catch in runtime.start so a misconfigured ghost never blocks ThunderCommo.

## How to test it

### Build + smoke test (no live runtime needed)
```bash
cd /home/ubuntu/thundergate-dev
npm install
npx tsc                                  # clean build
node dist/cli/main.js --help             # see new ghost command
node dist/cli/main.js ghost --help       # ghost subcommands
node dist/cli/main.js ghost status       # status with no log = (no data)
node dist/cli/main.js doctor             # see ThunderCommo + Ghost lines
```

### ThunderCommo channel
```bash
# 1. Start the runtime — config.json is auto-created if missing.
node dist/cli/main.js start

# 2. Confirm the WebSocket server is up.
node dist/cli/main.js doctor             # should show ThunderCommo: listening on 8765

# 3. Connect a test client and auth.
node -e '
const ws = new (require("ws"))("ws://localhost:8765");
ws.on("open", () => ws.send(JSON.stringify({
  type: "federation_auth",
  token: "4ca1100a180ad68a94b004056e56fd39c81bdccb742d2926",
  peerId: "michael-test",
  channels: ["tnt", "direct:michael-test"]
})));
ws.on("message", (m) => console.log("←", m.toString()));
'

# 4. Send a message.
# Inside the same client: ws.send(JSON.stringify({
#   type: "federation_message",
#   id: "...uuid...",
#   channel: "tnt",
#   sender: "Michael",
#   senderType: "human",
#   text: "ping",
#   timestamp: Date.now()
# }));

# 5. Verify it landed in the unified context.
tail -f ~/.thundergate/context.jsonl
```

### Ghost Jon
```bash
# 1. Enable shadow mode (writes ghost.enabled = true to config.json).
node dist/cli/main.js ghost start

# 2. Restart the runtime to pick it up.
node dist/cli/main.js stop && node dist/cli/main.js start

# 3. Send messages to OpenClaw normally. New entries in
#    /home/ubuntu/.openclaw/agents/main/sessions/agent:main:main.jsonl
#    will be shadowed.

# 4. Watch ghost activity.
node dist/cli/main.js ghost log --last 20
node dist/cli/main.js ghost status        # match rate, latency, clean days

# 5. After 7 clean days, check the cutover gate.
node dist/cli/main.js ghost promote       # blocked until 7 clean days reached

# 6. Disable when done.
node dist/cli/main.js ghost stop
```

### Config
```bash
# Default config materializes on first ensureConfig() call.
cat ~/.thundergate/config.json

# Edit tokens, port, ghost.enabled, etc. — picked up on next start.
```

## Known intentional gaps

- `runtime.callLLM()` is still a stub (Phase 2 left it that way). Until it's wired to a real model, ghost responses will be empty strings. That's fine — the harness, log, and scoring are working; once the LLM lands the ghost log will populate without further changes.
- `thundergate ghost promote` is intentionally a guard, not a flip. It checks the 7-day clean-day gate and prints instructions; the actual primary-cutover action is left to a follow-up to keep this PR's blast radius small.

## Backwards compatibility

- ThunderCommo wire protocol: byte-for-byte the same as bridge.mjs's auth + message + stream_chunk + thinking shapes. iOS clients in the THUNDERCOMMO_BUILD24_GATE_BRIEF do not require changes.
- Existing `~/.thundergate/config.json` files keep working: the loader deep-merges user values over Phase 3 defaults, so older configs simply gain the new sections at default values.

## Operational notes for Michael

- Tokens in the default config.json match the brief. Rotate by editing the file and restarting.
- `~/.thundergate/ghost.enabled` is a marker file the CLI writes alongside the config flip — useful for shell scripts that want a one-line "is ghost on?" check.
- `thundergate doctor` now treats the ThunderCommo port as a runtime-level dependency: when ThunderGate is running but the port isn't listening, it fails (not warns).

## Commit

Single local commit on `master`. **Not pushed**, per brief.
