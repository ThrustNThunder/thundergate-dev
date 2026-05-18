/**
 * ThunderTUI — native terminal UI for ThunderGate.
 *
 * Layouts (all blessed):
 *   • split  — chat left (60%), browser right (40%) — default
 *   • chat   — chat full width
 *   • browser, browser-only — browser full width
 *
 * Mouse capture is disabled at both screen and widget level so iTerm2's
 * Option+drag (and Terminal.app's Alt+drag) yields native text selection
 * across the rendered panes — the operator can copy/paste without `/copy`.
 *
 * Status bar at the very bottom carries: session key, bridge URL, model,
 * context budget, last Ghost Jon weighted score, runtime uptime, browser
 * connection state.
 */

// blessed exports via `module.exports = ...` as a CJS object whose properties
// (.screen, .box, .log, ...) are the widget constructors. `import * as` would
// drop them under ESM — default import lets esModuleInterop synthesise the
// callable shape we need.
import blessed from 'blessed';
import { WebSocket } from 'ws';
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { ensureConfig } from '../config/index.js';
import { ProvenanceLedger } from '../provenance/ledger.js';

void existsSync;
const THUNDERGATE_DIR = join(process.env.HOME || '', '.thundergate');
const PID_FILE = join(THUNDERGATE_DIR, 'thundergate.pid');
const CDP_PORT = 9222;
const BROWSER_REFRESH_MS = 3000;
const STATUS_REFRESH_MS = 3000;
const SURFACE_ATTACH_PORT = 8772;
const BRIDGE_URL = 'ws://localhost:8765';
const SESSION_KEY = 'agent:main:thundercomm:main';
const TOOL_OUTPUT_MAX_CHARS = 4000;

export interface TuiOptions {
  mode: 'chat' | 'browser' | 'browser-only' | 'split';
  /** Override the chat attach URL — defaults to SurfaceAttach on 127.0.0.1:8772. */
  chatUrl?: string;
}

export async function launchTui(opts: TuiOptions): Promise<void> {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'ThunderGate TUI',
    fullUnicode: true,
    autoPadding: true,
    mouse: false,
    sendFocus: false
  });

  const wantsChat = opts.mode === 'chat' || opts.mode === 'split';
  const wantsBrowser = opts.mode !== 'chat';

  const chatHost = wantsChat ? makeChatHost(screen) : null;
  const browserHost = wantsBrowser ? makeBrowserHost(screen) : null;

  layoutPanes(chatHost, browserHost, opts.mode);

  const statusBar = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    height: 1,
    width: '100%',
    tags: true,
    mouse: false,
    style: { bg: 'blue', fg: 'white' },
    content: ''
  });

  const status: StatusState = {
    sessionKey: SESSION_KEY,
    bridgeUrl: BRIDGE_URL,
    model: shortModel(readConfigModel()),
    maxTokens: readMaxTokens(),
    startedAt: Date.now()
  };
  renderStatusBar(statusBar, status, screen);
  const statusTimer = setInterval(() => renderStatusBar(statusBar, status, screen), STATUS_REFRESH_MS);

  screen.key(['C-c'], () => exitClean(screen, statusTimer));
  screen.key(['escape'], () => exitClean(screen, statusTimer));
  if (chatHost && browserHost) {
    screen.key(['tab'], () => cycleFocus([chatHost.input, browserHost.content], screen));
  }

  if (chatHost) {
    printCopyBanner(chatHost);
    attachChat(chatHost, opts, status);
    chatHost.input.focus();
  } else if (browserHost) {
    browserHost.content.focus();
  }
  if (browserHost) attachBrowser(browserHost);

  screen.render();
  await new Promise<void>(() => { /* resolves on exitClean */ });
}

// ── layout ───────────────────────────────────────────────────────────────

interface ChatHost {
  pane: blessed.Widgets.BoxElement;
  history: blessed.Widgets.Log;
  input: blessed.Widgets.TextboxElement;
  screen: blessed.Widgets.Screen;
  slashPopup?: blessed.Widgets.ListElement;
  lastAssistantText?: string;
}

