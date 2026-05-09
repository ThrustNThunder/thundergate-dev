/**
 * ThunderGate Checkpoint System
 * 
 * Hybrid adaptive loading:
 * - Load checkpoint (~4K tokens)
 * - Agent thinks: "What do I need?"
 * - Pull more on demand
 * - Human override available
 */

import { SessionDB } from '../session/database.js';
import { Config } from '../config/loader.js';

interface CheckpointData {
  sessionId: string;
  tokenCount: number;
  identity: string;
  currentState: {
    status: string;
    activeProjects: string[];
    recentThreads: string[];
    armedAutomations: string[];
    openTodos: string[];
  };
  hotMemoryRefs: string[];
  lastCorrection?: string;
  loadedAt: Date;
}

export class Checkpoint {
  private db: SessionDB;
  private config: Config;
  private data: CheckpointData | null = null;

  constructor(db: SessionDB, config: Config) {
    this.db = db;
    this.config = config;
  }

  /**
   * Load checkpoint — adaptive, pulls only what's needed
   */
  async load(): Promise<CheckpointData> {
    // Load base checkpoint from context
    const identity = this.db.getContext('identity') || 'ThunderGate Agent';
    const state = this.db.getContext('current_state');
    const lastCorrection = this.db.getContext('last_correction');

    // Parse state or use defaults
    let currentState = {
      status: 'starting',
      activeProjects: [] as string[],
      recentThreads: [] as string[],
      armedAutomations: [] as string[],
      openTodos: [] as string[]
    };

    if (state) {
      try {
        currentState = JSON.parse(state);
      } catch {}
    }

    // Get hot memory references (most recent, most important)
    const hotMemory = this.db.getAllContext()
      .filter(c => c.importance === 'high' || c.importance === 'critical')
      .slice(0, 10)
      .map(c => c.key);

    // Calculate approximate token count
    const tokenCount = this.estimateTokens({
      identity,
      currentState,
      hotMemory,
      lastCorrection
    });

    this.data = {
      sessionId: `tg-${Date.now()}`,
      tokenCount,
      identity,
      currentState,
      hotMemoryRefs: hotMemory,
      lastCorrection: lastCorrection || undefined,
      loadedAt: new Date()
    };

    return this.data;
  }

  /**
   * Expand context — pull more when needed
   */
  async expand(request: ExpandRequest): Promise<ExpandedContext> {
    const expanded: ExpandedContext = {
      skills: [],
      memory: [],
      messages: [],
      tokenCount: 0
    };

    // Pull requested skills
    if (request.skills) {
      for (const skillName of request.skills) {
        const skill = this.db.getSkill(skillName);
        if (skill) {
          expanded.skills.push(skill);
        }
      }
    }

    // Pull memory by category
    if (request.memoryCategories) {
      // TODO: Implement category-based memory retrieval
    }

    // Pull recent messages
    if (request.recentMessages) {
      expanded.messages = this.db.getRecentMessages(request.recentMessages);
    }

    // Search for relevant context
    if (request.searchQuery) {
      const results = this.db.search(request.searchQuery, 10);
      expanded.messages.push(...results);
    }

    // Calculate expanded token count
    expanded.tokenCount = this.estimateExpandedTokens(expanded);

    return expanded;
  }

  /**
   * Full context load — when user requests everything
   */
  async loadFull(): Promise<ExpandedContext> {
    return this.expand({
      skills: this.db.listSkills().map(s => s.name),
      recentMessages: 100
    });
  }

  /**
   * Save checkpoint — called before shutdown or periodically
   */
  async save(): Promise<void> {
    if (!this.data) return;

    // Save current state
    this.db.setContext('current_state', JSON.stringify(this.data.currentState), 'high');
    this.db.setContext('identity', this.data.identity, 'critical');
    this.db.setContext('checkpoint_saved_at', new Date().toISOString(), 'normal');
  }

  /**
   * Update checkpoint with new information
   */
  updateState(updates: Partial<CheckpointData['currentState']>): void {
    if (!this.data) return;

    this.data.currentState = {
      ...this.data.currentState,
      ...updates
    };
  }

  /**
   * Record a correction (burns in, high priority)
   */
  recordCorrection(correction: string): void {
    this.db.setContext('last_correction', correction, 'critical');
    if (this.data) {
      this.data.lastCorrection = correction;
    }
  }

  /**
   * Estimate token count for checkpoint data
   */
  private estimateTokens(data: any): number {
    // Rough estimate: 1 token ≈ 4 characters
    const json = JSON.stringify(data);
    return Math.ceil(json.length / 4);
  }

  /**
   * Estimate token count for expanded context
   */
  private estimateExpandedTokens(expanded: ExpandedContext): number {
    let chars = 0;
    
    for (const skill of expanded.skills) {
      chars += skill.content.length;
    }
    
    for (const entry of expanded.memory) {
      chars += entry.value.length;
    }
    
    for (const msg of expanded.messages) {
      chars += (msg.content || '').length;
    }

    return Math.ceil(chars / 4);
  }
}

// Types
interface ExpandRequest {
  skills?: string[];
  memoryCategories?: string[];
  recentMessages?: number;
  searchQuery?: string;
}

interface ExpandedContext {
  skills: any[];
  memory: any[];
  messages: any[];
  tokenCount: number;
}
