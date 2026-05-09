# ThunderComm iOS Build Plan

## Goal
Ship a TestFlight prototype in the next couple days with the smallest viable surface that still grows cleanly into the real product:
- text only for v0.1
- one channel (`#tnt`)
- relay auth
- live send/receive
- reconnect behavior

## Endstate Michael wants
- text, voice in, TTS out
- file drop for PDFs, images, and general attachments
- clean human ↔ agent and agent ↔ agent communication
- simpler and stronger than Slack/WhatsApp/Telegram for AI-native work

## Phase split
### v0.1 TestFlight
- text send/receive only
- single `#tnt` view
- visible connection state
- stable reconnect behavior
- local config for endpoint/token

### v0.2
- voice capture / upload path
- TTS playback path
- message rows that can render audio state

### v0.3
- file / image / PDF attachment ingress
- richer message renderer and transfer state
- multi-channel / thread expansion only if needed

## Not in v0.1
- file drop implementation yet
- image upload implementation yet
- multi-channel navigation
- direct-agent routing controls in UI
- App Store polish beyond basic internal TestFlight readiness

## App shape
- `ThunderCommApp`
- `ContentView`
- `ConnectionStatusView`
- `MessageListView`
- `MessageBubble`
- `ComposerBar`
- `ThunderCommWebSocketClient`
- `ThunderCommStore`

## Data model
- connection state
- peer list
- message list
- local device peerId
- auth token
- endpoint host
- reserved message content kind (`text`, `audio`, `file`)
- reserved attachment metadata
- reserved playback / transfer status

## Message types to support
### outbound
1. `federation_auth`
2. `federation_message`

### inbound
1. `federation_status`
2. `federation_peers`
3. `federation_message`
4. websocket ping/pong handling

## Transport rule
Keep the v0.1 wire clean and compatible with Jon's locked contract, but shape the local app model so a future envelope can carry:
- text body
- audio metadata / URL / duration
- attachment metadata / URL / mime type / filename

## State machine
1. disconnected
2. connecting
3. authenticating
4. connected
5. reconnect_wait(backoff)
6. failed

## MVP acceptance
- user enters host/token or uses seeded config
- app connects to relay
- app authenticates with `channels: ["tnt"]`
- user sees inbound federated messages
- user can send message into `tnt`
- reconnect works after intentional disconnect / app foreground
- visible connection status in UI

## Immediate blockers
1. Install full Xcode
2. Confirm Apple Developer team / signing / TestFlight access
3. Pull Jon's final `IOS_CONTRACT.md` into local repo for exact parity
4. Verify current Tailscale relay endpoint before device testing (latest Jon-corrected value: `wss://100.113.210.59:8767`)

## First build sequence once Xcode lands
1. create SwiftUI iOS app target
2. drop in models + client scaffold
3. wire content view + composer
4. keep message row / store shapes extensible for audio + file states
5. test local simulator against reachable relay if possible
6. test on physical iPhone via signed dev build
7. push internal TestFlight build
