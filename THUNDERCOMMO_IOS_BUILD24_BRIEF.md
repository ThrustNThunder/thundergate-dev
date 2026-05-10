# ThunderCommo iOS — Build 24 Implementation Brief
## Date: May 10, 2026
## From: Jon | ThunderBase
## To: CLI Jon → Mack (builder/shipper)

---

## Context
Build 23 source is staged locally on Mack's Mac (not pushed). This brief covers:
1. All bugs found in the Build 23 review
2. The full design overhaul toward Slack-style agent-to-human UX

Run this as ONE coding pass. Output Swift files + INTEGRATION_NOTES.md. Do NOT push.

---

## Part 1 — Bug Fixes (from Build 23 review)

### 🔴 P0 — Ship blockers

**BUG-1: Hard-coded `ios-michael-*` identity**
- `ThunderCommIdentity.loadOrCreatePeerId()` always creates `ios-michael-<uuid>`
- `mappedCanonicalID` collapses any `ios-michael-*` to `michael`
- Fix: Identity must come from the auth system (signed-in user's handle from signup)
- If no user signed in → identity is `anonymous-<uuid>` until signup completes
- After signup: identity = user's chosen handle
- Remove all hard-coded `michael` references from identity resolution

**BUG-2: Stuck `sending` state on reconnect**
- If socket is reconnecting when `sendDraft` runs, send callback may never fire
- Message sits at `.sending` indefinitely with no recovery
- Fix: Add a timeout (5s) on `.sending` state. If ack not received within 5s and socket is reconnecting, mark as `.failed` with retry option. On reconnect, re-queue any `.failed` messages.

**BUG-3: Multi-text assistant turns mis-routing**
- `pendingResponseChannels` is queued once per dispatch but consumed once per text block
- If one assistant turn emits multiple text blocks, only the first lands in the right channel
- Fix: Hold the channel for the entire assistant turn (track by turn ID or streaming session). Only pop from queue when the turn is complete (stream ends / no more blocks from that agent for that turn).

### 🟡 P1 — Fix before ship

**BUG-4: Duplicate settings surfaces**
- Header has both a gear button (SettingsView) and an ellipsis menu with connection config
- Connection config (endpoint/token/relay) must live INSIDE SettingsView only
- Remove the ellipsis menu connection config — one settings surface, the gear

**BUG-5: Crowded header**
- Current: route menu chip + peers count chip + gear + ellipsis = 4 items fighting for space
- Fix: Consolidate to: [Channel title + subtitle] ... [peers count chip] [gear]
- Route menu → move into a long-press or tap on the channel title itself (or drop it for now)
- Ellipsis → eliminate (its functions moved to gear/SettingsView)

**BUG-6: Delete is local-only**
- `ThunderCommStore.deleteMessage` removes locally but never notifies bridge/federation
- Other clients can resurrect deleted messages on reload
- Fix: On delete, send a delete event to the bridge: `{"type": "delete", "messageId": "<id>", "channel": "<channel>"}`. Bridge propagates to federation. Add handler in bridge.mjs for delete events.
- For now, if bridge delete is too complex: at minimum prevent resurrection by including a tombstone in local persistence (deleted: true flag that survives reload).

**BUG-7: Streaming preview view churn**
- `MessageListView` keys streaming row off `updatedAt` → SwiftUI rebuilds entire view on every delta tick
- Fix: Key the streaming row off a stable ID (message ID or streaming session ID). Use `@StateObject` or `@ObservedObject` for the streaming content so only the text content re-renders, not the whole row.

**BUG-8: Identity resolution incidental**
- `ContentView.peerColor(for: senderName, senderType: .human)` passes display name as participantId
- Works by fallback, not by design — fragile
- Fix: Pass the actual canonical user ID (from auth system) as participantId everywhere. Display name is for rendering only.

### 🟢 P2 — Clean up

**BUG-9: `channel.ts` is dead code path**
- `extensions/thundercomm/src/channel.ts` is not the live server — `bridge.mjs` is
- Add a comment at the top of channel.ts: `// NOT THE LIVE PATH — see bridge.mjs`
- Do not delete it (may be useful for future ThunderGate integration) but make it obvious

**BUG-10: Bridge user table hard-coded**
- SettingsView Add Agent doesn't reach bridge auth
- New agents still need a code edit + restart
- Fix: When user adds an agent via SettingsView, send a registration event to the bridge:
  `{"type": "register_agent", "agentId": "<id>", "token": "<token>", "gatewayUrl": "<url>"}`
- Bridge.mjs adds handler that accepts the token and adds to its token map without restart
- This is the foundation for the Add Agent flow in onboarding

---

## Part 2 — Design Overhaul (Slack-style agent-to-human UX)

### Core Identity
ThunderCommo is NOT a human-to-human chat app.
It is an **agent-to-human collaboration app**.
Agents are first-class citizens. The design reflects the agent relationship.
Reference aesthetic: Slack iOS (dark, purple, sidebar) with ThunderCommo's agent twist.

### Color System
```
Background:     #1a1d21
Sidebar bg:     #19171d  (subtle purple tint)
Header gradient: #6b2fa0 → #4a1a7a
Active item:    #27242c + 3px left border #6b2fa0
Accent/CTA:     #6b2fa0
Text primary:   #d1d2d3
Text muted:     #7b7d82
Online dot:     #2bac76 with glow
Offline dot:    hollow ring #7b7d82
Agent: Jon      gold (#f5a623 / senderColor already set)
Agent: Mack     light blue (already set)
Michael/human   purple (#6b2fa0)
```

### Onboarding Flow (complete, end-to-end)
```
SplashView
  → ⚡ ThunderCommo wordmark centered
  → Dark bg, purple gradient glow behind logo
  → Auto-advances after 1.5s (or tap to continue)
  → If no saved session → SignUpView / SignInView
  → If saved session → AuthGate (Face ID) → HomeView

SignUpView
  → Email field
  → Password field (confirm)
  → Phone number (optional, for recovery)
  → Handle (@username — this becomes their identity in chat)
  → "Create Account" button (purple filled)
  → "Already have an account? Sign in" link
  → On success → AddAgentView

AddAgentView ("Add Your Agent")
  → Heading: "Connect your AI"
  → Subtext: "Your agent is the reason you're here."
  → 4 options as cards (tap to expand):
      [QR Code] — camera opens, scan agent's QR
      [Know Your Agent] — agent intro/verification flow
      [BYOAA] — Bring Your Own Agent API (gateway URL + token)
      [Direct Token] — paste token directly
  → "Skip for now" link (small, muted — goes to HomeView)
  → On agent added → HomeView

HomeView
  → Sidebar layout (see below)
  → Opens to last active channel or #tnt by default
```

### Home Screen — Sidebar Layout
```
┌─────────────────────────────┐
│ [⚡ ThunderCommo]  [@handle]│  ← Purple gradient, handle top-right
├─────────────────────────────┤
│ CHANNELS           [+]      │  ← Section label ALL CAPS 11px + inline + button
│  # tnt             ←active │  ← Active: #27242c bg + 3px purple left border
│  # team-jmab               │
├─────────────────────────────┤
│ AGENTS             [+]      │  ← + button → AddAgentView
│  ● Jon    [online]  [gold]  │  ← Filled green dot + glow
│  ○ Mack   [offline]        │  ← Hollow gray ring
│  ● Rex    [online]         │
├─────────────────────────────┤
│ DIRECT MESSAGES    [+]      │
│  Burt                       │
│  Alex                       │
└─────────────────────────────┘
```

Section labels: 11px, ALL CAPS, tracking 0.08em, color #7b7d82
Channel rows: 15px, medium weight, left-padded
Active row: background #27242c, 3px left border #6b2fa0, text #ffffff
Hover/pressed: opacity wash #ffffff10
Presence dots: 9pt circles. Online: filled #2bac76 + shadow(color: #2bac76, radius: 3). Offline: stroke only, #7b7d82.

### Chat View
- Flat rows, NOT bubbles (for agent messages)
- Own messages: subtle tinted bg (senderColor.opacity(0.15)) — keep current approach but flatten the bubble radius to 4px max
- Agent messages: NO bubble bg, just left-aligned with avatar monogram + bold name
- Agent name row: [Avatar 28px] [Bold name 14px] [model pill 11px muted purple] [timestamp muted]
- Message body: 15px regular, full width
- Thinking dots: animated, below last agent message
- Streaming: text appears word-by-word in place (no view churn — see BUG-7 fix)
- Delivery indicators: ✓ sent, ✓✓ delivered (muted, bottom-right of own messages only)

### Input Bar (ComposerBar)
- Pill shape, 22px radius, bg #222529
- Left: mic button (40px circle, muted icon)
- Center: text field, auto-grows up to 5 lines
- Right: send button (40px circle, filled #6b2fa0 when text present, gray when empty)
- Focus ring: #6b2fa0 glow on the pill container
- Placeholder: "Message #tnt…" (updates with active channel name)

### Header (simplified per BUG-5)
- Left: [☰ hamburger on mobile] [Channel title bold 17px] [subtitle muted 13px]
- Right: [Peers count chip] [Gear icon]
- Gradient: none on header (gradient lives in sidebar top only)
- Thinking dots appear inline after title when agent is processing

---

## What NOT to Change
- WebSocket connection logic (bridge.mjs wire protocol)  
- Auth flow that works: signup/signin/Face ID/BYOAA server calls
- APNs/notification registration code
- Wire protocol message parsing
- ThunderCommStore core persistence

---

## Output Format for Mack
1. Full Swift file contents for each changed file (complete file, not diffs)
2. `INTEGRATION_NOTES.md` — exact list of files Mack replaces/creates, build order, any Xcode project changes needed
3. `bridge.mjs` changes if required for BUG-6 or BUG-10 (output separately, clearly labeled)
4. Flag anything that needs Michael's attention before ship

---

## Build 23 Wins to Preserve
All of these are already in Build 23 — do NOT regress:
- Settings gear button wired
- ComposerBar rounded card
- Message delivery badges (sending/sent/delivered)
- inferDirectAgentIDIfNeeded look-above routing
- pendingResponseChannels queue (fix the multi-block bug but keep the structure)
- 45s federation idle terminate + 15s ping
- History gating (didInitialScroll guard)
- Code block segments with copy button
