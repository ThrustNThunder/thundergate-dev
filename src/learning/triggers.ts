/**
 * ThunderGate Learning Loop — Trigger Engine
 *
 * Event-based triggers:
 * 1. Task completes
 * 2. Correction from Michael
 * 3. Session ends
 * 4. Failure occurs
 * 5. Every 20 turns (backstop)
 *
 * On trigger: background review → extract memory/skills → store in DB
 */

import { SessionDB } from '../session/database.js';
import { execFile } from 'child_process';
import { join } from 'path';
import * as os from 'os';
import { MEMORY_REVIEW_PROMPT, SKILL_REVIEW_PROMPT, extractKeywords } from './review_prompts.js';

interface TriggerEvent {
  type: 'task_complete' | 'correction' | 'session_end' | 'failure' | 'backstop';
  context?: string;       // What happened
  correction?: string;    // If type=correction, what was corrected
  error?: string;         // If type=failure, the error
  turnCount?: number;     // Current turn count
}

interface ReviewResult {
  triggered: boolean;
  type?: string;
  memoriesExtracted: number;
  skillsCreated: number;
  skillsUpdated: number;
  durationMs: number;
}

export class TriggerEngine {
  private db: SessionDB;
  private turnCount: number = 0;
  private backstopInterval: number = 20;
  private reviewInProgress: boolean = false;
  private lastReviewAt: number = 0;
  private MIN_REVIEW_INTERVAL_MS = 60000; // Minimum 1 min between reviews
  // Monotonic counter to disambiguate keys produced inside the same
  // millisecond. T4 flagged that `failure_${Date.now()}` could collide
  // and silently overwrite via ON CONFLICT(key) DO UPDATE — this fixes
  // it without paying the cost of a real throttle (failures *should*
  // burn in immediately, not be coalesced).
  private monotonicSeq: number = 0;

  constructor(db: SessionDB, backstopInterval: number = 20) {
    this.db = db;
    this.backstopInterval = backstopInterval;
  }

  /**
   * Process a turn — increment counter, check backstop
   */
  async onTurn(userMessage: string, assistantResponse: string): Promise<ReviewResult | null> {
    this.turnCount++;

    // Store messages
    this.db.storeMessage({
      sessionId: 'current',
      channel: 'internal',
      role: 'user',
      content: userMessage
    });

    this.db.storeMessage({
      sessionId: 'current',
      channel: 'internal',
      role: 'assistant',
      content: assistantResponse
    });

    // Check backstop trigger
    if (this.turnCount % this.backstopInterval === 0) {
      return this.trigger({
        type: 'backstop',
        turnCount: this.turnCount
      });
    }

    return null;
  }

  /**
   * Fire a learning trigger
   */
  async trigger(event: TriggerEvent): Promise<ReviewResult> {
    // Throttle: don't review if already in progress or too soon
    if (this.reviewInProgress) {
      return { triggered: false, memoriesExtracted: 0, skillsCreated: 0, skillsUpdated: 0, durationMs: 0 };
    }

    const now = Date.now();
    if (now - this.lastReviewAt < this.MIN_REVIEW_INTERVAL_MS && event.type === 'backstop') {
      return { triggered: false, memoriesExtracted: 0, skillsCreated: 0, skillsUpdated: 0, durationMs: 0 };
    }

    this.reviewInProgress = true;
    const startMs = Date.now();

    console.log(`  📚 Learning trigger: ${event.type}`);

    try {
      let memoriesExtracted = 0;
      let skillsCreated = 0;
      let skillsUpdated = 0;

      // Handle different trigger types
      switch (event.type) {
        case 'correction':
          // Corrections burn in immediately — high priority
          if (event.correction) {
            await this.handleCorrection(event.correction);
            memoriesExtracted = 1;
          }
          break;

        case 'failure':
          // Failures update skills to prevent repeat
          if (event.error) {
            await this.handleFailure(event.error, event.context);
            skillsUpdated = 1;
          }
          break;

        case 'task_complete':
          // Task completion may create *or update* a skill.
          const taskResult = await this.handleTaskComplete(event.context);
          skillsCreated = taskResult.created;
          skillsUpdated = taskResult.updated;
          break;

        case 'session_end':
          // Full review on session end
          const result = await this.handleSessionEnd();
          memoriesExtracted = result.memories;
          skillsCreated = result.skills;
          break;

        case 'backstop':
          // Light review — just check for obvious patterns
          const backstopResult = await this.handleBackstop();
          memoriesExtracted = backstopResult.memories;
          break;
      }

      this.lastReviewAt = Date.now();

      return {
        triggered: true,
        type: event.type,
        memoriesExtracted,
        skillsCreated,
        skillsUpdated,
        durationMs: Date.now() - startMs
      };

    } finally {
      this.reviewInProgress = false;
    }
  }

