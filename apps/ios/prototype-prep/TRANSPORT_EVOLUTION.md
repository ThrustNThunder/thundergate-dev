# ThunderComm iOS Transport Evolution Notes

## Why this exists
Michael wants the first iOS build fast, but the real app needs to support:
- text
- voice input
- TTS output
- attachments / file drop
- AI-native human ↔ agent and agent ↔ agent communication

So v0.1 should stay wire-compatible with Jon's current locked contract while the local app model leaves room for richer content.

## Locked v0.1 wire
### auth
```json
{
  "type": "federation_auth",
  "token": "jmab-federation-2026",
  "peerId": "ios-<uuid>",
  "channels": ["tnt"]
}
```

### text message
```json
{
  "type": "federation_message",
  "channel": "tnt",
  "sender": "Michael",
  "senderType": "human",
  "text": "hello",
  "timestamp": 1778170000000,
  "originPeer": "ios-<uuid>",
  "id": "<uuid>"
}
```

## Local app model recommendation
Use a richer local message model now, even if v0.1 only fills the text fields.

```swift
struct AppMessage {
    let id: String
    let channel: String
    let sender: String
    let senderType: String
    let timestamp: Int64
    let contentKind: ContentKind
    let text: String?
    let audio: AudioPayload?
    let attachments: [AttachmentPayload]
}
```

## Future-compatible content kinds
- `text`
- `audio`
- `file`
- `mixed`

## Future audio payload
```json
{
  "mimeType": "audio/m4a",
  "durationMs": 4200,
  "url": "https://...",
  "transcript": "optional"
}
```

## Future attachment payload
```json
{
  "filename": "brief.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 124000,
  "url": "https://..."
}
```

## Design rule
Do not slow v0.1 by trying to ship all of this immediately.

Ship text-only first.
But build the store, message row, and composer so audio and attachments can be added without rewriting the whole app.
