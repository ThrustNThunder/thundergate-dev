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
import { Config } from '../config/loader.js';
import { ChannelRegistry } from '../channels/index.js';
import { GhostHarness } from '../ghost/harness.js';
import { WorldState } from '../world/state.js';
import { ProvenanceLedger } from '../provenance/ledger.js';
import { PostureStateMachine } from '../posture/machine.js';
import { ChannelTypeRegistry } from '../channels/registry.js';
import { LocalInferenceProvider } from '../inference/local_provider.js';
import { PromiseTracker } from '../memory/promises.js';
import { FrameManager } from '../memory/frame.js';
import { UntrainService } from '../memory/untrain.js';
import { ProvisionalMemoryService } from '../memory/provisional.js';
import { MemoryWAL } from '../memory/wal.js';
interface RuntimeState {
    status: 'starting' | 'running' | 'deep_mode' | 'stopping' | 'stopped';
    sessionId: string;
    contextTokens: number;
    deepModeActive: boolean;
    surfaceLayerActive: boolean;
    lastActivity: Date;
}
export declare class ThunderGateRuntime {
    private config;
    private db;
    private checkpoint;
    private learning;
    private doctor;
    private channels;
    private ghost;
    private state;
    private world;
    private provenance;
    private localInference;
    private promises;
    private frames;
    private untrain;
    private provisional;
    private wal;
    private posture;
    private channelTypes;
    private toneWindow;
    private static readonly TONE_WINDOW_LIMIT;
    /**
     * Wall-clock at runtime start, used by the Ghost state snapshot to
     * report service uptime. Captured in the constructor (not start()) so
     * `getStartedAt()` is non-null before `start()` resolves.
     */
    private startedAt;
    constructor(configPath?: string);
    /** Awareness substrate — read by Doctor + the message path. */
    getWorldState(): WorldState;
    getLocalInference(): LocalInferenceProvider | undefined;
    getProvenanceLedger(): ProvenanceLedger | undefined;
    /** Posture state machine — surfaced for CLI / Doctor. */
    getPostureMachine(): PostureStateMachine | undefined;
    /** Channel-type registry — surfaced so plugins can register matchers. */
    getChannelTypes(): ChannelTypeRegistry;
    /** Accessors for CLI + Doctor. */
    getPromiseTracker(): PromiseTracker | undefined;
    getFrameManager(): FrameManager | undefined;
    getUntrainService(): UntrainService | undefined;
    getProvisionalService(): ProvisionalMemoryService | undefined;
    getMemoryWAL(): MemoryWAL | undefined;
    /** DB accessor — CLI needs it for read-only memory list. */
    getDB(): SessionDB | undefined;
    /** Public accessor — used by Doctor and CLI ghost commands. */
    getConfig(): Config;
    getChannels(): ChannelRegistry;
    getGhost(): GhostHarness | null;
    /**
     * Start the runtime
     * 1. Initialize database
     * 2. Load checkpoint (adaptive)
     * 3. Start doctor monitoring
     * 4. Begin message loop
     */
    start(): Promise<void>;
    /**
     * Channel inbound hook. Routes to runtime, then broadcasts the runtime's
     * response back through every running channel that subscribed to the
     * same channel id.
     */
    private handleChannelInbound;
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
    private shadowResponse;
    /**
     * Build the snapshot-source the GhostHarness uses on status-type
     * prompts. Each accessor is a cheap closure that swallows its own
     * errors — a transient read failure must never break the shadow
     * path. The harness only invokes these when `isStatusQuery(input)`
     * is true, so non-status turns pay nothing.
     */
    private buildGhostStateSnapshotSource;
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
    private callGhostLLM;
    /**
     * Persist current checkpoint state
     */
    saveCheckpoint(): Promise<void>;
    /**
     * Process incoming message
     * Routes to deep or surface based on current state
     */
    processMessage(message: Message): Promise<Response>;
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
    private normalProcess;
    /**
     * Cloud processing — unchanged from pre-dual-mode behavior. Single
     * user-turn into callLLM. Cost-aware, conservative context. This is
     * the path that runs every time ThunderMind isn't up.
     */
    private processCloud;
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
    private processLocalInference;
    /** Hook for aggressive RAG retrieval under LOCAL_INFERENCE mode. */
    private localInferenceRagStub;
    /** Hook for background pre-processing under LOCAL_INFERENCE mode. */
    private backgroundPreprocessStub;
    /**
     * Surface processing — minimal context, quick response
     * Only active when deep mode is engaged
     */
    private surfaceProcess;
    /**
     * Enter deep mode — activate surface layer
     */
    private enterDeepMode;
    /**
     * Exit deep mode — deactivate surface layer
     */
    private exitDeepMode;
    /**
     * Evaluate if message requires deep mode
     */
    private evaluateComplexity;
    /**
     * Evaluate if message is urgent (should interrupt deep mode)
     */
    private evaluateUrgency;
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
    callLLM(messages: Array<{
        role: string;
        content: string;
    }>): Promise<string>;
    /**
     * Get current runtime state (for doctor, TUI, etc.)
     */
    getState(): RuntimeState;
    /**
     * Graceful shutdown
     */
    stop(): Promise<void>;
}
interface Message {
    id: string;
    channel: string;
    content: string;
    sender: string;
    timestamp: Date;
    ghost?: boolean;
}
interface Response {
    content: string;
    type: 'normal' | 'surface' | 'deep';
}
export {};
