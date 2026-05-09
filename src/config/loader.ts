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
    thundercommo: { enabled: boolean; relay: string; };
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
    thundercommo: { enabled: true, relay: 'wss://relay.thunderai.us' },
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