interface BrowserHost {
  pane: blessed.Widgets.BoxElement;
  header: blessed.Widgets.BoxElement;
  content: blessed.Widgets.Log;
  shortcuts: blessed.Widgets.BoxElement;
  screen: blessed.Widgets.Screen;
}

function layoutPanes(chat: ChatHost | null, browser: BrowserHost | null, mode: TuiOptions['mode']): void {
  const baseBottom = 1;
  if ((mode === 'browser' || mode === 'browser-only') && browser) {
    browser.pane.top = 0;
    browser.pane.left = 0;
    browser.pane.width = '100%';
    browser.pane.bottom = baseBottom;
    return;
  }
  if (mode === 'chat' && chat) {
    chat.pane.top = 0;
    chat.pane.left = 0;
    chat.pane.width = '100%';
    chat.pane.bottom = baseBottom;
    return;
  }
  if (chat && browser) {
    chat.pane.top = 0;
    chat.pane.left = 0;
    chat.pane.width = '60%';
    chat.pane.bottom = baseBottom;
    browser.pane.top = 0;
    browser.pane.left = '60%';
    browser.pane.width = '40%';
    browser.pane.bottom = baseBottom;
  }
}

function cycleFocus(targets: blessed.Widgets.BlessedElement[], screen: blessed.Widgets.Screen): void {
  const focused = screen.focused;
  let idx = targets.findIndex((t) => t === focused);
  if (idx < 0) idx = -1;
  const next = targets[(idx + 1) % targets.length];
  next.focus();
  screen.render();
}

function exitClean(screen: blessed.Widgets.Screen, statusTimer?: NodeJS.Timeout): void {
  if (statusTimer) clearInterval(statusTimer);
  try { screen.destroy(); } catch { /* ignore */ }
  process.exit(0);
}

// ── status bar ───────────────────────────────────────────────────────────

interface StatusState {
  sessionKey: string;
  bridgeUrl: string;
  model: string;
  maxTokens: number;
  startedAt: number;
}

function renderStatusBar(
  bar: blessed.Widgets.BoxElement,
  s: StatusState,
  screen: blessed.Widgets.Screen
): void {
  const score = readLatestWeightedScore();
  const scoreStr = score === null ? '–' : score.toFixed(3);
  const browser = readBrowserSnapshot();
  const browserStr = browser.connected ? 'connected' : 'idle';
  const uptime = formatUptime(readRuntimeUptimeMs(s.startedAt));
  const parts = [
    s.sessionKey,
    s.bridgeUrl,
    s.model,
    `${s.maxTokens}tok`,
    `GJ:${scoreStr}`,
    `up:${uptime}`,
    `browser:${browserStr}`
  ];
  bar.setContent(' ' + parts.join(' │ '));
  screen.render();
}

function readConfigModel(): string {
  try {
    const cfg = ensureConfig();
    const raw = cfg.runtime?.model ?? cfg.ghost?.model ?? 'claude-haiku-4-5-20251001';
    return raw;
  } catch {
    return 'claude-haiku-4-5-20251001';
  }
}

function shortModel(full: string): string {
  // anthropic/claude-haiku-4-5-20251001 → haiku-4-5
  const tail = full.split('/').pop() ?? full;
  const m = tail.match(/(haiku|sonnet|opus)-(\d+(?:-\d+)?)/i);
  if (m) return `${m[1].toLowerCase()}-${m[2]}`;
  return tail;
}

function readMaxTokens(): number {
  try {
    const cfg = ensureConfig();
    return cfg.ghost?.maxTokens ?? 512;
  } catch {
    return 512;
  }
}

function readRuntimeUptimeMs(fallbackStart: number): number {
  try {
    if (existsSync(PID_FILE)) {
      const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
      if (Number.isFinite(pid) && pid > 0) {
        const procStat = `/proc/${pid}`;
        if (existsSync(procStat)) {
          const stat = statSync(procStat);
          return Date.now() - stat.ctimeMs;
        }
      }
    }
  } catch { /* fall through */ }
  return Date.now() - fallbackStart;
}

function formatUptime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

