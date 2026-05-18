/**
 * Frame — first-class continuity object.
 *
 * A frame is the "what are we talking about right now" envelope. It
 * survives gateway restarts: on startup the runtime hydrates the most
 * recent ACTIVE or PAUSED frame from `frames` so the conversation
 * continues without forgetting context.
 *
 * Lifecycle:
 *   - First message ever → open a fresh ACTIVE frame.
 *   - Subsequent message inside the gap threshold → touch the current
 *     ACTIVE frame's last_activity_at.
 *   - Subsequent message past the gap threshold → PAUSE the current
 *     frame, then evaluate continuity:
 *       REJOIN if keyword overlap with topic_anchor exceeds the
 *       similarity floor — reopen the paused frame in place.
 *       NEW    otherwise — open a fresh ACTIVE frame, link to the
 *       paused one as parent_frame_id so threads stay traceable.
 *
 * The similarity check is intentionally a keyword-overlap stub today.
 * `evaluateSimilarity` is the only seam ThunderMind needs to replace
 * once an embedding model is available — return a [0..1] score and the
 * caller will compare against `confidenceFloor` (default 0.8 scaled
 * down from the brief's 20% overlap floor by `OVERLAP_REJOIN_THRESHOLD`).
 */

import { randomUUID } from 'crypto';
import type { SessionDB, FrameRow } from '../session/database.js';
import type { MemoryWAL } from './wal.js';

export const DEFAULT_GAP_MS = 30 * 60 * 1000;
// Brief: ">20% overlap → REJOIN". Stored as a fraction.
export const OVERLAP_REJOIN_THRESHOLD = 0.2;
export const DEFAULT_CONFIDENCE_FLOOR = 0.8;
const TOPIC_ANCHOR_LEN = 50;

const STOPWORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'back', 'because',
  'been', 'before', 'being', 'between', 'both', 'but', 'can', 'come',
  'could', 'did', 'does', 'doing', 'down', 'each', 'few',
  'for', 'from', 'further', 'had', 'has', 'have', 'having', 'her',
  'here', 'him', 'his', 'how', 'into', 'its', 'just', 'like', 'more',
  'most', 'much', 'must', 'now', 'off', 'once', 'only', 'other',
  'our', 'out', 'over', 'own', 'same', 'she', 'should', 'some',
  'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'those', 'through', 'too', 'under',
  'until', 'very', 'was', 'were', 'what', 'when', 'where', 'which',
  'while', 'who', 'whom', 'why', 'with', 'would', 'you', 'your',
  'yours'
]);

export type FrameTransitionType = 'opened' | 'paused' | 'closed' | 'rejoined';

export interface FrameContext {
  deviceHint?: string;
  modelInUse?: string;
  sessionId?: string;
  text: string;
  now?: number;
}

export interface FrameDecision {
  frame: FrameRow;
  transition: FrameTransitionType;
  reason?: string;
}

export class FrameManager {
  private db: SessionDB;
  private current: FrameRow | null = null;
  private gapMs: number;
  private confidenceFloor: number;
  private wal: MemoryWAL | null;
  private agentId: string;

  constructor(
    db: SessionDB,
    opts?: { gapMs?: number; confidenceFloor?: number; wal?: MemoryWAL; agentId?: string }
  ) {
    this.db = db;
    this.gapMs = opts?.gapMs ?? DEFAULT_GAP_MS;
    this.confidenceFloor = opts?.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR;
    this.wal = opts?.wal ?? null;
    this.agentId = opts?.agentId ?? 'jon';
  }

  /**
   * Boot-time hydrate. Pulls the most recent ACTIVE or PAUSED frame
   * from the DB so a fresh process picks up where the previous one
   * stopped. Returns the frame if any was found.
   */
  hydrate(): FrameRow | null {
    this.current = this.db.getActiveOrPausedFrame(this.agentId);
    return this.current;
  }

  /** Public read accessor — runtime + Doctor use this. */
  getCurrent(): FrameRow | null {
    return this.current;
  }

