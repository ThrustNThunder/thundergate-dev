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
import { GhostHarness } from '../ghost/harness.js';
import { randomUUID } from 'crypto';

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
    await this.channels.startAll();

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
   * Ghost shadow path. Same processMessage pipeline as the live one but
   * the result never reaches a channel — it is returned to the harness
   * to be logged.
   */
  private async shadowResponse(input: string): Promise<string> {
    const message: Message = {
      id: randomUUID(),
      channel: 'ghost',
      content: input,
      sender: 'openclaw-shadow',
      timestamp: new Date()
    };
    const response = await this.processMessage(message);
    return response?.content ?? '';
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
    const response = await this.callLLM(message);

    // Trigger engine: backstop check on each turn
    await this.learning.onTurn(message.content, response.content);

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
   * Call LLM with appropriate model based on routing config
   */
  private async callLLM(message: Message): Promise<Response> {
    // TODO: Implement LLM routing
    // - Check config.model.mode (auto/manual/supersaver)
    // - Route to appropriate model
    // - Handle "go big", "go fast", "ask grok" commands
    return { content: '', type: 'normal' };
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
