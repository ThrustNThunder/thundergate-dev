# ThunderGate Phase 3 — Implementation Brief
## Date: May 10, 2026
## From: Jon | ThunderBase
## To: CLI Jon (ThunderBase instance)

---

## Context
Read the following before starting:
- https://github.com/ThrustNThunder/cli-jon-context (repo context)
- /home/ubuntu/thundergate-dev/src/ (existing Phase 1+2 code)
- /home/ubuntu/.openclaw/workspace/project_jon/THUNDERGATE_RUNTIME_SPEC.md (full spec)
- /home/ubuntu/.openclaw/workspace/project_jon/THUNDERGATE_DESIGN_PRINCIPLES.md (locked principles)

## Phase 1+2 Status (DO NOT regress these)
Already built in /home/ubuntu/thundergate-dev/src/:
- src/core/runtime.ts — core runtime engine
- src/session/database.ts — session persistence (better-sqlite3)
- src/checkpoint/ — checkpoint save/load system
- src/learning/ — learning loop trigger engine
- src/doctor/ — standalone health check
- src/cli/main.ts — thundergate start/stop/status/doctor CLI

## Phase 3 Scope

### Component A: ThunderCommo Native Channel

**Goal:** ThunderCommo connects to ThunderGate as a first-class native channel — no bridge.mjs middleman required. ThunderGate dispatches inbound messages and receives outbound responses through a unified channel interface.

