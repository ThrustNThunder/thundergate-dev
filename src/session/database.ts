/**
 * ThunderGate Session Database
 * 
 * SQLite with FTS5 for full-text search across all sessions.
 * One context, all channels read/write.
 * 
 * Schema based on Hermes analysis but built from scratch.
 */

import Database from 'better-sqlite3';
import { join } from 'path';

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at REAL NOT NULL,
  ended_at REAL,
  status TEXT DEFAULT 'active',
  message_count INTEGER DEFAULT 0,
  tool_call_count INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  model TEXT,
  title TEXT
);

-- Messages table (all channels write here)
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  channel TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_calls TEXT,
  tool_name TEXT,
  timestamp REAL NOT NULL,
  token_count INTEGER,
  importance TEXT DEFAULT 'normal'
);

-- Context table (unified context for all channels)
CREATE TABLE IF NOT EXISTS context (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  value TEXT,
  updated_at REAL NOT NULL,
  importance TEXT DEFAULT 'normal'
);

-- Skills table
CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  content TEXT NOT NULL,
  category TEXT,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  use_count INTEGER DEFAULT 0,
  last_used REAL,
  source TEXT DEFAULT 'agent'
);

-- Memory table (facts about user, preferences)
CREATE TABLE IF NOT EXISTS memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  value TEXT NOT NULL,
  category TEXT,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  importance TEXT DEFAULT 'normal',
  source TEXT DEFAULT 'inferred'
);

