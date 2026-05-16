/**
 * Emergency Protocol — challenge/response state machine.
 *
 * States:
 *   INACTIVE          : default. Watches for the trigger phrase.
 *   AWAITING_RESPONSE : challenge has been emitted; waiting for the
 *                       response word. Times out to INACTIVE after 60s.
 *   ACTIVE            : protocol engaged. Channel security suspended,
 *                       heartbeat escalated, log appended. Returns to
 *                       INACTIVE on "all clear" / "stand down" or
 *                       4-hour safety timeout.
 *
 * Trigger phrase: "engage emergency protocol" (case-insensitive).
 *
 * Challenge + response words are pulled from vault H labels
 * `emergency_challenge` and `emergency_response`. If the vault is
 * locked or those fields aren't set, the protocol falls back to
 * development defaults ("ketchup" / "sauce") so the path is exercisable
 * before onboarding completes.
 *
 * The state machine is intentionally process-local — there's no DB
 * row tracking ACTIVE across restarts. If the runtime crashes during
 * an incident, the next start comes up INACTIVE and the operator has
 * to re-engage. The log file (~/.thundergate/emergency-log.jsonl) is
 * tamper-evident enough for the post-incident review.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import * as os from 'os';

export type EmergencyState = 'INACTIVE' | 'AWAITING_RESPONSE' | 'ACTIVE';

export interface EmergencyContext {
  /** Resolves a vault H label to plaintext, or null if locked/missing. */
  readVaultField: (label: string) => Promise<string | null>;
  /** Where the JSONL audit log lands. Defaults to ~/.thundergate/emergency-log.jsonl. */
  logPath?: string;
  /** Defaults to "ketchup" — used only when vault H can't supply the field. */
  challengeDefault?: string;
  /** Defaults to "sauce" — same caveat as above. */
  responseDefault?: string;
}

export interface EmergencyEvent {
  kind: 'none' | 'challenge_issued' | 'activated' | 'failed_response' | 'deactivated' | 'timeout';
  message?: string;
  /** Set whenever the state machine wants a notice sent back to the
   *  caller's channel. */
  reply?: string;
}

const TRIGGER_RX = /engage\s+emergency\s+protocol/i;
const STANDDOWN_RX = /\b(all\s+clear|stand\s+down)\b/i;
const AWAIT_TIMEOUT_MS = 60_000;
const ACTIVE_SAFETY_TIMEOUT_MS = 4 * 60 * 60 * 1000;

export class EmergencyProtocol {
  private state: EmergencyState = 'INACTIVE';
  private awaitChannel: string | null = null;
  private awaitDeadline: number | null = null;
  private awaitChallenge: string | null = null;
  private activeSince: number | null = null;
  private activeChannel: string | null = null;
  private activeChallengeUsed: string | null = null;
  // Live timers so we can clear them on state transitions instead of
  // racing.
  private awaitTimer: NodeJS.Timeout | null = null;
  private safetyTimer: NodeJS.Timeout | null = null;

  /**
   * Set when the protocol is ACTIVE. Mirrors the runtime contract
   * `runtime.state.emergencyActive` requested by the brief — kept here
   * so callers can read a single source of truth.
   */
  emergencyActive = false;

  /**
   * Set when ACTIVE — channel security guards (Slack/WhatsApp block,
   * etc.) inspect this before refusing to disclose vault contents.
   */
  channelSecuritySuspended = false;

  constructor(private readonly ctx: EmergencyContext) {}

  getState(): EmergencyState {
    return this.state;
  }

  /**
   * Process one inbound message. Returns the event the caller should
   * act on — typically `reply` is sent back through the same channel.
   */
  async onInbound(channel: string, text: string): Promise<EmergencyEvent> {
    if (!text) return { kind: 'none' };

    // ACTIVE: only stand-down phrases matter; everything else flows on.
    if (this.state === 'ACTIVE') {
      if (STANDDOWN_RX.test(text)) {
        return this.deactivate(channel, 'stand_down');
      }
      // Active state passes through — caller continues normal processing.
      return { kind: 'none' };
    }

    // AWAITING_RESPONSE: same channel must produce the response word.
    if (this.state === 'AWAITING_RESPONSE') {
      // If a different channel hit us with the trigger again, restart
      // the challenge on that channel — operators legitimately switch
      // surfaces mid-incident.
      if (TRIGGER_RX.test(text)) {
        return this.beginAwait(channel);
      }
      if (channel === this.awaitChannel) {
        const expected = await this.resolveResponse();
        const candidate = text.trim().toLowerCase();
        if (candidate === expected.toLowerCase()) {
          return this.activate(channel);
        }
        // Wrong word — log but keep waiting until the timer fires.
        this.appendLog({
          ts: new Date().toISOString(),
          kind: 'failed_response',
          channel,
          expected_word_hash: shortHash(expected),
          provided_excerpt: text.slice(0, 40)
        });
        return { kind: 'failed_response' };
      }
      return { kind: 'none' };
    }

    // INACTIVE: trigger phrase opens the challenge window.
    if (TRIGGER_RX.test(text)) {
      return this.beginAwait(channel);
    }

    return { kind: 'none' };
  }