**What this means in code:**
1. Create `src/channels/thundercommo.ts` — ThunderCommo channel adapter
   - WebSocket server on port 8765 (same as bridge.mjs, for compatibility)
   - Handles auth: `{"type": "federation_auth", "token": "...", "peerId": "...", "channels": [...]}`
   - Inbound messages → write to context file (ONE context, per design principle #1)
   - Outbound responses → broadcast to all connected ThunderCommo clients
   - Supports channels: `tnt`, `jmab`, `direct:<agentId>`
   - Relay federation: connects to relay.thunderai.us:8767 for JMAB federation

2. Create `src/channels/index.ts` — channel registry
   - ThunderCommo channel registered here
   - Future channels (Slack, WhatsApp) register here too
   - All channels share ONE context session (design principle #1)

3. Update `src/core/runtime.ts` — wire channels on start
   - When `thundergate start` runs, ThunderCommo channel starts automatically
   - Channel lifecycle tied to runtime lifecycle

**Wire protocol (must match existing bridge.mjs exactly for iOS compatibility):**
```typescript
// Inbound from iOS/web client:
type InboundMessage = {
  type: 'federation_message';
  channel: string;        // 'tnt' | 'jmab' | 'direct:jon'
  sender: string;         // display name
  senderType: 'human' | 'agent';
  text: string;
  timestamp: number;      // unix ms
  id: string;             // uuid, for dedup
  originPeer?: string;
}

// Outbound to iOS/web client:
type OutboundMessage = {
  type: 'message';
  id: string;
  agentId?: string;       // present for agent messages
  sender: string;
  channel: string;
  text: string;
  timestamp: number;
  model?: string;
}

type StreamingChunk = {
  type: 'stream_chunk';
  id: string;
  agentId: string;
  channel: string;
  delta: string;
  timestamp: number;
}

type ThinkingIndicator = {
  type: 'thinking';
  agentId: string;
  channel: string;
}
```

**Design constraints:**
- NO plugins — ThunderCommo is native code (design principle #3)
- ONE context file — all channels write to the same session (principle #1)
- Auth tokens stored in config, not hardcoded
- Federation handled by connecting to relay.thunderai.us, not running a local relay

---

### Component B: Ghost Jon Harness

**Goal:** ThunderGate runs in shadow mode alongside OpenClaw. Same inputs, ThunderGate generates responses but does NOT deliver them — responses are logged to a file for review. After 7 days of clean doctor checks, Michael can flip the switch to make ThunderGate the primary runtime.

**What this means in code:**

1. Create `src/ghost/harness.ts` — Ghost Jon shadow mode
   - Subscribes to OpenClaw's outbound transcript (reads from OpenClaw's JSONL session file)
   - For every message OpenClaw receives, ThunderGate ALSO processes it
   - ThunderGate response is written to `~/.thundergate/ghost-log.jsonl` (NOT delivered)
   - Each ghost entry: `{ timestamp, input, openclaw_response: string|null, thundergate_response: string, match: boolean, latency_ms: number }`
   - `match: true` when ThunderGate and OpenClaw agree on intent/direction (fuzzy — just for review)

2. Create `src/ghost/evaluator.ts` — comparison and health scoring
   - Reads ghost-log.jsonl
   - Scores: latency comparison, response quality (length, relevance heuristics), error rate
   - Writes daily score to `~/.thundergate/ghost-scores.json`
   - Doctor mode reads ghost scores as one of its health signals

3. CLI commands to add:
   - `thundergate ghost start` — start shadow mode
   - `thundergate ghost stop` — stop shadow mode
   - `thundergate ghost status` — show current shadow mode state + scores
   - `thundergate ghost log [--last N]` — tail the ghost log
   - `thundergate ghost promote` — (future) flip ThunderGate to primary

4. Doctor integration:
   - Add ghost health to doctor output: `ghost_mode: running|stopped`, `ghost_days_clean: N`
   - `N >= 7` + all other doctor checks green = cutover ready signal

**OpenClaw session file location:**
`/home/ubuntu/.openclaw/agents/main/sessions/agent:main:main.jsonl`
(Watch this file with fs.watch() for new entries)

---

### Component C: Config System

ThunderGate needs a config file for Phase 3 to work properly.

Create `~/.thundergate/config.json` schema:
```json
{
  "version": "0.1.0",
  "runtime": {
    "openclaw_session_file": "/home/ubuntu/.openclaw/agents/main/sessions/agent:main:main.jsonl",
    "context_file": "/home/ubuntu/.thundergate/context.jsonl",
    "model": "anthropic/claude-sonnet-4-6"
  },
  "channels": {
    "thundercommo": {
      "enabled": true,
      "port": 8765,
      "relay_url": "wss://relay.thunderai.us",
      "tokens": {
        "michael": "4ca1100a180ad68a94b004056e56fd39c81bdccb742d2926",
        "alex": "alex-thundercommo-4a365924ea69066effbb9ed88fead6c7"
      }
    }
  },
  "ghost": {
    "enabled": false,
    "openclaw_session": "/home/ubuntu/.openclaw/agents/main/sessions/agent:main:main.jsonl",
    "log_file": "/home/ubuntu/.thundergate/ghost-log.jsonl",
    "scores_file": "/home/ubuntu/.thundergate/ghost-scores.json"
  }
}
```

Create `src/config/index.ts` — config loader with defaults + validation.

---

## Implementation Order

1. Config system first (everything else depends on it)
2. ThunderCommo channel (the highest-value deliverable)
3. Ghost harness (builds on config + runtime already in place)
4. Wire everything into CLI (thundergate start includes channels, ghost commands added)
5. Update ACTIVE_TASKS.md in cli-jon-context repo with Phase 3 status

## Output Instructions

1. Write all new files directly to /home/ubuntu/thundergate-dev/src/
2. Update existing files (runtime.ts, cli/main.ts) as needed
3. Do NOT run or start anything — just write the code
4. Commit locally: `git -C /home/ubuntu/thundergate-dev commit -am "Phase 3: ThunderCommo native channel + Ghost Jon harness"`
5. Do NOT git push
6. Write a PHASE3_SUMMARY.md to /home/ubuntu/thundergate-dev/ with: files created, what each does, how to test it

## Key Design Constraints (from locked principles)
- NO plugins — ThunderCommo is native core code
- ONE context file — all channels share it
- Backwards compatible with bridge.mjs wire protocol (iOS must still connect)
- Ghost mode is READ ONLY — never delivers responses, never modifies OpenClaw state
- Doctor mode must always tell the truth — no happy-path lying
