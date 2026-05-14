/**
 * WorldState — shared situational substrate.
 *
 * Per the awareness analysis (§1, §7.1), ThunderGate needs an in-memory
 * snapshot of facts that should change Jon's posture *before* he opens
 * his mouth. Today this tracks:
 *
 *   - processingMode + localInference liveness (cloud/local fork)
 *   - activeChannel + activeDevice (which surface Michael is on)
 *   - interArrivalMs (gap/flurry classification input)
 *   - toneTrend (recent inbound length pattern)
 *   - lastInboundAt (raw timestamp the posture machine uses next turn)
 *   - posture (latest decision the state machine produced)
 *
 * Future fields (network class, peer liveness, …) hang off this same
 * object so consumers don't have to learn a new substrate.
 */
export var ProcessingMode;
(function (ProcessingMode) {
    /** Cloud-routed (Anthropic / OpenAI). Cost-aware, conservative context. */
    ProcessingMode["CLOUD"] = "CLOUD";
    /** Local 70B / ThunderMind reachable. */
    ProcessingMode["LOCAL_INFERENCE"] = "LOCAL_INFERENCE";
})(ProcessingMode || (ProcessingMode = {}));
export class WorldState {
    processingMode = ProcessingMode.CLOUD;
    localInference = {
        reachable: false,
        lastCheckedAt: null,
        lastReachableAt: null,
        lastError: null,
        endpoint: null
    };
    // Posture-input fields. All start as "no signal yet" so the posture
    // machine falls back to defaults until real inbound traffic lands.
    activeChannel = null;
    activeDevice = 'unknown';
    interArrivalMs = null;
    lastInboundAt = null;
    toneTrend = 'mixed';
    posture = null;
    effectiveMode() {
        return this.processingMode;
    }
}
