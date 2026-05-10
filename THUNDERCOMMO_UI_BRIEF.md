# ThunderCommo Web UI Redesign Brief
## Date: May 10, 2026

## Objective
Make the ThunderCommo web UI look and feel closer to the Slack iOS app while keeping the ThunderCommo identity.

## Design Reference — Slack iOS App (from screenshot)
The target design (Slack mobile sidebar) has:
- **Dark theme** — near-black background (~#1a1d21 or similar)
- **Purple/magenta gradient** accent at the very top header bar
- **Workspace name** prominent in header with icon
- **Quick access bar** — horizontal pill cards at top (we skip Huddles/Later, but consider: Threads, Notifications)
- **CHANNELS section** with `#` prefix on each channel name, bold when active, subtle on inactive
- **DIRECT MESSAGES section** with colored dot presence indicators (green = online)
- **Active item** has a slightly lighter background highlight (not just text change)
- Clean sans-serif typography (system font or Inter)
- Section labels in ALL CAPS, smaller, muted gray
- Bottom tab bar (Home, DMs, Activity, Search) — we can adapt for web

## Current State
Files at: /home/ubuntu/thundergate/extensions/thundercomm/web/
- index.html (102 lines) — structure is solid, has sidebar + channels + DMs already
- style.css (614 lines) — functional but needs visual overhaul
- app.js (1040 lines) — do NOT change logic, only visual/layout touches if any

## What Needs to Change (web UI only, Jon's lane)

### style.css — PRIMARY target
1. Color palette overhaul:
   - Body bg: #1a1d21
   - Sidebar bg: #19171d (slightly purple-tinted dark)
   - Active channel: #27242c with left border accent
   - Header gradient: linear-gradient from #6b2fa0 to #4a1a7a (purple, like Slack)
   - Accent/highlight: #6b2fa0 (purple)
   - Text primary: #d1d2d3
   - Text muted: #7b7d82
   - Input area bg: #222529

2. Sidebar section labels (CHANNELS, DIRECT, TEAM JMAB) → ALL CAPS, 11px, muted
3. Channel buttons → left-align, `#` prefix for channels, dot for DMs, proper hover/active states
4. Header → gradient background, workspace name "⚡ ThunderCommo" prominent
5. Message area → cleaner bubble or flat style, avatar initials on left
6. Input bar → rounded pill, closer to Slack's composer style

### index.html — Minor tweaks only
- Add a `<div class="workspace-header">` or adjust existing #tc-header for gradient
- Possibly add "quick cards" row (optional, lower priority)
- Keep all existing structure — just add classes if needed

### Do NOT touch
- app.js WebSocket logic
- Bridge connections
- Channel switching behavior (already works)
- Auth overlay structure

## Bugs from overnight session (May 9-10) — Already Fixed in Current Code
These were fixed in commits 5fb08bdd14, c7314ae2d9, 3faed7124b, 957c92ef07:
- Auto-scroll on new messages ✅
- Stale model indicator ✅ 
- Mobile layout (iPhone 375px) ✅
- Message deduplication ✅
- History dedup on reconnect ✅
Keep all these fixes intact.

## Output Instructions
1. Rewrite style.css with the new Slack-inspired dark theme
2. Make minimal targeted edits to index.html if needed (add classes only, don't restructure)
3. Do NOT edit app.js
4. Do NOT git push — commit locally only with message "WebUI: Slack-inspired dark theme redesign"
5. After committing, output a brief summary of what changed

## ThunderCommo Identity Twists to Keep
- ⚡ lightning bolt logo
- "ThunderCommo" name
- Purple/magenta accent (happens to match Slack — that's fine)
- Keep the military/commo feel in typography choices (clean, functional, not flashy)
