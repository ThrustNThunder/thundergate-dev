# ThunderGate

**Sovereign AI Agent Runtime for ThunderAI**

ThunderGate is the brain. One context, all channels. Learns from experience.

## Design Principles

1. **One Context File** — All channels read/write to single source of truth
2. **TUI Reads, Doesn't Own** — Runtime processes directly, TUI is just a window
3. **Parallel Processing** — Deep mode + surface layer when needed
4. **Event-Based Learning** — Triggers on meaningful moments, not intervals
5. **Hybrid Adaptive Loading** — Agent thinks on startup, pulls what's needed
6. **Doctor Mode Always On** — Pre-crash detection, auto-recovery
7. **7 Days Green = Cutover Ready** — Ghost Jon proves stability first

## Quick Start

```bash
# Install
npm install

# Start runtime
npm start

# Or with TypeScript directly
npm run dev
```

## Configuration

One config file: `~/.thundergate/config.json`

```json
{
  "model": {
    "mode": "auto",
    "primary": "anthropic/claude-sonnet-4-6",
    "reasoning": "anthropic/claude-opus-4-5"
  },
  "cache": {
    "hot": "1h",
    "warm": "24h",
    "cold": "7d",
    "archive": "forever"
  }
}
```

## Model Routing

Three modes:

| Mode | Behavior |
|------|----------|
| `auto` | Detects complexity, routes accordingly |
| `manual` | User picks model per request |
| `supersaver` | Lowest model, long cache, minimal reasoning |

**Commands:**
- `go big` — Force Opus for this task
- `go fast` — Force Sonnet, minimal reasoning
- `ask grok` — Route to xAI
- `ask gemini` — Route to Google

## CLI

```bash
thundergate start          # Start runtime
thundergate stop           # Stop runtime
thundergate status         # Show session state
thundergate doctor         # Run full diagnostic
thundergate doctor --watch # Live monitoring

# Ghost Jon (testing)
thundergate-ghost status
thundergate-ghost inject <task>
thundergate-ghost compare <input>
```

## Architecture

```
thundergate/
├── src/
│   ├── core/           # Runtime loop, message processing
│   ├── session/        # SQLite database, FTS5 search
│   ├── checkpoint/     # Adaptive loading system
│   ├── learning/       # Skills + memory, background review
│   ├── doctor/         # Health monitoring, crash detection
│   ├── comms/          # ThunderCommo integration
│   └── cli/            # CLI commands
├── config/
├── skills/
└── tests/
```

## Learning Loop

Event-based triggers:
1. Task completes
2. Correction from user
3. Session ends
4. Failure occurs
5. Every 20 turns (backstop)

**Memory** = facts about user, preferences, history
**Skills** = how to do tasks, procedures, lessons learned

## Doctor Mode

Always running health monitoring:
- CPU/Memory watchdog
- Context corruption detector
- Crash pattern detection (like 2026.4.26)
- Auto-recovery with checkpoint rollback

**7 days of Doctor green = ready for cutover**

## Ghost Jon

Shadow mode testing before cutover:
- Never live ops
- Training sessions from Jon Prime
- Direct CLI admin access
- Proves ThunderGate stability

## License

Proprietary — ThunderAI

---

*Built for ThunderMind. Designed for persistence.*
