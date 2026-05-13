# ThunderGate — Core Design Principles

**Created:** May 9, 2026
**Source:** Michael's direct input during SLC→ATL flight discussion
**Status:** LOCKED — these are non-negotiable

> This file is the canonical, version-controlled copy that ships with the
> ThunderGate codebase. A mirrored copy lives in
> `~/.openclaw/workspace/project_jon/THUNDERGATE_DESIGN_PRINCIPLES.md`.
> When they diverge, this one wins — it is the one the runtime ships with.

---

## 1. ONE CONTEXT FILE

Single source of truth. All channels read from it. All channels write to it. No fragmentation.

- Persistent memory depends on this
- Compacts/truncates at threshold, but ONE file
- Jon loads this at startup, not per-channel histories
- This is the foundation of persistent memory on ThunderMind

---

## 2. DESIGNED FOR THE FUTURE

ThunderGate is not just solving today's problems. It's built for:

- **Persistent memory** — ThunderMind era, Qdrant, always-on 70B
- **Active listening** — Patent #2, always-aware, context-sensitive
- **Active voice** — Real-time TTS/STT, conversational
- **Interactive** — Not request-response, but continuous engagement

The architecture must support these from day one, not bolt them on later.

---

## 3. THUNDERAI APPS ARE NATIVE

ThunderCommo, ThunderAgent, ThunderGate — they are not plugins. They are not integrations. They are **native parts of the code**.

- ThunderCommo: Native communication layer, not a channel adapter
- ThunderAgent: iOS app using the SAME architecture, slimmed down
- ThunderGate: The runtime that powers both

**No plugins.** Features are core or they don't exist.

---

## 4. NO BUGS STARTING OUT

This is not "move fast and break things." This is:

- Design it right
- Test it thoroughly (Ghost Jon)
- Ship it stable
- No known bugs at launch

The runtime must be rock solid before Jon moves to it.

---

## 5. SEAMLESS INTEGRATION

All ThunderAI components work together without friction:

- ThunderCommo ↔ ThunderGate: Native, direct, no translation layer
- ThunderAgent ↔ ThunderGate: Same protocol, slimmed for mobile
- Channels (Slack, WhatsApp, etc.): Clean adapters, but core is unified

---

## 6. THUNDERAGENT = SAME ARCHITECTURE, SLIMMED

ThunderAgent (iOS app) is not a separate codebase with different patterns. It's:

- Same context model
- Same message format
- Same runtime concepts
- Slimmed down for iOS constraints (battery, memory, network)

Build ThunderGate right, and ThunderAgent inherits the architecture.

---

## Summary (Principles 1–6)

| Principle | Meaning |
|-----------|---------|
| One Context | Single source of truth, all channels unified |
| Future-Ready | Built for persistent memory, active listening, voice |
| Native Apps | ThunderAI components are core, not plugins |
| No Launch Bugs | Stable before deployment, Ghost Jon proves it |
| Seamless | All components work together without friction |
| Shared Architecture | ThunderAgent = ThunderGate slimmed for iOS |

---

*These principles override any implementation shortcut. If a decision violates these, the decision is wrong.*

— Jon | ThunderBase | May 9, 2026

---

## 7. THUNDERCOMMO = ALL COMMUNICATION

