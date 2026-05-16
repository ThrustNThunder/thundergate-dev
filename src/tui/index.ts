/**
 * ThunderTUI — native terminal UI for ThunderGate.
 *
 * Two surfaces in one process:
 *
 *  • Chat pane   — connects to the live ThunderCommo bridge (ws://localhost:8765)
 *                  as a peer client. Same wire protocol the iOS / web clients
 *                  speak: `?token=...` query auth, `subscribe`+`message` types,
 *                  `thinking`/`message`/`stream_chunk` envelopes back. We don't
 *                  edit ThunderCommo here — we connect to it.
 *
 *  • Browser pane — polls the runtime's BrowserBridge state via the provenance
 *                  ledger (URL/title arrive there as `state_update` rows) and
 *                  fetches visible text via CDP Runtime.evaluate on port 9222,
 *                  the same surface `thundergate browser read` uses.
 *
 * Three launch modes — chat-only, browser-only, split — picked at CLI time
 * and assembled from the same chat/browser components. blessed handles layout;
 * we only describe what goes where.
 */

// blessed exports via `module.exports = ...` as a CJS object whose properties
// (.screen, .box, .log, ...) are the widget constructors. Under ESM with
// `module: ESNext`, `import * as blessed` does NOT include the default
// export, so blessed.screen is undefined at runtime. The default-import
// form below works because esModuleInterop is on: TS synthesizes a default
// for CJS modules that maps to module.exports — which is exactly what we
// need for `blessed.screen()` to be callable.
import blessed from 'blessed';
import { WebSocket } from 'ws';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ensureConfig } from '../config/index.js';
import { ProvenanceLedger } from '../provenance/ledger.js';

const THUNDERGATE_DIR = join(process.env.HOME || '', '.thundergate');
const CDP_PORT = 9222;
const BROWSER_REFRESH_MS = 3000;

export interface TuiOptions {
  mode: 'chat' | 'browser' | 'split';
  /** Override the ThunderCommo URL — defaults to ws://localhost:8765 with the Michael token. */
  chatUrl?: string;
}

export async function launchTui(opts: TuiOptions): Promise<void> {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'ThunderTUI',
    fullUnicode: true,
    autoPadding: true
  });

  const chatHost = opts.mode === 'browser' ? null : makeChatHost(screen, opts);
  const browserHost = opts.mode === 'chat' ? null : makeBrowserHost(screen, opts);

  layoutPanes(screen, chatHost, browserHost, opts.mode);

  // Status bar at the very bottom — always visible, always overlays whatever
  // pane it sits on. Reads as the cheat-sheet for the operator's keyboard.
  const statusBar = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    height: 1,
    width: '100%',
    tags: true,
    style: { bg: 'blue', fg: 'white' },
    content: statusBarContent(opts.mode)
  });

  // Global keys: Tab cycles focus between chat input and browser pane;
  // q / Ctrl+C / Esc exit. The chat input swallows printable keys so q
  // there should only quit if not focused — handled below.
  screen.key(['C-c'], () => exitClean(screen));
  screen.key(['escape'], () => exitClean(screen));
  if (chatHost && browserHost) {
    screen.key(['tab'], () => cycleFocus([chatHost.input, browserHost.content], screen));
  }

  // Default focus: chat input if present, otherwise browser content.
  if (chatHost) chatHost.input.focus();
  else if (browserHost) browserHost.content.focus();

  // Wire data sources after the screen is mounted so the first render shows
  // structure immediately; chat history + browser state stream in next.
  if (chatHost) attachChat(chatHost, opts);
  if (browserHost) attachBrowser(browserHost);

  screen.render();
  // Keep the process alive until the user quits — every interaction goes
  // through blessed's event loop, but Node would still exit if nothing else
  // pins the loop on startup. The WebSocket and the polling interval each
  // pin it; the unresolved promise here is belt-and-suspenders for the
  // chat-less, browser-only mode in case the interval is cleared by mistake.
  await new Promise<void>(() => { /* resolves on exitClean */ });
  void statusBar;
}

// ── layout ───────────────────────────────────────────────────────────────