function readLatestWeightedScore(): number | null {
  try {
    const cfg = ensureConfig();
    const raw = readFileSync(cfg.ghost?.scores_file ?? '', 'utf-8');
    const j = JSON.parse(raw) as {
      weighted?: number;
      overall?: number;
      days?: Array<{ weighted_score?: number; date?: string }>;
    };
    if (Array.isArray(j.days) && j.days.length > 0) {
      const sorted = [...j.days].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
      const top = sorted[0]?.weighted_score;
      if (typeof top === 'number') return top;
    }
    if (typeof j.weighted === 'number') return j.weighted;
    if (typeof j.overall === 'number') return j.overall;
    return null;
  } catch {
    return null;
  }
}

// ── chat pane ────────────────────────────────────────────────────────────

function makeChatHost(screen: blessed.Widgets.Screen): ChatHost {
  const pane = blessed.box({
    parent: screen,
    label: ' ThunderAI Chat ',
    border: { type: 'line' },
    style: { border: { fg: 'cyan' }, label: { fg: 'cyan', bold: true } },
    tags: true,
    mouse: false
  });

  const history = blessed.log({
    parent: pane,
    top: 0,
    left: 0,
    right: 0,
    bottom: 3,
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    mouse: false,
    keys: true,
    scrollbar: { ch: '│', style: { bg: 'cyan' } },
    style: { fg: 'white' }
  });

  const input = blessed.textbox({
    parent: pane,
    bottom: 0,
    left: 0,
    right: 0,
    height: 3,
    inputOnFocus: true,
    keys: true,
    mouse: false,
    border: { type: 'line' },
    style: {
      border: { fg: 'gray' },
      focus: { border: { fg: 'green' } }
    }
  });

  return { pane, history, input, screen };
}

function printCopyBanner(host: ChatHost): void {
  host.history.add('{gray-fg}─── ThunderGate ─── Hold Option + drag to select text  │  /help for commands ───{/gray-fg}');
  host.screen.render();
}

interface ChatClient {
  send(text: string): void;
  close(): void;
}

function attachChat(host: ChatHost, opts: TuiOptions, status: StatusState): void {
  const url = resolveChatUrl(opts);
  const append = (line: string) => {
    host.history.add(line);
    host.screen.render();
  };
  append('{gray-fg}Attaching to ThunderGate session at ' + url + '…{/gray-fg}');

  const client = openSurfaceClient(url, {
    onAttached: (sessionId, model, history) => {
      if (model) status.model = shortModel(model);
      append(`{green-fg}● attached{/green-fg} {gray-fg}session=${sessionId?.slice(0, 8) ?? 'none'} model=${model}{/gray-fg}`);
      if (history.length === 0) {
        append('{gray-fg}(no prior history in this session){/gray-fg}');
      } else {
        append(`{gray-fg}─── ${history.length} prior turn${history.length === 1 ? '' : 's'} ───{/gray-fg}`);
        for (const m of history) append(renderMessage(m.sender, m.text, m.timestamp));
        const lastJon = [...history].reverse().find((m) => m.sender !== 'Michael');
        if (lastJon) host.lastAssistantText = lastJon.text;
      }
    },
    onMessage: (m) => {
      append(renderMessage(m.sender, m.text, m.timestamp));
      if (m.sender !== 'Michael') {
        host.lastAssistantText = m.text;
        const calls = parseToolTags(m.text);
        if (calls.length > 0) {
          void runAgentToolCalls(calls, append, client);
        }
      }
    },
    onThinking: (agentId) => append(`{magenta-fg}… ${agentId} is thinking{/magenta-fg}`),
    onClose: (reason) => append(`{red-fg}● detached{/red-fg} {gray-fg}${escapeTags(reason)}{/gray-fg}`),
    onError: (err) => append(`{red-fg}● error: ${escapeTags(err.message)}{/red-fg}`),
    onServerError: (code, message) => append(`{red-fg}● ${code}: ${escapeTags(message)}{/red-fg}`)
  });

  installSlashPopup(host, append, client);

  host.input.on('submit', (text: string) => {
    const trimmed = (text || '').trim();
    host.input.clearValue();
    host.input.focus();
    host.screen.render();
    if (!trimmed) {
      host.input.readInput();
      return;
    }
    if (trimmed.startsWith('/')) {
      void dispatchSlashCommand(trimmed, host, append, client);
      host.input.readInput();
      return;
    }
    append(renderMessage('Michael', trimmed, Date.now()));
    client.send(trimmed);
    host.input.readInput();
  });

  host.input.readInput();
}

