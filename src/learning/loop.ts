/**
 * ThunderGate Learning Loop
 * 
 * Event-based triggers, not time-based:
 * 1. Task completes
 * 2. Correction from Michael
 * 3. Session ends
 * 4. Failure occurs
 * 5. Every 20 turns (backstop)
 * 
 * Memory and Skills stay separate.
 */

import { SessionDB } from '../session/database.js';
import { Config } from '../config/loader.js';

interface LearningEvent {
  type: 'task_complete' | 'correction' | 'session_end' | 'failure' | 'backstop' | 'message_processed';
  message?: any;
  response?: any;
  error?: Error;
  correction?: string;
}

export class LearningLoop {
  private db: SessionDB;
  private config: Config;
  private turnsSinceReview: number = 0;
  private pendingReview: boolean = false;

  constructor(db: SessionDB, config: Config) {
    this.db = db;
    this.config = config;
  }

  /**
   * Check if any learning triggers should fire
   */
  async checkTriggers(event: LearningEvent): Promise<void> {
    if (!this.config.learning.enabled) return;

    this.turnsSinceReview++;

    const triggers = this.config.learning.triggers;
    let shouldReview = false;
    let reviewType: 'memory' | 'skills' | 'both' = 'both';

    // Check each trigger type
    if (triggers.includes('task_complete') && event.type === 'task_complete') {
      shouldReview = true;
      reviewType = 'skills';  // Task completion → skill opportunity
    }

    if (triggers.includes('correction') && event.type === 'correction') {
      shouldReview = true;
      reviewType = 'both';    // Corrections burn into both
      
      // Immediately store correction as high-priority memory
      if (event.correction) {
        this.db.storeMemory({
          key: `correction_${Date.now()}`,
          value: event.correction,
          category: 'corrections',
          importance: 'critical',
          source: 'michael'
        });
      }
    }

    if (triggers.includes('session_end') && event.type === 'session_end') {
      shouldReview = true;
      reviewType = 'both';
    }

    if (triggers.includes('failure') && event.type === 'failure') {
      shouldReview = true;
      reviewType = 'skills';  // Failures → skill updates
      
      // Store failure for learning
      if (event.error) {
        this.db.storeMemory({
          key: `failure_${Date.now()}`,
          value: event.error.message,
          category: 'failures',
          importance: 'high',
          source: 'system'
        });
      }
    }

    // Backstop: review every N turns regardless
    if (triggers.includes('backstop') && 
        this.turnsSinceReview >= this.config.learning.backstopTurns) {
      shouldReview = true;
      reviewType = 'both';
    }

    // Run background review if triggered
    if (shouldReview && !this.pendingReview) {
      this.pendingReview = true;
      this.turnsSinceReview = 0;
      
      // Run in background (don't block main processing)
      setImmediate(() => this.runBackgroundReview(reviewType, event));
    }
  }

  /**
   * Run background review — like Hermes' background fork
   * Evaluates conversation and decides what to save
   */
  private async runBackgroundReview(
    type: 'memory' | 'skills' | 'both',
    event: LearningEvent
  ): Promise<void> {
    try {
      console.log(`  📚 Background review triggered (${type})`);

      if (type === 'memory' || type === 'both') {
        if (this.config.learning.memoryEnabled) {
          await this.reviewForMemory(event);
        }
      }

      if (type === 'skills' || type === 'both') {
        if (this.config.learning.skillsEnabled) {
          await this.reviewForSkills(event);
        }
      }

    } catch (error) {
      console.error('  ✗ Background review failed:', error);
    } finally {
      this.pendingReview = false;
    }
  }

  /**
   * Review conversation for memory updates
   * Memory = facts about user, preferences, history
   */
  private async reviewForMemory(event: LearningEvent): Promise<void> {
    // Get recent messages
    const recentMessages = this.db.getRecentMessages(20);
    
    // TODO: Use LLM to analyze and extract memory-worthy information
    // For now, just log that we would review
    console.log(`    → Reviewing ${recentMessages.length} messages for memory updates`);

    // Example extraction logic (to be replaced with LLM):
    // - Look for "remember" or "don't forget"
    // - Look for preference statements
    // - Look for personal information shared
  }

  /**
   * Review conversation for skill updates
   * Skills = how to do tasks, procedures, lessons
   */
  private async reviewForSkills(event: LearningEvent): Promise<void> {
    // Get recent messages
    const recentMessages = this.db.getRecentMessages(50);
    
    // TODO: Use LLM to analyze and extract skill opportunities
    console.log(`    → Reviewing ${recentMessages.length} messages for skill opportunities`);

    // Skill creation signals:
    // - Multi-step task completed (>5 tool calls)
    // - User corrected approach
    // - Error was recovered from
    // - Pattern repeated 3+ times
  }

  /**
   * Create a new skill from learned experience
   */
  async createSkill(skill: {
    name: string;
    content: string;
    category?: string;
  }): Promise<void> {
    // Validate skill doesn't already exist
    const existing = this.db.getSkill(skill.name);
    if (existing) {
      // Update instead of create
      return this.updateSkill(skill.name, skill.content);
    }

    // Store new skill
    this.db.storeSkill({
      name: skill.name,
      content: skill.content,
      category: skill.category,
      source: 'agent'
    });

    console.log(`  💾 Skill created: ${skill.name}`);
  }

  /**
   * Update existing skill with new learning
   */
  async updateSkill(name: string, content: string): Promise<void> {
    this.db.storeSkill({
      name,
      content,
      source: 'agent'
    });

    console.log(`  💾 Skill updated: ${name}`);
  }

  /**
   * Store memory entry
   */
  async storeMemory(entry: {
    key: string;
    value: string;
    category?: string;
    importance?: string;
  }): Promise<void> {
    this.db.storeMemory({
      key: entry.key,
      value: entry.value,
      category: entry.category,
      importance: entry.importance || 'normal',
      source: 'agent'
    });

    console.log(`  💾 Memory stored: ${entry.key}`);
  }

  /**
   * Record correction from Michael (burns in immediately)
   */
  async recordCorrection(correction: string): Promise<void> {
    // Store in memory as critical
    this.db.storeMemory({
      key: `correction_${Date.now()}`,
      value: correction,
      category: 'corrections',
      importance: 'critical',
      source: 'michael'
    });

    // Also store in context for checkpoint
    this.db.setContext('last_correction', correction, 'critical');

    console.log(`  🔥 Correction burned in: ${correction.substring(0, 50)}...`);

    // Trigger immediate skills review — correction might update a skill
    await this.reviewForSkills({ type: 'correction', correction });
  }

  /**
   * Get skills relevant to a query
   */
  getRelevantSkills(query: string, limit: number = 5): any[] {
    // For now, just return most used skills
    // TODO: Implement semantic search with embeddings
    return this.db.listSkills().slice(0, limit);
  }

  /**
   * Get memory entries by category
   */
  getMemoryByCategory(category: string): any[] {
    // TODO: Implement in database
    return [];
  }
}
