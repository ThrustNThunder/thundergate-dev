# ThunderGate Phase 4 Summary — LLM Wiring

**Date:** 2026-05-10
**Branch:** master (local commit, not pushed)
**TypeScript:** clean (`npx tsc` exits 0)

## Goal
Wire `runtime.callLLM()` to a real model so Ghost Jon produces actual responses instead of empty strings.

## Provider decision: Anthropic Claude Haiku 4.5
The brief preferred OpenAI `gpt-4o-mini`, with Anthropic Haiku as the fallback if no OpenAI key was found on ThunderBase.

OpenClaw auth was inspected at:
- `/home/ubuntu/.openclaw/openclaw.json` — `auth.profiles` only contained `anthropic:default`.
- `/home/ubuntu/.openclaw/agents/main/agent/auth-profiles.json` — same single profile.
- `OPENAI_API_KEY` — unset in the environment.

→ **No OpenAI key available**, so the default ghost model is Anthropic.

The brief suggested `claude-3-5-haiku-latest` / `claude-3-haiku-20240307`. Probing the OpenClaw key showed only Claude Haiku 4.5 was reachable on this account:

| Model ID                          | Status |
|-----------------------------------|--------|
| `claude-3-5-haiku-latest`         | 404 not_found_error |
| `claude-3-5-haiku-20241022`       | 404 not_found_error |
| `claude-3-haiku-20240307`         | 404 not_found_error |
| **`claude-haiku-4-5-20251001`**   | **200 OK** |

The default was set accordingly. The provider-routing code still supports OpenAI cleanly for the day a key shows up.

## What changed

### `src/config/loader.ts`
- Extended `Config.ghost` with `model`, `maxTokens`, `temperature`.
- Added top-level optional `openaiApiKey` and `anthropicApiKey`.
- Defaults: `ghost.model = 'anthropic/claude-haiku-4-5-20251001'`, `maxTokens = 512`, `temperature = 0.3`.
- Defaults read `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` from env when present.

### `src/config/index.ts`
- `PHASE3_DEFAULT.ghost` now includes `model`, `maxTokens`, `temperature` so first-run `~/.thundergate/config.json` carries them.
- `ensureConfig()` falls back to OpenClaw's `auth-profiles.json` (`profiles['anthropic:default'].key`) when no Anthropic key was supplied via env or config — so operators don't need to re-export a key Claw is already holding.

### `src/core/runtime.ts`
- `callLLM` is now public, takes `messages: Array<{role, content}>`, returns `Promise<string>` (matches the brief's signature exactly).
- Routes by `config.ghost.model` prefix:
  - `openai/...` or `gpt-...` → POST `https://api.openai.com/v1/chat/completions` with bearer auth.
  - `anthropic/...` or `claude-...` → POST `https://api.anthropic.com/v1/messages` with `x-api-key` + `anthropic-version: 2023-06-01`.
- Anthropic path lifts any `system` messages out of the chat list into the top-level `system` field (Anthropic 400s on inline system roles).
- Missing API key, non-OK HTTP, or transport errors all return `''` and log a warning rather than throwing — matches the harness's existing "Doctor must tell the truth, never crash silently" pattern.
- `normalProcess` now wraps the inbound `Message` into a single-element messages array and unpacks the returned string into the existing `Response` shape, so the rest of the pipeline (including `learning.onTurn`) is unchanged.

### `src/cli/main.ts`
- `thundergate ghost status` now prints `Model`, `Max tokens`, `Temperature`, and a `Provider auth` line that reflects which provider key is needed for the configured model and whether it's present.

## Verification

```
$ npx tsc            # exits 0, no diagnostics

$ node dist/cli/main.js ghost status
⚡ Ghost Jon Status
═══════════════════════════════════════
  Enabled (config):  ❌ no
  Model:             anthropic/claude-haiku-4-5-20251001
  Max tokens:        512
  Temperature:       0.3
  Provider auth:     ✅ Anthropic key present
  ...

$ node --input-type=module -e "
  const { ThunderGateRuntime } = await import('./dist/core/runtime.js');
  const rt = new ThunderGateRuntime();
  const r = await rt.callLLM([{role:'user', content:'Say hello in 5 words.'}]);
  console.log('LLM response:', JSON.stringify(r));
"
LLM response: "Hello, how are you today?"
```

Live HTTP call to `api.anthropic.com/v1/messages` succeeded; returned text is propagated back through the runtime.

## Files touched
- `src/config/loader.ts`
- `src/config/index.ts`
- `src/core/runtime.ts`
- `src/cli/main.ts`

## Commit
Committed locally on `master`. **Not pushed** per the brief.

## Follow-ups (not done in this phase)
- The brief mentions `config.model.mode` (`auto` / `manual` / `supersaver`) for primary-routing. `callLLM` currently routes only by `ghost.model`. When ThunderGate goes live (post-cutover) the same routing logic should be reused for the primary path, picking from `config.model.primary` / `reasoning` / `surface` / `fallback`.
- `evaluateComplexity` and `evaluateUrgency` are still stubs — deep-mode + surface-layer routing is unchanged from Phase 3.
- No retry/backoff on transient API errors. Acceptable for ghost mode (just lowers match rate); should be added before primary cutover.
