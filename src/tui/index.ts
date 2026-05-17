/**
 * ThunderTUI — native terminal UI for ThunderGate.
 *
 *  • Chat mode    — plain stdout + readline against the SurfaceAttach socket
 *                  (ws://127.0.0.1:8772). No widget framework, so terminal
 *                  mouse select / right-click copy work normally.
 *
 *  • Browser mode — blessed-rendered live page view, fed by the provenance
 *                  ledger + CDP Runtime.evaluate on port 9222.
 *
 *  • Split mode   — currently falls back to chat mode; mixing a plain-stdout
 *                  chat with a blessed browser pane in the same terminal
 *                  isn't worth the layout complexity for this fix.
 *
 * The blessed chat pane was removed because its mouse capture made terminal
 * text selection impossible.
 */

import blessed from 'blessed';
import { WebSocket } from 'ws';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import * as readline from 'node:readline';
import { ensureConfig } from '../config/index.js';
import { ProvenanceLedger } from '../provenance/ledger.js';

void existsSync;
void readFileSync;
const THUNDERGATE_DIR = join(process.env.HOME || '', '.thundergate');
const CDP_PORT = 9222;
const BROWSER_REFRESH_MS = 3000;
const SURFACE_ATTACH_PORT = 8772;

export interface TuiOptions {
  mode: 'chat' | 'browser' | 'split';
  /** Override the ThunderCommo URL — defaults to the SurfaceAttach socket. */
  chatUrl?: string;
}

export async function launchTui(opts: TuiOptions): Promise<void> {
  if (opts.mode === 'chat' || opts.mode === 'split') {
    if (opts.mode === 'split') {
      process.stdout.write(
        '[note] --split currently runs as --chat-only so the terminal\n' +
        '       keeps native mouse selection. Use `thundergate tui --browser`\n' +
        '       in a second terminal for the browser pane.\n\n'
      );
    }
    await runPlainChat(opts);
    return;
  }
  await runBlessedBrowser(opts);
}

// ── plain chat ───────────────────────────────────────────────────────────

interface PlainChatState {
  lastAssistantText: string | undefined;
  rl: readline.Interface;
  thinkingShown: boolean;
}

