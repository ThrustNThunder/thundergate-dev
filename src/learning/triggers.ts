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
          // Task completion may create a new skill
          const created = await this.handleTaskComplete(event.context);
          if (created) skillsCreated = 1;
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
    // Store as critical memory
    this.db.storeMemory({
      key: `correction_${Date.now()}`,
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
   * Handle failure — update skills to prevent repeat
   */
  private async handleFailure(error: string, context?: string): Promise<void> {
    this.db.storeMemory({
      key: `failure_${Date.now()}`,
      value: `Error: ${error}${context ? `\nContext: ${context}` : ''}`,
      category: 'failures',
      importance: 'high',
      source: 'system'
    });

    console.log(`    ⚠️  Failure logged: ${error.substring(0, 60)}...`);
  }

  /**
   * Handle task complete — may create skill
   */
  private async handleTaskComplete(context?: string): Promise<boolean> {
    // Get recent messages to analyze
    const messages = this.db.getRecentMessages(30);
    if (messages.length < 5) return false;

    // Count tool calls — if many, might be a skill opportunity
    const assistantMessages = messages.filter(m => m.role === 'assistant');
    const hasPattern = assistantMessages.length >= 3;

    if (hasPattern && context) {
      // Create a skill from this pattern
      const skillName = `task_${Date.now()}`;
      this.db.storeSkill({
        name: skillName,
        content: `Task pattern learned:\n${context}`,
        category: 'task_patterns',
        source: 'agent'
      });
      console.log(`    💾 Skill created from task: ${skillName}`);
      return true;
    }

    return false;
  }

  /**
   * Handle session end — full review
   */
  private async handleSessionEnd(): Promise<{ memories: number; skills: number }> {
    const messages = this.db.getRecentMessages(100);
    let memories = 0;
    let skills = 0;

    // Look for preference statements
    const preferencePatterns = [
      /i (prefer|like|want|need|always|never)/i,
      /remember that/i,
      /don't forget/i,
      /going forward/i
    ];

    for (const msg of messages) {
      if (msg.role !== 'user' || !msg.content) continue;

      for (const pattern of preferencePatterns) {
        if (pattern.test(msg.content)) {
          this.db.storeMemory({
            key: `preference_${Date.now()}_${memories}`,
            value: msg.content,
            category: 'preferences',
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