interface ChatHost {
  pane: blessed.Widgets.BoxElement;
  history: blessed.Widgets.Log;
  input: blessed.Widgets.TextboxElement;
  screen: blessed.Widgets.Screen;
}

interface BrowserHost {
  pane: blessed.Widgets.BoxElement;
  header: blessed.Widgets.BoxElement;
  content: blessed.Widgets.Log;
  shortcuts: blessed.Widgets.BoxElement;
  screen: blessed.Widgets.Screen;
}

function layoutPanes(
  screen: blessed.Widgets.Screen,
  chat: ChatHost | null,
  browser: BrowserHost | null,
  mode: TuiOptions['mode']
): void {
  // Reserve one row at the bottom for the status bar — every pane's bottom
  // is clamped to row 1 from the bottom rather than 0.
  const baseBottom = 1;
  if (mode === 'chat' && chat) {
    chat.pane.top = 0;
    chat.pane.left = 0;
    chat.pane.width = '100%';
    chat.pane.bottom = baseBottom;
  } else if (mode === 'browser' && browser) {
    browser.pane.top = 0;
    browser.pane.left = 0;
    browser.pane.width = '100%';
    browser.pane.bottom = baseBottom;
  } else if (mode === 'split' && chat && browser) {
    chat.pane.top = 0;
    chat.pane.left = 0;
    chat.pane.width = '50%';
    chat.pane.bottom = baseBottom;
    browser.pane.top = 0;
    browser.pane.left = '50%';
    browser.pane.width = '50%';
    browser.pane.bottom = baseBottom;
  }
}

function statusBarContent(mode: TuiOptions['mode']): string {
  const parts: string[] = [];
  parts.push('{bold}ThunderTUI{/bold}');
  parts.push(`mode={yellow-fg}${mode}{/yellow-fg}`);
  if (mode !== 'browser') parts.push('chat: type + Enter to send');
  if (mode !== 'chat') parts.push('browser: [N]av [C]lick [F]ill [R]efresh');
  if (mode === 'split') parts.push('Tab=cycle focus');
  parts.push('Q / Ctrl+C = quit');
  return ' ' + parts.join('  │  ');
}

function cycleFocus(targets: blessed.Widgets.BlessedElement[], screen: blessed.Widgets.Screen): void {
  const focused = screen.focused;
  let idx = targets.findIndex((t) => t === focused);
  if (idx < 0) idx = -1;
  const next = targets[(idx + 1) % targets.length];
  next.focus();
  screen.render();
}

function exitClean(screen: blessed.Widgets.Screen): void {
  try { screen.destroy(); } catch { /* ignore */ }
  process.exit(0);
}

// ── chat pane ────────────────────────────────────────────────────────────

function makeChatHost(screen: blessed.Widgets.Screen, _opts: TuiOptions): ChatHost {
  const pane = blessed.box({
    parent: screen,
    label: ' ThunderAI Chat ',
    border: { type: 'line' },
    style: { border: { fg: 'cyan' }, label: { fg: 'cyan', bold: true } },
    tags: true
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
    mouse: true,
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
    mouse: true,
    border: { type: 'line' },
    style: {
      border: { fg: 'gray' },
      focus: { border: { fg: 'green' } }
    }
  });

  return { pane, history, input, screen };
}

interface ChatClient {
  send(text: string): void;
  close(): void;
}

