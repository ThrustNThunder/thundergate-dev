# ThunderComm Design Principles

**Source:** Burt operational memo (BURT-OC-OPS-MODS-2026-05-06.md) + ThunderComm architecture review
**Date:** 2026-05-05
**Status:** LOCKED — read before touching dispatch, health, or orchestration logic

---

## 1. Dispatch is a truth seam

Outbound dispatch is where the user starts believing something happened.
It is not just formatting. It is not just delivery. It is the moment trust is formed.

**Rules:**
- Write transcript to disk BEFORE broadcast to clients (write-ahead)
- A delivered message ≠ completed work
- Distinguish explicitly:
  - `message delivered` — user received the text
  - `action accepted` — agent acknowledged a request
  - `work in progress` — background execution running
  - `work completed` — verifiable outcome achieved
- Never let a single assistant reply imply all four

**Code implication:** `channel.ts` broadcast fires after transcript append. Never before.

---

## 2. Health must be decomposed — four questions, not one green light

"Connected" is not "healthy." The UI's 🟢/🟡/🔴 indicator must answer four distinct questions:

1. Is the socket connected? (TCP/WebSocket layer)
2. Is the gateway responsive? (gateway process alive and handling requests)
3. Is the session responsive? (agent:main:main is processing turns)
4. Is delivery/replay still functioning? (transcript writes succeeding, broadcast working)

**Rules:**
- A connected socket can represent a stale or broken session
- Watchdog logic tracks all four independently
- 🟢 = all four healthy
- 🟡 = socket connected, one or more of 2-4 degraded
- 🔴 = socket disconnected or multiple layers failing

**Code implication:** `connection-manager.ts` tracks application-level health, not just socket state.

---

## 3. Watchdog design — conservative, inspectable, hysteresis-first

Aggressive health logic creates reconnect churn. We've seen this pattern cause false failures repeatedly.

**Rules:**
- Simple watchdog with hysteresis beats clever eager-reconnect logic
- Minimum stable window before declaring a processor failed: 5 minutes
- Flap detection: 3+ bounces within 10 minutes = sustained outage → escalate
- Single bounce does not trigger failover
- Track `lastInboundAt` separately from socket state
- Be suspicious of any watchdog that infers too much from inactivity alone

**Code implication:** No aggressive reconnect on first miss. Log it, wait, verify, then act.

---

## 4. Parallelism requires explicit state

When multiple agents coordinate through ThunderComm, orchestration truth must be visible.
Conversational continuity is not the same as workflow truth.

**Rules:**
- Multi-agent workflows need explicit state: pending / running / blocked / completed
- Coordination state is not inferred from the last chat bubble
- System events surface orchestration state — not conversation messages
- Parent does not claim success until child work has actually completed or hit a real blocker

**Code implication:** `action_request` and `system_event` message types exist for this reason.
Do not use `message` type for orchestration state. Use the right channel.

---

## 5. Honest completion beats smooth completion

A system that says "still running" truthfully is better than one that sounds polished and lies.

**Rules:**
- Distinguish claimed completion from verified completion
- If something is unverified, the system says so plainly
- Blocker language is explicit and durable — not smoothed over
- Provenance is preserved: who said what happened, when, from what source

**Code implication:** System events and artifact messages carry provenance fields.
Agent responses that represent completed work should be distinguishable from in-progress updates.

---

## 6. Authority is never ambiguous

Every piece of state has exactly one owner. No exceptions.

| State | Owner |
|-------|-------|
| Canonical memory (MEMORY.md, SOUL.md) | BeeKeeper |
| Communication record (transcript) | Gateway (.jsonl on disk) |
| Active session | agent:main:main session key |
| Client connection state | ThunderComm channel (connection-manager.ts) |
| Derived/search index | Qdrant (rebuildable, not canonical) |

**Rules:**
- Channel code is transport. It does not own truth.
- Session key outlives the processor. Never bind "same session" to "same machine."
- If it matters and isn't written to disk, it doesn't exist.

---

## What NOT to build in Phase 1

- Presence/typing indicators (nice, not critical — after transcript correctness is solid)
- Speculative runtime cleverness
- Multi-device semantics that aren't written down first
- Failover logic hidden in too many places
- Anything that makes the codebase hard to explain to a new reader

---

*These principles are derived from operational experience on both the ThunderMind and OAR sides.
They represent lessons learned the hard way — not aspirational guidelines.*

*If you're about to write code that conflicts with one of these rules, stop and explain why first.*
