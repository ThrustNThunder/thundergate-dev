/**
 * ThunderGate Runtime — Core Engine
 * 
 * The brain. One context, all channels. Learns from experience.
 * 
 * Design Principles:
 * - One context file, all channels read/write
 * - TUI reads from session, doesn't own it
 * - Parallel processing (deep + surface) when needed
 * - Event-based learning loop
 * - Hybrid adaptive checkpoint loading
 * - Doctor mode always running
 */

import { SessionDB } from '../session/database.js';
import { CheckpointData, saveCheckpoint, loadCheckpoint } from '../checkpoint/save.js';
import { TriggerEngine } from '../learning/triggers.js';
import { Doctor } from '../doctor/monitor.js';
import { Config, loadConfig } from '../config/loader.js';
import { ensureConfig } from '../config/index.js';
import { ChannelRegistry, type ContextEntry, type OutboundDelivery } from '../channels/index.js';
import { ThunderCommoChannel, newMessageId } from '../channels/thundercommo.js';
import { BrowserBridgeChannel } from '../channels/browser.js';
import { GhostHarness } from '../ghost/harness.js';
import { getGhostSystemPrompt, setGhostContextDB } from '../ghost/context.js';

// Runtime state
interface RuntimeState {
  status: 'starting' | 'running' | 'deep_mode' | 'stopping' | 'stopped';
  sessionId: string;
  contextTokens: number;
  deepModeActive: boolean;
  surfaceLayerActive: boolean;
  lastActivity: Date;
}

export class ThunderGateRuntime {
  private config: Config;
  private db!: SessionDB;
  private checkpoint!: CheckpointData;
  private learning!: TriggerEngine;
  private doctor!: Doctor;
  private channels: ChannelRegistry;
  private ghost: GhostHarness | null = null;
  private state: RuntimeState;

  constructor(configPath?: string) {
    // Phase 3: ensureConfig writes the default config.json on first run
    // and then loads it. configPath override still honored for tests.
    this.config = configPath ? loadConfig(configPath) : ensureConfig();
    this.channels = new ChannelRegistry();
    this.state = {
      status: 'starting',
      sessionId: '',
      contextTokens: 0,
      deepModeActive: false,
      surfaceLayerActive: false,
      lastActivity: new Date()
    };
  }

  /** Public accessor — used by Doctor and CLI ghost commands. */
  getConfig(): Config {
    return this.config;
  }

  getChannels(): ChannelRegistry {
    return this.channels;
  }

  getGhost(): GhostHarness | null {
    return this.ghost;
  }

  /**
   * Start the runtime
   * 1. Initialize database
   * 2. Load checkpoint (adaptive)
   * 3. Start doctor monitoring
   * 4. Begin message loop
   */
  async start(): Promise<void> {
    console.log('⚡ ThunderGate starting...');

    // Initialize session database
    this.db = new SessionDB(this.config.database.path);
    await this.db.initialize();
    // Wire the DB into the Ghost context loader so recent memories
    // (corrections, preferences, facts written by the learning loop)
    // land in the next shadow turn's system prompt. Without this the
    // learning loop is write-only.
    setGhostContextDB(this.db);
    console.log('  ✓ Session database initialized');

    // Load checkpoint (hybrid adaptive)
    this.checkpoint = loadCheckpoint() ?? saveCheckpoint({});
    this.state.contextTokens = this.checkpoint.contextTokenEstimate;
    console.log(`  ✓ Checkpoint loaded (${this.checkpoint.contextTokenEstimate} tokens)`);

    // Start doctor monitoring
    this.doctor = new Doctor(this);
    this.doctor.startMonitoring();
    console.log('  ✓ Doctor mode active');

    // Initialize learning trigger engine
    this.learning = new TriggerEngine(this.db, this.config.learning.backstopTurns);
    console.log('  ✓ Learning loop ready');

    // Phase 3: register and start native channels.
    if (this.config.channels.thundercommo.enabled) {
      this.channels.register(new ThunderCommoChannel({
        config: this.config,
        db: this.db,
        contextFile: this.config.runtime.context_file,
        onInbound: (entry) => this.handleChannelInbound(entry)
      }));
    }
    // TB-0-6: ThunderBrowser bridge. Runs on its own port (default 9876)
    // and only talks to the extension SW — runtime-level integration with
    // an action executor lands in TB-1-3+ once the inbound `cmd_result`
    // path is plumbed back into a request/response map.
    if (this.config.channels.browser?.enabled) {
      const b = this.config.channels.browser;
      const opts: Record<string, unknown> = {
        port: b.port ?? 9876,
        maxQueuePerClient: b.max_queue_per_client ?? 256,
        acceptUnverifiedPairing: b.accept_unverified_pairing ?? true
      };
      if (b.audit_file) opts.auditFile = b.audit_file;
      this.channels.register(new BrowserBridgeChannel(
        {
          config: this.config,
          db: this.db,
          contextFile: this.config.runtime.context_file,
          onInbound: (entry) => this.handleChannelInbound(entry)
        },
        opts
      ));
    }
    // Channel startup is non-fatal — bridge.mjs may already hold port 8765
    // in parallel-deployment mode. Surface the reason so `thundergate doctor`
    // output explains why the channel shows ❌ instead of silently swallowing
    // it. Per-channel failures are isolated by ChannelRegistry.startAll() so
    // a port conflict on one channel doesn't block the others.
    try {
      await this.channels.startAll();
    } catch (err) {
      const msg = (err as Error).message;
      const isPortConflict = /EADDRINUSE|address already in use/i.test(msg);
      if (isPortConflict) {
        console.log(`  ℹ Channel startup deferred: ${msg} (parallel-deployment mode)`);
      } else {
        console.warn('  ⚠ Channel startup error (non-fatal):', msg);
      }
    }

    // Phase 3: start Ghost harness if configured. Failure is non-fatal.
    if (this.config.ghost.enabled) {
      try {
        this.ghost = new GhostHarness(this.config, (input) => this.shadowResponse(input));
        await this.ghost.start();
      } catch (err) {
        console.warn('  ⚠ Ghost harness failed to start:', err);
        this.ghost = null;
      }
    }

    // Ready
    this.state.status = 'running';
    this.state.sessionId = this.checkpoint.sessionId;
    console.log('⚡ ThunderGate running');
  }

