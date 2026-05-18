# ThunderGate Phase 4 — LLM Wiring Brief
## Date: May 10, 2026
## From: Jon | ThunderBase

## Context
Read: https://github.com/ThrustNThunder/cli-jon-context
Read: /home/ubuntu/thundergate-dev/PHASE3_SUMMARY.md (what Phase 3 built)
Read: /home/ubuntu/thundergate-dev/src/core/runtime.ts (callLLM stub is here)

## Goal
Wire `runtime.callLLM()` to a real model so Ghost Jon produces actual responses.

## Model to use: OpenAI GPT-5.4-mini
- Provider: OpenAI
- Model ID: `openai/gpt-4o-mini` (use this as fallback if gpt-5.4-mini not available via standard API)
- Actually use: `gpt-4o-mini` via OpenAI API (this is what's available on standard OpenAI API)
- API key location: read from config or environment

## Where to get the OpenAI API key
Read the OpenClaw config to find Rex/Mack's OpenAI key:
```bash
cat /home/ubuntu/.openclaw/openclaw.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get('models',{}), indent=2))" 2>/dev/null
cat /home/ubuntu/.openclaw/openclaw.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get('providers',{}), indent=2))" 2>/dev/null
```

If not found there, check:
```bash
cat /home/ubuntu/.openclaw/agents/main/agent/auth-profiles.json 2>/dev/null
```

Look for an openai key. If none found on ThunderBase, use Anthropic (claude-haiku-3-5 or claude-3-5-haiku) as the lightweight ghost model instead — it's already authenticated.

## What to implement

### 1. Update `src/config/loader.ts`
Add to the Config type and defaults:
```typescript
ghost: {
  model: 'openai/gpt-4o-mini',  // or 'anthropic/claude-haiku-3-5' if no OpenAI key
  maxTokens: 512,               // ghost responses should be short
  temperature: 0.3,             // lower temp = more predictable = easier to compare
}
```

### 2. Implement `runtime.callLLM()` in `src/core/runtime.ts`

The stub currently returns empty string. Wire it to make a real API call:

```typescript
async callLLM(messages: Array<{role: string, content: string}>): Promise<string> {
  const model = this.config.ghost.model;
  
  if (model.startsWith('openai/') || model.startsWith('gpt-')) {
    // OpenAI API call
    // Use fetch() — no npm package needed
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.openaiApiKey}`
      },
      body: JSON.stringify({
        model: model.replace('openai/', ''),
        messages,
        max_tokens: this.config.ghost.maxTokens,
        temperature: this.config.ghost.temperature
      })
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? '';
    
  } else if (model.startsWith('anthropic/') || model.startsWith('claude-')) {
    // Anthropic API call
    const anthropicModel = model.replace('anthropic/', '');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', 
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.anthropicApiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: anthropicModel,
        max_tokens: this.config.ghost.maxTokens,
        messages
      })
    });
    const data = await response.json();
    return data.content?.[0]?.text ?? '';
  }
  
  return '';
}
```

### 3. Update config to include API keys
In `src/config/loader.ts`, add to Config:
```typescript
openaiApiKey?: string;
anthropicApiKey?: string;
```

In defaults, read from environment:
```typescript
openaiApiKey: process.env.OPENAI_API_KEY ?? '',
anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
```

### 4. Read the Anthropic key from OpenClaw auth
In `src/config/index.ts` or `ensureConfig()`, try to auto-populate from OpenClaw:
```typescript
// Try to read Anthropic key from OpenClaw auth profiles
try {
  const authPath = path.join(os.homedir(), '.openclaw/agents/main/agent/auth-profiles.json');
  const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  if (auth?.profiles?.['anthropic:default']?.key) {
    config.anthropicApiKey = auth.profiles['anthropic:default'].key;
  }
} catch {}
```

### 5. Update `~/.thundergate/config.json` schema
Add the ghost model config and API keys to the default config.json template.

### 6. Test
After implementation, verify:
```bash
cd /home/ubuntu/thundergate-dev
npx tsc  # must be clean
node dist/cli/main.js ghost status  # shows ghost config
node -e "
const { ThunderGateRuntime } = await import('./dist/core/runtime.js');
const rt = new ThunderGateRuntime();
await rt.initialize();
const resp = await rt.callLLM([{role:'user', content:'Say hello in 5 words.'}]);
console.log('LLM response:', resp);
" 2>&1
```

## Output instructions
1. Make all changes to /home/ubuntu/thundergate-dev/src/
2. Commit locally: `git -C /home/ubuntu/thundergate-dev commit -am "Phase 4: Wire callLLM to GPT-4o-mini/Claude-Haiku for Ghost Jon"`
3. Do NOT push
4. Write PHASE4_SUMMARY.md to /home/ubuntu/thundergate-dev/
5. TypeScript must compile clean

## Priority
Use Anthropic (claude-haiku-3-5 or claude-3-haiku-20240307) if OpenAI key not found.
Anthropic key is definitely available — use it as the safe fallback.
