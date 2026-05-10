# ThunderGate Hardening Summary
## Date: 2026-05-10

Five hardening fixes applied per `THUNDERGATE_HARDENING_BRIEF.md`. TypeScript
compiles clean (`npx tsc` → exit 0). One local commit, no push.

## Issue 1 — DB FK error on ghost log writes
**Files:** `src/core/runtime.ts`

Root cause: `shadowResponse()` ran the live `processMessage` → `normalProcess`
→ `learning.onTurn` chain. `TriggerEngine.onTurn` calls
`SessionDB.storeMessage({ sessionId: 'current', ... })`, but no `sessions` row
with id `current` exists, so the FK on `messages.session_id REFERENCES
sessions(id)` failed. The throw bubbled up through `await this.respond(input)`
in the harness and was logged as the literal text
`[ghost error: FOREIGN KEY constraint failed]`.

Fix:
- Added `ghost?: boolean` to the internal `Message` interface.
- `shadowResponse()` now stamps `ghost: true` on the synthetic message.
- `normalProcess()` skips `learning.onTurn` when `message.ghost` is true
  (shadow traffic is not a real session — the JSONL log is the truth seam).
- The remaining `learning.onTurn` call is wrapped in a non-fatal try/catch
  so any future DB hiccup on the live path doesn't replace the model's
  actual response with an error string.

## Issue 2 — Ghost status display
**Files:** `src/cli/main.ts`

The legacy `OpenClaw session: <single-file>` line was already replaced by
`Sessions dir: <dir>` in commit `5ac1f27`. Enhanced the display so it makes
the directory-watching behavior unambiguous:

```
Sessions dir:      /home/ubuntu/.openclaw/agents/main/sessions/
Watching:          42 session file(s)
Watch interval:    2000ms (poll)
```

The watched count is computed by listing `*.jsonl` files in the configured
`ghost.sessions_dir` and falls back to `(dir unavailable)` if the directory
is missing — Doctor must tell the truth.

## Issue 3 — systemd service unit
**File:** `/etc/systemd/system/thundergate.service`

Wrote the unit file. Node lives at `/home/linuxbrew/.linuxbrew/bin/node` on
this instance (not `/usr/bin/node` as in the brief), so `ExecStart`/`ExecStop`
point at the linuxbrew path and `Environment=PATH=...` was added so child
processes can find it.

```ini
[Unit]
Description=ThunderGate Runtime
After=network.target openclaw-gateway.service
Wants=openclaw-gateway.service

[Service]
Type=forking
User=ubuntu
WorkingDirectory=/home/ubuntu/thundergate-dev
Environment=PATH=/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin
ExecStart=/home/linuxbrew/.linuxbrew/bin/node /home/ubuntu/thundergate-dev/dist/cli/main.js start
ExecStop=/home/linuxbrew/.linuxbrew/bin/node /home/ubuntu/thundergate-dev/dist/cli/main.js stop
PIDFile=/home/ubuntu/.thundergate/thundergate.pid
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

`sudo systemctl daemon-reload` was run; `systemctl list-unit-files
thundergate.service` reports the unit loaded and `disabled`. The unit was
intentionally left disabled — enabling and starting it now would race the
already-running manual instance (PID file already populated).

**Operator step to finish:**
```
sudo systemctl stop thundergate  # no-op if not started
thundergate stop                  # stop the manual instance cleanly
sudo systemctl enable --now thundergate
sudo systemctl status thundergate
```

## Issue 4 — Ghost log pairing race
**Files:** `src/ghost/harness.ts`

Root cause: `pairWithOpenClaw()` fired the instant OpenClaw's reply landed.
When `askThunderGate()` was still in-flight (Haiku tail can be >2s), the
`tgResponses` map had no entry yet, so the pair was logged with
`thundergate_response: '[ghost: not yet ready]'` and `latency_ms: -1`. The
LLM later finished and its real response was silently dropped — explaining
why the JSONL "shows real latency" yet the log shows the error string.

Fix: `pairWithOpenClaw()` is now async and polls the `tgResponses` map at
100ms intervals for up to 30s before giving up. If the response lands
during the window the real Haiku reply is logged with its real latency;
if it genuinely times out we still log `[ghost: not yet ready]` (with
`latency_ms: -1`) so the evaluator can see the slowness honestly. The
30s ceiling matches the worst-case Haiku envelope and prevents an
indefinite hold on a stuck request. Errors from the async pairing are
caught at the caller in `drain()` so a single slow pair can't bring the
session watcher down.

## Issue 5 — ThunderCommo channel conflict logging
**Files:** `src/core/runtime.ts`

Replaced the silent `console.warn` after `channels.startAll()` with a
branch that detects `EADDRINUSE`/"address already in use" and emits an
info-level explanation:

```
  ℹ ThunderCommo channel deferred (bridge.mjs owns port 8765 — this is expected in parallel mode)
```

Non-EADDRINUSE errors still log the original warning so unexpected channel
failures aren't suppressed. This means `thundergate doctor` output (and
the runtime boot log) now explains *why* ThunderCommo shows ❌ rather
than leaving the operator to guess.

## Verification

- `npx tsc` → exit 0, no warnings.
- `node dist/cli/main.js ghost status` → shows `Sessions dir` + watched
  file count (42 on this instance) instead of any single-file path.
- `systemctl list-unit-files thundergate.service` → unit present.
- Source paths touched: `src/core/runtime.ts`, `src/ghost/harness.ts`,
  `src/cli/main.ts`.

## Not done

- The service is **not enabled** and the auto-restart path is **not
  verified end-to-end** — leaving that for the operator to avoid racing
  the already-running manual instance.
- Existing ghost log entries with `[ghost error: FOREIGN KEY constraint
  failed]` are not retroactively cleaned. New traffic will log real
  responses; old entries stay as historical truth.
