# ThunderCommo iOS App
*Updated: 2026-05-07 18:39 ET*

## Privacy / Release Posture
- ThunderCommo iOS is **private/internal**
- Distribution is **TestFlight internal only**
- No public App Store release is planned in the current path

## Current Truth
- Text MVP is proven live on a real iPhone
- Current internal iPhone path uses `wss://relay.thunderai.us`
- iPhone, web UI, Mack on Mac, and Jon on ThunderBase sync in `#tnt`
- Build 11 was uploaded directly to App Store Connect / TestFlight internal

## Build 11 Good
- Duplicate-name cleanup improved
- Participant colors improved

## Build 11 Still Broken
- iOS history restore on launch
- iOS stacked per-participant indicators
- Jon indicator path through to iOS
- Status dots should be online / busy / offline, not identity color
- Same-sender rendering parity across web UI and iOS

## Indicator Rule
- One active indicator line per participant
- Works for any number of agents and humans
- Indicators stack/restack as participants become active or idle
- Never default to Jon or any hardcoded participant
- If identity is missing, use safe fallback labeling: `Agent ...` / `Human ...`
- Same indicator model across web UI and iOS

## iOS UX Direction
- Native iPhone dictation for voice-in
- Text-first thread
- No auto-read-aloud on every message
- Jon/Mack messages may expose a small play button for on-demand voice-out
- Voice-out uses assigned iOS system voices from ThunderCommo settings

## Thread Resume Requirement
- Restore recent history/context on launch
- Load about the last 10 messages on startup
- Lazy-load older history on scroll-up
- Feel like resuming the current ThunderCommo thread, not opening blank

## Routing Note
- Mack ThunderCommo path is direct `chat.send`, not Slack
- Current cost issue is `agent:mack:main` context overhead
- Future cleanup target is a dedicated lightweight ThunderCommo session

## Direction
- Heavy on context window, light on quirks
- Simple, reliable UX over clever behavior
- Trusted-user onboarding, not public distribution
- Keep ThunderCommo ours

## Related Docs
- `../../../burt-jon-shared/burt-jon-shared/thundercomm/STATUS.md`
- `../../../burt-jon-shared/burt-jon-shared/thundercomm/IOS_HANDOFF.md`
- `../../../burt-jon-shared/burt-jon-shared/thundercomm/IOS_CONTRACT.md`

---
*Internal iOS README only.*