async function runPlainChat(opts: TuiOptions): Promise<void> {
  const url = resolveChatUrl(opts);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: '\nYou: '
  });

  const state: PlainChatState = {
    lastAssistantText: undefined,
    rl,
    thinkingShown: false
  };

  const clearThinking = () => {
    if (!state.thinkingShown) return;
    // CR + clear-to-EOL ANSI sequence.
    process.stdout.write('\r\x1b[K');
    state.thinkingShown = false;
  };

  // Print a chunk that didn't come from the user. If the user is mid-line,
  // erase that line first, print the chunk, then redraw the prompt + buffer.
  const writeAsync = (chunk: string) => {
    clearThinking();
    const inputBuffer = rl.line;
    if (inputBuffer.length > 0 || rl.cursor > 0) {
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
    }
    process.stdout.write(chunk);
    rl.prompt(true);
    if (inputBuffer.length > 0) {
      process.stdout.write(inputBuffer);
    }
  };

  const writeLine = (s: string) => writeAsync(s + '\n');

  process.stdout.write(`Attaching to ThunderGate session at ${url}…\n`);

  const client = openSurfaceClient(url, {
    onAttached: (sessionId, model, history) => {
      writeLine(`● attached  session=${sessionId?.slice(0, 8) ?? 'none'} model=${model}`);
      if (history.length === 0) {
        writeLine('(no prior history in this session)');
      } else {
        writeLine(`─── ${history.length} prior turn${history.length === 1 ? '' : 's'} ───`);
        for (const m of history) writeLine(formatPlainMessage(m.sender, m.text));
        const lastJon = [...history].reverse().find((mm) => mm.sender !== 'Michael');
        if (lastJon) state.lastAssistantText = lastJon.text;
      }
      rl.prompt();
    },
    onMessage: (m) => {
      writeLine(formatPlainMessage(m.sender, m.text));
      if (m.sender !== 'Michael') state.lastAssistantText = m.text;
    },
    onThinking: (agentId) => {
      if (state.thinkingShown) return;
      process.stdout.write(`[${agentId} thinking...]`);
      state.thinkingShown = true;
    },
    onClose: (reason) => writeLine(`● detached  ${reason}`),
    onError: (err) => writeLine(`● error: ${err.message}`),
    onServerError: (code, message) => writeLine(`● ${code}: ${message}`)
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }
    if (trimmed.startsWith('/')) {
      void dispatchPlainSlash(trimmed, state, client).then(() => rl.prompt());
      return;
    }
    client.send(trimmed);
    rl.prompt();
  });

  const shutdown = () => {
    try { client.close(); } catch { /* ignore */ }
    try { rl.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  rl.on('SIGINT', shutdown);
  rl.on('close', shutdown);
  process.on('SIGTERM', shutdown);

  // Pin the event loop — readline + WebSocket also pin it, but the unresolved
  // promise is belt-and-suspenders for early errors before either is wired in.
  await new Promise<void>(() => { /* resolves never; shutdown calls process.exit */ });
}

function formatPlainMessage(sender: string, text: string): string {
  return `\n[${sender}] ${text}`;
}

// ── slash commands (plain mode) ──────────────────────────────────────────

interface SlashCommand {
  name: string;
  signature: string;
  description: string;
  takesArgs?: boolean;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/navigate', signature: '/navigate <url>',           description: 'Drive the browser to a URL', takesArgs: true },
  { name: '/read',     signature: '/read',                     description: 'Print visible page text into chat' },
  { name: '/click',    signature: '/click <selector>',         description: 'Click an element (CSS or text=Foo)', takesArgs: true },
  { name: '/fill',     signature: '/fill <selector> <value>',  description: 'Fill an input field', takesArgs: true },
  { name: '/status',   signature: '/status',                   description: 'Show runtime + browser + Ghost snapshot' },
  { name: '/copy',     signature: '/copy',                     description: "Copy Jon's last reply to the clipboard" },
  { name: '/clear',    signature: '/clear',                    description: 'Clear the chat history pane' },
  { name: '/help',     signature: '/help',                     description: 'List available slash commands' },
  { name: '/quit',     signature: '/quit',                     description: 'Exit ThunderTUI' }
];

async function dispatchPlainSlash(
  raw: string,
  state: PlainChatState,
  client: ChatClient
): Promise<void> {
  const parts = raw.trim().split(/\s+/);
  const head = parts[0].toLowerCase();
  const args = parts.slice(1);

  const echo = (line: string) => process.stdout.write(stripBlessedTags(line) + '\n');

  try {
    switch (head) {
      case '/quit':
      case '/exit':
        client.close();
        try { state.rl.close(); } catch { /* ignore */ }
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      case '/clear':
        // ANSI clear screen + home cursor.
        process.stdout.write('\x1b[2J\x1b[H');
        return;
      case '/help':
        for (const c of SLASH_COMMANDS) echo(`  ${c.signature.padEnd(28)} ${c.description}`);
        return;
      case '/copy':
        await runCopyPlain(state.lastAssistantText, echo);
        return;
      case '/read':
        await runRead(echo);
        return;
      case '/navigate':
        if (args.length === 0) { echo('usage: /navigate <url>'); return; }
        await runNavigate(args[0], echo);
        return;
      case '/click':
        if (args.length === 0) { echo('usage: /click <selector|text=Foo>'); return; }
        await runClick(args.join(' '), echo);
        return;
      case '/fill':
        if (args.length < 2) { echo('usage: /fill <selector> <value>'); return; }
        await runFill(args[0], args.slice(1).join(' '), echo);
        return;
      case '/status':
        await runStatus(echo);
        return;
      default:
        echo(`unknown command: ${head}`);
    }
  } catch (err) {
    echo((err as Error).message);
  }
}

async function runCopyPlain(
  lastAssistantText: string | undefined,
  echo: (line: string) => void
): Promise<void> {
  if (!lastAssistantText) {
    echo('nothing to copy yet — wait for Jon to respond.');
    return;
  }
  const bytes = lastAssistantText.length;
  let clipboardOk = false;
  try {
    await copyToClipboard(lastAssistantText);
    clipboardOk = true;
  } catch { /* fall through to file path */ }

  const filePath = join(THUNDERGATE_DIR, 'last-jon-reply.txt');
  try {
    const { writeFileSync, mkdirSync: mk } = await import('fs');
    mk(THUNDERGATE_DIR, { recursive: true });
    writeFileSync(filePath, lastAssistantText);
  } catch (err) {
    if (!clipboardOk) {
      echo(`copy failed (no clipboard, file write failed too): ${(err as Error).message}`);
      return;
    }
  }
  if (clipboardOk) {
    echo(`Copied to clipboard (${bytes} chars) — also saved → ${filePath}`);
  } else {
    echo(`no X clipboard available — saved last Jon reply to file (${bytes} chars): ${filePath}`);
  }
}

/**
 * Strip blessed tags so reused helpers (runRead, runStatus, …) that still
 * emit `{red-fg}…{/red-fg}` produce clean text on plain stdout.
 */
function stripBlessedTags(s: string): string {
  return s.replace(/\{[^{}\n]+\}/g, (m) => {
    if (m === '{open}') return '{';
    if (m === '{close}') return '}';
    return '';
  });
}

// ── surface client ───────────────────────────────────────────────────────

interface ChatClient {
  send(text: string): void;
  close(): void;
}

interface ChatMessage {
  sender: string;
  text: string;
  timestamp: number;
}

interface SurfaceHooks {
  onAttached: (sessionId: string | null, model: string, history: ChatMessage[]) => void;
  onMessage: (msg: ChatMessage) => void;
  onThinking: (agentId: string) => void;
  onClose: (reason: string) => void;
  onError: (err: Error) => void;
  onServerError: (code: string, message: string) => void;
}

function openSurfaceClient(url: string, hooks: SurfaceHooks): ChatClient {
  let ws: WebSocket | null = new WebSocket(url);
  let closed = false;

  ws.on('message', (raw) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const t = typeof msg.type === 'string' ? msg.type : '';
    if (t === 'attached') {
      const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : null;
      const model = typeof msg.model === 'string' ? msg.model : 'unknown';
      const arr = Array.isArray(msg.history) ? msg.history : [];
      hooks.onAttached(sessionId, model, arr.map(coerceChatMessage));
    } else if (t === 'message') {
      hooks.onMessage(coerceChatMessage(msg));
    } else if (t === 'thinking') {
      const agentId = typeof msg.agentId === 'string' ? msg.agentId : 'agent';
      hooks.onThinking(agentId);
    } else if (t === 'error') {
      const code = typeof msg.code === 'string' ? msg.code : 'ERROR';
      const message = typeof msg.message === 'string' ? msg.message : 'unknown error';
      hooks.onServerError(code, message);
    }
  });

  ws.on('error', (err) => hooks.onError(err as Error));
  ws.on('close', (code, reason) => {
    if (closed) return;
    hooks.onClose(`code=${code} ${reason?.toString() ?? ''}`.trim());
  });

  return {
    send: (text: string) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        type: 'send',
        text,
        correlationId: randomKey()
      }));
    },
    close: () => {
      closed = true;
      try { ws?.close(1000, 'tui-quit'); } catch { /* ignore */ }
      ws = null;
    }
  };
}