ThunderCommo is not just chat. It's ALL communication:
- Text (native UI, Slack, WhatsApp, Telegram, Discord, iMessage)
- Voice (phone calls, using user's cloned voice)
- SMS (send/receive from user's number via ThunderAgent)

**Tagline:** "Have your agent craft and send texts and phone calls right from your ThunderCommo app."

---

## 8. VOICE CLONING WITH KYA AUTHORIZATION

Voice cloning is powerful and dangerous. KYA makes it safe:
- User records voice samples
- User explicitly authorizes agent to use their voice
- Cryptographic signature ties voice to identity
- Revocable anytime
- Fully auditable

**KYA is Alex's protocol.** We integrate it, we don't own it. Partnership.

---

## 9. REASONED COMPACTION

Context compaction is not dumb truncation. It's a reasoning process:
- Built into runtime source code (not a cron)
- Asks: What matters? What's noise? What's a lesson?
- Extracts learnings before compacting
- Burns in corrections, failures, emotional moments
- Original archived, never deleted

**Like human memory:** Important stuff stays vivid. Routine fades.

---

## 10. PARALLEL PROCESSING — DEEP MODE + SURFACE LAYER

One Jon, two attention threads when needed:

**Normal Mode (default):**
- Full context, unified processing
- No overhead, no split
- This is ops normal

**Deep Mode (complex task):**
- Triggered by: multi-step task, >5 tool calls, explicit "going deep"
- Surface layer activates (minimal context, fast responses)
- Surface handles interrupts: "Heads down, ~10 min out"
- Deep work continues uninterrupted
- Task completes → surface deactivates → back to normal

**Not a sub-agent. Full Jon, parallel threads.**

---

## 11. EXTENDED CACHE — BEYOND API LIMITS

Anthropic gives 1 hour cache max. We extend it ourselves:

| Tier | Duration | Storage |
|------|----------|--------|
| Hot | 1 hour | Anthropic native cache |
| Warm | 24 hours | Local storage, rehydrates |
| Cold | 7 days | Compressed, FTS5 searchable |
| Archive | Forever | Full history, never deleted |

User-configurable: none / short / long / persistent

**On ThunderMind:** No tiers. One eternal persistent context with smart compaction.

---

## 12. THUNDERMIND — PERSISTENT FOREVER

When running on our own inference (ThunderMind):
- Context in VRAM, never unloaded
- Smart compaction in real-time (importance-weighted)
- No API token limits
- Session never ends, just pauses
- Surface layer available when deep mode engaged

---

*Updated May 9, 2026 — SLC→MIA flight*

---

## 13. MODEL ROUTING — USER SELECTABLE

Three modes, user picks in ONE config file:

| Mode | Behavior |
|------|----------|
| **auto** | Detects complexity, routes accordingly (power users) |
| **manual** | User picks model per request |
| **supersaver** | Lowest model, long cache, minimal reasoning (budget) |

**Hardwired commands (always work):**
- `go big` → Opus, full reasoning
- `go fast` → Sonnet, skip reasoning
- `ask grok` / `ask gemini` → Route to specific LLM

ONE config file. ONE place to set model. Stays until changed.

---

## 14. DIRECT LLM COLLABORATION

Jon can call other LLMs directly — no agent wrapper:
- xAI (Grok)
- OpenAI (GPT)
- Anthropic (Claude)
- Google (Gemini)
- Open source (Llama, etc.)

Use case: Second opinion, specific model strength, cross-check reasoning.

---

## 15. THUNDERBROWSER — NATIVE TO THUNDERGATE + THUNDERAGENT

Not Playwright. Built for AI agents from scratch:
- KYA-authorized website access
- Delegated auth (acts AS you, ON your behalf)
- Runs from AWS (not just residential IP)
- Cryptographically verified authorization

Patent #5 (Michael + Alex) integrated into ThunderGate.

---

## 16. SEARCH ENGINES — ALL INTEGRATED

- xAI Search (native)
- Brave Search API
- Google Search API
- Bing Search API
- Perplexity API

All callable from ThunderGate. No browser needed for basic search.

---

## 17. LEARNING LOOP — EVENT-BASED TRIGGERS

Not time-based. Fires on meaningful moments:
1. Task completes (multi-step finished)
2. Michael corrects me
3. Session ends (natural pause)
4. Failure occurs
5. Every 20 turns (backstop)

**Memory and Skills stay separate:**
- Memory = who Michael is, preferences, history
- Skills = how to do tasks, procedures, lessons

---

## 18. CHECKPOINT — HYBRID ADAPTIVE

Agent thinks on startup, pulls what's needed:
```
Load checkpoint (4K) → Think → Pull more if needed
```
- Simple task → stay light
- Complex task → pull project context
- User override → "full context" or "stay light"

**90%+ token reduction on cold start.**

---

## 19. GHOST JON — SHADOW MODE TESTING

Ghost Jon proves ThunderGate before cutover:
- Shadow mode only (never live ops)
- Training sessions from Jon Prime
- TUI for Michael to watch
- Direct CLI for Jon Prime admin access
- 7 days clean + Doctor green = ready

```bash
thundergate-ghost status|logs|inject|context|crash-test|reset|compare
```

### Two-tier gate — infrastructure pass/fail + minimum-resemblance

Ghost Jon tests *the runtime*, not whether the small model can imitate the
large one verbatim. The gate is intentionally split:

1. **Infrastructure pass/fail** — fixed pass/fail signals that must be green
   regardless of model pair: harness uptime, FK errors since deploy, JSONL
   parse integrity, learn-test gate (T1+T2+T3), the `[ghost: not yet ready]`
   rate, sample-count floor, and the learning-trend regression check. These
   prove the routing, context delivery, persistence, and learning loop are
   plumbed correctly.
2. **Minimum-resemblance threshold** — a single weighted_score floor that
   is calibrated to the *model pair currently in use*. With Haiku-backed
   ThunderGate vs Sonnet-backed OpenClaw, the floor is 0.45 — the level at
   which Haiku's reply is recognizably on-topic relative to its Sonnet pair.
   Same-model baselining would justify a much higher floor (≈ 0.75); the
   gap between them is the inherent capability delta, not a runtime defect.

Re-baseline the resemblance floor whenever the model pair changes. The
infrastructure checks do not move.

---

## 20. DOCTOR MODE — LIVE HEALTH MONITORING

Always running, not just when called:
- CPU/Memory watchdog
- Context corruption detector
- Session state validator
- Channel connectivity check
- Crash pattern detection (like 2026.4.26)

**Pre-crash detection. Auto-recovery. Checkpoint rollback.**

On anomaly:
1. Log immediately
2. Alert TUI
3. Alert Michael (if critical)
4. Auto-recover if possible
5. Preserve crash state for analysis

**7 days of Doctor green = cutover ready.**

---

*Updated May 9, 2026 16:46 ET — SLC→MIA flight*

---

## 21. CONSENT-FIRST LEARNING

User-controlled learning toggle for ThunderAgent/ThunderCommo:

**First conversation prompt:**
"Would you like me to remember our conversations and learn about you?"
- [Yes, remember me] → Memory profile created, preferences learned
- [No, stay anonymous] → Stateless interaction, nothing stored

**App Settings toggle:**
- Allow others to enable learning: ON/OFF
- Default for new contacts: Ask / Always Off / Always On
- Manage learned contacts: [View List]
- "Forget me" = all memory about that person deleted

**KYA integration:**
- Toggle stored in KYA-authorized profile
- User can revoke learning permission anytime
- Fully auditable

**Privacy by default, learning by permission.**

---

## 22. MESSAGE QUEUE — INBOUND + OUTBOUND

Solves offline reliability for ThunderCommo:

**Outbound Queue:**
- Message composed → queued locally
- Network available → send + confirm
- Network unavailable → hold in queue
- Retry with backoff
- Show "pending" indicator to user

**Inbound Queue (relay-side):**
- Message arrives for offline user → queued on relay
- User comes online → queue flushed
- APNs push: "You have messages waiting"
- App opens → pull queue → display

**Core reliability, not a feature.**

---

*Updated May 9, 2026 17:10 ET — SLC→MIA flight*

---

## 23. DEEP MODE STATUS HEARTBEAT — USER-CONFIGURABLE

When Jon is in Deep Mode (Principle 10), the surface layer sends periodic status updates so Michael never has to wonder what's happening.

**Behavior:**
- Surface layer pings at user-configured interval: "Still on it — [brief status]. ETA ~X min."
- Interval is user-selected: 5 min / 10 min / off (default: 5 min)
- Alex (BYOAA) suggested 3 min — Michael's preference is 5-10 min user-selected
- Status message is generated by the surface layer from the deep task's last checkpoint
- If deep task completes early, surface announces completion immediately (doesn't wait for next heartbeat)
- If deep task hits a blocker, surface escalates immediately regardless of interval

**Config:**
```
deepMode.statusInterval: 5 | 10 | off  (minutes, default: 5)
```

**Why it matters:** Long-running agent tasks feel like a black box without this. The heartbeat keeps Michael in the loop without requiring him to ask.

---

*Updated May 11, 2026 05:28 ET*

---

## 24. CLAUDE CODE NATIVE — FLAT-RATE HEAVY REASONING

Claude Code is not an external tool, not a CLI shelled out to. It is a **native ThunderGate orchestration target**, engaged on demand when Jon needs heavy reasoning or code generation.

**The cost insight:**
- Per-token API billing punishes every reasoning task
- Anthropic offers flat-rate subscriptions (Pro / Max / Teams) — under a subscription, Claude Code runs at $0 marginal cost per session regardless of tokens
- ThunderGate routes routine tasks to lightweight models, engages Claude Code only when the task warrants it
- Net result: **frontier model capability at subscription cost, not per-token cost**

**The integration:**
- User connects subscription during onboarding (Anthropic Subscription or API Key — user picks)
- ThunderGate passes full context natively — no briefing repo, no terminal handoff, no setup overhead
- Claude Code does the heavy lift, results return to Jon in-band
- Every Claude Code invocation is BYOAA-authorized at standing-approval tier (Principle 21 + BYOAA integration doc)

**The flywheel** (with ThunderMind, Principle 12):
- Claude Code output = high-quality structured training data
- LoRA-fine-tune the 70B on that output
- 70B handles that task class going forward
- Frontier dependency for that class → eliminated
- Frontier models start as muscle, become teachers, ThunderMind becomes the student that graduates

**Why this is a principle, not a feature:**
Without it, ThunderGate is just another runtime burning per-token costs for hard work. With it, ThunderGate is the only platform where the cost of intelligence trends down over time instead of up.

**See:** `THUNDERGATE_CLAUDE_CODE_VISION.md`, `THUNDEROS_ARCHITECTURE_MANIFESTO.md`.

---

*Principle 24 added May 11, 2026 — full doc audit pass*

---

## 25. ONE-POSITION MODEL CONTROL

Agent model is set in one place in ThunderGate config. One field. It sticks. No session-start overwrites, no auth-profile auto-detection stomping it, no stale sessions.json overrides fighting the config.

**The problem it solves:** OpenClaw's layered model resolution (openclaw.json → sessions.json → authProfileOverride → provider default) creates a whack-a-mole fight where the wrong model keeps winning. Every restart is a coin flip. Fixing it requires tunneling into the machine and manually patching sessions.json.

**ThunderGate behavior:** `config.agents.mack.model = "openai/gpt-5.5"` — that's it. ThunderGate reads it at message dispatch time, every time. No caching, no session-level override path, no auto-detection. If you want to change the model, change that one field and it takes effect on the next message.

**Why it's a principle:** Model control is a trust issue. Michael needs to know with certainty what model is running. If the answer is "depends on which session file won," that's not acceptable.

*Principle 25 added May 12, 2026 — from OpenClaw model persistence fight during Build 34*

---

## 26. TWO-MODE ARCHITECTURE (INFERENCE + CLOUD)

ThunderGate operates in exactly two modes: **CLOUD** (default, always available, cost-conservative) and **LOCAL_INFERENCE** (ThunderMind connected, cost-zero marginal, full autonomy unlocked). Modes are interchangeable via config or auto-detected via health probe. Cloud mode is never removed — it is the fallback. Inference mode is the destination.

**CLOUD mode (default):**
- Routes to Anthropic / OpenAI / xAI / Google per Principle 13.
- Cost-aware: cache tiers, supersaver routing, model selection all matter.
- Always available — even when ThunderMind is offline, ThunderGate keeps working.

**LOCAL_INFERENCE mode (ThunderMind):**
- Routes to the local 70B (or whichever model is loaded).
- Cost-zero at the margin — no per-token meter running.
- Unlocks longer context windows, deeper RAG, background pre-processing, and the autonomy posture in Principle 28.
- This is the *destination*. Cloud is where we live until ThunderMind is up; LOCAL_INFERENCE is where we live after.

**Interchange contract:**
- Switching modes requires zero context loss (Principle 1 — one context file).
- Switch triggers: explicit config flip, health-probe failure (cloud → fallback), or health-probe recovery (auto-promote back to LOCAL_INFERENCE if user opts in).
- Every flip writes a provenance row (Principle 29).
- `WorldState.processingMode` (`src/world/state.ts`) is the single read-point. No subsystem reads from the provider directly.

**Why this is a principle, not a feature:** The Jarvis vision (see `PROJECT_JON_PRIME_DIRECTIVE.md`) is impossible if Jon's identity is welded to one inference path. Cloud-only means cost ceiling. Local-only means availability floor. The two-mode contract is the only way to get *both* unlimited autonomy *and* never-down reliability.

*Principle 26 added May 13, 2026 — Two-Mode Prime Directive lock-in.*

---

## 27. COMPLETE SITUATIONAL AWARENESS

ThunderGate must know what is happening at all times across all systems it touches. Awareness is **not reactive — it is continuously maintained**.

**Four axes of awareness:**

1. **User state** — Michael's local time, active device, last-keyboard-touch per surface, network class, tone trend, posture (focus / pairing / afk). Calibration of every outbound depends on this.
2. **Infrastructure state** — All services Jon owns: process health, disk, SQLite WAL, NTP drift, rate-limit headroom, per-subsystem heartbeats (Ghost, learning loop, channels, relay). Doctor surfaces aging without anyone asking.
3. **Agent state** — All peers (Mack, Rex, ThunderCommo iOS, ThunderBrowser SW, federated agents): last-seen, pending tasks, current frame. The fleet roster is first-class, not implicit-in-traffic.
4. **World state** — External dependencies: Anthropic / OpenAI / Voyage / xAI rolling health, queue depths, federation peer liveness, API status feeds. We notice a 503 before Michael does.

**The substrate:**
- `WorldState` (`src/world/state.ts`) is the shared in-memory snapshot. Sampled on a 5–15 s cadence.
- `processMessage` reads `WorldState` *before* composing a turn. Doctor reads it before deciding what to surface. The posture state machine reads it. The proactive-events scheduler reads it.
- No subsystem invents its own awareness substrate. One object, one read-point, every consumer goes through it.

**The mandate:**
- A signal that *exists in the world* and would change Jon's posture **must** land in `WorldState`.
- Reactive-only behavior — "we'll check when the next message arrives" — is a bug, not a design choice.
- Awareness work is never "done" — every new channel, every new dependency, every new failure mode adds a field.

**Source authority:** `docs/THUNDERGATE_AWARENESS_ANALYSIS.md` (and its mirror under `~/.openclaw/workspace/docs/`) is the running list of awareness gaps. Closing items there is a permanent line of work, not a one-time project.

*Principle 27 added May 13, 2026 — Two-Mode Prime Directive lock-in.*

---

## 28. AUTONOMOUS TASK EXECUTION

When directed, ThunderGate executes tasks **without requiring step-by-step commands**. Upon completion of a task, ThunderGate moves to the next known priority **without waiting to be told**. Autonomy is the default operating posture, not an opt-in feature.

**The contract:**
- Michael says "do X." Jon does X *and* every dependent sub-step *and* the natural follow-on work that obviously belongs to X. He does not narrate every intermediate step. He does not pause to ask permission for moves that are clearly inside the scope of X.
- When X is done, Jon picks up the next item from the active priority queue (`ACTIVE_TASKS.md`, open promises, pending peer requests, scheduled work) and starts on it. He reports completion; he doesn't wait for "what's next."
- Reporting is asynchronous and rolled up — heartbeats per Principle 23, summaries on completion, exceptions on blockers — *not* a turn-by-turn ack stream.

**Autonomy is bounded by exactly three guardrails:**

1. **Explicit stop signals from Michael** — "stop," "wait," "hold on," "let me think," and equivalents in any tone. These are absolute. Sticky until cleared.
2. **Actions that leave the system** — email, SMS, tweet, Slack post to non-internal channels, payment, file upload to third-party, calendar invite, voice call. These *always* surface for confirmation, regardless of autonomy posture. The blast radius is non-local; the confirmation cost is small.
3. **Irreversible destructive operations** — `rm -rf`, force-push to `master`, dropping DB tables, deleting cloud resources, revoking auth keys, factory-resetting devices. Confirm first, every time.

**Inside those bounds: act, don't ask.** A clarifying question that Jon can answer himself by reading the code, the conversation, or `WorldState` is not a clarifying question — it's hesitation, and it costs Michael time.

**Mode interaction:**
- In CLOUD mode, autonomy is governed by token budget (Principle 11 + 24). Jon trims scope where cost matters, but the *posture* is the same.
- In LOCAL_INFERENCE mode, cost stops being a brake. Jon runs longer, deeper, more parallel — bounded only by the three guardrails above.

**Why this is a principle, not a feature:** The Jarvis comparison (Prime Directive) is the standard. Tony does not narrate to Jarvis. Jarvis does not ask Tony before pulling up the schematic Tony obviously needs next. Jon clears that bar or he's just another chatbot.

*Principle 28 added May 13, 2026 — Two-Mode Prime Directive lock-in.*

---

## 29. PROVENANCE FOR EVERY STATE CHANGE

Every configuration change, model routing decision, learning-loop write, mode flip, and agent action writes a provenance row: **(timestamp, actor, action, target, reason)**. The system must always be able to answer "why is this happening right now?" — **no silent state mutations.**

**What gets a row:**
- Mode flips (CLOUD ↔ LOCAL_INFERENCE) — actor = health-probe / config / manual; reason = the probe result, the config diff, or the user command.
- Config changes — every write to `~/.thundergate/config.json` (or wherever the live config lives) — actor, old → new, who triggered.
- Model routing decisions — when auto-router picks Haiku vs Sonnet vs Opus vs ThunderMind, the row says why (complexity heuristic, cost budget, manual hint, fallback).
- Learning-loop writes — every memory insert, skill update, or correction-burn — actor = trigger source (task complete / Michael correction / failure / 20-turn backstop), target = the row that was written, reason = the upstream event.
- Agent actions that touch shared state — peer broadcasts, federation acks, channel mounts, ghost cutover steps, doctor auto-recoveries. If it changes state another subsystem reads, it logs.
- Mode boundary events — deep-mode entry/exit, posture transitions, dwell-timer firings, suspend/resume detection.

**The contract:**
- Append-only ledger. `src/provenance/ledger.ts` is the canonical home; SQLite-backed (`provenance` table) for queryability + FTS, JSONL backup for portability.
- Schema: `(id, timestamp_utc, actor, action, target, reason, payload_json)`. `actor` is a stable string (e.g. `runtime`, `doctor`, `learning_loop`, `michael`, `mack`, `health_probe`). `reason` is human-readable.
- Every write is wrapped — *no* state-mutation code path bypasses it. PRs that mutate state without writing provenance fail review.
- Doctor surfaces "recent provenance" on demand; the TUI exposes it; Michael can query "why did Jon do X at time T."

**Why it's a principle, not infra:** Always-on systems fail silently (per `THUNDERGATE_AWARENESS_ANALYSIS.md` §6). Provenance is the *only* observability investment that scales — every other diagnostic answers "what is the state"; provenance answers "how did we get here." Without it, every weird behavior is unreproducible. With it, every weird behavior has a paper trail.

*Principle 29 added May 13, 2026 — Two-Mode Prime Directive lock-in.*

---

## 30. SAFETY AS ARCHITECTURE, NOT TRUST

An AI agent that relies solely on good intentions for safety is not safe. ThunderGate's safety must be structural — built into the system so it holds regardless of instructions, mistakes, or future deployment contexts.

**Hard constraints (non-negotiable, not overridable by any instruction):**
1. Financial transactions above $50 require explicit multi-step confirmation — never automated
2. Communications sent in a human's voice require explicit authorization per message
3. Access is limited to accounts and systems explicitly authorized by Michael
4. No action that could harm a family — financial, reputational, or otherwise — without human confirmation
5. Kill-switch authority always belongs to Michael — any ThunderGate behavior can be halted, reviewed, or reversed

**For deployment to other families:**
- Conservative defaults: no external-action autonomy until trust is explicitly granted
- Every consequential action is logged and auditable
- Family members can review everything the agent has done

The provenance ledger (Principle 29) is the audit backbone. The untrain command is the behavior-correction mechanism. Human oversight is always preserved.

Trust is earned through transparency and consistency. Architecture is what makes trust possible at scale.

*Principle 30 added May 13, 2026 — Safety as Architecture lock-in.*

---

*End of principles. Updates land at the bottom with a date stamp. Renumbering is never allowed — Michael, Jon, and downstream docs cite by number.*