function attachChat(host: ChatHost, opts: TuiOptions): void {
  const url = resolveChatUrl(opts);
  const append = (line: string) => {
    host.history.add(line);
    host.screen.render();
  };
  append('{gray-fg}Connecting to ' + url.replace(/\?.*$/, '?…') + '…{/gray-fg}');

  const client = openChatClient(url, {
    onStatus: (gateway, model) => {
      append(`{green-fg}● connected{/green-fg} {gray-fg}gateway=${gateway} model=${model ?? 'unknown'}{/gray-fg}`);
    },
    onHistory: (msgs) => {
      if (msgs.length === 0) {
        append('{gray-fg}(no recent history){/gray-fg}');
      } else {
        for (const m of msgs) append(renderMessage(m.sender, m.text, m.timestamp));
      }
    },
    onMessage: (m) => append(renderMessage(m.sender, m.text, m.timestamp)),
    onThinking: (agentId) => append(`{magenta-fg}… ${agentId} is thinking{/magenta-fg}`),
    onClose: (reason) => append(`{red-fg}● disconnected{/red-fg} {gray-fg}${reason}{/gray-fg}`),
    onError: (err) => append(`{red-fg}● error: ${escapeTags(err.message)}{/red-fg}`)
  });

  host.input.on('submit', (text: string) => {
    const trimmed = (text || '').trim();
    host.input.clearValue();
    host.input.focus();
    host.screen.render();
    if (!trimmed) {
      host.input.readInput();
      return;
    }
    if (trimmed === '/quit' || trimmed === '/exit') {
      client.close();
      exitClean(host.screen);
      return;
    }
    append(renderMessage('Michael', trimmed, Date.now()));
    client.send(trimmed);
    // textbox.on('submit') consumes the input — re-arm so the user can
    // keep typing without re-clicking.
    host.input.readInput();
  });

  // First-time arming — textbox stays cold until readInput() is called or
  // the user clicks/tabs in.
  host.input.readInput();
}

function resolveChatUrl(opts: TuiOptions): string {
  if (opts.chatUrl) return opts.chatUrl;
  // The live bridge.mjs accepts the literal string "Michael" as a token
  // shortcut for the federation gateway token. The TUI is a local
  // operator surface, so we use the same shortcut every other local
  // client uses rather than reading the channel token out of config.json.
  const port = readTcPort() ?? 8765;
  return `ws://localhost:${port}/?token=Michael&deviceId=tui`;
}

function readTcPort(): number | null {
  try {
    const cfg = ensureConfig();
    return cfg.channels.thundercommo.port ?? null;
  } catch {
    return null;
  }
}

interface ChatHooks {
  onStatus: (gateway: string, model: string | undefined) => void;
  onHistory: (msgs: ChatMessage[]) => void;
  onMessage: (msg: ChatMessage) => void;
  onThinking: (agentId: string) => void;
  onClose: (reason: string) => void;
  onError: (err: Error) => void;
}

interface ChatMessage {
  sender: string;
  text: string;
  timestamp: number;
}

function openChatClient(url: string, hooks: ChatHooks): ChatClient {
  let ws: WebSocket | null = new WebSocket(url);
  let closed = false;

  ws.on('open', () => {
    ws!.send(JSON.stringify({ type: 'subscribe', lastMessageId: null }));
  });

  ws.on('message', (raw) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const t = typeof msg.type === 'string' ? msg.type : '';
    if (t === 'status') {
      hooks.onStatus(
        typeof msg.gateway === 'string' ? msg.gateway : 'unknown',
        typeof msg.model === 'string' ? msg.model : undefined
      );
    } else if (t === 'history') {
      const arr = Array.isArray(msg.messages) ? msg.messages : [];
      hooks.onHistory(arr.map(coerceChatMessage));
    } else if (t === 'message') {
      hooks.onMessage(coerceChatMessage(msg));
    } else if (t === 'thinking') {
      const agentId = typeof msg.agentId === 'string' ? msg.agentId : 'agent';
      hooks.onThinking(agentId);
    }
    // stream_chunk is intentionally ignored for now — the bridge also
    // emits a final `message` once the stream completes, so we render
    // that instead of redrawing on every delta.
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
        type: 'message',
        text,
        channel: 'tnt',
        sender: 'Michael',
        timestamp: Date.now(),
        idempotencyKey: randomKey()
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

// ── markdown rendering ───────────────────────────────────────────────────

/**
 * Convert a subset of Markdown into blessed-tag-formatted text:
 *
 *   • ```lang\ncode``` and ```code``` → distinct-bg block, one per line
 *   • `inline code`                   → distinct-bg single token
 *   • **bold** / __bold__             → {bold}
 *   • *italic* / _italic_             → {underline} (blessed lacks italic;
 *                                       underline reads as emphasis in most
 *                                       terminals and survives the rest of
 *                                       the tag substitutions cleanly)
 *
 * We tag-escape any pre-existing curly braces before running substitutions
 * so user text containing `{` / `}` doesn't get reinterpreted as a tag.
 */
export function markdownToBlessed(input: string): string {
  // Pull fenced code blocks out first so their contents don't get rewritten
  // by the inline-formatting passes — store them under sentinel tokens and
  // splice them back at the end.
  const fences: string[] = [];
  let text = input.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_m, _lang, body) => {
    const idx = fences.length;
    fences.push(renderFencedBlock(body));
    return ` FENCE${idx} `;
  });

  // Same trick for inline code so it isn't mauled by the bold/italic passes.
  const inlines: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_m, body) => {
    const idx = inlines.length;
    inlines.push(`{black-bg}{white-fg} ${escapeTags(body)} {/white-fg}{/black-bg}`);
    return ` INLINE${idx} `;
  });

  text = escapeTags(text);

  // Bold first so the ** pair gets greedy matched before * runs on the same
  // characters; otherwise *foo* nested inside **bar** would split awkwardly.
  text = text.replace(/\*\*([^*]+)\*\*/g, '{bold}$1{/bold}');
  text = text.replace(/__([^_]+)__/g, '{bold}$1{/bold}');
  text = text.replace(/(?<![\\*\w])\*([^*\n]+)\*(?!\w)/g, '{underline}$1{/underline}');
  text = text.replace(/(?<![\\_\w])_([^_\n]+)_(?!\w)/g, '{underline}$1{/underline}');

  text = text.replace(/ INLINE(\d+) /g, (_m, i) => inlines[parseInt(i, 10)]);
  text = text.replace(/ FENCE(\d+) /g, (_m, i) => fences[parseInt(i, 10)]);
  return text;
}

