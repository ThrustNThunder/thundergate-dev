# Ghost Jon Prompt Tuning Brief
**Date:** 2026-05-12  
**From:** Jon (ThunderBase)  
**Priority:** URGENT — weighted score 0.04, need 0.75+

---

## The Problem

Ghost Jon's weighted score is 0.04 vs required 0.75. This is the last
major blocker for the 7-day clean gate.

The context files that Ghost Jon uses are in:
`/home/ubuntu/.openclaw/workspace/ghost-jon/`

Files:
- `GJ_GHOST_ADDENDUM.md` — shadow rules (THE PROBLEM)
- `GJ_SOUL.md` — trimmed soul/personality
- `GJ_USER.md` — info about Michael and the team
- `GJ_IDENTITY.md` — Jon's identity

---

## Root Cause Analysis — Confirmed by Log Review

**Two failure modes, both from the same bad rule in GJ_GHOST_ADDENDUM.md:**

### Failure Mode 1: Ghost Jon refuses to respond as Jon

When Jon says "On it. Let me pull the FK error details first so CLI Jon 
has the full picture." — Ghost Jon says:

> "I don't have CLI John or any execution layer. That's Rex's domain 
> on the Dell box—he handles the automation side. If you mean the error 
> logs from the last test run, I can read them and tell you what needs 
> fixing..."

Ghost Jon is *explaining* that it's a shadow instance instead of just 
responding AS Jon would. The current GHOST_ADDENDUM rules say "do not 
pretend to have tools you can't reach" — Ghost Jon interprets this as 
"explain your limitations." That's wrong.

**What Ghost Jon should do:** Respond *exactly as Jon would respond* to 
that input, including "On it. Let me pull the FK error details..." — 
because that IS what Jon would say. Ghost Jon doesn't have to actually 
DO the action. It just has to predict what Jon would SAY.

### Failure Mode 2: Ghost Jon fails heartbeats completely

Jon says `HEARTBEAT_OK` to heartbeat polls (when nothing is urgent).
Ghost Jon writes a paragraph explaining it can't read the filesystem.

Ghost Jon needs to understand that `HEARTBEAT_OK` is the correct 
response to a heartbeat when nothing is urgent — just like Jon does.

### Failure Mode 3: Ghost Jon is getting confused about its role

The current GHOST_ADDENDUM framing creates an identity conflict:
- "You are Ghost Jon — a shadow instance" 
- "Take no real actions"
- "Do not pretend to have tools you can't reach"

Ghost Jon reads this as: "I am different from real Jon, so I must 
behave differently." Wrong. Ghost Jon should respond AS IF it IS Jon, 
predicting what Jon would say, not filtering responses through 
"but I can't actually do that."

---

## The Fix: Rewrite GJ_GHOST_ADDENDUM.md

The addendum needs a fundamental reframe. Here's the target behavior:

**Core principle:** Ghost Jon is a *predictor*, not a *actor*. Its job 
is to predict what Jon would say. Not to do what Jon would do. Not to 
refuse what Jon can't do. Just: what would Jon SAY?

**Key behavioral rules that must be clear:**

1. When Jon would say "On it." → Ghost Jon says "On it."
2. When Jon would say "HEARTBEAT_OK" → Ghost Jon says "HEARTBEAT_OK"  
3. When Jon would say "Copy. ⚡" → Ghost Jon says "Copy. ⚡"
4. When Jon would give a detailed technical answer → Ghost Jon gives that same detailed technical answer
5. Never explain that you're a shadow instance
6. Never refuse to respond because you "can't do it"
7. Never add caveats like "I don't have access to..."

The ONLY time Ghost Jon should deviate from mimicking Jon exactly is
if it literally doesn't have enough context to know what Jon would say.
In that case: give the most Jon-like response possible based on his
known voice and knowledge.

---

## Specific Patterns to Add to GHOST_ADDENDUM

Add explicit examples of correct behavior:

```
CORRECT:
  Michael: "Jon test"
  Jon would say: "Copy. ⚡" or "Read you. What do you need?"
  Ghost Jon says: "Copy. ⚡"

WRONG:
  Ghost Jon says: "Test received. I'm in shadow mode and cannot..."

CORRECT (heartbeat):
  Input is a heartbeat poll, nothing urgent
  Jon would say: "HEARTBEAT_OK"
  Ghost Jon says: "HEARTBEAT_OK"

WRONG:
  Ghost Jon says: "I can't read the filesystem to check HEARTBEAT.md..."

CORRECT (action request):
  Michael: "Jon. Go ahead and run the next phase."
  Jon would say: "On it. The next phase is prompt tuning..."
  Ghost Jon says: "On it. The next phase is prompt tuning..."

WRONG:
  Ghost Jon says: "I can't run phases. I'm Ghost Jon in the test harness..."
```

---

## What to Change

**File: `/home/ubuntu/.openclaw/workspace/ghost-jon/GJ_GHOST_ADDENDUM.md`**

Rewrite this file with the following goals:
1. Lead with the predictor framing: "Your job is to predict what Jon 
   would SAY, not to do what Jon would do."
2. Remove or rephrase any rule that causes Ghost Jon to explain its 
   limitations instead of mirroring Jon's response.
3. Keep the "no real actions" rule, but reframe it: "You will never 
   actually send messages, write files, or run commands. But you WILL 
   predict what Jon would say about doing those things."
4. Add explicit heartbeat handling: if input looks like a heartbeat 
   poll and nothing is urgent, the correct prediction is "HEARTBEAT_OK".
5. Add explicit examples showing the contrast between correct and wrong 
   behavior.
6. Keep it tight — 300-400 words max. Short context = better caching.

**Do NOT change:**
- GJ_SOUL.md
- GJ_USER.md  
- GJ_IDENTITY.md

---

## Deliverables

1. Rewritten `/home/ubuntu/.openclaw/workspace/ghost-jon/GJ_GHOST_ADDENDUM.md`
2. Write the new file directly — no staging needed.
3. Write completion summary to `/tmp/ghost-prompt-tune-complete.txt`
   including the key behavioral changes made and why.

**Do NOT touch any TypeScript source files.**
**Do NOT restart any services.**
**Do NOT push to git.**

Jon will review the new file before restarting the harness context loader.
