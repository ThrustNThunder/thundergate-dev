# Ghost Jon FK Fix Brief
**Date:** 2026-05-12  
**From:** Jon (ThunderBase)  
**Priority:** URGENT — blocking 7-day clean gate

---

## The Problem

Ghost Jon has 56 FOREIGN KEY constraint failures. Every single one since
May 10. The 7-day clean gate **cannot start** until these are zero.

The gate check in `evaluator.ts` counts:
```
fk_errors_since_deploy == 0
```
Currently: 56. Blocking.

---

## Root Cause — Confirmed

**File:** `src/learning/triggers.ts` — `TriggerEngine.onTurn()`

```typescript
this.db.storeMessage({
  sessionId: 'current',   // <-- THIS IS THE PROBLEM
  channel: 'internal',
  role: 'user',
  content: userMessage
});
```

The `messages` table has:
```sql
session_id TEXT NOT NULL REFERENCES sessions(id)
```

There is **no row** in the `sessions` table with `id = 'current'`.
Every `storeMessage` call with `sessionId: 'current'` hits the FK
constraint and throws. This is 100% of the FK errors.

SQLite FK enforcement is on (confirmed by WAL mode + explicit pragma).

---

## The Fix

**Two parts — both required:**

### Part 1: Seed the 'current' session row before first use

In `src/learning/triggers.ts`, add an `ensureCurrentSession()` helper
that does an `INSERT OR IGNORE` into `sessions`:

```typescript
private ensureCurrentSession(): void {
  this.db.ensureSession('current');
}
```

And call it once at construction time or at the top of `onTurn()`.

### Part 2: Add `ensureSession()` to `SessionDB`

In `src/session/database.ts`, add:

```typescript
ensureSession(id: string): void {
  this.db.prepare(`
    INSERT OR IGNORE INTO sessions (id, started_at, status)
    VALUES (?, ?, 'active')
  `).run(id, Date.now() / 1000);
}
```

This is idempotent — safe to call every turn if needed.

---

## Where to Call It

Option A (preferred): Call `ensureCurrentSession()` once in the
`TriggerEngine` constructor after receiving `db`.

Option B (belt-and-suspenders): Call it at the top of `onTurn()` before
the first `storeMessage`.

Either works. Option A is cleaner.

---

## Also Check: Ghost Harness Session ID

The harness in `src/ghost/harness.ts` line 344 uses:
```typescript
session_id: session.sessionId,
```

The `sessionId` value comes from the OpenClaw session JSONL filename.
These IDs are NOT pre-seeded in the sessions table either.

This may or may not be hitting FK errors too — the ghost log shows FK
errors in the `thundergate_response` field, which is the Haiku response
string, not the DB write path. So harness FK errors are separate from
trigger FK errors.

**Check:** Does the ghost harness call `storeMessage` anywhere with
these session IDs? If yes, the same fix applies — seed the session row
before the message insert.

Looking at the code: the harness writes to the JSONL log only, NOT to
the DB directly. The FK errors in the ghost log come from the
`thundergate_response` string — meaning Haiku itself is outputting
`[ghost error: FOREIGN KEY constraint failed]` as its response text.

This means the **ThunderGate runtime** (not the harness) is hitting FK
errors when it tries to write to the DB in response to the ghost input.
The trigger engine is wired into the runtime — when the runtime
processes a message, it calls `triggerEngine.onTurn()`, which calls
`storeMessage('current')`, which hits the FK.

**The fix to `triggers.ts` will resolve all 56 FK errors.**

---

## After the Fix

1. Rebuild: `npm run build` in `/home/ubuntu/thundergate-dev/`
2. Restart ThunderGate: `sudo systemctl restart thundergate` (or however
   the service is managed — check `thundergate ghost status` after)
3. Verify: `thundergate ghost status` should show 0 FK errors after a
   few turns of activity
4. The evaluator uses `fk_errors_since_deploy` — it counts from the
   last deploy timestamp in `checkpoint.json`. After the fix lands,
   the counter resets on next deploy/restart.

---

## Secondary Issue: Weighted Score (0.04 vs needed 0.75)

This is a separate problem — the FK fix won't fix this. But after the
FK fix lands, at least Ghost Jon can generate clean entries to score.

The low weighted score means Haiku 4.5's responses don't match Jon's
tone/style/content. This will need prompt tuning in the GJ_* context
files or a different approach to response matching.

**Do NOT address the score issue in this fix run.** Fix the FK errors
only. One problem at a time.

---

## Deliverables

1. `src/learning/triggers.ts` — fix `onTurn()` to seed 'current' session
2. `src/session/database.ts` — add `ensureSession()` method
3. `npm run build` — compiled to `dist/`
4. Confirm FK constraint check passes after rebuild

**Do NOT push to git.** Jon will review before any push.
**Do NOT restart the ThunderGate service.** Jon will do that after review.

Write a completion summary to `/tmp/ghost-fk-fix-complete.txt`.
