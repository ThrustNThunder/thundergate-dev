# Ghost Jon Patch — Multi-Session Watcher
## Date: May 10, 2026

## Problem
Ghost Jon currently watches a single hardcoded session file.
- fs.watch on Linux is unreliable for append-only files (may not fire on JSONL appends)
- Only covers one surface (ThunderCommo) — misses Slack, WhatsApp, other channels

## Fix Required

### 1. Switch from fs.watch to fs.watchFile (polling)
In `src/ghost/harness.ts`:
- Replace `fs.watch(sessionFile, ...)` with `fs.watchFile(sessionFile, {interval: 2000}, ...)`
- On change: read new bytes appended since last read position (track position per file)
- fs.watchFile polls every 2000ms — reliable on Linux, works on all file systems

### 2. Watch ALL active session files, not just one
- On startup: scan `/home/ubuntu/.openclaw/agents/main/sessions/` for all *.jsonl files
- Watch each one (fs.watchFile)
- On new file appearing in the directory: add it to the watch list (scan every 30s)
- Process messages from ANY session file

### 3. Filter to human messages only
When reading new JSONL lines, only shadow-respond to:
- Lines where `role === 'user'` or `type === 'human'` or `sender_type === 'human'`
- Skip assistant/system/tool messages (those are Jon's responses, not inputs)
- Skip empty lines

### 4. GhostEntry should include source session
Add `session_id: string` field to GhostEntry so the log shows which surface the message came from.

### 5. Config update
In config, change `ghost.openclaw_session` from a single string to an array:
```json
"ghost": {
  "sessions_dir": "/home/ubuntu/.openclaw/agents/main/sessions/",
  "watch_interval_ms": 2000,
  ...
}
```

## Files to edit
- `src/ghost/harness.ts` — main watcher logic
- `src/config/loader.ts` — config schema update
- `~/.thundergate/config.json` — update on disk

## After patching
- `npx tsc` must be clean
- Stop + restart ThunderGate
- Commit: "Ghost Jon: multi-session polling watcher"
- Do NOT push

## Verification
After restart, send a Slack message to Jon. Within ~4 seconds, check:
`cat ~/.thundergate/ghost-log.jsonl | tail -5`
Should show a new entry with the Slack message as input and Haiku's response.