  /**
   * Handle correction — burns into memory immediately
   */
  private async handleCorrection(correction: string): Promise<void> {
    // Store as critical memory. Append a monotonic suffix so two
    // corrections fired inside the same ms get distinct keys instead
    // of one silently overwriting the other.
    this.db.storeMemory({
      key: this.uniqueKey('correction'),
      value: correction,
      category: 'corrections',
      importance: 'critical',
      source: 'michael'
    });

    // Also update last_correction context
    this.db.setContext('last_correction', correction, 'critical');

    console.log(`    🔥 Correction burned in: ${correction.substring(0, 60)}...`);
  }

  /**
   * Handle failure — log it so we don't repeat ourselves. Unique keys
   * (Date.now + monotonic) ensure back-to-back failures don't merge via
   * ON CONFLICT and overwrite each other — T4 surfaced that latent risk.
   */
  private async handleFailure(error: string, context?: string): Promise<void> {
    this.db.storeMemory({
      key: this.uniqueKey('failure'),
      value: `Error: ${error}${context ? `\nContext: ${context}` : ''}`,
      category: 'failures',
      importance: 'high',
      source: 'system'
    });

    console.log(`    ⚠️  Failure logged: ${error.substring(0, 60)}...`);
  }

  /**
   * Handle task complete — update an existing skill if one looks like
   * a fit; only create a new skill if nothing matches. This mirrors the
   * Hermes bias toward *deepening* the skill library rather than
   * fragmenting it.
   *
   * Matching is keyword-overlap based — extract content tokens, look
   * for skills whose name or content contains any of them. If the most
   * recent match shares ≥ 2 keywords, we update it; otherwise we create.
   */
  private async handleTaskComplete(context?: string): Promise<{ created: number; updated: number }> {
    const messages = this.db.getRecentMessages(30);
    if (messages.length < 5) return { created: 0, updated: 0 };

    const assistantMessages = messages.filter((m) => m.role === 'assistant');
    if (assistantMessages.length < 3) return { created: 0, updated: 0 };
    if (!context) return { created: 0, updated: 0 };

    const keywords = extractKeywords(context, 8);
    const similar = keywords.length > 0 ? this.db.findSimilarSkills(keywords, 5) : [];

    // Pick the strongest match: skill with most keyword overlap in
    // its content. Threshold of 2 means a single coincidental token
    // doesn't force a wrong merge.
    let best: { name: string; overlap: number } | null = null;
    for (const skill of similar) {
      const body = `${skill.name} ${skill.content}`.toLowerCase();
      let overlap = 0;
      for (const k of keywords) if (body.includes(k)) overlap++;
      if (overlap >= 2 && (!best || overlap > best.overlap)) {
        best = { name: skill.name, overlap };
      }
    }

    if (best) {
      // Update path: append the new pattern under a separator so the
      // skill's prior content is preserved and the history is readable.
      const existing = this.db.getSkill(best.name);
      const stamp = new Date().toISOString();
      const appended =
        (existing?.content ?? '') +
        `\n\n---\nUpdate ${stamp}:\n${context}`;
      this.db.storeSkill({
        name: best.name,
        content: appended,
        category: existing?.category ?? 'task_patterns',
        source: 'agent'
      });
      console.log(`    🔁 Skill updated: ${best.name} (+${best.overlap} keyword overlap)`);
      return { created: 0, updated: 1 };
    }

    // Create path — only when nothing similar exists.
    const skillName = this.uniqueKey('task');
    this.db.storeSkill({
      name: skillName,
      content: `Task pattern learned:\n${context}`,
      category: 'task_patterns',
      source: 'agent'
    });
    console.log(`    💾 Skill created (no existing match): ${skillName}`);
    return { created: 1, updated: 0 };
  }