  private async beginAwait(channel: string): Promise<EmergencyEvent> {
    this.clearAwaitTimer();
    this.state = 'AWAITING_RESPONSE';
    this.awaitChannel = channel;
    this.awaitDeadline = Date.now() + AWAIT_TIMEOUT_MS;
    const challenge = await this.resolveChallenge();
    this.awaitChallenge = challenge;
    this.awaitTimer = setTimeout(() => this.onAwaitTimeout(), AWAIT_TIMEOUT_MS);
    return {
      kind: 'challenge_issued',
      reply: challenge
    };
  }

  private async activate(channel: string): Promise<EmergencyEvent> {
    this.clearAwaitTimer();
    this.state = 'ACTIVE';
    this.activeSince = Date.now();
    this.activeChannel = channel;
    this.activeChallengeUsed = this.awaitChallenge;
    this.emergencyActive = true;
    this.channelSecuritySuspended = true;
    this.appendLog({
      ts: new Date(this.activeSince).toISOString(),
      kind: 'activated',
      channel,
      activatedBy: channel,
      challengeUsed: this.awaitChallenge
    });
    this.safetyTimer = setTimeout(() => this.onSafetyTimeout(), ACTIVE_SAFETY_TIMEOUT_MS);
    this.awaitChannel = null;
    this.awaitDeadline = null;
    this.awaitChallenge = null;
    return {
      kind: 'activated',
      reply: 'Emergency Protocol active. Standing by. Say all clear to stand down.'
    };
  }

  private deactivate(channel: string, reason: 'stand_down' | 'safety_timeout'): EmergencyEvent {
    const start = this.activeSince ?? Date.now();
    const duration = Date.now() - start;
    this.clearSafetyTimer();
    this.appendLog({
      ts: new Date().toISOString(),
      kind: 'deactivated',
      reason,
      channel,
      resolvedBy: channel,
      duration_ms: duration,
      activated_at: new Date(start).toISOString()
    });
    this.state = 'INACTIVE';
    this.emergencyActive = false;
    this.channelSecuritySuspended = false;
    this.activeSince = null;
    this.activeChannel = null;
    this.activeChallengeUsed = null;
    return {
      kind: 'deactivated',
      reply:
        reason === 'safety_timeout'
          ? 'Emergency Protocol auto-deactivated after 4h with no stand-down. Incident logged.'
          : 'Emergency Protocol deactivated. Incident logged.'
    };
  }

  private onAwaitTimeout(): void {
    if (this.state !== 'AWAITING_RESPONSE') return;
    this.appendLog({
      ts: new Date().toISOString(),
      kind: 'await_timeout',
      channel: this.awaitChannel
    });
    this.state = 'INACTIVE';
    this.awaitChannel = null;
    this.awaitDeadline = null;
    this.awaitChallenge = null;
    this.awaitTimer = null;
  }

  private onSafetyTimeout(): void {
    if (this.state !== 'ACTIVE') return;
    this.deactivate(this.activeChannel ?? 'auto', 'safety_timeout');
  }

  private clearAwaitTimer(): void {
    if (this.awaitTimer) {
      clearTimeout(this.awaitTimer);
      this.awaitTimer = null;
    }
  }

  private clearSafetyTimer(): void {
    if (this.safetyTimer) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
  }

  private async resolveChallenge(): Promise<string> {
    try {
      const fromVault = await this.ctx.readVaultField('emergency_challenge');
      if (fromVault && fromVault.length > 0) return fromVault;
    } catch {
      /* fall through */
    }
    return this.ctx.challengeDefault ?? 'ketchup';
  }

  private async resolveResponse(): Promise<string> {
    try {
      const fromVault = await this.ctx.readVaultField('emergency_response');
      if (fromVault && fromVault.length > 0) return fromVault;
    } catch {
      /* fall through */
    }
    return this.ctx.responseDefault ?? 'sauce';
  }

  private appendLog(entry: Record<string, unknown>): void {
    const path = this.ctx.logPath ?? join(os.homedir(), '.thundergate', 'emergency-log.jsonl');
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(entry) + '\n');
    } catch (err) {
      // Logging failure during an emergency is non-fatal but worth a
      // console warning — operator may notice in the live tail.
      console.warn('emergency-log append failed:', (err as Error).message);
    }
  }
}

// Short non-cryptographic fingerprint — used to record that a failed
// response did NOT match the expected word, without writing the word
// itself to the log file.
function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}