  /**
   * Channel inbound hook. Routes to runtime, then broadcasts the runtime's
   * response back through every running channel that subscribed to the
   * same channel id.
   */
  private async handleChannelInbound(entry: ContextEntry): Promise<void> {
    const channelId = entry.channel.replace(/^thundercommo:/, '');
    const message: Message = {
      id: entry.id,
      channel: channelId,
      content: entry.text,
      sender: entry.sender,
      timestamp: new Date(entry.timestamp)
    };

    let response: Response;
    try {
      response = await this.processMessage(message);
    } catch (err) {
      console.error('  ✗ runtime.processMessage threw:', err);
      response = {
        content: `[runtime error: ${(err as Error).message}]`,
        type: 'normal'
      };
    }

    if (!response?.content) return;

    const delivery: OutboundDelivery = {
      id: newMessageId(),
      agentId: 'jon',
      sender: 'Jon',
      channel: channelId,
      text: response.content,
      timestamp: Date.now(),
      model: this.config.runtime.model
    };
    this.channels.broadcast(delivery);
  }

  /**
   * Ghost shadow path. Routes around the live `callLLM` so cache discipline
   * and identity-framing for Ghost can evolve independently of the primary
   * runtime — mixing the two regressed Ghost previously (no system prompt,
   * stock-Haiku behavior, 0% match rate).
   *
   * Pipeline:
   *   1. Pull Ghost's assembled system prompt from `ghost/context.ts`
   *      (SOUL + USER + IDENTITY + GHOST_ADDENDUM, hot-reloaded on file change).
   *   2. Call Anthropic Messages with the system block marked
   *      `cache_control: { type: "ephemeral" }` so the ~15K-token frame
   *      is amortized across the day's shadow calls. Only the current
   *      user input goes in the messages array — no prior turns, no
   *      runtime context leakage.
   *   3. Return the text response to the harness for logging. We never
   *      deliver this to a channel and never write it to the session DB.
   */
  private async shadowResponse(input: string): Promise<string> {
    const system = getGhostSystemPrompt();
    return this.callGhostLLM(system, input);
  }

