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

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname as pathDirname, resolve as pathResolve } from 'path';
import { SessionDB } from '../session/database.js';
import { CheckpointData, saveCheckpoint, loadCheckpoint } from '../checkpoint/save.js';
import { TriggerEngine } from '../learning/triggers.js';
import { Doctor } from '../doctor/monitor.js';
import { Config, loadConfig } from '../config/loader.js';
import { ensureConfig } from '../config/index.js';
import { ChannelRegistry, type ContextEntry, type OutboundDelivery } from '../channels/index.js';
import { ThunderCommoChannel, newMessageId } from '../channels/thundercommo.js';
import { BrowserBridgeChannel } from '../channels/browser.js';
import {
  GhostHarness,
  type GhostResponderOpts,
  type GhostTurn,
  type StateSnapshotSource
} from '../ghost/harness.js';
import { GhostEvaluator } from '../ghost/evaluator.js';
import { getGhostSystemPrompt, setGhostContextDB } from '../ghost/context.js';
import { WorldState, ProcessingMode } from '../world/state.js';
import { ProvenanceLedger } from '../provenance/ledger.js';
import { BrowserBridge, DEFAULT_BROWSER_BRIDGE_PORT } from '../browser/bridge.js';
import { LocalInferenceProvider } from '../inference/local_provider.js';
import { PromiseTracker } from '../memory/promises.js';
import { FrameManager } from '../memory/frame.js';
import { UntrainService, detectUntrainTrigger } from '../memory/untrain.js';
import { ProvisionalMemoryService } from '../memory/provisional.js';
import { MemoryWAL } from '../memory/wal.js';
import { VaultService } from '../vault/vault.js';
import { VaultProtocol } from '../vault/protocol.js';
import type { VaultProviderRegistry } from '../vault/registry.js';

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
  // Native runtime bridge to the ThunderBrowser extension. Listens on a
  // dedicated port (default 8770) and exposes browser.click()/fill()/
  // getState() as direct async calls — the brain commanding the arm.
  // Unlike `BrowserBridgeChannel`, this is not a channel: there's no
  // queueing, no per-peer audit chain, just request/response over a
  // single live extension socket. Absence of an extension is a no-op.
  private browser!: BrowserBridge;
  // Persistent-memory subsystems wired in Build 28 — promise tracker,
  // continuity frame manager, untrain audit, and the provisional-memory
  // promoter. All four read/write to context.db so they survive
  // gateway restarts.
  private promises!: PromiseTracker;
  private frames!: FrameManager;
  private untrain!: UntrainService;
  private provisional!: ProvisionalMemoryService;
  // Write-ahead log for every memory-affecting op. Built before the
  // memory subsystems so all of them can push intent rows through it.
  private wal!: MemoryWAL;
  // PII vault + the live request/response shell that turns "I need
  // field X" into either an inline response (vault already unlocked)
  // or a vault_unlock_request prompt on the active channel. The vault
  // is constructed early in start() so doctor + CLI can read status,
  // but it is never auto-unlocked: every protocol cycle re-prompts.
  private vault: VaultService | null = null;
  private vaultProtocol: VaultProtocol | null = null;
  /**
   * Wall-clock at runtime start, used by the Ghost state snapshot to
   * report service uptime. Captured in the constructor (not start()) so
   * `getStartedAt()` is non-null before `start()` resolves.
   */
  private startedAt: number = Date.now();

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

  /**
   * Native BrowserBridge accessor. Used by tools/agents that want to
   * drive the connected ThunderBrowser extension directly. Returns
   * undefined only before `start()` has bound the listener.
   */
  getBrowser(): BrowserBridge | undefined {
    return this.browser;
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

  getMemoryWAL(): MemoryWAL | undefined {
    return this.wal;
  }

  getVault(): VaultService | undefined {
    return this.vault ?? undefined;
  }

  getVaultProtocol(): VaultProtocol | undefined {
    return this.vaultProtocol ?? undefined;
  }

  /** Access the vault's plugin-provider registry. Construction lives
   *  inside VaultService.initialize(); this is the runtime-side
   *  accessor BYOAA/Loop integrations call to swap a provider. */
  getVaultRegistry(): VaultProviderRegistry | undefined {
    return this.vault?.getRegistry() ?? undefined;
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

    // Vault service + protocol orchestrator. Vault starts locked (per
    // its constructor). The protocol is the seam every channel inbound
    // checks before falling through to normal processing. Failure to
    // initialize is non-fatal — vault features just won't be available
    // until the next restart.
    try {
      this.vault = new VaultService(this.provenance);
      this.vault.initialize();
      this.vaultProtocol = new VaultProtocol(this.vault, this.world, this.provenance);
      console.log('  ✓ Vault initialized (locked)');
    } catch (err) {
      console.warn('  ⚠ Vault init failed (non-fatal):', (err as Error).message);
      this.vault = null;
      this.vaultProtocol = null;
    }
    if (this.config.localInference.enabled) {
      console.log(`  ✓ Local inference probe started (${this.config.localInference.endpoint})`);
    } else {
      console.log('  ℹ Local inference disabled in config — staying on cloud mode');
    }

    // BrowserBridge — native runtime infrastructure for the ThunderBrowser
    // extension. Comes up before Doctor so the first health tick already
    // sees a stable listening/not-listening state. `start()` swallows bind
    // failure (port in use → existing functionality keeps running, browser
    // calls just see "not connected"). The Ghost Jon 7-day gate clock
    // takes priority over any new feature errors.
    this.browser = new BrowserBridge(this.world, this.provenance, {
      port: DEFAULT_BROWSER_BRIDGE_PORT
    });
    try {
      await this.browser.start();
      const stats = this.browser.getStats();
      if (stats.listening) {
        console.log(`  ✓ BrowserBridge listening on ws://0.0.0.0:${stats.port} (extension dial-in)`);
      } else {
        console.log(`  ℹ BrowserBridge not listening on :${stats.port} — bind failed, see provenance (browser calls will fail-fast)`);
      }
    } catch (err) {
      console.warn('  ⚠ BrowserBridge start error (non-fatal):', (err as Error).message);
    }

    // Start doctor monitoring
    this.doctor = new Doctor(this);
    this.doctor.startMonitoring();
    console.log('  ✓ Doctor mode active');

    // Write-ahead log boot sequence. Must come before promise/frame/
    // untrain wiring so each subsystem can route intent rows through
    // it during processing. The order matters:
    //   1. Construct WAL (no I/O — just binds the DB handle).
    //   2. Replay unplayed rows — recover from any prior crash.
    //   3. Rotate the hot table once on boot — archive anything >7d old.
    //   4. Schedule the daily rotation cron.
    this.wal = new MemoryWAL(this.db);
    const replay = this.wal.replay();
    if (replay.recovered === 0 && replay.corrupted === 0) {
      console.log('  ✓ WAL replay: 0 rows recovered (clean boot)');
    } else {
      const counts = Object.entries(replay.byType)
        .filter(([, n]) => n > 0)
        .map(([t, n]) => `${t}=${n}`)
        .join(' ');
      console.log(
        `  ✓ WAL replay: ${replay.recovered} rows recovered ` +
        `(${counts || 'none'})` +
        (replay.corrupted > 0 ? `, ${replay.corrupted} corrupted skipped` : '') +
        (replay.orphanedInbound > 0 ? `, ${replay.orphanedInbound} orphaned inbound (in-flight at crash)` : '')
      );
      if (replay.lastTurns.length > 0) {
        console.log(`  ✓ WAL replay: reconstructed last ${replay.lastTurns.length} turn(s) of context`);
      }
    }
    const rotated = this.wal.rotate();
    if (rotated.archived > 0) {
      console.log(`  ✓ WAL boot rotation: archived ${rotated.archived} row(s)`);
    }
    this.wal.startDailyRotation();

    // Persistent-memory subsystems. Order matters: provenance must
    // already exist (constructed above) so UntrainService can append.
    // WAL is passed in so each subsystem can write its intent row
    // BEFORE the canonical table mutation it performs.
    this.promises = new PromiseTracker(this.db, { wal: this.wal });
    this.frames = new FrameManager(this.db, { wal: this.wal });
    this.untrain = new UntrainService(this.db, this.provenance, { wal: this.wal });
    this.provisional = new ProvisionalMemoryService(this.db);

    // Learning trigger engine. Constructed after WAL so correction +
    // learning_extracted events get durably logged on capture.
    this.learning = new TriggerEngine(this.db, this.config.learning.backstopTurns, this.wal);
    console.log('  ✓ Learning loop ready');

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
        this.ghost = new GhostHarness(
          this.config,
          (input, history, opts) => this.shadowResponse(input, history, opts),
          this.buildGhostStateSnapshotSource()
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

    // WAL the inbound BEFORE we touch any processing. If we crash
    // before producing an outbound, replay will surface this row as an
    // orphaned inbound so Doctor can flag it on the next boot.
    this.wal.append({
      type: 'inbound_message',
      sessionId: this.state.sessionId || null,
      payload: {
        messageId: entry.id,
        channel: channelId,
        sender: entry.sender,
        text: entry.text,
        timestamp: entry.timestamp
      }
    });

    // ── Vault protocol short-circuit ────────────────────────────────────
    // If a vault unlock request is pending on this channel and the
    // inbound looks like the user's answer, divert *before* any other
    // processing so the password text never enters the LLM path, the
    // promise tracker, or the WAL outbound (we still log the outcome).
    if (this.vaultProtocol && this.vaultProtocol.looksLikeUnlockResponse(channelId, entry.text)) {
      try {
        const result = await this.vaultProtocol.handleInbound(channelId, entry.text);
        const replyText = this.vaultProtocol.formatOutcome(result);
        const delivery: OutboundDelivery = {
          id: newMessageId(),
          agentId: 'jon',
          sender: 'Jon',
          channel: channelId,
          text: replyText,
          timestamp: Date.now(),
          model: this.config.runtime.model
        };
        // WAL the synthetic outbound so the audit trail pairs the
        // unlock attempt with its response. The body deliberately
        // does NOT include the password the user typed.
        this.wal.append({
          type: 'outbound_message',
          sessionId: this.state.sessionId || null,
          payload: {
            messageId: delivery.id,
            inboundMessageId: entry.id,
            channel: channelId,
            agentId: delivery.agentId,
            sender: delivery.sender,
            text: replyText,
            timestamp: delivery.timestamp,
            model: delivery.model,
            vault_unlock_outcome: result.status
          }
        });
        this.channels.broadcast(delivery);
        return;
      } catch (err) {
        console.warn('  ⚠ vault unlock response handling failed:', (err as Error).message);
        // fall through to normal processing if the protocol exploded
      }
    }

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

    // WAL the outbound BEFORE handing it to the channel. The inbound
    // messageId is carried in the payload so replay can pair the two
    // and identify orphans (inbound with no matching outbound = crash
    // mid-LLM-call).
    this.wal.append({
      type: 'outbound_message',
      sessionId: this.state.sessionId || null,
      payload: {
        messageId: delivery.id,
        inboundMessageId: entry.id,
        channel: channelId,
        agentId: delivery.agentId,
        sender: delivery.sender,
        text: composedText,
        timestamp: delivery.timestamp,
        model: delivery.model
      }
    });

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
  private async shadowResponse(
    input: string,
    history: GhostTurn[],
    opts?: GhostResponderOpts
  ): Promise<string> {
    const system = getGhostSystemPrompt();
    return this.callGhostLLM(system, input, history, opts?.stateSnapshot);
  }

  /**
   * Build the snapshot-source the GhostHarness uses on status-type
   * prompts. Each accessor is a cheap closure that swallows its own
   * errors — a transient read failure must never break the shadow
   * path. The harness only invokes these when `isStatusQuery(input)`
   * is true, so non-status turns pay nothing.
   */
  private buildGhostStateSnapshotSource(): StateSnapshotSource {
    return {
      ghostScore: () => {
        try {
          const evaluator = new GhostEvaluator(this.config);
          const file = evaluator.loadScores();
          if (!file || file.days.length === 0) return null;
          const day = file.days[0];
          return {
            weightedScore: day.weighted_score,
            samples: day.samples,
            matchRate: day.match_rate
          };
        } catch {
          return null;
        }
      },
      walStats: () => {
        try {
          if (!this.wal) return null;
          const s = this.wal.stats();
          return { hotRows: s.hotRows, lastRotationAt: s.lastRotationAt };
        } catch {
          return null;
        }
      },
      openPromiseCount: () => {
        try {
          return this.promises ? this.promises.countOpen() : null;
        } catch {
          return null;
        }
      },
      currentFrame: () => {
        try {
          const f = this.frames?.getCurrent();
          if (!f) return null;
          return { topic: f.topic_anchor, status: f.status };
        } catch {
          return null;
        }
      },
      inferenceState: () => {
        try {
          const mode = this.world.effectiveMode();
          const h = this.localInference?.getHealth();
          return {
            mode: mode === ProcessingMode.LOCAL_INFERENCE ? 'LOCAL_INFERENCE' : 'CLOUD',
            breakerOpen: h?.circuitBreakerOpen ?? false,
            reachable: h?.reachable ?? false
          };
        } catch {
          return null;
        }
      },
      serviceUptime: () => {
        const tgUptime = Math.max(0, Date.now() - this.startedAt);
        return [{ name: 'thundergate', uptimeMs: tgUptime }];
      },
      serviceStatus: () => {
        // Best-effort `is-active` probe for the three units the CLI
        // snapshot pins. systemctl may be absent inside non-systemd
        // sandboxes — we report `inactive` rather than crash.
        const units = [
          { name: 'thundergate', unit: 'thundergate.service' },
          { name: 'relay', unit: 'thundercomm-relay.service' },
          { name: 'bridge', unit: 'thundercomm-bridge.service' }
        ];
        return units.map((u) => ({
          name: u.name,
          active: systemctlIsActive(u.unit)
        }));
      },
      lastGitCommit: () => readLastGitCommit(repoRootGuess()),
      lastInbound: () => {
        // Pull the most recent inbound_message row directly from the
        // WAL. Read-only, indexed by id, so cheap even with a hot
        // table. Returns null when WAL is empty or unavailable.
        try {
          if (!this.db) return null;
          const row = this.db.raw().prepare(
            `SELECT created_at, payload FROM memory_wal
             WHERE type = 'inbound_message'
             ORDER BY id DESC LIMIT 1`
          ).get() as { created_at: number; payload: string } | undefined;
          if (!row) return null;
          const payload = JSON.parse(row.payload);
          return {
            sender: String(payload.sender ?? 'unknown'),
            channel: String(payload.channel ?? 'unknown'),
            text: String(payload.text ?? ''),
            ageMs: Math.max(0, Date.now() - row.created_at)
          };
        } catch {
          return null;
        }
      },
      version: () => readPackageVersion(repoRootGuess()),
      principlesCount: () => readPrinciplesCount(repoRootGuess()),
      doctorSummary: () => {
        try {
          if (!this.doctor) return null;
          const s = this.doctor.getStatus();
          if (!s) return null;
          return {
            status: s.status,
            consecutiveHealthy: this.doctor.getConsecutiveHealthy()
          };
        } catch {
          return null;
        }
      },
      // WorldState carries the same fields the bridge mutates on every
      // extension envelope. Reading them here (instead of touching the
      // bridge directly) keeps the harness ignorant of the bridge — if
      // the bridge ever fails to bind, the world reads cleanly as
      // disconnected and `browserLine()` simply skips.
      browserState: () => {
        try {
          if (!this.world.browserConnected) return null;
          return {
            connected: true,
            url: this.world.browserCurrentUrl,
            portalState: this.world.browserPortalState,
            lastActionAt: this.world.browserLastActionAt
          };
        } catch {
          return null;
        }
      },
      now: () => Date.now()
    };
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
    history: GhostTurn[] = [],
    stateSnapshot?: string
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
      const sys = stateSnapshot ? `${stateSnapshot}\n\n${system}` : system;
      return this.callLLM([
        { role: 'system', content: sys },
        ...chat
      ]);
    }

    const apiKey = this.config.anthropicApiKey;
    if (!apiKey) {
      console.warn('  ⚠ callGhostLLM: anthropicApiKey not set');
      return '';
    }
    const anthropicModel = model.replace(/^anthropic\//, '');

    // Static system block keeps its ephemeral cache_control marker so
    // the big SOUL/IDENTITY frame stays cacheable across calls. The
    // per-turn state snapshot lands in a second, *uncached* block —
    // every status query gets fresh numbers without invalidating the
    // big cached prefix.
    const systemBlocks: Array<Record<string, unknown>> = [
      {
        type: 'text',
        text: system,
        cache_control: { type: 'ephemeral' }
      }
    ];
    if (stateSnapshot) {
      systemBlocks.push({ type: 'text', text: stateSnapshot });
    }

    const body = {
      model: anthropicModel,
      max_tokens: maxTokens,
      temperature,
      system: systemBlocks,
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

    // In-flight tracking: bracket the inference call so the provider
    // knows how many local-routed requests are mid-flight if the breaker
    // trips during this call. Two outcomes if local is suddenly dead:
    //   1. The real ThunderMind path errors → we retry on cloud below.
    //   2. The stub path (today) just calls callLLM and returns.
    // The retry is the seamless-failover guarantee: from the user's
    // perspective, a single in-flight request never errors because the
    // mode flipped.
    this.localInference.beginRequest();
    try {
      const text = await this.callLLM([{ role: 'user', content: message.content }]);
      // Empty content from callLLM means a transport failure on the
      // local path. Today this only happens when callLLM's API errors,
      // not on a ThunderMind-specific failure (since routing-to-local
      // isn't wired yet), but the retry shape matches Michael's spec:
      // local fails → retry on cloud → never drop the request.
      if (!text || text.length === 0) {
        this.provenance.append({
          actor: 'runtime',
          action: 'local_inference_retry_on_cloud',
          target: 'message',
          reason: 'local path returned empty — retrying on cloud',
          data: { endpoint: this.config.localInference.endpoint }
        });
        const cloud = await this.processCloud(message);
        return cloud;
      }
      return { content: text, type: 'normal' };
    } catch (err) {
      // Any throw from the inference call gets retried on cloud once.
      // A second failure is the cloud's own problem and propagates.
      this.provenance.append({
        actor: 'runtime',
        action: 'local_inference_threw_retry_on_cloud',
        target: 'message',
        reason: `local inference threw: ${(err as Error).message}`
      });
      return this.processCloud(message);
    } finally {
      this.localInference.endRequest();
    }
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

    // Stop the native BrowserBridge — closes the extension socket and
    // rejects any in-flight commands so awaiting callers fail fast.
    try { await this.browser?.stop(); } catch { /* ignore */ }

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

    // Stop WAL daily rotation timer so the process can exit cleanly.
    try { this.wal?.stopDailyRotation(); } catch { /* ignore */ }

    // Close the vault — locks the in-memory key and closes the SQLite
    // handle. Drops any pending unlock requests since they are
    // process-local state.
    try {
      this.vault?.close();
      this.vault = null;
      this.vaultProtocol = null;
    } catch { /* ignore */ }

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

/**
 * Resolve the thundergate-dev repo root from the compiled module's own
 * location. Falls back to cwd() if the URL math gives us something that
 * doesn't look like a repo. Memoized for cheap repeat calls during a
 * shadow run.
 */
let _repoRootCache: string | null = null;
function repoRootGuess(): string {
  if (_repoRootCache) return _repoRootCache;
  try {
    const here = fileURLToPath(import.meta.url);
    // src/core/runtime.ts → repo root is two dirs up.
    const candidate = pathResolve(pathDirname(here), '..', '..');
    if (existsSync(pathResolve(candidate, 'package.json'))) {
      _repoRootCache = candidate;
      return candidate;
    }
  } catch {
    /* fall through */
  }
  _repoRootCache = process.cwd();
  return _repoRootCache;
}

function readLastGitCommit(repo: string): { hash: string; subject: string } | null {
  try {
    const out = execSync(`git -C ${shellQuote(repo)} log -1 --format=%h%x09%s`, {
      encoding: 'utf-8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (!out) return null;
    const [hash, ...rest] = out.split('\t');
    const subject = rest.join('\t').trim();
    if (!hash) return null;
    return { hash, subject };
  } catch {
    return null;
  }
}

function readPackageVersion(repo: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(pathResolve(repo, 'package.json'), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function readPrinciplesCount(repo: string): number | null {
  // Count the numbered `## N. NAME` headers in the design-principles
  // doc — that file is the source of truth for the locked-principles
  // count Ghost has to quote on technical asks.
  const candidates = [
    pathResolve(repo, 'docs/THUNDERGATE_DESIGN_PRINCIPLES.md'),
    pathResolve(repo, 'THUNDERGATE_DESIGN_PRINCIPLES.md')
  ];
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const text = readFileSync(path, 'utf-8');
      const matches = text.match(/^##\s+\d+\.\s+/gm);
      if (matches) return matches.length;
    } catch {
      /* try next */
    }
  }
  return null;
}

function systemctlIsActive(unit: string): boolean {
  try {
    const out = execSync(`systemctl is-active ${shellQuote(unit)} 2>/dev/null || true`, {
      encoding: 'utf-8',
      timeout: 1500
    }).trim();
    return out === 'active';
  } catch {
    return false;
  }
}

function shellQuote(s: string): string {
  // Conservative quoting for shell arguments we splice into execSync —
  // single-quote and escape any embedded single quotes. The inputs here
  // are repo paths and systemd unit names, both expected to be ASCII.
  return `'${s.replace(/'/g, `'\\''`)}'`;
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