// ── slash commands ───────────────────────────────────────────────────────

interface SlashCommand {
  name: string;
  signature: string;
  description: string;
  takesArgs?: boolean;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/navigate', signature: '/navigate <url>',           description: 'Drive the browser to a URL',          takesArgs: true },
  { name: '/read',     signature: '/read',                     description: 'Print visible page text into chat' },
  { name: '/extract',  signature: '/extract <selector>',       description: 'Extract text from a CSS selector',    takesArgs: true },
  { name: '/eval',     signature: '/eval <expr>',              description: 'Evaluate JS in the page',             takesArgs: true },
  { name: '/status',   signature: '/status',                   description: 'Show runtime + browser + Ghost snapshot' },
  { name: '/copy',     signature: '/copy',                     description: "Save Jon's last reply to ~/.thundergate/last-jon-reply.txt" },
  { name: '/clear',    signature: '/clear',                    description: 'Clear the chat history pane' },
  { name: '/help',     signature: '/help',                     description: 'List available slash commands' },
  { name: '/quit',     signature: '/quit',                     description: 'Exit ThunderTUI' }
];

function installSlashPopup(
  host: ChatHost,
  append: (line: string) => void,
  client: ChatClient
): void {
  const popup = blessed.list({
    parent: host.pane,
    bottom: 3,
    left: 1,
    right: 1,
    height: Math.min(SLASH_COMMANDS.length + 2, 12),
    border: { type: 'line' },
    label: ' slash commands ',
    tags: true,
    keys: false,
    mouse: false,
    interactive: true,
    style: {
      border: { fg: 'yellow' },
      selected: { bg: 'yellow', fg: 'black' }
    },
    items: []
  });
  popup.hide();
  host.slashPopup = popup;

  let filtered: SlashCommand[] = [];

  const hide = () => {
    if (!popup.hidden) {
      popup.hide();
      host.screen.render();
    }
    filtered = [];
  };

  const showAndFilter = (rawValue: string) => {
    if (!rawValue.startsWith('/')) { hide(); return; }
    if (rawValue.includes(' ')) { hide(); return; }
    const needle = rawValue.toLowerCase();
    filtered = SLASH_COMMANDS.filter((c) => c.name.startsWith(needle));
    if (filtered.length === 0) { hide(); return; }
    popup.setItems(filtered.map((c) => `${c.signature} {gray-fg}— ${c.description}{/gray-fg}`));
    popup.select(0);
    popup.show();
    popup.setFront();
    host.screen.render();
  };

  const completeWith = (cmd: SlashCommand) => {
    const next = cmd.takesArgs ? cmd.name + ' ' : cmd.name;
    host.input.setValue(next);
    hide();
    host.input.focus();
    host.screen.render();
  };

  host.input.on('keypress', (_ch: string, key: { name: string; full?: string; ctrl?: boolean }) => {
    if (!popup.hidden && filtered.length > 0) {
      const p = popup as unknown as { up: (n?: number) => void; down: (n?: number) => void; selected: number };
      if (key.name === 'up')   { p.up(1);   host.screen.render(); return; }
      if (key.name === 'down') { p.down(1); host.screen.render(); return; }
      if (key.name === 'escape') { hide(); return; }
      if (key.name === 'tab' || (key.name === 'return' && p.selected !== undefined)) {
        const idx = p.selected ?? 0;
        const pick = filtered[idx];
        if (pick) {
          completeWith(pick);
          if (!pick.takesArgs && key.name === 'return') {
            void dispatchSlashCommand(pick.name, host, append, client);
            host.input.clearValue();
            host.screen.render();
          }
        }
        return;
      }
    }
    setImmediate(() => showAndFilter(host.input.getValue() ?? ''));
  });
}