  /**
   * Anthropic-only LLM path used exclusively by Ghost Jon. Kept separate
   * from `callLLM` so:
   *   - Cache discipline on the system block stays clean (one static
   *     block, ephemeral cache_control, no interleaved per-call context).
   *   - Tweaks to the live runtime's prompt assembly can't silently
   *     regress shadow scoring, and vice versa.
   *
   * Returns an empty string on transport failure rather than throwing —
   * the harness logs absent responses as `[ghost: not yet ready]` and
   * Doctor surfaces that as an error-rate signal.
   */
  private async callGhostLLM(system: string, userInput: string): Promise<string> {
    const model = this.config.ghost.model;
    const maxTokens = this.config.ghost.maxTokens;
    const temperature = this.config.ghost.temperature;

    if (!(model.startsWith('anthropic/') || model.startsWith('claude-'))) {
      // Ghost path is Anthropic-only — caching semantics differ per provider
      // and the brief locks Ghost on Haiku 4.5. Fall back to the shared
      // path for any non-Anthropic override so config typos don't 500.
      return this.callLLM([
        { role: 'system', content: system },
        { role: 'user', content: userInput }
      ]);
    }

    const apiKey = this.config.anthropicApiKey;
    if (!apiKey) {
      console.warn('  ⚠ callGhostLLM: anthropicApiKey not set');
      return '';
    }
    const anthropicModel = model.replace(/^anthropic\//, '');

    const body = {
      model: anthropicModel,
      max_tokens: maxTokens,
      temperature,
      system: [
        {
          type: 'text',
          text: system,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [{ role: 'user', content: userInput }]
    };

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        console.warn(`  ⚠ Ghost LLM ${response.status}: ${await response.text()}`);
        return '';
      }
      const data: any = await response.json();
      const block = Array.isArray(data.content)
        ? data.content.find((b: any) => b?.type === 'text')
        : null;
      return block?.text ?? '';
    } catch (err) {
      console.warn('  ⚠ Ghost LLM transport error:', (err as Error).message);
      return '';
    }
  }

  /**
   * Persist current checkpoint state
   */
  async saveCheckpoint(): Promise<void> {
    this.checkpoint = saveCheckpoint(this.checkpoint);
  }

  /**
   * Process incoming message
   * Routes to deep or surface based on current state
   */
  async processMessage(message: Message): Promise<Response> {
    this.state.lastActivity = new Date();

    // If in deep mode, route to surface layer
    if (this.state.deepModeActive && this.state.surfaceLayerActive) {
      return this.surfaceProcess(message);
    }

    // Normal processing
    return this.normalProcess(message);
  }

  /**
   * Normal processing — full context, full reasoning
   */
  private async normalProcess(message: Message): Promise<Response> {
    // Check if this triggers deep mode
    const isComplex = this.evaluateComplexity(message);
    
    if (isComplex) {
      this.enterDeepMode();
    }

    // Process with LLM
    const text = await this.callLLM([{ role: 'user', content: message.content }]);
    const response: Response = { content: text, type: 'normal' };

    // Trigger engine: backstop check on each turn. Skip for ghost shadow
    // traffic — those messages have no real session row in the DB, so the
    // FK-constrained insert would throw. The JSONL ghost log is the truth
    // seam for shadow runs.
    if (!message.ghost) {
      try {
        await this.learning.onTurn(message.content, response.content);
      } catch (err) {
        console.warn('  ⚠ learning.onTurn skipped:', (err as Error).message);
      }
    }

    return response;
  }

  /**
   * Surface processing — minimal context, quick response
   * Only active when deep mode is engaged
   */
  private async surfaceProcess(message: Message): Promise<Response> {
    // Quick evaluation: urgent or routine?
    const isUrgent = this.evaluateUrgency(message);

    if (isUrgent) {
      // Interrupt deep mode
      this.exitDeepMode();
      return this.normalProcess(message);
    }

    // Quick response without interrupting deep work
    return {
      content: `Heads down on a task. Will respond fully in a few minutes.`,
      type: 'surface'
    };
  }

  /**
   * Enter deep mode — activate surface layer
   */
  private enterDeepMode(): void {
    this.state.deepModeActive = true;
    this.state.surfaceLayerActive = true;
    this.state.status = 'deep_mode';
    console.log('  → Entering deep mode, surface layer active');
  }

  /**
   * Exit deep mode — deactivate surface layer
   */
  private exitDeepMode(): void {
    this.state.deepModeActive = false;
    this.state.surfaceLayerActive = false;
    this.state.status = 'running';
    console.log('  → Exiting deep mode');
  }

  /**
   * Evaluate if message requires deep mode
   */
  private evaluateComplexity(message: Message): boolean {
    // TODO: Implement complexity detection
    // - Multi-step task indicators
    // - Explicit "go big" command
    // - Code review, strategy, planning keywords
    return false;
  }

  /**
   * Evaluate if message is urgent (should interrupt deep mode)
   */
  private evaluateUrgency(message: Message): boolean {
    // TODO: Implement urgency detection
    // - Explicit /urgent command
    // - Emergency keywords
    // - Michael override
    return false;
  }

  /**
   * Call the configured ghost LLM with a chat-style message array.
   *
   * Routing is driven by `config.ghost.model`:
   *   - `openai/...` or `gpt-...`  → OpenAI Chat Completions
   *   - `anthropic/...` or `claude-...` → Anthropic Messages API
   *
   * Anthropic does not accept inline `system` messages, so any system
   * roles are concatenated into a single top-level `system` field.
   * Returns an empty string on transport failure rather than throwing —
   * Ghost mode logs failures via the harness; deep routing isn't wired yet.
   */
  async callLLM(
    messages: Array<{ role: string; content: string }>
  ): Promise<string> {
    const model = this.config.ghost.model;
    const maxTokens = this.config.ghost.maxTokens;
    const temperature = this.config.ghost.temperature;

    try {
      if (model.startsWith('openai/') || model.startsWith('gpt-')) {
        const apiKey = this.config.openaiApiKey;
        if (!apiKey) {
          console.warn('  ⚠ callLLM: OPENAI_API_KEY not set');
          return '';
        }
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: model.replace(/^openai\//, ''),
            messages,
            max_tokens: maxTokens,
            temperature
          })
        });
        if (!response.ok) {
          console.warn(`  ⚠ OpenAI API ${response.status}: ${await response.text()}`);
          return '';
        }
        const data: any = await response.json();
        return data.choices?.[0]?.message?.content ?? '';
      }

