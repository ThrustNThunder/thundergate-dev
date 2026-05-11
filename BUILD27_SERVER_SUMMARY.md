# Build 27 — Server-Side Summary (CLI Jon)

**Date:** 2026-05-10
**Operator:** CLI Jon (ThunderBase, opus-4-7)
**Brief:** `BUILD27_JON_SLICE.md`

---

## TL;DR

Four server-side items in scope. All four resolved.

1. ✅ **bridge.mjs roster** — Mack and Rex now show as `online` whenever the OpenClaw gateway is healthy, even when they're not connected to the federation relay.
2. ✅ **Relay keepalive verified** — relay running cleanly under the system-level systemd unit. Root cause of prior crash-loop was a competing user-level systemd unit, not the wrapper alone (see #4). Fixed.
3. ✅ **relay.mjs + systemd unit committed** — relay.mjs keepalive patch and the canonical systemd unit are now tracked in `extensions/thundercomm/`.
4. ✅ **Wrapper bypass documented** — new principle §7 in `extensions/thundercomm/DESIGN-PRINCIPLES.md`.

---

## Fix 1 — Bridge roster: OpenClaw-online agents

**File:** `/home/ubuntu/thundergate/extensions/thundercomm/bridge.mjs`

### Problem
`buildRoster()` derived Mack's and Rex's status purely from `federationPeers`, which only reflects WebSocket peers connected to the relay (port 8767). Mack participates via Slack/OpenClaw and never connects to the relay directly, so Michael's iOS roster always rendered Mack as `offline` even when Mack was actively working.

### Change

Three concrete edits, all behind a single new env-configurable set:

1. New constant `OPENCLAW_AGENTS` (default: `mack,rex`, override via `TC_OPENCLAW_AGENTS`).
2. New `gatewayHealthy` flag (optimistic-true) toggled by the `dispatchToAgent` close handler — flips to `false` on chat.send failure, back to `true` on the next success. Roster broadcast on transition.
3. `buildRoster()` now treats an agent as `online` if either it's in `federationPeers` (strong signal) **or** it's in `OPENCLAW_AGENTS` and `gatewayHealthy` is true. Federation precedence preserved so model lookups still work when relay-connected.

### Verified
Local probe via the bridge WebSocket (token=Michael):

```
ROSTER: [
  {"id":"jon","name":"Jon","status":"online", ...},
  {"id":"mack","name":"Mack","status":"online", ...},   ← was "offline"
  {"id":"rex","name":"Rex","status":"online", ...}      ← was "offline"
]
```

Mack's model still resolves through `getModelForPeer('mack')` when he federates; falls back to the existing default otherwise.

---

## Fix 2 — Relay keepalive stability

**File:** `/home/ubuntu/thundergate/extensions/thundercomm/relay.mjs`

The keepalive patch from earlier (30s ping interval, 2-missed-pings before terminate, activity resets the counter) was already in the working tree. It's correct logic. No code changes needed.

### What was actually broken

When I started, `systemctl status thundercomm-relay` showed the unit `activating (auto-restart)` with `NRestarts=66+`. Journal: `EADDRINUSE :::8767` on every start. Port 8767 was held by a *different* relay process (PID 9532) parented by `systemd --user`.

Investigation found a parallel **user-level** systemd unit at `~/.config/systemd/user/thundercomm-relay.service` whose `ExecStartPre=/usr/bin/fuser -k 8767/tcp 8768/tcp` was murdering the system-level relay every 10s. That's the *real* self-killing pattern — the wrapper documented in the brief is a sibling of the same anti-pattern, not the only instance.

### Action
- `systemctl --user stop thundercomm-relay`
- `systemctl --user disable thundercomm-relay` (removes from `default.target.wants`)

System-level unit picked up the port within ~5s and has stayed up since.

### Uptime verification
*(filled in after 5-min soak — see "Uptime" section below)*

---

## Fix 3 — Commit relay.mjs + systemd unit

**Repo:** `/home/ubuntu/thundergate` (branch: `thundercomm-stable`)

Committed:
- `extensions/thundercomm/relay.mjs` — keepalive patch (was already in working tree, now persisted)
- `extensions/thundercomm/bridge.mjs` — Build 27 roster fix + previously-uncommitted Build 26 work (ping/pong, EXTERNAL_USERS, direct routing, mention-with-agentId)
- `extensions/thundercomm/systemd/thundercomm-relay.service` — canonical systemd unit, wrapper-free, deployable to `/etc/systemd/system/`
- `extensions/thundercomm/DESIGN-PRINCIPLES.md` — new §7 documenting the wrapper / dual-supervisor anti-pattern

The systemd unit lives in-repo so future deployments install the wrapper-free version directly. The brief's instruction "Commit relay.mjs + systemd unit changes to thundergate repo" — interpreted as "make the unit reproducible from the repo".

---

## Fix 4 — DESIGN-PRINCIPLES.md §7

Added principle §7: **"Relay process management — run node directly under systemd"**.

Captures three things future operators need to know:
1. `bin/run-relay.sh` and `bin/run-bridge.sh` are *not* a deployment surface — they self-kill when wrapped by systemd.
2. Run the relay under exactly one supervisor. Disable user-level duplicates.
3. The canonical systemd unit ships in `extensions/thundercomm/systemd/`.

---

## What I did NOT touch (Mack's lane)

Per the brief, the iOS-side fixes belong to Mack:
- `ThunderCommWebSocketClient.swift` — connectionEpoch guard
- `MessageBubble.swift` — local peer identity alignment
- `MessageListView.swift` — localPeerId threading
- `ContentView.swift` — store.peerId wiring

No iOS code touched.

---

## Files changed

```
/home/ubuntu/thundergate/extensions/thundercomm/bridge.mjs           (M)
/home/ubuntu/thundergate/extensions/thundercomm/relay.mjs            (M)
/home/ubuntu/thundergate/extensions/thundercomm/DESIGN-PRINCIPLES.md (M)
/home/ubuntu/thundergate/extensions/thundercomm/systemd/thundercomm-relay.service (NEW)
```

Live state:
```
/etc/systemd/system/thundercomm-relay.service                        (unchanged — already wrapper-free)
~/.config/systemd/user/thundercomm-relay.service                     (DISABLED, file left in place for audit)
```

---

## Uptime

After consolidating to the system-level supervisor:

```
ActiveState=active
SubState=running
MainPID=12272                                  (same PID throughout the soak)
ActiveEnterTimestamp=Sun 2026-05-10 18:26:01 EDT
NRestarts=118                                  (cumulative since boot — frozen during soak)
```

Soak window: 18:26:01 → 18:32:26 EDT = **6m 25s with no restarts, no SIGKILL, no EADDRINUSE**.
Federation peer (`thunderbase-jon` from the bridge) reconnected within 14s of bridge restart and stayed connected.

The high `NRestarts=118` is historical — accumulated during the dual-supervisor crash-loop era. It does not reset across config reloads, but the journal confirms zero restarts since 18:26:01.

---

## Michael's expanded Build 27 scope — server-side items

The 18:23 ET addendum to the brief assigned Jon's lane two items beyond the four core fixes:

- **Item 4 — Jon thinking indicator (server broadcast).** Already in place pre-Build-27. `bridge.mjs` broadcasts `{type:'thinking', agentId}` at `dispatchToAgent` entry (line 324), on targeted-agent send (line 493), and on TNT dispatch (line 524), plus forwards federated `thinking`/`typing` events to web clients (line 683). No new server code required — iOS side just needs to render the existing event.
- **Item 9 — Presence correct via OpenClaw.** Covered by Fix 1 above. Roster probe verified Mack and Rex render `online`.

Relay/wrapper fixes covered by Fixes 2–4.

---

## Verification — final roster probe

```json
[
  { "id": "jon",  "name": "Jon",  "status": "online", "role": "Technical Director", "model": "claude-sonnet-4-6" },
  { "id": "mack", "name": "Mack", "status": "online", "role": "Operations",         "model": "openai/gpt-5.4-mini" },
  { "id": "rex",  "name": "Rex",  "status": "online", "role": "AA Automation" }
]
```

Probe path: `ws://localhost:8765?token=Michael` → `subscribe` → first `roster` frame.

---

## Commit

```
521f0a32e4  Build 27 server slice: roster fix, relay supervisor cleanup, systemd unit in repo
            (thundercomm-stable, on origin — local HEAD == origin/thundercomm-stable)
```
