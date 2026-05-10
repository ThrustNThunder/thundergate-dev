# Jon's iOS Slice — Build 23 Pass
## Date: May 10, 2026
## Files owned by Jon (do NOT touch Mack's files)

### Jon's files:
- `apps/ios/ThunderCommIOS/DeliveryCore.swift` — delivery state management
- `apps/ios/ThunderCommIOS/MessageListView.swift` — message list, look-above routing, streaming
- `apps/ios/ThunderCommIOS/LightweightContextEngine.swift` (NEW) — context inference

### Mack's files (DO NOT TOUCH):
- ContentView.swift, ComposerBar.swift, SettingsView.swift
- MessageBubble.swift, ThunderCommStore.swift, ThunderCommWebSocketClient.swift

### Boundary: ThunderCommModels.swift
- Flag any needed model changes BEFORE touching. Coordinate with Mack.

---

## Feature Scope for Jon's Slice

### 1. DeliveryCore.swift
Create or refactor delivery state as a clean, testable core:
- `DeliveryState` enum: `.sending`, `.sent`, `.delivered`, `.failed`
- `DeliveryCore` actor — owns delivery state map (messageId → DeliveryState)
- `arm(messageId:)` — registers a message as sending
- `markSent(messageId:)` — transitions to .sent
- `markDelivered(messageId:)` — transitions to .delivered (never downgrades)
- `markFailed(messageId:)` — transitions to .failed
- `state(for messageId:) -> DeliveryState` — read-only query
- `retryPending() -> [String]` — returns all .failed messageIds for retry on reconnect
- Keep it isolated — no UIKit/SwiftUI imports. Pure logic actor.
- ThunderCommStore can hold a DeliveryCore instance and call into it.

### 2. MessageListView.swift — Look-Above Context Engine
The "look above" routing that already exists needs to be cleaner and more robust:

**Current behavior:** When user sends a message in #tnt without naming an agent, 
look 1 message up for the last agent who spoke, route to them.

**What to improve:**
- Extract look-above logic into a clean function: `inferTargetAgent(from messages: [Message], channel: String) -> String?`
- Handle edge cases: what if the last message was from a human? Keep looking up (max 3 messages).
- What if channel is a direct (direct:jon)? Don't apply look-above — channel IS the target.
- Add a `LookAboveResult` enum: `.explicit(agentId)`, `.inferred(agentId, confidence)`, `.none`
- Log inferred routing at debug level so it's visible in testing.

**Thinking dots + live roster:**
- Thinking dots: confirm they show for ALL agents (not just Jon). If `thinkingAgentId` is set, show dots below last message from that agent.
- Live roster: when roster update arrives, update presence dots immediately. If agent disappears from roster, show offline. If new agent joins, add them.
- Roster updates should NOT trigger full list re-render — update only the affected roster item.

### 3. LightweightContextEngine.swift (NEW — only if needed)
If look-above logic grows beyond 30 lines, extract to its own file:
- `LightweightContextEngine` struct (not actor — stateless, functional)
- `inferRoute(messages: [Message], currentChannel: String, channelType: ChannelType) -> RouteDecision`
- `RouteDecision`: `.direct(agentId)`, `.broadcast`, `.inferred(agentId)`
- Unit-testable without any SwiftUI dependency

### Streaming view churn fix (BUG-7 — in MessageListView)
This is the B3 blocker from the gate report. Fix it here:
- Find the streaming row in MessageListView
- If it's keyed off `updatedAt` or similar timestamp, change to stable message ID
- The streaming row's view ID must be: `"streaming-\(message.id)"` — not time-based
- This prevents SwiftUI from rebuilding the entire row on every delta tick
- After fix: streaming text appends in-place without full row rebuild

---

## Output Instructions
1. Write complete Swift files to a local output folder: `/home/ubuntu/thundergate-dev/ios-jon-slice/`
2. Create the folder if it doesn't exist
3. Files: `DeliveryCore.swift`, `MessageListView.swift`, and optionally `LightweightContextEngine.swift`
4. Each file must compile standalone (no Xcode required to read)
5. Include inline comments explaining key decisions
6. Write `IOS_SLICE_NOTES.md` — what changed, what Mack needs to know before integrating
7. Flag any ThunderCommModels.swift changes needed (do NOT write them — just document)
8. Do NOT touch any of Mack's files

## Context
- Repo on Mack's Mac: `repos/thundergate-sparse/apps/ios/ThunderCommIOS.xcodeproj`
- Branch: thundercomm-ios
- Jon doesn't have direct Xcode access — output files, Mack integrates
- Wire protocol reference: /home/ubuntu/.openclaw/workspace/project_jon/THUNDERCOMM_IOS_HANDOFF.md
