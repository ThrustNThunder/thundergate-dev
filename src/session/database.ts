/**
 * ThunderGate Session Database
 * 
 * SQLite with FTS5 for full-text search across all sessions.
 * One context, all channels read/write.
 * 
 * Schema based on Hermes analysis but built from scratch.
 */

import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { mkdirSync } from 'fs';

const SCHEMA_VERSION = 4;

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

-- Messages table (all channels write here).
-- agent_id (schema v4) namespaces every row so multiple agents can share
-- this database without cross-agent leakage. Default 'jon' preserves the
-- pre-multi-agent baseline.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  agent_id TEXT NOT NULL DEFAULT 'jon',
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
  agent_id TEXT NOT NULL DEFAULT 'jon',
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
  agent_id TEXT NOT NULL DEFAULT 'jon',
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

-- Promises table — outbound commitments extracted from assistant text.
-- status: OPEN | FULFILLED | DISMISSED. Closed promises retain the row
-- so the audit trail survives.
CREATE TABLE IF NOT EXISTS promises (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  agent_id TEXT NOT NULL DEFAULT 'jon',
  channel TEXT,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at REAL NOT NULL,
  closed_at REAL,
  resolved_by TEXT
);

-- Frames — first-class continuity object. ACTIVE | PAUSED | CLOSED.
-- parent_frame_id is set when a fresh frame opens after a gap; on
-- rejoin we reopen the paused frame in place and write a transition row.
CREATE TABLE IF NOT EXISTS frames (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL DEFAULT 'jon',
  opened_at REAL NOT NULL,
  closed_at REAL,
  topic_anchor TEXT NOT NULL,
  device_hint TEXT,
  model_in_use TEXT,
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  parent_frame_id TEXT,
  confidence_floor REAL NOT NULL DEFAULT 0.8,
  last_activity_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS frame_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  frame_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  timestamp REAL NOT NULL
);

-- Memory WAL — write-ahead log of every memory-affecting operation.
-- Rows land here BEFORE the operation is processed so a crash mid-flight
-- can be replayed on the next boot. Canonical state lives in the
-- subsystem tables (promises, frames, memory, untrain_log); the WAL is
-- the durable history of intent + the recovery surface.
--   type — discriminator. See WALEventType in src/memory/wal.ts.
--   payload — JSON-encoded type-specific body.
--   checksum — sha256 over the payload string. Verified on replay.
--   replayed — 0 until the boot replay sweeps the row, then 1.
CREATE TABLE IF NOT EXISTS memory_wal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  type TEXT NOT NULL,
  session_id TEXT,
  agent_id TEXT NOT NULL DEFAULT 'jon',
  payload TEXT NOT NULL,
  replayed INTEGER NOT NULL DEFAULT 0,
  checksum TEXT NOT NULL
);

-- WAL archive — rows older than the retention window (default 7 days)
-- AND already replayed are moved here on rotation. Same shape as
-- memory_wal so it can be queried with the same code paths.
CREATE TABLE IF NOT EXISTS memory_wal_archive (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  type TEXT NOT NULL,
  session_id TEXT,
  payload TEXT NOT NULL,
  replayed INTEGER NOT NULL DEFAULT 1,
  checksum TEXT NOT NULL,
  archived_at INTEGER NOT NULL
);

