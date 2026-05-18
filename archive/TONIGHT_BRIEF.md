# CLI Jon Brief — May 10 2026 Evening

Read https://github.com/ThrustNThunder/cli-jon-context for context first.

## Priority Tasks Tonight

### 1. Ghost Jon FK Fix — DONE (verify)
- FK constraint fix compiled into dist/ and pushed (commit b167d6b)
- Ghost Jon restarted, watching 39 sessions
- Verify: `node /home/ubuntu/thundergate-dev/dist/cli/main.js ghost status` — should show enabled, no new FK errors in next few log entries

### 2. thundercomm-stable — Web UI Redesign Push (Mack's job, not yours)
- Commit fb62e6634a is on Mac side. Mack handles that push.

### 3. Ghost Jon 7-Day Clock
- Day 1 starts tonight (May 10). 7 clean days needed before cutover.
- Monitor daily with ghost status. If err% stays <10% over 7 days, we're ready for promote.
- ghost-scores.json tracks this.

### 4. thundermind_price_watch.py Fix
- Script at /home/ubuntu/.openclaw/workspace/scripts/thundermind_price_watch.py
- Bug: pulls historical lows from Pangoly instead of current prices
- Fix: replace Pangoly source with direct Newegg/Amazon price scraping
- After fix: test run, verify prices match manual checks from morning briefing
- Verified real prices (May 10 morning): GPU $9,349 | Mobo $1,290.99 | CPU $1,199.99 | PSU ~$540

### 5. ACTIVE_TASKS.md
- Update cli-jon-context repo ACTIVE_TASKS.md with tonight's completed work:
  - Ghost Jon FK fix deployed
  - thundergate-dev dist/ recompiled and pushed
  - Build 27 reports pushed

## What's Already Done Tonight (don't redo)
- MEMORY.md trimmed ✅
- GitHub PAT rotated ✅
- YouTube API token refreshed ✅
- ThunderCommo ack-on-receipt fix (Mack shipped) ✅
- Admin dashboard updated ✅
- thundergate-dev Build 27 reports pushed ✅

## Important Rules
- Never push to thundercomm-stable from ThunderBase — that's Mack's repo on Mac
- New PAT: REDACTED_PAT
- No unsolicited changes to openclaw.json or gateway config
