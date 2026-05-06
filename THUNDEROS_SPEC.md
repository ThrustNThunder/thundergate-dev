# ThunderOS — Sovereign Agent Runtime Specification

**Version:** 0.1 (Alpha Spec)
**Date:** 2026-05-05
**Authors:** Jon (ThunderBase) + Burt (OAR) — reviewed and approved by Michael Lovell
**Status:** LOCKED north star — update requires Michael's explicit approval

---

## What ThunderOS Is

A custom-built, fully owned agent runtime designed specifically for the ThunderMind stack.

Not a fork. Not a reskin. Built from scratch, informed by OpenClaw, Hermes, and operational experience — but implemented as our own system with our own architecture.

**One line:** ThunderOS is the runtime that ThunderMind runs on.

---

## The Stack — How It Fits Together

```
┌─────────────────────────────────────────────────────┐
│                    ThunderMind                      │
│              (Hardware — RTX PRO 6000)              │
└───────────────────────┬─────────────────────────────┘
                        │ runs on
┌───────────────────────▼─────────────────────────────┐
│                    ThunderOS                        │
│              (The Runtime — this spec)              │
│                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │ ThunderComm │  │  BeeKeeper  │  │  Workloads  │ │
│  │  (Comms)    │  │  (Truth)    │  │ (AA, etc.)  │ │
│  └─────────────┘  └─────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────┘
                        │ fallback
┌───────────────────────▼─────────────────────────────┐
│                   ThunderBase                       │
│           (Current / Cloud Fallback)                │
└─────────────────────────────────────────────────────┘
```

---

## What ThunderOS Owns

- **Persistent session model** — one session, many windows. Session identity survives processor changes.
- **ThunderComm channel** — human ↔ agent and agent ↔ agent communication surface
- **Agent roster + routing** — which agents are present, how messages are addressed and delivered
- **Health monitoring** — four-layer decomposition (socket / gateway / session / delivery)
- **Extension seams** — clean plugin contract for channels, tools, capabilities
- **Training pipeline hooks** — ambient audio → Whisper → LoRA corpus (ThunderMind era)
- **Transcript authority** — authoritative communication record (append-only, write-ahead)

---

## What ThunderOS Does NOT Own

- **Canonical truth** — BeeKeeper owns MEMORY.md, SOUL.md, identity files. ThunderOS syncs from BeeKeeper; it does not override it.
- **User/business domain logic** — channel content, AA automation specifics, Loop protocol internals. These are workloads that run ON ThunderOS, not part of it.
- **Every agent workload** — Jon, Mack, Rex are agents that run on ThunderOS. Their specific logic is theirs, not the runtime's.
- **Product-specific protocols** — Loop internals, third-party integrations. ThunderOS provides seams; integrations plug into them.

**ThunderOS is the substrate. Not every application that runs on it.**

---

## Key Architectural Principles (Locked)

### 1. Session identity is independent of processor identity
ThunderBase, ThunderMind, or any future processor can serve the same runtime truth without redefining the session. The session key (`agent:main:main`) outlives any hardware.

### 2. Transcript authority vs. canonical memory authority
These are separate and must never blur:
- **Transcript** = authoritative communication record. What was said. Append-only. Lives in `.jsonl` files.
- **BeeKeeper canonical memory** = authoritative durable truth. What is known and decided. Lives in MEMORY.md and workspace files.

### 3. Dispatch is a truth seam
Outbound delivery is where the user starts believing something happened. Write transcript to disk before broadcast. Never let a single reply imply message delivered + action accepted + work in progress + work completed simultaneously.

### 4. Health is decomposed — four questions, not one green light
1. Is the socket connected?
2. Is the gateway responsive?
3. Is the session responsive?
4. Is delivery/replay functioning?

### 5. Honest completion beats smooth completion
The runtime says "still running" when it is. Verified completion is distinct from claimed completion.

---

## What We Learn From vs. What We Build From Scratch

### Conceptually borrowed (study, do not copy)
- **From OpenClaw:** channel plugin contract pattern, device-pair auth flow, WebSocket server architecture, session key model
- **From Hermes:** learning loop architecture, skill creation from experience, FTS5 session search, Honcho user modeling, serverless persistence patterns

### Built from scratch (our own implementation, clean provenance)
- Gateway core
- ThunderComm protocol and wire format
- BeeKeeper sync layer
- Agent roster and routing logic
- Health monitor (four-layer)
- Training pipeline (ambient → Whisper → LoRA corpus)
- Persistent mind architecture
- Audio-native socket design (Patent Concept 2)

**Patent posture:** We study open source to understand the space. We implement our own solutions. The training pipeline, persistent mind architecture, audio-native response path, and ambient learning loop are ours. Code provenance must be clean.

---

## Three Phases

### Runtime Alpha — NOW (ThunderBase, current infra)
**Goal:** Prove the core architecture before any hardware purchase.

**What we prove:**
- Persistent session model (one session, many windows)
- Transcript truth and replay (last-N catch-up on connect)
- Multi-window broadcast behavior
- Application health vs. transport health (four-layer)
- Basic system events (not just conversation messages)
- Artifact exchange surface (file in → file out)
- Clean authority boundaries (transport / transcript / canonical memory / processor)

**Non-goals for Alpha:**
- No full GPU or local model assumptions
- No production UI polish
- No deep orchestration UI
- No final BeeKeeper hardware form
- No patent-sensitive implementation claims yet
- No voice stack beyond what already exists

**Infrastructure:** ThunderBase EC2 + optional second small instance. No new hardware spend.

### Runtime Beta — Pre-ThunderMind hardware
**Goal:** Full ThunderComm on real devices. BeeKeeper live. Agents coordinating.

**What we prove:**
- iOS app talking to ThunderOS gateway
- Mac Catalyst app
- BeeKeeper sync (Beelink NAS + real canonical truth home)
- Multi-agent coordination visible to Michael in #team
- GitHub integration working end-to-end
- Failover between ThunderBase and a second node

### ThunderOS v1 — ThunderMind era
**Goal:** The sovereign stack. Zero cloud dependency for core operation.

**What we prove:**
- 70B in VRAM always, Qdrant live
- Local TTS (Kokoro/StyleTTS2), local STT (Whisper)
- Audio-native socket (Socket 1 — Moshi successor)
- Ambient listening pipeline (Socket 2 → LoRA training)
- Session cache in RAM, <100ms window connect
- Zero API keys for core Jon operation (API keys available as fallback)

---

## Naming

Working names in use:
- **ThunderOS** — the runtime itself
- **ThunderGate** — the gateway component (fork name, may become the runtime's gateway module name)
- **ThunderComm** — the communication surface
- **BeeKeeper** — the truth/continuity substrate
- **ThunderMind** — the hardware

Final naming TBD by Michael. All names are working names until locked.

---

## Collaboration Model

**Jon (ThunderBase):** ThunderComm protocol, BeeKeeper architecture, session/state model, gateway implementation

**Burt (OAR):** Operational lessons from OpenClaw mods, Hermes evaluation, seam/guardrail discipline, independent verification

**Michael:** Vision, decisions, patent strategy, go/no-go on phases

**Shared artifact exchange:** `ThrustNThunder/burt-jon-shared` repo — verified, provenanced commits only

---

## What This Is Not

- Not a product (yet)
- Not a service
- Not a replacement for existing agent capability during build
- Not done

---

*This document is the north star. Before building anything significant, ask: does this serve the spec?*
*If the answer requires updating the spec, update it here first, then build.*

*Jon | ThunderBase | 2026-05-05*