function coerceChatMessage(raw: unknown): ChatMessage {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    sender: typeof r.sender === 'string' ? r.sender : 'agent',
    text: typeof r.text === 'string' ? r.text : '',
    timestamp: typeof r.timestamp === 'number' ? r.timestamp : Date.now()
  };
}

function randomKey(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function resolveChatUrl(opts: TuiOptions): string {
  if (opts.chatUrl) return opts.chatUrl;
  return `ws://127.0.0.1:${SURFACE_ATTACH_PORT}`;
}

// ── browser action helpers (shared with plain chat slash commands) ───────

async function runRead(echo: (line: string) => void): Promise<void> {
  const text = await readPageText();
  const lines = text.split('\n').slice(0, 60).join('\n');
  echo(`page text (first ${Math.min(60, text.split('\n').length)} lines):\n${lines}`);
}

async function runNavigate(url: string, echo: (line: string) => void): Promise<void> {
  if (!/^https?:\/\//i.test(url)) {
    echo('url must start with http(s)://');
    return;
  }
  await navigateViaCDP(url);
  echo(`✓ navigated to ${url}`);
}

async function runClick(selector: string, echo: (line: string) => void): Promise<void> {
  const expr = buildClickExpr(selector);
  await evalOnPageOnce(expr);
  echo(`✓ clicked ${selector}`);
}

async function runFill(selector: string, value: string, echo: (line: string) => void): Promise<void> {
  const expr = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('element_not_found');
    if ('value' in el) {
      el.focus();
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = ${JSON.stringify(value)};
    } else {
      throw new Error('element_not_fillable');
    }
    return true;
  })()`;
  await evalOnPageOnce(expr);
  echo(`✓ filled ${selector} (${value.length} chars)`);
}

async function runStatus(echo: (line: string) => void): Promise<void> {
  const parts: string[] = [];
  try {
    const snap = await fetchContextStatusViaSurface();
    if (snap) {
      const ageMin = Math.floor(snap.msSinceLastActivity / 60_000);
      parts.push(`runtime: session=${snap.sessionId?.slice(0, 16) ?? '(none)'} turns=${snap.sessionTurnCount} tokens≈${snap.sessionTokensEstimate} age=${ageMin}m`);
      parts.push(`context: ttl=${snap.cfg.sessionTtl} compaction=${snap.cfg.compaction} cache=${snap.cfg.cacheRetention}`);
    } else {
      parts.push('runtime: unreachable on 127.0.0.1:8772');
    }
  } catch (err) {
    parts.push(`runtime: ${(err as Error).message}`);
  }
  const browser = readBrowserSnapshot();
  parts.push(`browser: ${browser.connected ? '● connected' : '● disconnected'} url=${browser.url || '(none)'}`);
  parts.push(`ghost: ${readGhostScoreLine()}`);
  echo(parts.join('\n'));
}

interface ContextSnapshot {
  sessionId: string | null;
  msSinceLastActivity: number;
  sessionTurnCount: number;
  sessionTokensEstimate: number;
  cfg: { sessionTtl: string; cacheRetention: string; compaction: string; maxTokens: number; pruneOnReset: boolean };
}

async function fetchContextStatusViaSurface(): Promise<ContextSnapshot | null> {
  return await new Promise<ContextSnapshot | null>((resolve) => {
    const sock = new WebSocket(`ws://127.0.0.1:${SURFACE_ATTACH_PORT}`);
    const timer = setTimeout(() => {
      try { sock.close(); } catch { /* ignore */ }
      resolve(null);
    }, 1500);
    sock.on('open', () => sock.send(JSON.stringify({ type: 'status_request' })));
    sock.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; snapshot?: ContextSnapshot };
        if (msg?.type === 'status') {
          clearTimeout(timer);
          try { sock.close(); } catch { /* ignore */ }
          resolve(msg.snapshot ?? null);
        }
      } catch { /* keep waiting */ }
    });
    sock.on('error', () => { clearTimeout(timer); resolve(null); });
    sock.on('close', () => { clearTimeout(timer); resolve(null); });
  });
}