-- Untrain audit — rows for every untrain operation, regardless of trigger.
-- The provenance ledger has the primary audit trail; this table is the
-- query-friendly view for the CLI 'untrain log' command.
CREATE TABLE IF NOT EXISTS untrain_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp REAL NOT NULL,
  actor TEXT NOT NULL,
  target_key TEXT NOT NULL,
  target_value TEXT,
  reason TEXT,
  trigger_type TEXT
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id, session_id);
CREATE INDEX IF NOT EXISTS idx_context_key ON context(key);
CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
CREATE INDEX IF NOT EXISTS idx_memory_category ON memory(category);
CREATE INDEX IF NOT EXISTS idx_promises_status ON promises(status, created_at);
CREATE INDEX IF NOT EXISTS idx_frames_status ON frames(status, opened_at);
CREATE INDEX IF NOT EXISTS idx_frame_transitions_frame ON frame_transitions(frame_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_untrain_log_ts ON untrain_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_memory_wal_replayed ON memory_wal(replayed, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_wal_type ON memory_wal(type, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_wal_archive_ts ON memory_wal_archive(created_at);
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
  private db!: Database.Database;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || join(process.env.HOME || '', '.thundergate', 'context.db');
  }

  /**
   * Initialize database with schema
   */
  async initialize(): Promise<void> {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    
    // SQLite WAL journaling — separate from our memory_wal table.
    // This pragma ensures the DB file itself survives crashes at the
    // filesystem layer; combined with the application-level memory_wal
    // table, every memory-affecting op is durable end-to-end.
    // synchronous=NORMAL is the safe-for-WAL setting: fsync happens at
    // checkpoint boundaries, not every commit. Much faster than FULL,
    // and the only failure mode it admits is losing the last few
    // transactions on hard power loss — which is exactly what the
    // memory_wal replay path is designed to recover from.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    // Create schema
    this.db.exec(SCHEMA_SQL);
    this.db.exec(FTS_SQL);

    // Schema v2 additions to existing tables. ALTER TABLE ADD COLUMN
    // throws "duplicate column" when re-run; we swallow that specific
    // error so initialize() stays idempotent across restarts.
    this.addColumnIfMissing('memory', 'status', "TEXT NOT NULL DEFAULT 'confirmed'");
    this.addColumnIfMissing('memory', 'uses_remaining', 'INTEGER NOT NULL DEFAULT 0');

    // Schema v4 multi-agent dimension. Existing rows are stamped 'jon'
    // via the column DEFAULT so the live Jon instance keeps working
    // without a backfill step.
    this.addColumnIfMissing('messages', 'agent_id', "TEXT NOT NULL DEFAULT 'jon'");
    this.addColumnIfMissing('memory', 'agent_id', "TEXT NOT NULL DEFAULT 'jon'");
    this.addColumnIfMissing('skills', 'agent_id', "TEXT NOT NULL DEFAULT 'jon'");
    this.addColumnIfMissing('promises', 'agent_id', "TEXT NOT NULL DEFAULT 'jon'");
    this.addColumnIfMissing('frames', 'agent_id', "TEXT NOT NULL DEFAULT 'jon'");
    this.addColumnIfMissing('memory_wal', 'agent_id', "TEXT NOT NULL DEFAULT 'jon'");
    try {
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id, session_id)'
      );
    } catch {
      /* index already present */
    }

    // Check/update schema version
    const version = this.db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
    if (!version) {
      this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    } else if (version.version < SCHEMA_VERSION) {
      this.db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
    }
  }

  /**
   * Idempotent ALTER TABLE ADD COLUMN. SQLite has no "IF NOT EXISTS" for
   * column adds — we issue the ALTER and swallow the duplicate-column
   * error, which is the only outcome on a re-run.
   */
  private addColumnIfMissing(table: string, column: string, ddl: string): void {
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    } catch (err) {
      const msg = (err as Error).message || '';
      if (!/duplicate column name/i.test(msg)) {
        throw err;
      }
    }
  }

  /** Raw handle escape hatch for memory subsystems (frames, promises). */
  raw(): Database.Database {
    return this.db;
  }

  /**
   * Idempotently ensure a sessions row exists for `id`. The messages
   * table FKs to sessions(id), so any code path that writes a message
   * for an ad-hoc/synthetic session (e.g. the learning trigger's
   * 'current' bucket, ghost harness session IDs derived from JSONL
   * filenames) must call this first or the INSERT throws.
   */
  ensureSession(id: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO sessions (id, started_at, status)
      VALUES (?, ?, 'active')
    `).run(id, Date.now() / 1000);
  }

  /**
   * Store a message (from any channel). agentId defaults to 'jon' for
   * backward compatibility with the pre-multi-agent runtime.
   */
  storeMessage(message: {
    sessionId: string;
    agentId?: string;
    channel: string;
    role: string;
    content: string;
    toolCalls?: string;
    toolName?: string;
    tokenCount?: number;
    importance?: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO messages (session_id, agent_id, channel, role, content, tool_calls, tool_name, timestamp, token_count, importance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      message.sessionId,
      message.agentId ?? 'jon',
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
   * Get recent messages (across all channels), scoped to one agent.
   */
  getRecentMessages(limit: number = 50, agentId: string = 'jon'): Message[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE agent_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    return stmt.all(agentId, limit) as Message[];
  }

  /**
   * Get the recent N messages for one session. SessionDB stores rows from
   * every session across the runtime's lifetime; the surface attach and
   * context manager both want only the currently-active session's transcript
   * (so a TTL reset cleanly starts a new history without dragging old
   * conversation through the LLM call).
   */
  getRecentMessagesForSession(sessionId: string, limit: number = 50, agentId: string = 'jon'): Message[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE session_id = ? AND agent_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    return stmt.all(sessionId, agentId, limit) as Message[];
  }

  /**
   * Get messages by channel, scoped to one agent.
   */
  getMessagesByChannel(channel: string, limit: number = 50, agentId: string = 'jon'): Message[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE channel = ? AND agent_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    return stmt.all(channel, agentId, limit) as Message[];
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
   * Store skill. agentId defaults to 'jon'.
   */
  storeSkill(skill: {
    name: string;
    agentId?: string;
    content: string;
    category?: string;
    source?: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO skills (name, agent_id, content, category, created_at, updated_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        content = excluded.content,
        updated_at = excluded.updated_at
    `);

    const now = Date.now() / 1000;
    stmt.run(
      skill.name,
      skill.agentId ?? 'jon',
      skill.content,
      skill.category || null,
      now,
      now,
      skill.source || 'agent'
    );
  }

  /**
   * Get skill by name, scoped to one agent.
   */
  getSkill(name: string, agentId: string = 'jon'): Skill | null {
    const stmt = this.db.prepare('SELECT * FROM skills WHERE name = ? AND agent_id = ?');
    const skill = stmt.get(name, agentId) as Skill | undefined;

    if (skill) {
      // Update use count
      this.db.prepare('UPDATE skills SET use_count = use_count + 1, last_used = ? WHERE name = ? AND agent_id = ?')
        .run(Date.now() / 1000, name, agentId);
    }

    return skill || null;
  }

  /**
   * List all skills for one agent.
   */
  listSkills(agentId: string = 'jon'): Skill[] {
    const stmt = this.db.prepare('SELECT * FROM skills WHERE agent_id = ? ORDER BY use_count DESC, updated_at DESC');
    return stmt.all(agentId) as Skill[];
  }

  /**
   * Store memory entry. The provisional-memory flow (added in schema v2)
   * routes through the optional `status` and `usesRemaining` fields —
   * when omitted, rows default to 'confirmed' with 0 uses remaining,
   * matching pre-v2 behavior.
   */
  storeMemory(entry: {
    key: string;
    agentId?: string;
    value: string;
    category?: string;
    importance?: string;
    source?: string;
    status?: 'provisional' | 'confirmed';
    usesRemaining?: number;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO memory (key, agent_id, value, category, created_at, updated_at, importance, source, status, uses_remaining)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at,
        importance = excluded.importance,
        status = excluded.status,
        uses_remaining = excluded.uses_remaining
    `);

    const now = Date.now() / 1000;
    const status = entry.status || 'confirmed';
    const uses = entry.usesRemaining ?? 0;
    stmt.run(
      entry.key,
      entry.agentId ?? 'jon',
      entry.value,
      entry.category || null,
      now,
      now,
      entry.importance || 'normal',
      entry.source || 'inferred',
      status,
      uses
    );
  }

  /**
   * Get memory by key, scoped to one agent.
   */
  getMemory(key: string, agentId: string = 'jon'): MemoryEntry | null {
    const stmt = this.db.prepare('SELECT * FROM memory WHERE key = ? AND agent_id = ?');
    return stmt.get(key, agentId) as MemoryEntry | undefined || null;
  }

  /**
   * List all memories with status, scoped to one agent. The CLI 'memory list'
   * command uses this to surface provisional vs. confirmed counts.
   */
  listMemories(limit: number = 100, agentId: string = 'jon'): MemoryEntry[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memory
      WHERE agent_id = ?
      ORDER BY
        CASE importance
          WHEN 'critical' THEN 0
          WHEN 'high'     THEN 1
          WHEN 'normal'   THEN 2
          ELSE 3
        END,
        updated_at DESC
      LIMIT ?
    `);
    return stmt.all(agentId, limit) as MemoryEntry[];
  }

  /**
   * Decrement uses_remaining for a provisional memory by one. Returns the
   * row's new state. Once uses_remaining reaches 0 the caller is expected
   * to call confirmMemory().
   */
  decrementProvisionalUse(key: string): MemoryEntry | null {
    const tx = this.db.transaction((k: string) => {
      this.db.prepare(`
        UPDATE memory
        SET uses_remaining = CASE WHEN uses_remaining > 0 THEN uses_remaining - 1 ELSE 0 END,
            updated_at = ?
        WHERE key = ? AND status = 'provisional'
      `).run(Date.now() / 1000, k);
      return this.getMemory(k);
    });
    return tx(key);
  }

  /** Promote a provisional memory to confirmed. Idempotent. */
  confirmMemory(key: string): void {
    this.db.prepare(`
      UPDATE memory
      SET status = 'confirmed', uses_remaining = 0, updated_at = ?
      WHERE key = ?
    `).run(Date.now() / 1000, key);
  }

  /** Hard delete a memory row by key. Returns true if a row was removed. */
  deleteMemory(key: string): boolean {
    const info = this.db.prepare('DELETE FROM memory WHERE key = ?').run(key);
    return info.changes > 0;
  }

  // ─── Promises ─────────────────────────────────────────────────────────

  insertPromise(p: {
    id: string;
    sessionId?: string | null;
    agentId?: string;
    channel?: string | null;
    text: string;
  }): void {
    this.db.prepare(`
      INSERT INTO promises (id, session_id, agent_id, channel, text, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'OPEN', ?)
    `).run(
      p.id,
      p.sessionId ?? null,
      p.agentId ?? 'jon',
      p.channel ?? null,
      p.text,
      Date.now() / 1000
    );
  }

  closePromise(id: string, status: 'FULFILLED' | 'DISMISSED', resolvedBy: string): boolean {
    const info = this.db.prepare(`
      UPDATE promises
      SET status = ?, closed_at = ?, resolved_by = ?
      WHERE id = ? AND status = 'OPEN'
    `).run(status, Date.now() / 1000, resolvedBy, id);
    return info.changes > 0;
  }

  getOpenPromises(limit: number = 50, agentId: string = 'jon'): PromiseRow[] {
    return this.db.prepare(`
      SELECT * FROM promises WHERE status = 'OPEN' AND agent_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(agentId, limit) as PromiseRow[];
  }

  getAllPromises(limit: number = 100, agentId: string = 'jon'): PromiseRow[] {
    return this.db.prepare(`
      SELECT * FROM promises
      WHERE agent_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(agentId, limit) as PromiseRow[];
  }

  // ─── Frames ───────────────────────────────────────────────────────────

  insertFrame(f: {
    id: string;
    agentId?: string;
    topicAnchor: string;
    deviceHint?: string | null;
    modelInUse?: string | null;
    sessionId?: string | null;
    parentFrameId?: string | null;
    confidenceFloor?: number;
  }): void {
    const now = Date.now() / 1000;
    this.db.prepare(`
      INSERT INTO frames (
        id, agent_id, opened_at, topic_anchor, device_hint, model_in_use,
        session_id, status, parent_frame_id, confidence_floor, last_activity_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)
    `).run(
      f.id,
      f.agentId ?? 'jon',
      now,
      f.topicAnchor,
      f.deviceHint ?? null,
      f.modelInUse ?? null,
      f.sessionId ?? null,
      f.parentFrameId ?? null,
      f.confidenceFloor ?? 0.8,
      now
    );
  }

  updateFrameStatus(id: string, status: 'ACTIVE' | 'PAUSED' | 'CLOSED'): void {
    const now = Date.now() / 1000;
    if (status === 'CLOSED') {
      this.db.prepare(`
        UPDATE frames SET status = ?, closed_at = ?, last_activity_at = ? WHERE id = ?
      `).run(status, now, now, id);
    } else {
      this.db.prepare(`
        UPDATE frames SET status = ?, closed_at = NULL, last_activity_at = ? WHERE id = ?
      `).run(status, now, id);
    }
  }

  touchFrame(id: string): void {
    this.db.prepare(`UPDATE frames SET last_activity_at = ? WHERE id = ?`)
      .run(Date.now() / 1000, id);
  }

  getFrame(id: string, agentId: string = 'jon'): FrameRow | null {
    return (this.db.prepare('SELECT * FROM frames WHERE id = ? AND agent_id = ?').get(id, agentId) as FrameRow | undefined) ?? null;
  }

  getActiveOrPausedFrame(agentId: string = 'jon'): FrameRow | null {
    return (this.db.prepare(`
      SELECT * FROM frames
      WHERE status IN ('ACTIVE', 'PAUSED') AND agent_id = ?
      ORDER BY last_activity_at DESC
      LIMIT 1
    `).get(agentId) as FrameRow | undefined) ?? null;
  }

  getRecentFrames(limit: number = 20, agentId: string = 'jon'): FrameRow[] {
    return this.db.prepare(`
      SELECT * FROM frames
      WHERE agent_id = ?
      ORDER BY opened_at DESC
      LIMIT ?
    `).all(agentId, limit) as FrameRow[];
  }

  logFrameTransition(t: {
    frameId: string;
    from: string | null;
    to: string;
    reason?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO frame_transitions (frame_id, from_status, to_status, reason, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(t.frameId, t.from ?? null, t.to, t.reason ?? null, Date.now() / 1000);
  }

  getRecentFrameTransitions(limit: number = 50): FrameTransitionRow[] {
    return this.db.prepare(`
      SELECT * FROM frame_transitions
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit) as FrameTransitionRow[];
  }

  // ─── Untrain audit ────────────────────────────────────────────────────

  logUntrain(entry: {
    actor: string;
    targetKey: string;
    targetValue?: string | null;
    reason?: string | null;
    triggerType?: string | null;
  }): void {
    this.db.prepare(`
      INSERT INTO untrain_log (timestamp, actor, target_key, target_value, reason, trigger_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      Date.now() / 1000,
      entry.actor,
      entry.targetKey,
      entry.targetValue ?? null,
      entry.reason ?? null,
      entry.triggerType ?? null
    );
  }

  getRecentUntrains(limit: number = 50): UntrainLogRow[] {
    return this.db.prepare(`
      SELECT * FROM untrain_log
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit) as UntrainLogRow[];
  }

  /**
   * Recent memory rows in importance-then-recency order. Importance is
   * stored as a string ('critical' | 'high' | 'normal' | …) so we map it
   * to an integer in the query rather than relying on lexicographic sort,
   * which would put 'normal' above 'critical'.
   *
   * Consumed by the Ghost system-prompt assembler so a fresh correction
   * actually influences the next shadow turn — without this, the learning
   * loop is write-only and behavior cannot change.
   */
  getRecentMemories(limit: number = 10, agentId: string = 'jon'): MemoryEntry[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memory
      WHERE agent_id = ?
      ORDER BY
        CASE importance
          WHEN 'critical' THEN 0
          WHEN 'high'     THEN 1
          WHEN 'normal'   THEN 2
          ELSE 3
        END,
        updated_at DESC
      LIMIT ?
    `);
    return stmt.all(agentId, limit) as MemoryEntry[];
  }

  /**
   * Skill content search — used by the learning trigger to decide whether
   * a new pattern should update an existing skill instead of creating a
   * new one. Returns skills whose name or content contains any of the
   * supplied keyword tokens, ordered by recency.
   */
  findSimilarSkills(keywords: string[], limit: number = 5): Skill[] {
    if (keywords.length === 0) return [];
    const likes = keywords.map(() => '(content LIKE ? OR name LIKE ?)').join(' OR ');
    const params: string[] = [];
    for (const k of keywords) {
      const wild = `%${k}%`;
      params.push(wild, wild);
    }
    const stmt = this.db.prepare(
      `SELECT * FROM skills WHERE ${likes} ORDER BY updated_at DESC LIMIT ?`
    );
    return stmt.all(...params, limit) as Skill[];
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
  agent_id: string;
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
  agent_id: string;
  content: string;
  category: string | null;
  created_at: number;
  updated_at: number;
  use_count: number;
  last_used: number | null;
  source: string;
}

export interface MemoryEntry {
  id: number;
  key: string;
  agent_id: string;
  value: string;
  category: string | null;
  created_at: number;
  updated_at: number;
  importance: string;
  source: string;
  // v2: provisional-memory machinery. status is 'provisional' | 'confirmed';
  // existing rows default to 'confirmed' via the column DEFAULT. uses_remaining
  // is the countdown on a provisional entry — decremented each time the
  // memory is surfaced into a prompt; promoted to 'confirmed' at 0.
  status: string;
  uses_remaining: number;
}

export interface PromiseRow {
  id: string;
  session_id: string | null;
  agent_id: string;
  channel: string | null;
  text: string;
  status: 'OPEN' | 'FULFILLED' | 'DISMISSED' | string;
  created_at: number;
  closed_at: number | null;
  resolved_by: string | null;
}

export interface FrameRow {
  id: string;
  agent_id: string;
  opened_at: number;
  closed_at: number | null;
  topic_anchor: string;
  device_hint: string | null;
  model_in_use: string | null;
  session_id: string | null;
  status: 'ACTIVE' | 'PAUSED' | 'CLOSED' | string;
  parent_frame_id: string | null;
  confidence_floor: number;
  last_activity_at: number;
}

export interface FrameTransitionRow {
  id: number;
  frame_id: string;
  from_status: string | null;
  to_status: string;
  reason: string | null;
  timestamp: number;
}

export interface UntrainLogRow {
  id: number;
  timestamp: number;
  actor: string;
  target_key: string;
  target_value: string | null;
  reason: string | null;
  trigger_type: string | null;
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