async function dispatchSlashCommand(
  raw: string,
  host: ChatHost,
  append: (line: string) => void,
  client: ChatClient
): Promise<void> {
  const parts = raw.trim().split(/\s+/);
  const head = parts[0].toLowerCase();
  const args = parts.slice(1);
  const echo = (line: string) => append(`{yellow-fg}${escapeTags(raw)}{/yellow-fg}\n${line}`);

  try {
    switch (head) {
      case '/quit':
      case '/exit':
        client.close();
        exitClean(host.screen);
        return;
      case '/clear':
        host.history.setContent('');
        host.screen.render();
        return;
      case '/help':
        for (const c of SLASH_COMMANDS) {
          append(`{gray-fg}  ${c.signature.padEnd(28)} — ${c.description}{/gray-fg}`);
        }
        return;
      case '/copy':
        runCopy(host.lastAssistantText, echo);
        return;
      case '/read':
        await runRead(echo);
        return;
      case '/extract':
        if (args.length === 0) { echo('{red-fg}usage: /extract <selector>{/red-fg}'); return; }
        await runExtract(args.join(' '), echo);
        return;
      case '/eval':
        if (args.length === 0) { echo('{red-fg}usage: /eval <expr>{/red-fg}'); return; }
        await runEval(args.join(' '), echo);
        return;
      case '/navigate':
        if (args.length === 0) { echo('{red-fg}usage: /navigate <url>{/red-fg}'); return; }
        await runNavigate(args[0], echo);
        return;
      case '/status':
        await runStatus(echo);
        return;
      default:
        echo(`{red-fg}unknown command: ${escapeTags(head)}{/red-fg}`);
    }
  } catch (err) {
    echo(`{red-fg}${escapeTags((err as Error).message)}{/red-fg}`);
  }
}

function runCopy(lastAssistantText: string | undefined, echo: (line: string) => void): void {
  if (!lastAssistantText) {
    echo('{red-fg}nothing to copy yet — wait for Jon to respond.{/red-fg}');
    return;
  }
  const filePath = join(THUNDERGATE_DIR, 'last-jon-reply.txt');
  try {
    mkdirSync(THUNDERGATE_DIR, { recursive: true });
    writeFileSync(filePath, lastAssistantText);
  } catch (err) {
    echo(`{red-fg}copy failed: ${escapeTags((err as Error).message)}{/red-fg}`);
    return;
  }
  echo(`{green-fg}✓ Copied to ${filePath}{/green-fg} {gray-fg}(${lastAssistantText.length} chars){/gray-fg}`);
}

async function runRead(echo: (line: string) => void): Promise<void> {
  const text = await readPageText();
  const lines = text.split('\n').slice(0, 60).join('\n');
  echo(`{gray-fg}page text (first ${Math.min(60, text.split('\n').length)} lines):{/gray-fg}\n${escapeTags(lines)}`);
}

async function runNavigate(url: string, echo: (line: string) => void): Promise<void> {
  if (!/^https?:\/\//i.test(url)) {
    echo('{red-fg}url must start with http(s)://{/red-fg}');
    return;
  }
  await navigateViaCDP(url);
  echo(`{green-fg}✓ navigated to ${escapeTags(url)}{/green-fg}`);
}