-- Health/Doctor table
CREATE TABLE IF NOT EXISTS health_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp REAL NOT NULL,
  status TEXT NOT NULL,
  cpu_percent REAL,
  memory_mb REAL,
  context_tokens INTEGER,
  anomaly TEXT,
  action_taken TEXT
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, timestamp);
CREATE INDEX IF NOT EXISTS idx_context_key ON context(key);
CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
CREATE INDEX IF NOT EXISTS idx_memory_category ON memory(category);
`;

const FTS_SQL = `
-- FTS5 for full-text search across messages
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='id'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
`;

export class SessionDB {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || join(process.env.HOME || '', '.thundergate', 'context.db');
  }

  /**
   * Initialize database with schema
   */
  async initialize(): Promise<void> {
    this.db = new Database(this.dbPath);
    
    // Enable WAL mode for concurrent access
    this.db.pragma('journal_mode = WAL');
    
    // Create schema
    this.db.exec(SCHEMA_SQL);
    this.db.exec(FTS_SQL);

    // Check/update schema version
    const version = this.db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
    if (!version) {
      this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    }
  }

  /**
   * Store a message (from any channel)
   */
  storeMessage(message: {
    sessionId: string;
    channel: string;
    role: string;
    content: string;
    toolCalls?: string;
    toolName?: string;
    tokenCount?: number;
    importance?: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO messages (session_id, channel, role, content, tool_calls, tool_name, timestamp, token_count, importance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const result = stmt.run(
      message.sessionId,
      message.channel,
      message.role,
      message.content,
      message.toolCalls || null,
      message.toolName || null,
      Date.now() / 1000,
      message.tokenCount || null,
      message.importance || 'normal'
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Full-text search across all messages
   */
  search(query: string, limit: number = 20): SearchResult[] {
    const stmt = this.db.prepare(`
      SELECT m.*, rank
      FROM messages_fts fts
      JOIN messages m ON m.id = fts.rowid
      WHERE messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);

    return stmt.all(query, limit) as SearchResult[];
  }

  /**
   * Get recent messages (across all channels)
   */
  getRecentMessages(limit: number = 50): Message[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    return stmt.all(limit) as Message[];
  }

  /**
   * Get messages by channel
   */
  getMessagesByChannel(channel: string, limit: number = 50): Message[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE channel = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    return stmt.all(channel, limit) as Message[];
  }

  /**
   * Store/update context value
   */
  setContext(key: string, value: string, importance: string = 'normal'): void {
    const stmt = this.db.prepare(`
      INSERT INTO context (key, value, updated_at, importance)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at,
        importance = excluded.importance
    `);

    stmt.run(key, value, Date.now() / 1000, importance);
  }

  /**
   * Get context value
   */
  getContext(key: string): string | null {
    const stmt = this.db.prepare('SELECT value FROM context WHERE key = ?');
    const row = stmt.get(key) as { value: string } | undefined;
    return row?.value || null;
  }

  /**
   * Get all context (for checkpoint)
   */
  getAllContext(): ContextEntry[] {
    const stmt = this.db.prepare('SELECT * FROM context ORDER BY importance DESC, updated_at DESC');
    return stmt.all() as ContextEntry[];
  }

  /**
   * Store skill
   */
  storeSkill(skill: {
    name: string;
    content: string;
    category?: string;
    source?: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO skills (name, content, category, created_at, updated_at, source)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        content = excluded.content,
        updated_at = excluded.updated_at
    `);

    const now = Date.now() / 1000;
    stmt.run(skill.name, skill.content, skill.category || null, now, now, skill.source || 'agent');
  }

  /**
   * Get skill by name
   */
  getSkill(name: string): Skill | null {
    const stmt = this.db.prepare('SELECT * FROM skills WHERE name = ?');
    const skill = stmt.get(name) as Skill | undefined;
    
    if (skill) {
      // Update use count
      this.db.prepare('UPDATE skills SET use_count = use_count + 1, last_used = ? WHERE name = ?')
        .run(Date.now() / 1000, name);
    }

    return skill || null;
  }

  /**
   * List all skills
   */
  listSkills(): Skill[] {
    const stmt = this.db.prepare('SELECT * FROM skills ORDER BY use_count DESC, updated_at DESC');
    return stmt.all() as Skill[];
  }

  /**
   * Store memory entry
   */
  storeMemory(entry: {
    key: string;
    value: string;
    category?: string;
    importance?: string;
    source?: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO memory (key, value, category, created_at, updated_at, importance, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at,
        importance = excluded.importance
    `);

    const now = Date.now() / 1000;
    stmt.run(entry.key, entry.value, entry.category || null, now, now, entry.importance || 'normal', entry.source || 'inferred');
  }

  /**
   * Get memory by key
   */
  getMemory(key: string): MemoryEntry | null {
    const stmt = this.db.prepare('SELECT * FROM memory WHERE key = ?');
    return stmt.get(key) as MemoryEntry | undefined || null;
  }

  /**
   * Log health status
   */
  logHealth(status: {
    status: string;
    cpuPercent?: number;
    memoryMb?: number;
    contextTokens?: number;
    anomaly?: string;
    actionTaken?: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO health_log (timestamp, status, cpu_percent, memory_mb, context_tokens, anomaly, action_taken)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      Date.now() / 1000,
      status.status,
      status.cpuPercent || null,
      status.memoryMb || null,
      status.contextTokens || null,
      status.anomaly || null,
      status.actionTaken || null
    );
  }

  /**
   * Get recent health logs
   */
  getHealthLogs(limit: number = 100): HealthLog[] {
    const stmt = this.db.prepare('SELECT * FROM health_log ORDER BY timestamp DESC LIMIT ?');
    return stmt.all(limit) as HealthLog[];
  }

  /**
   * Close database
   */
  async close(): Promise<void> {
    this.db.close();
  }
}

// Types
interface Message {
  id: number;
  session_id: string;
  channel: string;
  role: string;
  content: string;
  tool_calls: string | null;
  tool_name: string | null;
  timestamp: number;
  token_count: number | null;
  importance: string;
}

interface SearchResult extends Message {
  rank: number;
}

interface ContextEntry {
  id: number;
  key: string;
  value: string;
  updated_at: number;
  importance: string;
}

interface Skill {
  id: number;
  name: string;
  content: string;
  category: string | null;
  created_at: number;
  updated_at: number;
  use_count: number;
  last_used: number | null;
  source: string;
}

interface MemoryEntry {
  id: number;
  key: string;
  value: string;
  category: string | null;
  created_at: number;
  updated_at: number;
  importance: string;
  source: string;
}

interface HealthLog {
  id: number;
  timestamp: number;
  status: string;
  cpu_percent: number | null;
  memory_mb: number | null;
  context_tokens: number | null;
  anomaly: string | null;
  action_taken: string | null;
}
