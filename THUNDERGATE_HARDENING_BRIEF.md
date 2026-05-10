# ThunderGate Hardening Brief
## Date: May 10, 2026
## Priority: Make ThunderGate production-ready for agent migration

Read https://github.com/ThrustNThunder/cli-jon-context for context first.

## Known Issues to Fix

### Issue 1: DB Foreign Key Error on Ghost Log Writes
Ghost Jon processes messages fine (LLM calls work, JSONL log populates) but when 
it tries to write to the session database it fails with "FOREIGN KEY constraint failed".

File: src/ghost/harness.ts — the `pairWithOpenClaw()` method
Root cause: GhostHarness calls `this.respond(input)` which calls `runtime.shadowResponse()` 
which tries to write to the session DB with a parent message ID that doesn't exist.

Fix: In `src/core/runtime.ts`, `shadowResponse()` method — wrap the DB write in a try/catch 
that swallows the FK error silently. The JSONL log is the truth seam; DB write is optional.
Or better: don't attempt to store ghost responses in the session DB at all — they're not real 
session messages. Add a `ghost: true` flag check before DB writes in the message storage path.

### Issue 2: Ghost Status Shows Stale Single-File Path
`thundergate ghost status` shows:
  OpenClaw session: /home/ubuntu/.openclaw/agents/main/sessions/agent:main:main.jsonl
But actual config has sessions_dir watching the whole directory.

Fix: Update `src/cli/main.ts` ghost status display to show sessions_dir instead of the 
legacy single-file path. Read from `config.ghost.sessions_dir`.

### Issue 3: ThunderGate Doesn't Auto-Start on Reboot
After instance restarts, ThunderGate (including Ghost Jon) must be manually started.
Needs a systemd service unit.

Create: /etc/systemd/system/thundergate.service
```
[Unit]
Description=ThunderGate Runtime
After=network.target openclaw-gateway.service
Wants=openclaw-gateway.service

[Service]
Type=forking
User=ubuntu
WorkingDirectory=/home/ubuntu/thundergate-dev
ExecStart=/usr/bin/node /home/ubuntu/thundergate-dev/dist/cli/main.js start
ExecStop=/usr/bin/node /home/ubuntu/thundergate-dev/dist/cli/main.js stop
PIDFile=/home/ubuntu/.thundergate/thundergate.pid
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

After creating: `sudo systemctl enable thundergate && sudo systemctl start thundergate`

### Issue 4: Ghost Log Pairing (input/response mismatch)
Many ghost entries show [ghost error: FOREIGN KEY constraint failed] as the thundergate_response
instead of the actual Haiku response. The LLM call IS working (latency_ms shows real values)
but the response isn't being captured before the pairing happens.

The issue: `askThunderGate()` is async and stores results in `tgResponses` map. 
`pairWithOpenClaw()` fires when OpenClaw's response arrives — if it fires before `askThunderGate()` 
completes, `tg` is undefined and we log `[ghost: not yet ready]`.

Fix: In `pairWithOpenClaw()`, if tg is undefined, wait up to 30s for it to arrive before 
giving up. Use a polling approach or store a promise in the map.

### Issue 5: ThunderCommo Channel Port Conflict Logging
The channel startup non-fatal error is swallowed but should log at info level so doctor 
output explains why ThunderCommo shows ❌ (bridge.mjs already holds port 8765).

Fix: In `src/core/runtime.ts`, after the try/catch for channels.startAll(), log:
`console.log('  ℹ ThunderCommo channel deferred (bridge.mjs owns port 8765 — this is expected in parallel mode)')`

## Output Instructions
1. Fix all 5 issues
2. TypeScript must compile clean after fixes
3. Write the systemd service file to /etc/systemd/system/thundergate.service
4. Commit locally: "ThunderGate hardening: DB fix, status fix, systemd, pairing fix, logging"
5. Do NOT push
6. Write HARDENING_SUMMARY.md with what was fixed

## Test After Fixing
- `npx tsc` clean
- `thundergate ghost status` shows sessions_dir
- Ghost log shows real Haiku responses, not FK errors
- `systemctl status thundergate` shows the unit exists