async function runExtract(selector: string, echo: (line: string) => void): Promise<void> {
  const expr = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('element_not_found');
    return (el.innerText ?? el.textContent ?? '').trim();
  })()`;
  const value = await evalOnPageOnce(expr);
  const out = typeof value === 'string' ? value : JSON.stringify(value);
  echo(`{green-fg}✓ extract ${escapeTags(selector)}:{/green-fg}\n${escapeTags(out)}`);
}

async function runEval(expression: string, echo: (line: string) => void): Promise<void> {
  const value = await evalOnPageOnce(expression);
  const out = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  echo(`{green-fg}✓ eval result:{/green-fg}\n${escapeTags(out ?? 'undefined')}`);
}

async function runStatus(echo: (line: string) => void): Promise<void> {
  const parts: string[] = [];
  try {
    const snap = await fetchContextStatusViaSurface();
    if (snap) {
      const ageMin = Math.floor(snap.msSinceLastActivity / 60_000);
      parts.push(`{cyan-fg}runtime:{/cyan-fg} session=${snap.sessionId?.slice(0, 16) ?? '(none)'} turns=${snap.sessionTurnCount} tokens≈${snap.sessionTokensEstimate} age=${ageMin}m`);
      parts.push(`{cyan-fg}context:{/cyan-fg} ttl=${snap.cfg.sessionTtl} compaction=${snap.cfg.compaction} cache=${snap.cfg.cacheRetention}`);
    } else {
      parts.push('{red-fg}runtime: unreachable on 127.0.0.1:8772{/red-fg}');
    }
  } catch (err) {
    parts.push(`{red-fg}runtime: ${escapeTags((err as Error).message)}{/red-fg}`);
  }
  const browser = readBrowserSnapshot();
  parts.push(`{cyan-fg}browser:{/cyan-fg} ${browser.connected ? '{green-fg}● connected{/green-fg}' : '{red-fg}● disconnected{/red-fg}'} url=${escapeTags(browser.url || '(none)')}`);
  parts.push(`{cyan-fg}ghost:{/cyan-fg} ${readGhostScoreLine()}`);
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
    const j = JSON.parse(raw) as { weighted?: number; overall?: number };
    const score = typeof j.weighted === 'number' ? j.weighted : (j.overall ?? null);
    if (score === null || score === undefined) return '(no score yet)';
    return `weighted=${score.toFixed(3)}`;
  } catch {
    return '(scores file missing)';
  }
}

// ── surface client ───────────────────────────────────────────────────────

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
      ws.send(JSON.stringify({ type: 'send', text, correlationId: randomKey() }));
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

function renderMessage(sender: string, text: string, ts: number): string {
  const time = formatClock(ts);
  const senderColor = sender === 'Michael' ? '{cyan-fg}' : '{yellow-fg}';
  const senderClose = sender === 'Michael' ? '{/cyan-fg}' : '{/yellow-fg}';
  return `${senderColor}{bold}${sender}{/bold}${senderClose} {gray-fg}${time}{/gray-fg}\n${markdownToBlessed(text)}\n`;
}

function formatClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ── markdown → blessed tags ──────────────────────────────────────────────

export function markdownToBlessed(input: string): string {
  const fences: string[] = [];
  let text = input.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_m, _lang, body) => {
    const idx = fences.length;
    fences.push(renderFencedBlock(body));
    return ` FENCE${idx} `;
  });

  const inlines: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_m, body) => {
    const idx = inlines.length;
    inlines.push(`{black-bg}{white-fg} ${escapeTags(body)} {/white-fg}{/black-bg}`);
    return ` INLINE${idx} `;
  });

  text = escapeTags(text);

  text = text.replace(/\*\*([^*]+)\*\*/g, '{bold}$1{/bold}');
  text = text.replace(/__([^_]+)__/g, '{bold}$1{/bold}');
  text = text.replace(/(?<![\\*\w])\*([^*\n]+)\*(?!\w)/g, '{underline}$1{/underline}');
  text = text.replace(/(?<![\\_\w])_([^_\n]+)_(?!\w)/g, '{underline}$1{/underline}');

  text = text.replace(/ INLINE(\d+) /g, (_m, i) => inlines[parseInt(i, 10)]);
  text = text.replace(/ FENCE(\d+) /g, (_m, i) => fences[parseInt(i, 10)]);
  return text;
}

function renderFencedBlock(body: string): string {
  const lines = body.replace(/\n+$/, '').split('\n');
  const rendered = lines.map((line) => `{black-bg}{white-fg}  ${escapeTags(line).padEnd(60, ' ')}{/white-fg}{/black-bg}`);
  return '\n' + rendered.join('\n') + '\n';
}

function escapeTags(s: string): string {
  return s.replace(/[{}]/g, (c) => (c === '{' ? '{open}' : '{close}'));
}

// ── browser pane ─────────────────────────────────────────────────────────

function makeBrowserHost(screen: blessed.Widgets.Screen): BrowserHost {
  const pane = blessed.box({
    parent: screen,
    label: ' ThunderBrowser ',
    border: { type: 'line' },
    style: { border: { fg: 'magenta' }, label: { fg: 'magenta', bold: true } },
    tags: true,
    mouse: false
  });

  const header = blessed.box({
    parent: pane,
    top: 0,
    left: 0,
    right: 0,
    height: 3,
    tags: true,
    mouse: false,
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
    mouse: false,
    border: { type: 'line' },
    style: { border: { fg: 'gray' } },
    content: ' {magenta-fg}[N]{/magenta-fg}avigate  {magenta-fg}[R]{/magenta-fg}efresh  {gray-fg}— slash commands run from chat{/gray-fg}'
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
    mouse: false,
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

// ── Ghost Jon tool-tag dispatch ──────────────────────────────────────────
//
// Assistant messages may carry self-closing tags like
//   <tool:browser_navigate url="https://…"/>
//   <tool:browser_read/>
//   <tool:browser_extract selector="h1"/>
//   <tool:browser_eval expression="document.title"/>
//   <tool:browser_state/>
//
// We scan, shell each call out to `thundergate browser …` (no shell interp,
// argv carries attribute values literally), truncate, and feed the result
// back to the agent as the next user turn so the conversation continues.

interface ToolCall {
  tool: string;
  attrs: Record<string, string>;
  raw: string;
}

const TOOL_TAG_RE = /<tool:([a-z_][a-z0-9_]*)((?:\s+[a-zA-Z_][\w-]*="[^"]*")*)\s*\/>/g;
const ATTR_RE = /([a-zA-Z_][\w-]*)="([^"]*)"/g;

function parseToolTags(text: string): ToolCall[] {
  const out: ToolCall[] = [];
  for (const m of text.matchAll(TOOL_TAG_RE)) {
    const tool = m[1];
    const attrs: Record<string, string> = {};
    const attrSrc = m[2] ?? '';
    for (const am of attrSrc.matchAll(ATTR_RE)) {
      attrs[am[1]] = am[2];
    }
    out.push({ tool, attrs, raw: m[0] });
  }
  return out;
}

interface ToolResult {
  ok: boolean;
  output: string;
}

function runBrowserTool(call: ToolCall): ToolResult {
  let args: string[];
  switch (call.tool) {
    case 'browser_navigate': {
      const url = call.attrs.url;
      if (!url) return { ok: false, output: 'missing url attribute' };
      args = ['browser', 'navigate', url];
      break;
    }
    case 'browser_read':
      args = ['browser', 'read'];
      break;
    case 'browser_extract': {
      const sel = call.attrs.selector;
      if (!sel) return { ok: false, output: 'missing selector attribute' };
      args = ['browser', 'extract', sel];
      break;
    }
    case 'browser_eval': {
      const expr = call.attrs.expression;
      if (!expr) return { ok: false, output: 'missing expression attribute' };
      args = ['browser', 'eval', expr];
      break;
    }
    case 'browser_state':
      args = ['browser', 'state'];
      break;
    default:
      return { ok: false, output: `unknown tool: ${call.tool}` };
  }
  const res = spawnSync('thundergate', args, { encoding: 'utf8', timeout: 20000 });
  if (res.error) return { ok: false, output: res.error.message };
  const stdout = (res.stdout ?? '').toString().trim();
  const stderr = (res.stderr ?? '').toString().trim();
  if (res.status !== 0) {
    return { ok: false, output: stderr || stdout || `exit ${res.status ?? 'null'}` };
  }
  return { ok: true, output: stdout };
}

function truncateOutput(s: string): string {
  if (s.length <= TOOL_OUTPUT_MAX_CHARS) return s;
  return s.slice(0, TOOL_OUTPUT_MAX_CHARS) + `\n…(truncated, ${s.length - TOOL_OUTPUT_MAX_CHARS} more chars)`;
}

async function runAgentToolCalls(
  calls: ToolCall[],
  append: (line: string) => void,
  client: ChatClient
): Promise<void> {
  const pieces: string[] = [];
  for (const call of calls) {
    append(`{gray-fg}  → running ${escapeTags(call.raw)}{/gray-fg}`);
    const result = runBrowserTool(call);
    const body = truncateOutput(result.output || '(no output)');
    const label = result.ok ? 'Browser result' : 'Browser error';
    pieces.push(`[${label} for ${call.raw}]\n${body}`);
    append(`{gray-fg}  ← ${result.ok ? 'ok' : 'err'} ${call.tool} (${body.length} chars){/gray-fg}`);
  }
  const followUp = pieces.join('\n\n');
  client.send(followUp);
}

void THUNDERGATE_DIR;