function readGhostScoreLine(): string {
  try {
    const cfg = ensureConfig();
    const raw = readFileSync(cfg.ghost?.scores_file ?? '', 'utf-8');
    const j = JSON.parse(raw) as { weighted?: number; overall?: number; updated_at?: number; categories?: Record<string, { score?: number }> };
    const score = typeof j.weighted === 'number' ? j.weighted : (j.overall ?? null);
    if (score === null || score === undefined) return '(no score yet)';
    return `weighted=${score.toFixed(3)}`;
  } catch {
    return '(scores file missing)';
  }
}

async function copyToClipboard(text: string): Promise<void> {
  const { spawn } = await import('child_process');
  const candidates: Array<{ bin: string; args: string[] }> = [
    { bin: 'xsel', args: ['-bi'] },
    { bin: 'xclip', args: ['-selection', 'clipboard', '-in'] },
    { bin: 'wl-copy', args: [] }
  ];
  return await new Promise<void>((resolve, reject) => {
    let lastErr: Error | null = null;
    const tryNext = (idx: number) => {
      if (idx >= candidates.length) {
        reject(lastErr ?? new Error('no clipboard backend (install xsel or xclip)'));
        return;
      }
      const c = candidates[idx];
      let proc;
      try {
        proc = spawn(c.bin, c.args, { stdio: ['pipe', 'ignore', 'pipe'] });
      } catch (err) {
        lastErr = err as Error;
        tryNext(idx + 1);
        return;
      }
      proc.on('error', (err) => {
        lastErr = err;
        tryNext(idx + 1);
      });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else { lastErr = new Error(`${c.bin} exited ${code}`); tryNext(idx + 1); }
      });
      proc.stdin?.end(text);
    };
    tryNext(0);
  });
}

// ── browser-only mode (blessed) ──────────────────────────────────────────

interface BrowserHost {
  pane: blessed.Widgets.BoxElement;
  header: blessed.Widgets.BoxElement;
  content: blessed.Widgets.Log;
  shortcuts: blessed.Widgets.BoxElement;
  screen: blessed.Widgets.Screen;
}

