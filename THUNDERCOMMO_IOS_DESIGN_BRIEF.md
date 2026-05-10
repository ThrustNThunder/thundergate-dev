# ThunderCommo iOS — Design & UX Brief
## Date: May 10, 2026
## From: Jon | ThunderBase
## To: CLI Jon → Mack (builder/shipper)

---

## The Product Identity

ThunderCommo is NOT a human-to-human chat app.
It is an **agent-to-human collaboration app** — a place where AI agents and their humans sync up, communicate, and work together.

Design must reflect this. Agents are first-class citizens. The experience is built around the agent relationship, not around human group chat.

**Reference aesthetic:** Slack iOS (dark theme, sidebar nav, clean channel list, purple accent) — but with ThunderCommo's agent-specific identity layered on top.

---

## End-State App Flow (Non-Negotiable)

### 1. Onboarding — New User

```
Launch → Splash (⚡ ThunderCommo wordmark, dark bg, purple gradient)
       → Sign Up screen
            - Email
            - Password
            - Phone number (for recovery/alerts)
            - Handle (@username for the chat)
       → "Now let's add your agent" screen
            - Option A: QR Code scan (agent generates QR)
            - Option B: KYA (Know Your Agent) — agent intro screen
            - Option C: BYOAA (Bring Your Own Agent API) — manual token + gateway URL entry
            - Option D: Direct token assignment (paste token)
       → Connected ✅ → Home screen
```

### 2. Returning User
```
Launch → Face ID / biometric auth → Home screen (last active channel)
```

### 3. Home Screen — Slack Sidebar Layout
```
┌─────────────────────────────┐
│ ⚡ ThunderCommo    [avatar] │  ← Purple gradient header
│ @michael          [status] │
├─────────────────────────────┤
│ CHANNELS                    │
│  # tnt                      │  ← Active = left purple border + bg highlight
│  # team-jmab               │
│  + Add channel              │  ← + button inline
├─────────────────────────────┤
│ AGENTS                      │
│  ● Jon          [online]    │  ← Green dot = online
│  ○ Mack         [offline]   │  ← Gray dot = offline  
│  ● Rex          [online]    │
│  + Add agent                │  ← + button inline
├─────────────────────────────┤
│ DIRECT MESSAGES             │
│  Burt                       │
│  Alex                       │
└─────────────────────────────┘
```

Tap channel or agent → main chat view loads that conversation.

### 4. Chat View
- Messages flat (no bubbles) — Slack style
- Agent messages: agent name + model indicator pill (small, subtle)
- Thinking dots when agent is processing
- Streaming text appears word by word
- Input bar at bottom: pill shape, mic button + text field + send button (purple filled circle)
- "+" icon in input area or header → add to channel, mention agent, attach

### 5. Adding Agents / Channels
- `+` button in sidebar AGENTS section → add agent flow (same as onboarding options)
- `+` button in sidebar CHANNELS section → create channel or join by name
- Agent can also push a channel invite (agent-initiated channel creation)

---

## Visual Design System

### Colors
- Background: `#1a1d21`
- Sidebar: `#19171d` (subtle purple tint)
- Header gradient: `#6b2fa0 → #4a1a7a`
- Active item: `#27242c` + 3px `#6b2fa0` left border
- Accent/CTA: `#6b2fa0`
- Text primary: `#d1d2d3`
- Text muted: `#7b7d82`
- Online dot: `#2bac76` with glow
- Offline dot: hollow ring `#7b7d82`

### Typography
- System font (SF Pro on iOS)
- Section labels: 11px, ALL CAPS, tracking 0.1em, muted
- Channel names: 15px, medium weight
- Active channel: 15px, semibold
- Message author: 15px, bold
- Message body: 15px, regular
- Model indicator: 11px pill, muted purple bg

### Layout
- Sidebar: 280px, slides in from left (hamburger toggle on mobile)
- Safe area padding: respected everywhere (notch, home indicator)
- Bottom tab bar (optional): Home | DMs | Activity | Search
  OR just the sidebar — keep it simple, don't force tab bar if sidebar handles it

---

## Current Build State (Build 22 → Build 23)

Build 22 is live on TestFlight. Build 23 source is staged locally on Mack's machine.

### What Build 23 has (Mack confirmed staged):
- UI/routing fixes from overnight

### What still needs work (for CLI Jon to address in Build 23):
1. **Full Slack-style sidebar** — current sidebar exists but needs the visual overhaul above
2. **Onboarding flow** — existing signup + add-agent screens from build-20-redesign need to match the flow spec above. Verify the flow is complete end-to-end: splash → signup → add agent → home.
3. **Agent section in sidebar** — currently just DMs, needs an explicit "AGENTS" section with presence dots
4. **+ buttons** — add agent and add channel inline in sidebar sections
5. **Chat view visual polish** — flat messages, model indicator pill, thinking dots, streaming
6. **Input bar** — pill shape matching web UI style

### Do NOT change:
- WebSocket connection logic
- Auth flow that's already working (signup/signin/Face ID/BYOAA)
- Wire protocol handling
- APNs/notification code

---

## Instructions for CLI Jon

1. Read this brief fully
2. Read the existing iOS source in the build-20-redesign branch of ThunderCommIOS.xcodeproj (Mack has this locally)
3. Read project_jon/PROJECT_MACK.md for product vision
4. Produce a complete set of Swift file changes that implement:
   - The Slack-inspired visual design system above
   - The complete onboarding flow (splash → signup → add agent → home)
   - The sidebar with CHANNELS / AGENTS / DIRECT sections + inline + buttons
   - Flat message style with agent indicators
5. Output changes as files with clear paths — Mack will integrate
6. DO NOT push anything
7. Write an INTEGRATION_NOTES.md for Mack with exactly what to change and where

---

## Key Principle

The app should feel like Slack — but when you open it, it's clearly built for agents. The first thing you add isn't a coworker. It's your AI. That's the ThunderCommo twist.
