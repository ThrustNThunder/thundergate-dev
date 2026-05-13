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
import { GhostHarness, type GhostTurn } from '../ghost/harness.js';
import { getGhostSystemPrompt, setGhostContextDB } from '../ghost/context.js';
import { WorldState, ProcessingMode } from '../world/state.js';
import { ProvenanceLedger } from '../provenance/ledger.js';
import { LocalInferenceProvider } from '../inference/local_provider.js';
import { PromiseTracker } from '../memory/promises.js';
import { FrameManager } from '../memory/frame.js';
import { UntrainService, detectUntrainTrigger } from '../memory/untrain.js';
import { ProvisionalMemoryService } from '../memory/provisional.js';

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
  // Awareness substrate. WorldState holds the situational snapshot any
  // path can read before composing a turn (today: processingMode +
  // local-inference liveness; future: device, network, tone trend, …).
  // ProvenanceLedger is the audit log of state transitions. The
  // LocalInferenceProvider is what flips processingMode when ThunderMind
  // becomes reachable.
  private world: WorldState;
  private provenance!: ProvenanceLedger;
  private localInference!: LocalInferenceProvider;
  // Persistent-memory subsystems wired in Build 28 — promise tracker,
  // continuity frame manager, untrain audit, and the provisional-memory
  // promoter. All four read/write to context.db so they survive
  // gateway restarts.
  private promises!: PromiseTracker;
  private frames!: FrameManager;
  private untrain!: UntrainService;
  private provisional!: ProvisionalMemoryService;

  constructor(configPath?: string) {
    // Phase 3: ensureConfig writes the default config.json on first run
    // and then loads it. configPath override still honored for tests.
    this.config = configPath ? loadConfig(configPath) : ensureConfig();
    this.channels = new ChannelRegistry();
    this.world = new WorldState();
    this.state = {
      status: 'starting',
      sessionId: '',
      contextTokens: 0,
      deepModeActive: false,
      surfaceLayerActive: false,
      lastActivity: new Date()
    };
  }

  /** Awareness substrate — read by Doctor + the message path. */
  getWorldState(): WorldState {
    return this.world;
  }

  getLocalInference(): LocalInferenceProvider | undefined {
    return this.localInference;
  }

  getProvenanceLedger(): ProvenanceLedger | undefined {
    return this.provenance;
  }

  /** Accessors for CLI + Doctor. */
  getPromiseTracker(): PromiseTracker | undefined {
    return this.promises;
  }

  getFrameManager(): FrameManager | undefined {
    return this.frames;
  }

  getUntrainService(): UntrainService | undefined {
    return this.untrain;
  }

  getProvisionalService(): ProvisionalMemoryService | undefined {
    return this.provisional;
  }

  /** DB accessor — CLI needs it for read-only memory list. */
  getDB(): SessionDB | undefined {
    return this.db;
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

    // Provenance ledger + local inference probe come up before Doctor
    // so the first health tick sees the right liveness snapshot.
    this.provenance = new ProvenanceLedger(this.config.localInference.provenanceFile);
    this.localInference = new LocalInferenceProvider(this.config, this.world, this.provenance);
    this.localInference.start();
    if (this.config.localInference.enabled) {
      console.log(`  ✓ Local inference probe started (${this.config.localInference.endpoint})`);
    } else {
      console.log('  ℹ Local inference disabled in config — staying on cloud mode');
    }

    // Start doctor monitoring
    this.doctor = new Doctor(this);
    this.doctor.startMonitoring();
    console.log('  ✓ Doctor mode active');

    // Initialize learning trigger engine
    this.learning = new TriggerEngine(this.db, this.config.learning.backstopTurns);
    console.log('  ✓ Learning loop ready');

    // Persistent-memory subsystems. Order matters: provenance must
    // already exist (constructed above) so UntrainService can append.
    this.promises = new PromiseTracker(this.db);
    this.frames = new FrameManager(this.db);
    this.untrain = new UntrainService(this.db, this.provenance);
    this.provisional = new ProvisionalMemoryService(this.db);

    // Hydrate the most recent ACTIVE/PAUSED frame so the conversation
    // survives the restart. If nothing exists, the first inbound will
    // open a fresh frame.
    const hydrated = this.frames.hydrate();
    if (hydrated) {
      console.log(`  ✓ Frame hydrated: ${hydrated.id.slice(0, 8)} (${hydrated.status})`);
    } else {
      console.log('  ✓ No prior frame — first inbound opens a new one');
    }

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
        this.ghost = new GhostHarness(this.config, (input, history) =>
          this.shadowResponse(input, history)
        );
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

    // ── Frame lifecycle: advance/transition based on this inbound ──
    let frameDecision: ReturnType<FrameManager['onInbound']> | null = null;
    try {
      frameDecision = this.frames.onInbound({
        text: entry.text,
        sessionId: this.state.sessionId || undefined,
        deviceHint: channelId,
        modelInUse: this.config.runtime.model
      });
      if (frameDecision.transition === 'rejoined') {
        console.log(`  ↺ Frame rejoined ${frameDecision.frame.id.slice(0, 8)}: ${frameDecision.reason}`);
      } else if (frameDecision.transition === 'opened' && frameDecision.reason !== 'continuation within gap window') {
        console.log(`  ✱ Frame opened ${frameDecision.frame.id.slice(0, 8)}: ${frameDecision.reason}`);
      }
    } catch (err) {
      console.warn('  ⚠ frame.onInbound skipped:', (err as Error).message);
    }

    // ── Promise tracker: surface-on-gap + close-on-reference ──
    let surfaceLine = '';
    try {
      const senderLower = (entry.sender || '').toLowerCase();
      const pres = this.promises.onInbound({ text: entry.text, sender: senderLower });
      if (pres.surface.length > 0) {
        surfaceLine = this.promises.formatSurfaceLine(pres.surface);
        console.log(`  ⏳ Surfacing ${pres.surface.length} open promise(s) on gap-resume`);
      }
      if (pres.closed.length > 0) {
        console.log(`  ✓ Closed ${pres.closed.length} promise(s) on inbound reference`);
      }
    } catch (err) {
      console.warn('  ⚠ promises.onInbound skipped:', (err as Error).message);
    }

    // ── Untrain conversational trigger ──
    let untrainLine = '';
    try {
      if (detectUntrainTrigger(entry.text)) {
        const actor: 'jon' | 'michael' =
          (entry.sender || '').toLowerCase() === 'michael' ? 'michael' : 'jon';
        const confirm = this.untrain.conversationalUntrain({ actor });
        if (confirm) {
          untrainLine = confirm;
          console.log(`  ✂ Untrain (conversational): ${confirm}`);
        }
      }
    } catch (err) {
      console.warn('  ⚠ untrain trigger skipped:', (err as Error).message);
    }

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

    // ── Prepend surface lines: open-promises + untrain confirmation ──
    let composedText = response.content;
    if (untrainLine) composedText = `${untrainLine}\n\n${composedText}`;
    if (surfaceLine) composedText = `${surfaceLine}\n\n${composedText}`;

    // ── Promise extraction from the assistant's outbound text ──
    try {
      const extracted = this.promises.extractFromOutbound({
        text: response.content,
        sessionId: this.state.sessionId || null,
        channel: channelId
      });
      if (extracted.count > 0) {
        console.log(`  📌 Captured ${extracted.count} promise(s) from outbound`);
      }
    } catch (err) {
      console.warn('  ⚠ promise extraction skipped:', (err as Error).message);
    }

    const delivery: OutboundDelivery = {
      id: newMessageId(),
      agentId: 'jon',
      sender: 'Jon',
      channel: channelId,
      text: composedText,
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
   *      is amortized across the day's shadow calls. The recent per-session
   *      turn history (snapshotted by the harness at fire time) goes into
   *      the messages array as alternating user/assistant turns, followed
   *      by the new user input. Static block stays cacheable; only the
   *      tail varies per call.
   *   3. Return the text response to the harness for logging. We never
   *      deliver this to a channel and never write it to the session DB.
   */
  private async shadowResponse(input: string, history: GhostTurn[]): Promise<string> {
    const system = getGhostSystemPrompt();
    return this.callGhostLLM(system, input, history);
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
  private async callGhostLLM(
    system: string,
    userInput: string,
    history: GhostTurn[] = []
  ): Promise<string> {
    const model = this.config.ghost.model;
    const maxTokens = this.config.ghost.maxTokens;
    const temperature = this.config.ghost.temperature;

    // Build the chat tail: prior turns (oldest first) + the current user
    // input. Anthropic requires alternating user/assistant roles starting
    // with user — sanitizeHistory enforces that even if the JSONL stream
    // produced an out-of-order sequence.
    const chat = sanitizeHistory(history);
    chat.push({ role: 'user', content: userInput });

    if (!(model.startsWith('anthropic/') || model.startsWith('claude-'))) {
      // Ghost path is Anthropic-only — caching semantics differ per provider
      // and the brief locks Ghost on Haiku 4.5. Fall back to the shared
      // path for any non-Anthropic override so config typos don't 500.
      return this.callLLM([
        { role: 'system', content: system },
        ...chat
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
      messages: chat
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
   * Normal processing — full context, full reasoning.
   *
   * Forks on `world.processingMode`. The CLOUD branch keeps today's
   * behavior byte-for-byte (this is the production path). The
   * LOCAL_INFERENCE branch unlocks a more aggressive algorithm —
   * larger context window target, more RAG, background pre-processing
   * hooks. Those hooks are stubs for now since ThunderMind isn't built;
   * the wiring is the point so the surface is ready when it lands.
   */
  private async normalProcess(message: Message): Promise<Response> {
    // Check if this triggers deep mode
    const isComplex = this.evaluateComplexity(message);

    if (isComplex) {
      this.enterDeepMode();
    }

    const mode = this.world.effectiveMode();
    const response = mode === ProcessingMode.LOCAL_INFERENCE
      ? await this.processLocalInference(message)
      : await this.processCloud(message);

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
   * Cloud processing — unchanged from pre-dual-mode behavior. Single
   * user-turn into callLLM. Cost-aware, conservative context. This is
   * the path that runs every time ThunderMind isn't up.
   */
  private async processCloud(message: Message): Promise<Response> {
    const text = await this.callLLM([{ role: 'user', content: message.content }]);
    return { content: text, type: 'normal' };
  }

  /**
   * Local-inference processing — runs when ThunderMind / a local 70B is
   * reachable. Differences vs. cloud, per Michael's brief:
   *   - Longer context window target (config.localInference.contextWindowTarget)
   *   - More aggressive RAG retrieval (ragResultsLimit)
   *   - Background pre-processing hooks light up
   *   - No cost-conservation compression
   *
   * Today this is a thin shim that records *what would change* into
   * provenance and falls back to the cloud LLM call. We deliberately
   * don't route to the local endpoint yet: ThunderMind isn't built,
   * the probe being "green" against a non-existent endpoint would be
   * a bug, and we don't want the runtime making real calls to a
   * placeholder. The real routing lands when ThunderMind exists.
   */
  private async processLocalInference(message: Message): Promise<Response> {
    this.provenance.append({
      actor: 'runtime',
      action: 'process_local_inference',
      target: 'message',
      reason: 'processingMode = LOCAL_INFERENCE',
      data: {
        contextWindowTarget: this.config.localInference.contextWindowTarget,
        ragResultsLimit: this.config.localInference.ragResultsLimit,
        backgroundPreprocessing: this.config.localInference.enableBackgroundPreprocessing,
        endpoint: this.config.localInference.endpoint
      }
    });

    // Stub: aggressive-RAG hook. Real implementation pulls
    // `ragResultsLimit` rows from FTS5/embedding store and prepends them
    // as context blocks. Today the cloud path already runs without any
    // RAG, so we leave the call site stubbed and tracked in provenance
    // so it's discoverable once embeddings ship.
    void this.localInferenceRagStub(message);

    // Stub: background pre-processing. Real impl kicks off summarization,
    // memory extraction, and proactive triggers on a worker. Stub now —
    // wiring the runtime to spawn work it can't yet complete would be
    // worse than a no-op with a provenance trail.
    if (this.config.localInference.enableBackgroundPreprocessing) {
      this.backgroundPreprocessStub(message);
    }

    // Until ThunderMind has a confirmed routing target, the actual LLM
    // call still goes through `callLLM`. The brief explicitly requires
    // graceful fallback when the local endpoint isn't real — this is it.
    const text = await this.callLLM([{ role: 'user', content: message.content }]);
    return { content: text, type: 'normal' };
  }

  /** Hook for aggressive RAG retrieval under LOCAL_INFERENCE mode. */
  private async localInferenceRagStub(_message: Message): Promise<void> {
    // Intentional no-op stub. Real implementation: pull
    // config.localInference.ragResultsLimit rows from the FTS5 search +
    // embedding store and prepend as context blocks.
  }

  /** Hook for background pre-processing under LOCAL_INFERENCE mode. */
  private backgroundPreprocessStub(_message: Message): void {
    // Intentional no-op stub. Real implementation: queue summarization,
    // memory extraction, and proactive-trigger evaluation on a worker.
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

    // Stop local inference probe.
    try { this.localInference?.stop(); } catch { /* ignore */ }

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

/**
 * Coerce a stream of harness-captured turns into the strict alternating
 * user→assistant→user…→assistant shape Anthropic's Messages API demands.
 * Drops empty-text turns and collapses adjacent same-role turns by
 * keeping the last one (the freshest text in that role wins). If the
 * sequence would start with an assistant turn we drop it — the first
 * turn of an Anthropic call must be `user`.
 */
function sanitizeHistory(history: GhostTurn[]): Array<{ role: string; content: string }> {
  const cleaned: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const turn of history) {
    const text = (turn.text ?? '').trim();
    if (!text) continue;
    const last = cleaned[cleaned.length - 1];
    if (last && last.role === turn.role) {
      last.content = text;
    } else {
      cleaned.push({ role: turn.role, content: text });
    }
  }
  while (cleaned.length > 0 && cleaned[0].role !== 'user') {
    cleaned.shift();
  }
  return cleaned;
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