      if (model.startsWith('anthropic/') || model.startsWith('claude-')) {
        const apiKey = this.config.anthropicApiKey;
        if (!apiKey) {
          console.warn('  ⚠ callLLM: anthropicApiKey not set');
          return '';
        }
        const anthropicModel = model.replace(/^anthropic\//, '');

        // Split out system messages — Anthropic wants a top-level system field.
        const systemParts: string[] = [];
        const chat: Array<{ role: string; content: string }> = [];
        for (const m of messages) {
          if (m.role === 'system') systemParts.push(m.content);
          else chat.push(m);
        }

        const body: Record<string, unknown> = {
          model: anthropicModel,
          max_tokens: maxTokens,
          temperature,
          messages: chat
        };
        if (systemParts.length > 0) body.system = systemParts.join('\n\n');

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify(body)
        });
        if (!response.ok) {
          console.warn(`  ⚠ Anthropic API ${response.status}: ${await response.text()}`);
          return '';
        }
        const data: any = await response.json();
        const block = Array.isArray(data.content)
          ? data.content.find((b: any) => b?.type === 'text')
          : null;
        return block?.text ?? '';
      }

      console.warn(`  ⚠ callLLM: unrecognized model ${model}`);
      return '';
    } catch (err) {
      console.warn('  ⚠ callLLM transport error:', (err as Error).message);
      return '';
    }
  }

  /**
   * Get current runtime state (for doctor, TUI, etc.)
   */
  getState(): RuntimeState {
    return { ...this.state };
  }

  /**
   * Graceful shutdown
   */
  async stop(): Promise<void> {
    console.log('⚡ ThunderGate stopping...');
    this.state.status = 'stopping';

    // Stop ghost first (read-only, but cleanly close watchers).
    if (this.ghost) {
      try { await this.ghost.stop(); } catch { /* ignore */ }
      this.ghost = null;
    }

    // Stop channels — drain client connections.
    try { await this.channels.stopAll(); } catch { /* ignore */ }
    console.log('  ✓ Channels stopped');

    // Detach the DB from the Ghost context loader so a future restart
    // doesn't see a stale handle.
    try { setGhostContextDB(null); } catch { /* ignore */ }

    // Save checkpoint before stopping
    await this.saveCheckpoint();
    console.log('  ✓ Checkpoint saved');

    // Stop doctor
    this.doctor.stopMonitoring();
    console.log('  ✓ Doctor stopped');

    // Close database
    await this.db.close();
    console.log('  ✓ Database closed');

    this.state.status = 'stopped';
    console.log('⚡ ThunderGate stopped');
  }
}

// Types
interface Message {
  id: string;
  channel: string;
  content: string;
  sender: string;
  timestamp: Date;
  // Marks a shadow/Ghost Jon message. Shadow traffic must not touch the
  // session DB — there is no parent session row to satisfy the FK.
  ghost?: boolean;
}

interface Response {
  content: string;
  type: 'normal' | 'surface' | 'deep';
}

// Main entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const runtime = new ThunderGateRuntime();
  runtime.start().catch(console.error);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    await runtime.stop();
    process.exit(0);
  });
}
