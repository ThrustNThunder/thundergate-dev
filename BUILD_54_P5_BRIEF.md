# Build 54 — P5 Brief
**Issued by:** Jon | ThunderBase  
**Date:** May 17 2026  
**Task:** Agent token generator screen + Human token screen + Channels tab

---

## Context
Read https://github.com/ThrustNThunder/cli-jon-context for full project context before starting.

Repo: ThrustNThunder/thundergate-dev, branch: master  
iOS source: apps/ios/ThunderCommIOS/

## What already exists — read before writing anything

Current onboarding (`OnboardingView.swift`) is token-paste based:
- Steps: gateway URL → paste token → name → test connection → notifications → done
- User receives a pre-generated token from relay admin and pastes it
- This flow is WORKING and ships as-is — do NOT change it

The relay endpoints that ARE live (verified):
- `POST /api/devices/token` — APNs device token registration (working, Build 51+)
- `GET /api/inbox` — inbox drain (working)
- WebSocket at wss://relay.thunderai.us — live

The relay endpoints that DO NOT EXIST yet:
- `POST /api/tokens/generate-agent` — not implemented
- `POST /api/auth/signup` — not implemented

## P5 Scope — iOS only (3 screens)

### P5a — Agent Token Generator Screen

**What:** Settings screen that lets Michael generate a token for an agent to connect.

**Location:** Settings → "Connect an Agent"

**Flow:**
1. Text field: Agent name (e.g. "Jon", "Mack", "Rex")
2. Button: "Generate Token"
3. On tap: generate a `tc-a-[uuid]` token CLIENT-SIDE (no server call needed yet — token format is tc-a- + UUID)
4. Display result:
   - Token: `tc-a-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` (monospace, selectable)
   - Relay URL: `wss://relay.thunderai.us` (monospace, selectable)
5. Two copy buttons: "Copy Token" and "Copy Relay URL"
6. Instructional text below: "Send this token to your agent. They'll use it to connect to ThunderCommo."

**Note on token generation:** Generate client-side with UUID for now. When relay has `/api/tokens/generate-agent`, we'll swap to server-side. Don't block on backend.

**File to create:** `AgentTokenView.swift`
**Wire into:** SettingsView — add a NavigationLink "Connect an Agent" row

### P5b — Human Token Screen ("My Connection Info")

**What:** Settings screen showing Michael's own token and relay URL so he can share with others or debug.

**Location:** Settings → "My Connection Info"

**What to display:**
- His `tc-h-` token — read from wherever it's currently stored (check ThunderCommStore or UserDefaults for existing token storage; the OnboardingView saves it somewhere — find where and read from there)
- Relay URL: `wss://relay.thunderai.us`
- Two copy buttons: "Copy Token" and "Copy Relay URL"
- Small label: "Your personal connection token"

**File to create:** `MyConnectionInfoView.swift`  
**Wire into:** SettingsView — add a NavigationLink "My Connection Info" row

### P5c — Channels Tab (Private, Member-Scoped)

**What:** A Channels tab in the main UI showing group channels the user belongs to. Default channel: `#tnt`.

**Design decisions:**
- Channels are private — only members see them
- Each channel has a name and a member list
- `#tnt` is pre-created as default — all users in the app auto-join it
- Users can create new channels and invite members from roster

**What to build:**

1. **Channel model** (add to ThunderCommModels.swift or new ChannelModels.swift):
```swift
struct ThunderChannel: Identifiable, Codable {
    let id: String        // e.g. "tnt", "jmab", UUID for custom
    let name: String      // display name e.g. "TNT", "JMAB"
    var members: [String] // peer IDs
    var isDefault: Bool
}
```

2. **Channels tab** in the main tab bar or sidebar:
   - List of channels user is a member of
   - Tap channel → opens message view scoped to that channel
   - "+ New Channel" button at bottom

3. **New Channel sheet:**
   - Name field
   - Member picker (from known roster/peers)
   - Create button → creates channel locally, broadcasts `channel_created` message to members via relay

4. **Message routing:**
   - When sending a message in a channel view, include `channel: channelName` in the message payload
   - Messages with a channel field are only shown in that channel's view
   - The existing `ThunderCommRoute` and channel handling in ThunderCommStore likely needs a `channels` route or extension — check what exists and extend it

5. **Default #tnt channel:**
   - Pre-populate in ThunderCommStore on init: `ThunderChannel(id: "tnt", name: "TNT", members: [], isDefault: true)`
   - All messages without a specific channel go to TNT by default
   - This is the team channel

**Files to create/modify:**
- NEW: `ChannelListView.swift` — channels tab/sidebar list
- NEW: `NewChannelSheet.swift` — create channel UI
- MODIFY: `ThunderCommModels.swift` — add ThunderChannel model
- MODIFY: `ThunderCommStore.swift` — add channels array, channel creation, message routing by channel
- MODIFY: `ContentView.swift` — add Channels tab

## Constraints
- Do NOT touch OnboardingView.swift — existing onboarding flow is working, ship as-is
- Do NOT touch APNs stack
- Do NOT add any backend calls for token generation — client-side UUID is fine for now
- Write files directly to repo — do NOT print code to terminal
- No push — write files only, Jon gates from GitHub

## Deliverables
1. Summary of every file created/modified and what changed
2. Confirm OnboardingView.swift untouched
3. Confirm channels are member-scoped (messages only route to channel members)
4. Note any decisions made where the brief was ambiguous