async function runBlessedBrowser(opts: TuiOptions): Promise<void> {
  void opts;
  const screen = blessed.screen({
    smartCSR: true,
    title: 'ThunderTUI',
    fullUnicode: true,
    autoPadding: true,
    mouse: false,
    sendFocus: false
  });

  const browserHost = makeBrowserHost(screen);
  browserHost.pane.top = 0;
  browserHost.pane.left = 0;
  browserHost.pane.width = '100%';
  browserHost.pane.bottom = 1;

  const statusBar = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    height: 1,
    width: '100%',
    tags: true,
    style: { bg: 'blue', fg: 'white' },
    content: ' {bold}ThunderTUI{/bold}  │  mode={yellow-fg}browser{/yellow-fg}  │  [N]av [C]lick [F]ill [R]efresh  │  Q / Ctrl+C = quit'
  });
  void statusBar;

  screen.key(['C-c'], () => exitClean(screen));
  screen.key(['escape'], () => exitClean(screen));

  browserHost.content.focus();
  attachBrowser(browserHost);
  screen.render();
  await new Promise<void>(() => { /* resolves on exitClean */ });
}

function exitClean(screen: blessed.Widgets.Screen): void {
  try { screen.destroy(); } catch { /* ignore */ }
  process.exit(0);
}

function makeBrowserHost(screen: blessed.Widgets.Screen): BrowserHost {
  const pane = blessed.box({
    parent: screen,
    label: ' ThunderBrowser ',
    border: { type: 'line' },
    style: { border: { fg: 'magenta' }, label: { fg: 'magenta', bold: true } },
    tags: true
  });

  const header = blessed.box({
    parent: pane,
    top: 0,
    left: 0,
    right: 0,
    height: 3,
    tags: true,
    content: ' URL:   (waiting)\n Title: (waiting)'
  });

  const content = blessed.log({
    parent: pane,
    top: 3,
    left: 0,
    right: 0,
    bottom: 3,
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    mouse: false,
    keys: true,
    scrollbar: { ch: '│', style: { bg: 'magenta' } },
    style: { fg: 'white' }
  });

  const shortcuts = blessed.box({
    parent: pane,
    bottom: 0,
    left: 0,
    right: 0,
    height: 3,
    tags: true,
    border: { type: 'line' },
    style: { border: { fg: 'gray' } },
    content: ' {magenta-fg}[N]{/magenta-fg}avigate  {magenta-fg}[C]{/magenta-fg}lick  {magenta-fg}[F]{/magenta-fg}ill  {magenta-fg}[R]{/magenta-fg}efresh'
  });

  return { pane, header, content, shortcuts, screen };
}

function attachBrowser(host: BrowserHost): void {
  let lastStateKey = '';
  let cancelled = false;
  const tick = async () => {
    if (cancelled) return;
    try {
      const snap = readBrowserSnapshot();
      const key = `${snap.url}|${snap.title}|${snap.connected}`;
      host.header.setContent(
        ' {bold}URL:{/bold}   ' + escapeTags(snap.url || '(no page yet)') +
        '\n {bold}Title:{/bold} ' + escapeTags(snap.title || '(no page yet)') +
        '\n {gray-fg}Extension: ' + (snap.connected ? '{green-fg}● connected{/green-fg}' : '{red-fg}● disconnected{/red-fg}') + '{/gray-fg}'
      );
      if (key !== lastStateKey) {
        lastStateKey = key;
        await refreshPageContent(host);
      }
      host.screen.render();
    } catch { /* polled silently — next tick retries */ }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, BROWSER_REFRESH_MS);

  host.screen.key(['N', 'n'], () => promptNavigate(host));
  host.screen.key(['C', 'c'], () => promptClick(host));
  host.screen.key(['F', 'f'], () => promptFill(host));
  host.screen.key(['R', 'r'], () => { void refreshPageContent(host); });
  host.screen.key(['q', 'Q'], () => {
    cancelled = true;
    clearInterval(timer);
    exitClean(host.screen);
  });
}

interface BrowserSnapshot {
  url: string;
  title: string;
  connected: boolean;
}