  /**
   * Handle session end — structured extraction guided by the memory
   * review prompt. Not yet a full LLM-backed background fork (see
   * `review_prompts.ts` for the contract that the future fork will use);
   * for now we sweep recent messages with heuristics that target the
   * same signal categories the prompt asks for: preferences, behavioral
   * expectations, personal facts.
   */
  private async handleSessionEnd(): Promise<{ memories: number; skills: number }> {
    // Referenced so a future background-fork implementation has the
    // exact prompts loaded; also prevents tree-shaking from dropping
    // the module while it's still infrastructure-only.
    void MEMORY_REVIEW_PROMPT;
    void SKILL_REVIEW_PROMPT;

    const messages = this.db.getRecentMessages(100);
    let memories = 0;
    const skills = 0;

    // Preference / behavioral-expectation signals.
    const preferencePatterns = [
      /i (prefer|like|want|need|always|never)/i,
      /remember that/i,
      /don't forget/i,
      /going forward/i,
      /from now on/i,
      /stop (doing|saying)/i
    ];

    // Personal-fact signals — "i'm a", "my <noun>", "we (live|work|fly|ride)".
    const factPatterns = [
      /\bi('m| am) (a|an) /i,
      /\bmy (wife|husband|partner|son|daughter|kid|kids|family|home|job|truck|boat|rv|tesla|f-?150|company)\b/i,
      /\bwe (live|work|fly|ride|own) /i
    ];

    for (const msg of messages) {
      if (msg.role !== 'user' || !msg.content) continue;

      let captured = false;

      for (const pattern of preferencePatterns) {
        if (pattern.test(msg.content)) {
          this.db.storeMemory({
            key: `preference_${this.uniqueKey('pref')}_${memories}`,
            value: msg.content,
            category: 'preferences',
            importance: 'normal',
            source: 'inferred'
          });
          memories++;
          captured = true;
          break;
        }
      }
      if (captured) continue;

      for (const pattern of factPatterns) {
        if (pattern.test(msg.content)) {
          this.db.storeMemory({
            key: `fact_${this.uniqueKey('fact')}_${memories}`,
            value: msg.content,
            category: 'facts',
            importance: 'normal',
            source: 'inferred'
          });
          memories++;
          break;
        }
      }
    }

    console.log(`    💾 Session end: ${memories} memories extracted`);
    return { memories, skills };
  }

  /**
   * Date.now() + monotonic counter — guarantees uniqueness across
   * keys produced by the same trigger fire even if the clock hasn't
   * advanced. The counter wraps inside the process but each value
   * combined with the timestamp is still distinct.
   */
  private uniqueKey(prefix: string): string {
    this.monotonicSeq = (this.monotonicSeq + 1) >>> 0;
    return `${prefix}_${Date.now()}_${this.monotonicSeq}`;
  }

  /**
   * Handle backstop — light review
   */
  private async handleBackstop(): Promise<{ memories: number }> {
    // Just a light pass — look for anything obvious
    const recentMessages = this.db.getRecentMessages(20);
    let memories = 0;

    // Look for corrections in recent messages
    const correctionPatterns = [/no,? (that's|thats) wrong/i, /actually,/i, /correction:/i];
    for (const msg of recentMessages) {
      if (msg.role !== 'user' || !msg.content) continue;
      for (const pattern of correctionPatterns) {
        if (pattern.test(msg.content)) {
          this.db.storeMemory({
            key: `correction_pattern_${Date.now()}`,
            value: msg.content,
            category: 'corrections',
            importance: 'high',
            source: 'inferred'
          });
          memories++;
          break;
        }
      }
    }

    return { memories };
  }

  /**
   * Get trigger stats
   */
  getStats(): {
    turnCount: number;
    lastReviewAt: Date | null;
    reviewInProgress: boolean;
    turnsUntilBackstop: number;
  } {
    return {
      turnCount: this.turnCount,
      lastReviewAt: this.lastReviewAt ? new Date(this.lastReviewAt) : null,
      reviewInProgress: this.reviewInProgress,
      turnsUntilBackstop: this.backstopInterval - (this.turnCount % this.backstopInterval)
    };
  }
}
