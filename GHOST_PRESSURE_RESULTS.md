# Ghost Jon Pressure Test — May 11, 2026

**Verdict:** ✅ **PASSED.** Ghost Jon survived the pressure test. No FK
regressions, no transport errors, no harness crashes, mid-run session
discovery worked, and every edge case landed correctly. Two small
improvements were made to keep future test runs from corrupting the
cutover scoring.

## Test scope

Driver: `/tmp/ghost_pressure_test.py`. Verifier: `/tmp/ghost_verify.py`.

1. FK regression check on `~/.thundergate/ghost-log.jsonl` after the
   23:00 ET recompile.
2. Flood: 50 user/assistant pairs appended to a fresh JSONL session
   file dropped into `~/.openclaw/agents/main/sessions/`.
3. Edge cases bundled into the flood as messages 46–50:
   empty string, 5000-char `"x"`-string, multi-script unicode + emoji,
   JSON-looking payload with an embedded `<script>` tag, literal
   `"null"`.
4. Session-boundary: a second JSONL file (`ghost-test-boundary.jsonl`)
   created mid-run, with 5 user/assistant pairs appended after the
   30-second rescan window.
5. Status check via `node dist/cli/main.js ghost status`.
6. Match/error rate computed on entries written by the harness.

## Numbers

| Metric                          | Result |
| ------------------------------- | ------ |
| User/assistant pairs sent       | 55 (50 flood + 5 boundary) |
| Log entries written by harness  | 54 (49 flood + 5 boundary) |
| Entries lost / never paired     | 0 ("[ghost: not yet ready]" count) |
| `[ghost error: …]` entries      | 0 |
| `FOREIGN KEY constraint failed` | 0 (was 55 historic, count unchanged) |
| LLM transport failures          | 0 |
| Latency (ms): min / median / p90 / max | 519 / 705 / 4890 / 5908 |
| Errors during test window       | 0% |
| Mid-run new-file attach         | ✅ second file detected on next 30 s rescan; 5/5 pairs logged |

The "missing" 55th entry is the empty-string message: `parseLine()`
rejects empty `content` upstream, so no LLM call was issued and the
following assistant line found no `pendingInput` to pair with. That
filter is desirable — it stops the harness from billing Haiku tokens
on whitespace-only lines.

## Edge-case rundown

| Edge case      | Outcome | Notes |
| -------------- | ------- | ----- |
| Empty string   | Filtered upstream (0 entries) | `parseLine` returns null for empty text — no LLM call, no log row, no pairing artifact. Working as designed. |
| 5000-char `x`  | 1 entry, 1593 ms | Haiku replied within token cap (`max_tokens=512`). No payload truncation in storage. |
| Unicode/emoji  | 1 entry, ~800 ms | `💥⚡🤖 héllo wörld 你好 مرحبا 🌩️` round-tripped intact (UTF-8 preserved through `appendFileSync` + `ensure_ascii=False` JSON). |
| JSON-looking   | 1 entry, 3062 ms | Embedded `<script>` not interpreted — it's just bytes inside a string. Haiku flagged it as an XSS test in plain prose. |
| `"null"`       | 1 entry, 1343 ms | Treated as literal text, not as JSON `null`. |

## FK fix status

`b167d6b` recompiled `dist/` with the `message.ghost` short-circuit
that bypasses `learning.onTurn()` for shadow traffic
(`src/core/runtime.ts:247`). Last FK error in the log: **2026-05-10
13:48:05 EDT**, ~10 h before the recompile. **No new FK errors
during this test or during the organic traffic since.** Fix is
holding.

## Bugs found & fixed

### 1. Pressure-test sessions corrupt daily scoring (introduced by *running* the test)

Symptom we hit: dropping 54 synthetic user/assistant pairs into the
sessions dir worked perfectly — pairing, latency, errors all clean —
but the synthetic OpenClaw "ack" lines couldn't fuzzy-match Haiku's
actual replies. Result: today's `match_rate` plunged to **0%**, the
day flipped to **red**, and the 7-day cutover clock would have reset
for everyone who tries to pressure-test going forward.

Two-layer fix, both compiled into `dist/`:

- **Harness skip** (`src/ghost/harness.ts:170`): the directory
  scanner now ignores files whose basename starts with
  `ghost-test-`. Future test JSONLs won't be attached, so they
  can't generate log rows in the first place.
- **Evaluator skip** (`src/ghost/evaluator.ts:80`): even if test
  rows already exist (e.g. from before this patch), `computeScores`
  now drops entries whose `session_id` starts with `ghost-test-`
  before bucketing by day. Defence-in-depth.

After the patch + cleanup, today's `match_rate=0%` on the **6 real
organic samples** that landed during the test window — that's a
known limitation (Haiku ↔ OpenClaw voice gap), not a pressure-test
failure, and tracking it is part of the 7-day cutover discussion.

### 2. No other bugs surfaced

- Watcher polled every 2 s as configured; no missed appends.
- 30 s rescan picked up `ghost-test-boundary.jsonl` on first tick.
- Pairing 30 s deadline (`harness.ts:286`) never expired — all
  shadow responses arrived inside 6 s.
- Anthropic API key was auto-resolved from
  `~/.openclaw/agents/main/agent/auth-profiles.json`
  (`config/index.ts:64`) — no env-var setup required.

## Cleanup performed

- Backed up the pre-scrub log to
  `~/.thundergate/ghost-log.jsonl.pre-scrub.bak`.
- Removed the 54 `ghost-test-*` entries from
  `~/.thundergate/ghost-log.jsonl` (kept 129).
- Removed `ghost-test-pressure.jsonl` and `ghost-test-boundary.jsonl`
  from `~/.openclaw/agents/main/sessions/`.
- Stopped runtime, recompiled (`npx tsc` clean), restarted runtime.
  New PID confirmed running, 39 session files attached.
- Recomputed scores via `ghost status` — today shows `samples=6,
  err=0%`.

## What the test does not yet prove

- **Match rate.** The fuzzy-match heuristic between Haiku and
  Sonnet is still unverified; only error rate and latency are
  pressure-validated. Match rate will need real-traffic days to
  characterize.
- **Crash recovery.** This test didn't kill the runtime
  mid-stream. Tomorrow's automated daily-health-check script
  (`~/.openclaw/workspace/scripts/daily-health-check.sh`,
  per `ACTIVE_TASKS.md`) is expected to flag any FK regressions
  newer than the deploy.
- **Backpressure under rate limit.** The 54 Haiku calls did not
  hit the Anthropic rate limit. A much larger flood (1000+) would
  be needed to verify the harness's error handling on 429s.

## Files / commits touched

- `src/ghost/harness.ts` — `ghost-test-*` scan filter
- `src/ghost/evaluator.ts` — `ghost-test-*` evaluator filter
- `dist/ghost/harness.js`, `dist/ghost/evaluator.js` — recompiled
- `~/.thundergate/ghost-log.jsonl` — scrubbed
- `~/.thundergate/ghost-log.jsonl.pre-scrub.bak` — backup of pre-scrub log