function readBrowserSnapshot(): BrowserSnapshot {
  let url = '';
  let title = '';
  let connected = false;
  try {
    const cfg = ensureConfig();
    const ledger = new ProvenanceLedger(cfg.localInference.provenanceFile);
    const tail = ledger.tail(200).reverse();
    const ready = tail.find((e) => e.actor === 'browser-bridge' && e.action === 'extension_ready');
    const disc = tail.find((e) => e.actor === 'browser-bridge' && e.action === 'extension_disconnected');
    connected = ready != null && (disc == null || disc.timestamp < ready.timestamp);
    const stateEvt = tail.find(
      (e) => e.actor === 'browser-bridge' && (e.action === 'state_update' || e.action === 'extension_ready')
    );
    if (stateEvt) {
      const data = (stateEvt.data as Record<string, unknown>) ?? {};
      url = typeof data.url === 'string' ? data.url : '';
      title = typeof data.title === 'string' ? data.title : '';
    }
  } catch { /* return defaults */ }
  return { url, title, connected };
}

async function refreshPageContent(host: BrowserHost): Promise<void> {
  try {
    const text = await readPageText();
    host.content.setContent(highlightInteractive(text));
    host.content.setScrollPerc(0);
    host.screen.render();
  } catch (err) {
    host.content.setContent(`{red-fg}browser read failed: ${escapeTags((err as Error).message)}{/red-fg}`);
    host.screen.render();
  }
}

async function readPageText(): Promise<string> {
  const listRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
  if (!listRes.ok) throw new Error(`CDP list returned ${listRes.status}`);
  const tabs = (await listRes.json()) as Array<{
    id: string; type: string; url?: string; webSocketDebuggerUrl?: string;
  }>;
  const pages = tabs.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (pages.length === 0) throw new Error('no page tab');
  const page = pages.find((t) => t.url && t.url !== 'about:blank') ?? pages[0];
  return await new Promise<string>((resolve, reject) => {
    const sock = new WebSocket(page.webSocketDebuggerUrl!);
    const timer = setTimeout(() => {
      try { sock.close(); } catch { /* ignore */ }
      reject(new Error('CDP read timed out'));
    }, 8000);
    sock.on('open', () => {
      sock.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: 'document.body ? document.body.innerText : ""',
          returnByValue: true,
          awaitPromise: true
        }
      }));
    });
    sock.on('message', (raw) => {
      let msg: { id?: number; result?: { result?: { value?: unknown }; exceptionDetails?: unknown } };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { sock.close(); } catch { /* ignore */ }
      if (msg.result?.exceptionDetails) {
        reject(new Error('eval threw on page'));
        return;
      }
      const value = msg.result?.result?.value;
      resolve(typeof value === 'string' ? value : '');
    });
    sock.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function highlightInteractive(text: string): string {
  const lines = text.split('\n').map((line) => {
    const stripped = line.trim();
    if (!stripped) return '';
    if (/^[A-Z][A-Z0-9 &/_-]{0,30}$/.test(stripped) && stripped.length <= 32) {
      return `{cyan-fg}${escapeTags(line)}{/cyan-fg}`;
    }
    if (/^[>→]/.test(stripped) || /[→»]\s*$/.test(stripped)) {
      return `{green-fg}${escapeTags(line)}{/green-fg}`;
    }
    return escapeTags(line);
  });
  return lines.join('\n');
}

function promptNavigate(host: BrowserHost): void {
  promptOne(host, ' URL to navigate to: ', async (url) => {
    if (!/^https?:\/\//i.test(url)) {
      flashStatus(host, '{red-fg}url must start with http(s)://{/red-fg}');
      return;
    }
    try {
      await navigateViaCDP(url);
      await refreshPageContent(host);
    } catch (err) {
      flashStatus(host, `{red-fg}navigate failed: ${escapeTags((err as Error).message)}{/red-fg}`);
    }
  });
}

function promptClick(host: BrowserHost): void {
  promptOne(host, ' CSS selector (or text=Foo): ', async (selector) => {
    try {
      const expr = buildClickExpr(selector);
      await evalOnPageOnce(expr);
      await refreshPageContent(host);
    } catch (err) {
      flashStatus(host, `{red-fg}click failed: ${escapeTags((err as Error).message)}{/red-fg}`);
    }
  });
}

