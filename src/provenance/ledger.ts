/**
 * Provenance Ledger — append-only JSONL of state transitions.
 *
 * Per the awareness analysis (§7.3), every meaningful state change in
 * ThunderGate should write a row here: who, what, when, why. This file is
 * the substrate that lets the gateway answer "why am I doing what I'm
 * doing right now?" without grepping logs.
 *
 * This is the stub: a process-local JSONL appender plus a tail reader.
 * Future work moves it into SQLite once the row volume justifies the
 * upgrade and once consumers (Doctor, TUI, learning loop) start querying
 * it. Until then JSONL is enough — it's append-safe across crashes and
 * trivial to inspect with `tail`.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';

export interface ProvenanceEvent {
  timestamp: number;       // epoch ms
  actor: string;           // who/what initiated the change ('local-inference', 'doctor', 'runtime', 'config', …)
  action: string;          // verb-phrase ('liveness_ok', 'liveness_lost', 'mode_change', …)
  target: string;          // what was affected ('local-inference-provider', 'processingMode', …)
  reason?: string;         // optional human-readable cause
  data?: Record<string, unknown>;  // optional structured payload
}

export class ProvenanceLedger {
  private path: string;
  private headerWritten = false;

  constructor(path: string) {
    this.path = path;
  }

  /**
   * Append one event. Best-effort: a write failure (no disk, permissions)
   * is logged and swallowed — provenance is observability, never the
   * critical path, and a noisy throw here would mask the actual subsystem
   * the caller was reporting on.
   */
  append(event: Omit<ProvenanceEvent, 'timestamp'> & { timestamp?: number }): void {
    const row: ProvenanceEvent = {
      timestamp: event.timestamp ?? Date.now(),
      actor: event.actor,
      action: event.action,
      target: event.target,
      ...(event.reason !== undefined ? { reason: event.reason } : {}),
      ...(event.data !== undefined ? { data: event.data } : {})
    };
    try {
      if (!this.headerWritten && !existsSync(this.path)) {
        mkdirSync(dirname(this.path), { recursive: true });
      }
      appendFileSync(this.path, JSON.stringify(row) + '\n', 'utf-8');
      this.headerWritten = true;
    } catch (err) {
      console.warn('  ⚠ provenance.append failed:', (err as Error).message);
    }
  }

  /**
   * Read the last N rows, oldest-first. Returns [] if the file doesn't
   * exist yet — provenance is purely additive, so "no file" === "no
   * events recorded".
   */
  tail(limit: number = 50): ProvenanceEvent[] {
    if (!existsSync(this.path)) return [];
    try {
      const raw = readFileSync(this.path, 'utf-8');
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      const slice = lines.slice(-limit);
      const out: ProvenanceEvent[] = [];
      for (const line of slice) {
        try {
          out.push(JSON.parse(line) as ProvenanceEvent);
        } catch {
          // skip corrupt lines — JSONL ledgers occasionally truncate
          // under hard kill; we'd rather show N-1 events than throw.
        }
      }
      return out;
    } catch {
      return [];
    }
  }
}