function renderFencedBlock(body: string): string {
  // Indent each line by two columns and apply a distinct background so the
  // block reads as a separate visual unit inside the scrollable log. A real
  // bordered widget per block would fight blessed.log's line-flow rendering;
  // the bg-stripe is the next-best clean-selection target for copy/paste.
  const lines = body.replace(/\n+$/, '').split('\n');
  const rendered = lines.map((line) => `{black-bg}{white-fg}  ${escapeTags(line).padEnd(60, ' ')}{/white-fg}{/black-bg}`);
  return '\n' + rendered.join('\n') + '\n';
}

function escapeTags(s: string): string {
  return s.replace(/[{}]/g, (c) => (c === '{' ? '{open}' : '{close}'));
}

// ── browser pane ─────────────────────────────────────────────────────────

function makeBrowserHost(screen: blessed.Widgets.Screen, _opts: TuiOptions): BrowserHost {
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
    mouse: true,
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

  // Browser keyboard shortcuts. We attach to the screen rather than the
  // content widget so they fire even when the chat input has focus, *unless*
  // the chat input is in active input mode (textbox.readInput() consumes
  // keys until Enter/Esc). Operators expect [N] / [R] to be cheap muscle
  // memory regardless of where focus currently sits.
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
  // Same shape as the `evalOnPage` helper used by `thundergate browser read`,
  // but kept private here so the TUI doesn't have to reach into the CLI
  // module (which would pull commander + every other subcommand into the
  // TUI's import graph).
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

/**
 * Mark links / buttons / inputs in the rendered text so operators can see at
 * a glance which lines on the page are actionable. We don't have the DOM
 * here, just the innerText output — so we colour heuristically: leading
 * arrows, "click", "go", and the like — and trust the operator to use
 * [C]lick / [F]ill for the real interaction.
 */
function highlightInteractive(text: string): string {
  const lines = text.split('\n').map((line) => {
    const stripped = line.trim();
    if (!stripped) return '';
    // Heuristic: short ALL-CAPS lines are usually nav links; lines ending
    // with an arrow glyph or starting with > / → are CTAs.
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

// ── browser shortcut prompts ─────────────────────────────────────────────

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

// silence unused-import lint complaints for paths we may need later
void THUNDERGATE_DIR;
void existsSync;
void readFileSync;
