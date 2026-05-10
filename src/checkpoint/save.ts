/**
 * ThunderGate Checkpoint — Save/Load System
 *
 * Hybrid adaptive:
 * - Cold start: ~4K tokens (checkpoint only)
 * - Expand on demand: agent pulls what's needed
 * - Human override: "full context" or "stay light"
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import * as os from 'os';

const THUNDERGATE_DIR = join(os.homedir(), '.thundergate');
const CHECKPOINT_FILE = join(THUNDERGATE_DIR, 'checkpoint.json');

export interface CheckpointData {
  version: number;
  sessionId: string;
  savedAt: string;
  identity: {
    name: string;
    role: string;
    location: string;
  };
  activeProjects: string[];
  recentCorrections: string[];
  openTodos: string[];
  armedAutomations: string[];
  contextTokenEstimate: number;
  modelMode: string;
  doctorStatus: string;
  consecutiveHealthyChecks: number;
}

const DEFAULT_CHECKPOINT: CheckpointData = {
  version: 1,
  sessionId: '',
  savedAt: '',
  identity: {
    name: 'Jon',
    role: 'Technical Director, ThunderBase',
    location: 'AWS EC2, US-East'
  },
  activeProjects: [],
  recentCorrections: [],
  openTodos: [],
  armedAutomations: [],
  contextTokenEstimate: 0,
  modelMode: 'auto',
  doctorStatus: 'unknown',
  consecutiveHealthyChecks: 0
};

/**
 * Save checkpoint to disk
 */
export function saveCheckpoint(data: Partial<CheckpointData>): CheckpointData {
  // Ensure directory exists
  if (!existsSync(THUNDERGATE_DIR)) {
    mkdirSync(THUNDERGATE_DIR, { recursive: true });
  }

  const checkpoint: CheckpointData = {
    ...DEFAULT_CHECKPOINT,
    ...data,
    version: 1,
    savedAt: new Date().toISOString(),
    sessionId: data.sessionId || `tg-${Date.now()}`
  };

  // Estimate token count
  checkpoint.contextTokenEstimate = estimateTokens(checkpoint);

  writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
  console.log(`  ✓ Checkpoint saved (${checkpoint.contextTokenEstimate} tokens est.)`);

  return checkpoint;
}

/**
 * Load checkpoint from disk
 */
export function loadCheckpoint(): CheckpointData | null {
  if (!existsSync(CHECKPOINT_FILE)) {
    console.log('  ⚠ No checkpoint found — cold start');
    return null;
  }

  try {
    const raw = readFileSync(CHECKPOINT_FILE, 'utf-8');
    const data = JSON.parse(raw) as CheckpointData;

    // Version check
    if (data.version !== 1) {
      console.log(`  ⚠ Checkpoint version mismatch (${data.version}) — ignoring`);
      return null;
    }

    const age = Date.now() - new Date(data.savedAt).getTime();
    const ageHours = (age / 3600000).toFixed(1);

    console.log(`  ✓ Checkpoint loaded (${data.contextTokenEstimate} tokens, ${ageHours}h old)`);
    return data;

  } catch (error) {
    console.error('  ✗ Checkpoint load failed:', error);
    return null;
  }
}

/**
 * Update specific checkpoint fields
 */
export function updateCheckpoint(updates: Partial<CheckpointData>): CheckpointData {
  const current = loadCheckpoint() || DEFAULT_CHECKPOINT;
  return saveCheckpoint({ ...current, ...updates });
}

/**
 * Estimate token count for checkpoint data
 */
export function estimateTokens(data: CheckpointData): number {
  const json = JSON.stringify(data);
  return Math.ceil(json.length / 4);
}

/**
 * Check if checkpoint is fresh (< 24h old)
 */
export function isCheckpointFresh(maxAgeHours: number = 24): boolean {
  const checkpoint = loadCheckpoint();
  if (!checkpoint) return false;

  const age = Date.now() - new Date(checkpoint.savedAt).getTime();
  return age < maxAgeHours * 3600000;
}

/**
 * Test: create, save, and reload a checkpoint
 */
export function createTestCheckpoint(): boolean {
  console.log('Testing checkpoint system...');

  const testData: Partial<CheckpointData> = {
    sessionId: 'test-session-123',
    identity: {
      name: 'Jon',
      role: 'Technical Director',
      location: 'ThunderBase'
    },
    activeProjects: ['ThunderGate', 'ThunderCommo iOS'],
    recentCorrections: ['ThunderBrowser is Michael+Alex joint'],
    openTodos: ['CLI Jon GitHub workflow', 'Phase 2 complete'],
    armedAutomations: ['AA2644 check-in May 11'],
    modelMode: 'auto',
    doctorStatus: 'healthy',
    consecutiveHealthyChecks: 42
  };

  // Save
  const saved = saveCheckpoint(testData);
  console.log(`  Saved: ${saved.contextTokenEstimate} tokens`);

  // Load
  const loaded = loadCheckpoint();
  if (!loaded) {
    console.error('  ✗ Load failed');
    return false;
  }

  // Verify
  const pass = loaded.sessionId === testData.sessionId &&
    loaded.activeProjects?.length === testData.activeProjects?.length &&
    loaded.consecutiveHealthyChecks === testData.consecutiveHealthyChecks;

  console.log(`  ${pass ? '✅' : '❌'} Checkpoint test ${pass ? 'passed' : 'FAILED'}`);
  return pass;
}