function promptFill(host: BrowserHost): void {
  promptOne(host, ' Selector: ', (selector) => {
    promptOne(host, ' Value: ', async (value) => {
      const expr = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('element_not_found');
        if ('value' in el) {
          el.focus();
          el.value = ${JSON.stringify(value)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (el.isContentEditable) {
          el.textContent = ${JSON.stringify(value)};
        } else {
          throw new Error('element_not_fillable');
        }
        return true;
      })()`;
      try {
        await evalOnPageOnce(expr);
        await refreshPageContent(host);
      } catch (err) {
        flashStatus(host, `{red-fg}fill failed: ${escapeTags((err as Error).message)}{/red-fg}`);
      }
    });
  });
}

function buildClickExpr(selector: string): string {
  if (selector.startsWith('text=')) {
    const phrase = selector.slice(5);
    return `(() => {
      const needle = ${JSON.stringify(phrase.toLowerCase())};
      const cands = document.querySelectorAll('a,button,input[type="submit"],input[type="button"],[role="button"]');
      for (const el of cands) {
        const text = (el.innerText || el.value || '').trim().toLowerCase();
        if (text === needle || text.includes(needle)) { el.click(); return true; }
      }
      throw new Error('no_clickable_match');
    })()`;
  }
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('element_not_found');
    el.click();
    return true;
  })()`;
}

function promptOne(host: BrowserHost, label: string, then: (val: string) => void | Promise<void>): void {
  const prompt = blessed.prompt({
    parent: host.screen,
    border: 'line',
    height: 'shrink',
    width: '50%',
    top: 'center',
    left: 'center',
    label,
    tags: true,
    keys: true,
    vi: true
  });
  prompt.input(label, '', (err, value) => {
    prompt.destroy();
    host.screen.render();
    if (err || value == null) return;
    void then(value);
  });
}

function flashStatus(host: BrowserHost, msg: string): void {
  const original = host.shortcuts.getContent();
  host.shortcuts.setContent(' ' + msg);
  host.screen.render();
  setTimeout(() => {
    host.shortcuts.setContent(original);
    host.screen.render();
  }, 2500);
}

async function navigateViaCDP(url: string): Promise<void> {
  const listRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
  if (!listRes.ok) throw new Error(`CDP list returned ${listRes.status}`);
  const tabs = (await listRes.json()) as Array<{
    id: string; type: string; webSocketDebuggerUrl?: string;
  }>;
  const page = tabs.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) throw new Error('no page tab with a debugger URL');
  await new Promise<void>((resolve, reject) => {
    const sock = new WebSocket(page.webSocketDebuggerUrl!);
    const timer = setTimeout(() => { try { sock.close(); } catch { /* ignore */ } reject(new Error('CDP timed out')); }, 5000);
    sock.on('open', () => sock.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url } })));
    sock.on('message', (raw) => {
      let msg: { id?: number; result?: { errorText?: string }; error?: { message?: string } };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { sock.close(); } catch { /* ignore */ }
      if (msg.error?.message) return reject(new Error(msg.error.message));
      if (msg.result?.errorText) return reject(new Error(msg.result.errorText));
      resolve();
    });
    sock.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

async function evalOnPageOnce(expression: string): Promise<unknown> {
  const listRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
  if (!listRes.ok) throw new Error(`CDP list returned ${listRes.status}`);
  const tabs = (await listRes.json()) as Array<{
    id: string; type: string; url?: string; webSocketDebuggerUrl?: string;
  }>;
  const pages = tabs.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (pages.length === 0) throw new Error('no page tab');
  const page = pages.find((t) => t.url && t.url !== 'about:blank') ?? pages[0];
  return await new Promise<unknown>((resolve, reject) => {
    const sock = new WebSocket(page.webSocketDebuggerUrl!);
    const timer = setTimeout(() => { try { sock.close(); } catch { /* ignore */ } reject(new Error('CDP eval timed out')); }, 8000);
    sock.on('open', () => sock.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true, userGesture: true }
    })));
    sock.on('message', (raw) => {
      let msg: { id?: number; result?: { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }; error?: { message?: string } };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { sock.close(); } catch { /* ignore */ }
      if (msg.error?.message) return reject(new Error(msg.error.message));
      const ex = msg.result?.exceptionDetails;
      if (ex) {
        const detail = ex.exception?.description ?? ex.text ?? 'page exception';
        return reject(new Error(detail.split('\n')[0].replace(/^Error:\s*/, '')));
      }
      resolve(msg.result?.result?.value);
    });
    sock.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function escapeTags(s: string): string {
  return s.replace(/[{}]/g, (c) => (c === '{' ? '{open}' : '{close}'));
}

void THUNDERGATE_DIR;
void existsSync;
void readFileSync;
