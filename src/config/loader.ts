/**
 * ThunderGate Configuration
 * 
 * ONE config file. ONE place to set everything.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface Config {
  version: string;

  // Database
  database: {
    path: string;
  };

  // Phase 3: Runtime — points at OpenClaw session + unified context file
  runtime: {
    openclaw_session_file: string;
    context_file: string;
    model: string;
  };

  // Phase 3: Ghost Jon shadow mode
  ghost: {
    enabled: boolean;
    // Directory of OpenClaw session files — harness watches every *.jsonl
    // inside, picks up new ones via periodic rescan.
    sessions_dir: string;
    // fs.watchFile polling interval (ms). Polling is required: fs.watch
    // misses appends to JSONL on Linux.
    watch_interval_ms: number;
    log_file: string;
    scores_file: string;
    // Phase 4: lightweight LLM used by the shadow harness
    model: string;       // e.g. 'openai/gpt-4o-mini' or 'anthropic/claude-haiku-4-5-20251001'
    maxTokens: number;
    temperature: number;
  };

  // Phase 4: provider credentials. Populated from env or OpenClaw auth.
  openaiApiKey?: string;
  anthropicApiKey?: string;
  // Voyage AI embeddings (now part of Anthropic). Used by Ghost Jon's
  // tier-3 semantic comparator. If absent, the comparator falls back to
  // its tier-1/tier-2 scores and logs the skip — it never blocks pairing.
  voyageApiKey?: string;

  // Model routing
  model: {
    mode: 'auto' | 'manual' | 'supersaver';
    primary: string;
    reasoning: string;
    surface: string;
    fallback: string[];
    supersaver: {
      model: string;
      cache: string;
      reasoning: boolean;
    };
  };

  // Cache settings
  cache: {
    hot: string;      // Anthropic native (1h max)
    warm: string;     // Local cache (24h)
    cold: string;     // Compressed (7d)
    archive: string;  // Forever
  };

  // Compaction
  compaction: {
    threshold24h: number;      // Tokens before compacting within 24h
    emergencyThreshold: number; // Force compact above this
    backstopTurns: number;      // Compact after N turns regardless
  };

  // Learning loop
  learning: {
    enabled: boolean;
    triggers: string[];         // 'task_complete', 'correction', 'session_end', 'failure', 'backstop'
    backstopTurns: number;      // Every N turns as backstop
    skillsEnabled: boolean;
    memoryEnabled: boolean;
  };

  // Channels
  channels: {
    thundercommo: {
      enabled: boolean;
      relay: string;
      port?: number;
      relay_url?: string;
      tokens?: Record<string, string>;
    };
    browser: {
      enabled: boolean;
      port?: number;
      audit_file?: string;
      max_queue_per_client?: number;
      accept_unverified_pairing?: boolean;
    };
    slack: { enabled: boolean; token?: string; };
    whatsapp: { enabled: boolean; };
    telegram: { enabled: boolean; token?: string; };
    discord: { enabled: boolean; token?: string; };
    phone: { enabled: boolean; provider?: string; };
    imessage: { enabled: boolean; };
  };

  // Doctor mode
  doctor: {
    enabled: boolean;
    intervalMs: number;         // Health check interval
    alertThresholds: {
      cpuPercent: number;
      memoryMb: number;
      contextTokens: number;
    };
    autoRecover: boolean;
  };

  // Deep mode / Surface layer
  parallel: {
    surfaceModel: string;
    surfaceMaxTokens: number;
    deepModeThreshold: number;  // Tool calls before deep mode activates
  };
}

const DEFAULT_CONFIG: Config = {
  version: '0.1.0',
  
  database: {
    path: join(process.env.HOME || '', '.thundergate', 'context.db')
  },

  runtime: {
    openclaw_session_file: '/home/ubuntu/.openclaw/agents/main/sessions/agent:main:main.jsonl',
    context_file: join(process.env.HOME || '', '.thundergate', 'context.jsonl'),
    model: 'anthropic/claude-sonnet-4-6'
  },

  ghost: {
    enabled: false,
    sessions_dir: '/home/ubuntu/.openclaw/agents/main/sessions/',
    watch_interval_ms: 2000,
    log_file: join(process.env.HOME || '', '.thundergate', 'ghost-log.jsonl'),
    scores_file: join(process.env.HOME || '', '.thundergate', 'ghost-scores.json'),
    model: 'anthropic/claude-haiku-4-5-20251001',
    maxTokens: 512,
    temperature: 0.3
  },

  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  voyageApiKey: process.env.VOYAGE_API_KEY ?? '',

  model: {
    mode: 'auto',
    primary: 'anthropic/claude-sonnet-4-6',
    reasoning: 'anthropic/claude-opus-4-5',
    surface: 'anthropic/claude-sonnet-4-6',
    fallback: ['anthropic/claude-sonnet-4-5'],
    supersaver: {
      model: 'anthropic/claude-sonnet-4-5',
      cache: 'long',
      reasoning: false
    }
  },

  cache: {
    hot: '1h',
    warm: '24h',
    cold: '7d',
    archive: 'forever'
  },

  compaction: {
    threshold24h: 500000,       // 500K tokens in 24h triggers review
    emergencyThreshold: 800000, // 800K forces immediate compact
    backstopTurns: 20
  },

  learning: {
    enabled: true,
    triggers: ['task_complete', 'correction', 'session_end', 'failure', 'backstop'],
    backstopTurns: 20,
    skillsEnabled: true,
    memoryEnabled: true
  },

  channels: {
    thundercommo: {
      enabled: true,
      relay: 'wss://relay.thunderai.us',
      port: 8765,
      relay_url: 'wss://relay.thunderai.us',
      tokens: {}
    },
    browser: {
      enabled: true,
      port: 9876,
      audit_file: join(process.env.HOME || '', '.thundergate', 'browser-audit.jsonl'),
      max_queue_per_client: 256,
      accept_unverified_pairing: true
    },
    slack: { enabled: true },
    whatsapp: { enabled: true },
    telegram: { enabled: true },
    discord: { enabled: false },
    phone: { enabled: false },
    imessage: { enabled: false }
  },

  doctor: {
    enabled: true,
    intervalMs: 30000,          // Check every 30 seconds
    alertThresholds: {
      cpuPercent: 90,
      memoryMb: 1500,
      contextTokens: 800000
    },
    autoRecover: true
  },

  parallel: {
    surfaceModel: 'anthropic/claude-sonnet-4-6',
    surfaceMaxTokens: 5000,
    deepModeThreshold: 5         // 5+ tool calls = deep mode
  }
};

export function loadConfig(configPath?: string): Config {
  const path = configPath || join(process.env.HOME || '', '.thundergate', 'config.json');
  
  if (!existsSync(path)) {
    return DEFAULT_CONFIG;
  }

  try {
    const content = readFileSync(path, 'utf-8');
    const userConfig = JSON.parse(content);
    
    // Deep merge with defaults
    return deepMerge(DEFAULT_CONFIG, userConfig);
  } catch (error) {
    console.warn(`Failed to load config from ${path}, using defaults:`, error);
    return DEFAULT_CONFIG;
  }
}

function deepMerge<T>(target: T, source: Partial<T>): T {
  const result = { ...target };
  
  for (const key in source) {
    if (source[key] !== undefined) {
      if (typeof source[key] === 'object' && !Array.isArray(source[key])) {
        (result as any)[key] = deepMerge((target as any)[key] || {}, source[key] as any);
      } else {
        (result as any)[key] = source[key];
      }
    }
  }
  
  return result;
}