  /**
   * Main inbound hook. Applies the lifecycle rules and returns the
   * frame + transition that resulted. Persists everything: frames
   * table, frame_transitions log, and current pointer.
   */
  onInbound(ctx: FrameContext): FrameDecision {
    const now = ctx.now ?? Date.now();

    if (!this.current) {
      return this.openFresh(ctx, now, null, 'no active frame');
    }

    const last = this.current.last_activity_at * 1000;
    const gap = now - last;

    if (gap <= this.gapMs) {
      // Inside the gap → same frame, just touch it.
      this.db.touchFrame(this.current.id);
      this.current = this.db.getFrame(this.current.id, this.agentId) ?? this.current;
      return {
        frame: this.current,
        transition: 'opened',
        reason: 'continuation within gap window'
      };
    }

    // Gap exceeded — pause the current frame, then decide REJOIN vs NEW.
    this.db.updateFrameStatus(this.current.id, 'PAUSED');
    this.db.logFrameTransition({
      frameId: this.current.id,
      from: this.current.status,
      to: 'PAUSED',
      reason: `gap ${(gap / 60000).toFixed(1)}m exceeded ${(this.gapMs / 60000).toFixed(1)}m`
    });
    this.wal?.append({
      type: 'frame_closed',
      sessionId: ctx.sessionId ?? null,
      agentId: this.agentId,
      payload: {
        frameId: this.current.id,
        fromStatus: this.current.status,
        toStatus: 'PAUSED',
        reason: `gap ${(gap / 60000).toFixed(1)}m exceeded`
      }
    });

    const pausedFrame = { ...this.current, status: 'PAUSED' as const };
    const similarity = this.evaluateSimilarity(ctx.text, pausedFrame.topic_anchor);
    if (similarity >= OVERLAP_REJOIN_THRESHOLD) {
      // REJOIN: flip the paused frame back to ACTIVE, log the transition.
      this.db.updateFrameStatus(pausedFrame.id, 'ACTIVE');
      this.db.touchFrame(pausedFrame.id);
      this.db.logFrameTransition({
        frameId: pausedFrame.id,
        from: 'PAUSED',
        to: 'ACTIVE',
        reason: `frame rejoined (similarity ${(similarity * 100).toFixed(0)}%)`
      });
      this.wal?.append({
        type: 'frame_opened',
        sessionId: ctx.sessionId ?? null,
        agentId: this.agentId,
        payload: {
          frameId: pausedFrame.id,
          transition: 'rejoined',
          similarity,
          topicAnchor: pausedFrame.topic_anchor
        }
      });
      this.current = this.db.getFrame(pausedFrame.id, this.agentId) ?? pausedFrame;
      return {
        frame: this.current,
        transition: 'rejoined',
        reason: `keyword overlap ${(similarity * 100).toFixed(0)}% ≥ floor`
      };
    }

    return this.openFresh(
      ctx,
      now,
      pausedFrame.id,
      `new frame opened (similarity ${(similarity * 100).toFixed(0)}% < floor)`
    );
  }

  /**
   * Stub similarity. Returns the fraction of paused-frame topic-anchor
   * tokens that appear in the new inbound text. Bounded [0..1].
   *
   * Replace with a cosine-distance call against an embedding model
   * when ThunderMind ships. The signature is stable — callers compare
   * against OVERLAP_REJOIN_THRESHOLD regardless of how it's computed.
   */
  evaluateSimilarity(inboundText: string, topicAnchor: string): number {
    const a = tokenize(inboundText);
    const b = tokenize(topicAnchor);
    if (b.size === 0) return 0;
    let overlap = 0;
    for (const t of b) if (a.has(t)) overlap++;
    return overlap / b.size;
  }

  /** Explicit close. CLI / shutdown hook can call this. */
  closeCurrent(reason: string = 'manual'): FrameRow | null {
    if (!this.current) return null;
    const prev = this.current.status;
    this.db.updateFrameStatus(this.current.id, 'CLOSED');
    this.db.logFrameTransition({
      frameId: this.current.id,
      from: prev,
      to: 'CLOSED',
      reason
    });
    this.wal?.append({
      type: 'frame_closed',
      sessionId: this.current.session_id ?? null,
      agentId: this.agentId,
      payload: {
        frameId: this.current.id,
        fromStatus: prev,
        toStatus: 'CLOSED',
        reason
      }
    });
    const closed = this.db.getFrame(this.current.id, this.agentId);
    this.current = null;
    return closed;
  }

  private openFresh(
    ctx: FrameContext,
    now: number,
    parentFrameId: string | null,
    reason: string
  ): FrameDecision {
    const id = randomUUID();
    const anchor = extractTopicAnchor(ctx.text);
    this.db.insertFrame({
      id,
      agentId: this.agentId,
      topicAnchor: anchor,
      deviceHint: ctx.deviceHint ?? null,
      modelInUse: ctx.modelInUse ?? null,
      sessionId: ctx.sessionId ?? null,
      parentFrameId,
      confidenceFloor: this.confidenceFloor
    });
    this.db.logFrameTransition({
      frameId: id,
      from: null,
      to: 'ACTIVE',
      reason
    });
    this.wal?.append({
      type: 'frame_opened',
      sessionId: ctx.sessionId ?? null,
      agentId: this.agentId,
      payload: {
        frameId: id,
        transition: 'opened',
        topicAnchor: anchor,
        deviceHint: ctx.deviceHint ?? null,
        modelInUse: ctx.modelInUse ?? null,
        parentFrameId,
        reason
      }
    });
    this.current = this.db.getFrame(id, this.agentId);
    return {
      frame: this.current!,
      transition: 'opened',
      reason
    };
  }
}

function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of (s || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/**
 * Topic anchor = first ~50 chars of the message, collapsed to a single
 * line. This is intentionally a heuristic; ThunderMind will eventually
 * compute a richer anchor (extracted noun phrase, entity, or embedded
 * topic vector) — the field stays the same regardless.
 */
function extractTopicAnchor(text: string): string {
  const flat = (text || '').replace(/\s+/g, ' ').trim();
  return flat.slice(0, TOPIC_ANCHOR_LEN);
}
