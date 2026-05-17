/**
 * ThunderCommo Web UI — app.js
 * Version: 0.5 (12)
 *
 * Wire protocol: per THUNDERCOMM_MASTER.md
 * Session model: one persistent session, all surfaces are windows
 * 
 * Input modes: Ambient 🎙️ | Push-to-talk 🎤 | Silent 🔇
 * UI: Streaming text, inline typing indicators, connection status, agent roster
 *
 * Jon | ThunderBase | 2026-05-07
 */

// ── State ─────────────────────────────────────────────────────────────────

const state = {
  ws: null,
  token: null,
  host: null,
  channel: 'tnt',
  agentId: null,          // null = team channel
  inputMode: 'silent',    // 'ambient' | 'ptt' | 'silent'
  streamBuffer: null,     // { msgEl, textEl, agentId } — current streaming message
  reconnectTimer: null,
  reconnectAttempts: 0,
  pingInterval: null,
  agents: {},             // { id: { status, name } }
  sentKeys: new Set(),    // idempotency keys we already echo'd locally
  allMessages: [],        // all messages across all channels, for filtering
  seenIds: new Set(),     // server message ids we've already rendered (dedup history on reconnect)
  typingIndicators: {},   // { participantId: timeoutId } — active typing indicators
  batchingHistory: false, // suppress scrollBottom during batch history render
  authFailed: false,      // bad token — stop reconnecting
  hasConnected: false,    // first connection vs reconnect (status colour)
  lastDisconnectMsg: 0,   // throttle "Disconnected" system messages
};

const MAX_MESSAGES   = 500;
const MAX_SENT_KEYS  = 200;
const MAX_SEEN_IDS   = 1000;

const INPUT_MODES = ['ambient', 'ptt', 'silent'];
const MODE_ICONS  = { ambient: '🎙️', ptt: '🎤', silent: '🔇' };

// ── DOM refs ──────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const messagesEl    = $('messages');
const thinkingEl    = $('thinking-indicator');
const llmIndicator  = $('llm-indicator');
const textInputEl   = $('text-input');
const sendBtn       = $('send-btn');
const connDot       = $('conn-status');
const chatTitle     = $('chat-title');
const inputModeBtn  = $('input-mode-toggle');
const authOverlay   = $('auth-overlay');
const tokenInput    = $('token-input');
const hostInput     = $('host-input');
const connectBtn    = $('connect-btn');
const authError     = $('auth-error');

// ── Channel helpers ───────────────────────────────────────────────────

function normalizeChannel(channel) {
  if (!channel) return 'tnt';
  if (channel === 'team') return 'tnt';
  if (channel.startsWith('#')) return channel.slice(1);
  return channel;
}

// Check if a message channel should be visible in the current view
// tnt + direct = same stream, jmab = separate
function shouldShowInCurrentView(msgChannel) {
  const current = state.channel;
  
  // JMAB is isolated — only show JMAB messages in JMAB view
  if (current === 'jmab') return msgChannel === 'jmab';
  if (msgChannel === 'jmab') return current === 'jmab';
  
  // Everything else (tnt, direct) shares the same stream
  return true;
}

// ── Markdown renderer ───────────────────────────────────────────────────

function renderMarkdown(text) {
  if (text == null) return '';
  text = String(text);
  // Escape HTML first
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g, '&quot;');

  // Split into code blocks and non-code blocks
  const parts = text.split(/(```[\s\S]*?```)/g);
  let html = '';

  for (const part of parts) {
    if (part.startsWith('```')) {
      // Code block
      const lines = part.split('\n');
      const lang = lines[0].replace('```','').trim();
      // If the block isn't closed (still streaming), treat the remainder as code.
      const closed = part.endsWith('```') && part.length > 3;
      const code = closed ? lines.slice(1, -1).join('\n') : lines.slice(1).join('\n');
      html += `<div class="code-block"><div class="code-lang">${esc(lang) || 'code'}</div><pre><code>${esc(code)}</code></pre><button class="copy-btn" type="button">Copy</button></div>`;
    } else {
      // Inline formatting
      let p = esc(part);
      // Inline code
      p = p.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
      // Bold
      p = p.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      // Italic (single * or _)
      p = p.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
      // Bullet lists
      p = p.replace(/^[ \t]*[-*] (.+)$/gm, '<li>$1</li>');
      p = p.replace(/(<li>[^\n]*<\/li>\n?)+/g, s => `<ul>${s.replace(/\n/g, '')}</ul>`);
      // Line breaks
      p = p.replace(/\n/g, '<br>');
      html += p;
    }
  }
  return html;
}

// Delegated copy-button handler — works for streamed-in code blocks too
// and avoids inline onclick (which CSP can block).
document.addEventListener('click', e => {
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  const codeEl = btn.parentElement && btn.parentElement.querySelector('pre code');
  if (!codeEl) return;
  const code = codeEl.textContent;
  const done = ok => {
    btn.textContent = ok ? 'Copied!' : 'Copy failed';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1800);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(code).then(() => done(true), () => done(false));
  } else {
    // Fallback for http:// dev contexts
    try {
      const ta = document.createElement('textarea');
      ta.value = code; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      done(ok);
    } catch { done(false); }
  }
});

// ── LLM Indicator ────────────────────────────────────────────────────
// Only visible while an agent is actively processing. We never persist a
// "last seen" model — a stale label is worse than no label.

function showLlmIndicator(agentId) {
  const id = (agentId || '').toLowerCase();
  const model = id && state.agents[id] && state.agents[id].model;
  if (!model) { hideLlmIndicator(); return; }
  llmIndicator.textContent = shortenModelName(model) || model;
  llmIndicator.title = `Model: ${model}`;
  llmIndicator.style.display = '';
}

function hideLlmIndicator() {
  llmIndicator.textContent = '';
  llmIndicator.title = '';
  llmIndicator.style.display = 'none';
}

// ── Auth & connect ────────────────────────────────────────────────────────

// Restore credentials from localStorage (never auto-connect — let user confirm)
{
  const savedToken = localStorage.getItem('tc_token');
  const savedHost  = localStorage.getItem('tc_host');
  if (savedToken) tokenInput.value = savedToken;
  if (savedHost)  hostInput.value  = savedHost;
}

connectBtn.addEventListener('click', () => {
  const token = tokenInput.value.trim();
  const host  = hostInput.value.trim();
  if (!token || !host) {
    showAuthError('Token and host are required.');
    return;
  }
  hideAuthError();
  state.token = token;
  state.host  = host;
  state.authFailed = false;
  state.reconnectAttempts = 0;
  localStorage.setItem('tc_token', token);
  localStorage.setItem('tc_host',  host);
  connect();
});

function hideAuthError() {
  authError.classList.add('hidden');
  authError.textContent = '';
}

tokenInput.addEventListener('keydown', e => { if (e.key === 'Enter') connectBtn.click(); });
hostInput.addEventListener('keydown',  e => { if (e.key === 'Enter') connectBtn.click(); });

function showAuthError(msg) {
  authError.textContent = msg;
  authError.classList.remove('hidden');
}

// ── WebSocket connection ──────────────────────────────────────────────────

function connect() {
  // Tear down any prior socket so we don't get duplicate handlers firing.
  if (state.ws) {
    try { state.ws.onopen = state.ws.onmessage = state.ws.onclose = state.ws.onerror = null; } catch {}
    try { state.ws.close(); } catch {}
    state.ws = null;
  }
  clearInterval(state.pingInterval);
  state.pingInterval = null;

  setConnStatus(state.hasConnected ? 'reconnecting' : 'connecting');
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${state.host}?token=${encodeURIComponent(state.token)}&deviceId=web-${fingerprint()}`;

  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    setConnStatus('offline');
    showAuthError(`Cannot connect: ${e.message}`);
    return;
  }
  state.ws = ws;

  ws.addEventListener('open', () => {
    if (ws !== state.ws) return; // stale handler
    state.reconnectAttempts = 0;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    setConnStatus('online');
    authOverlay.style.display = 'none';
    hideLlmIndicator();
    updateSendBtn();
    // Subscribe — request recent history + roster.
    // Pass the last id we saw so the server can avoid resending old history.
    const lastId = lastSeenServerId();
    send({ type: 'subscribe', lastMessageId: lastId });
    if (!state.hasConnected) {
      addSystemMsg('Connected to ThunderCommo gateway ⚡');
    } else {
      addSystemMsg('Reconnected ⚡');
    }
    state.hasConnected = true;

    // Keepalive ping every 30s to prevent idle disconnect
    state.pingInterval = setInterval(() => {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        send({ type: 'ping' });
      }
    }, 30000);
  });

  ws.addEventListener('message', evt => {
    if (ws !== state.ws) return;
    try {
      const msg = JSON.parse(evt.data);
      handleMessage(msg);
    } catch (e) {
      console.error('[TC] Failed to parse message:', e, evt.data);
    }
  });

  ws.addEventListener('close', (evt) => {
    if (ws !== state.ws) return;
    clearInterval(state.pingInterval);
    state.pingInterval = null;
    setConnStatus('offline');
    updateSendBtn();
    finalizeStream();
    hideAllTypingIndicators();
    // Throttle the disconnect chatter — once every 30s max.
    const now = Date.now();
    if (now - state.lastDisconnectMsg > 30000) {
      const reason = state.authFailed ? 'auth failed' : `code ${evt.code}`;
      addSystemMsg(state.authFailed
        ? `Disconnected (${reason}).`
        : `Disconnected (${reason}). Reconnecting…`);
      state.lastDisconnectMsg = now;
    }
    if (!state.authFailed && evt.code !== 1000) scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    if (ws !== state.ws) return;
    // 'error' is always followed by 'close' — let close handle reconnect.
    setConnStatus('offline');
    updateSendBtn();
  });
}

function lastSeenServerId() {
  for (let i = state.allMessages.length - 1; i >= 0; i--) {
    if (state.allMessages[i].id) return state.allMessages[i].id;
  }
  return null;
}

function scheduleReconnect() {
  if (state.reconnectTimer || state.authFailed) return;
  const delay = Math.min(1000 * Math.pow(1.5, state.reconnectAttempts), 30000);
  state.reconnectAttempts++;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (state.token && state.host && !state.authFailed) connect();
  }, delay);
}

function disconnect() {
  state.authFailed = true; // generic "stop reconnecting" flag
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  clearInterval(state.pingInterval);
  state.pingInterval = null;
  if (state.ws) {
    try { state.ws.close(1000, 'client disconnect'); } catch {}
  }
}

function send(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

// ── Message handling ──────────────────────────────────────────────────────

function handleMessage(msg) {
  switch (msg.type) {

    case 'status':
      setConnStatus(msg.gateway === 'connected' ? 'online' : 'reconnecting');
      // Don't surface msg.model here — the gateway reports last-known, not live.
      break;

    case 'roster':
      updateRoster(msg.agents || []);
      break;

    case 'history':
      if (msg.messages && msg.messages.length) {
        // Batch into a DocumentFragment — one DOM write, one scroll, fast.
        state.batchingHistory = true;
        const frag = document.createDocumentFragment();
        const origAppend = messagesEl.appendChild.bind(messagesEl);
        // Temporarily redirect appends into the fragment
        messagesEl.appendChild = (el) => frag.appendChild(el);
        msg.messages.forEach(m => {
          if (m.id && state.seenIds.has(m.id)) return; // dedup on reconnect
          if (m.sender) {
            renderHumanMsg(m.sender, m.text, m.channel, m.id, m.timestamp);
          } else {
            renderAgentMsg(m.agentId, m.text, m.channel, m.id, m.timestamp);
          }
        });
        messagesEl.appendChild = origAppend; // restore
        state.batchingHistory = false;
        origAppend(frag); // single DOM write
        requestAnimationFrame(() => scrollBottom(true)); // scroll once after paint
      }
      break;

    case 'thinking':
      showThinking(msg.agentId);
      break;

    case 'typing':
      // Handle typing indicator for any participant (human or agent)
      if (msg.participantId || msg.sender || msg.agentId) {
        const id = (msg.participantId || msg.sender || msg.agentId).toLowerCase();
        if (msg.typing === false) {
          hideTypingIndicator(id);
        } else {
          showTypingIndicator(id, false);
        }
      }
      break;

    case 'stream':
      if (msg.delta != null) appendStream(msg.agentId, msg.delta, msg.channel);
      break;

    case 'message': {
      // Message arrival = processing complete for this agent.
      hideLlmIndicator();
      hideThinking();
      const senderId = (msg.sender || msg.agentId || '').toLowerCase();
      if (senderId) hideTypingIndicator(senderId);
      // Skip if we already saw this server id (reconnect / duplicate broadcast)
      if (msg.id && state.seenIds.has(msg.id)) {
        finalizeStream();
        break;
      }
      // If we were streaming this same agent's reply, drop the temp element —
      // the persistent renderAgentMsg below will replace it.
      if (state.streamBuffer && state.streamBuffer.msgEl) {
        state.streamBuffer.msgEl.remove();
      }
      finalizeStream();
      if (msg.sender) {
        // Skip if we already echo'd this locally
        if (msg.idempotencyKey && state.sentKeys.has(msg.idempotencyKey)) {
          state.sentKeys.delete(msg.idempotencyKey);
          if (msg.id) state.seenIds.add(msg.id);
        } else {
          // Live arrival via websocket — force scroll so Michael always sees new messages.
          renderHumanMsg(msg.sender, msg.text, msg.channel, msg.id, msg.timestamp, false, true);
        }
      } else {
        // Live arrival via websocket — force scroll so Michael always sees new messages.
        renderAgentMsg(msg.agentId, msg.text, msg.channel, msg.id, msg.timestamp, false, true);
      }
      break;
    }

    case 'pong':
    case 'ack':
      // Heartbeat / delivery — no UI work needed.
      break;

    case 'system_event':
      addSystemMsg(msg.text);
      break;

    case 'error':
      if (msg.code === 'AUTH_FAILED') {
        state.authFailed = true;
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
        // Drop the stored token so refresh doesn't retry the bad creds.
        localStorage.removeItem('tc_token');
        authOverlay.style.display = 'flex';
        showAuthError(`Auth failed: ${msg.message || 'invalid token'}`);
        setConnStatus('offline');
      } else if (msg.code !== 'INVALID_MESSAGE') {
        // Suppress low-level protocol errors from chat UI
        addSystemMsg(`Error: ${msg.message || msg.code || 'unknown'}`);
      }
      break;
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────

function storeMessage(msg) {
  if (msg.id) {
    if (state.seenIds.has(msg.id)) return false;
    state.seenIds.add(msg.id);
    if (state.seenIds.size > MAX_SEEN_IDS) {
      // Drop oldest insertion (Set iterates in insertion order)
      const first = state.seenIds.values().next().value;
      state.seenIds.delete(first);
    }
  }
  state.allMessages.push(msg);
  if (state.allMessages.length > MAX_MESSAGES) {
    state.allMessages.splice(0, state.allMessages.length - MAX_MESSAGES);
    // Trim DOM to match
    while (messagesEl.children.length > MAX_MESSAGES) {
      messagesEl.removeChild(messagesEl.firstChild);
    }
  }
  return true;
}

function renderAgentMsg(agentId, text, channel, id, timestamp, skipStore = false, forceScroll = false) {
  const msgChannel = normalizeChannel(channel);
  const safeAgentId = (agentId || 'agent').toLowerCase();

  // Store for later filtering. If storeMessage returns false, we've seen this id before.
  if (!skipStore) {
    const stored = storeMessage({ type: 'agent', agentId: safeAgentId, text, channel: msgChannel, id, timestamp: timestamp || Date.now() });
    if (!stored) return;
  }

  // Skip rendering if message doesn't belong to current view
  if (!shouldShowInCurrentView(msgChannel)) return;

  const msgEl = document.createElement('div');
  msgEl.className = 'msg agent';
  if (id) msgEl.dataset.id = id;
  msgEl.dataset.channel = msgChannel;

  const meta = document.createElement('div');
  meta.className = 'msg-meta';

  const author = document.createElement('span');
  author.className = `msg-author ${safeAgentId}`;
  author.textContent = safeAgentId.charAt(0).toUpperCase() + safeAgentId.slice(1);

  const time = document.createElement('span');
  time.textContent = formatTime(timestamp || Date.now());

  meta.append(author, time);

  const textEl = document.createElement('div');
  textEl.className = 'msg-text';
  textEl.innerHTML = renderMarkdown(text);

  msgEl.append(meta, textEl);
  messagesEl.appendChild(msgEl);
  // Defer one frame so the new node's height is included in scrollHeight
  // before we measure / set scrollTop — otherwise we land short.
  if (forceScroll) requestAnimationFrame(() => scrollBottom(true));
  else scrollBottom();
}

function renderUserMsg(text) {
  // Local echo — show your own message immediately on send
  const now = Date.now();
  const msgChannel = normalizeChannel(state.channel);

  // Store so message survives channel switches
  storeMessage({ type: 'human', sender: 'Michael', text, channel: msgChannel, id: null, timestamp: now });

  const msgEl = document.createElement('div');
  msgEl.className = 'msg user';
  msgEl.dataset.channel = msgChannel;

  const meta = document.createElement('div');
  meta.className = 'msg-meta';

  const author = document.createElement('span');
  author.className = 'msg-author human';
  author.textContent = 'Michael';

  const time = document.createElement('span');
  time.textContent = formatTime(now);

  meta.append(author, time);

  const textEl = document.createElement('div');
  textEl.className = 'msg-text';
  textEl.textContent = text;

  msgEl.append(meta, textEl);
  messagesEl.appendChild(msgEl);
  scrollBottom(true);
}

function renderHumanMsg(sender, text, channel, id, timestamp, skipStore = false, forceScroll = false) {
  const msgChannel = normalizeChannel(channel);

  if (!skipStore) {
    const stored = storeMessage({ type: 'human', sender, text, channel: msgChannel, id, timestamp: timestamp || Date.now() });
    if (!stored) return;
  }

  if (!shouldShowInCurrentView(msgChannel)) return;

  const msgEl = document.createElement('div');
  msgEl.className = 'msg user';
  if (id) msgEl.dataset.id = id;
  msgEl.dataset.channel = msgChannel;

  const meta = document.createElement('div');
  meta.className = 'msg-meta';

  const author = document.createElement('span');
  author.className = 'msg-author human';
  author.textContent = sender;

  const time = document.createElement('span');
  time.textContent = formatTime(timestamp || Date.now());

  meta.append(author, time);

  const textEl = document.createElement('div');
  textEl.className = 'msg-text';
  textEl.textContent = text;

  msgEl.append(meta, textEl);
  messagesEl.appendChild(msgEl);
  if (forceScroll) requestAnimationFrame(() => scrollBottom(true));
  else scrollBottom();
}

function addSystemMsg(text) {
  const el = document.createElement('div');
  el.className = 'msg system';
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollBottom();
}

function rerenderMessagesForChannel() {
  // Clear current messages
  messagesEl.innerHTML = '';
  
  // Re-render only messages for current view
  for (const msg of state.allMessages) {
    if (!shouldShowInCurrentView(msg.channel)) continue;
    
    if (msg.type === 'agent') {
      renderAgentMsg(msg.agentId, msg.text, msg.channel, msg.id, msg.timestamp, true);
    } else if (msg.type === 'human') {
      renderHumanMsg(msg.sender, msg.text, msg.channel, msg.id, msg.timestamp, true);
    }
  }
}

// ── Streaming ─────────────────────────────────────────────────────────────

function appendStream(agentId, delta, channel) {
  const safeAgentId = (agentId || 'agent').toLowerCase();
  const msgChannel  = normalizeChannel(channel);

  if (!state.streamBuffer || state.streamBuffer.agentId !== safeAgentId || state.streamBuffer.channel !== msgChannel) {
    // Start a new streaming message
    finalizeStream();
    state.streamBuffer = {
      msgEl: null, textEl: null,
      agentId: safeAgentId,
      channel: msgChannel,
      text: '',
    };

    if (shouldShowInCurrentView(msgChannel)) {
      const msgEl = document.createElement('div');
      msgEl.className = 'msg agent';
      msgEl.dataset.channel = msgChannel;

      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      const author = document.createElement('span');
      author.className = `msg-author ${safeAgentId}`;
      author.textContent = safeAgentId.charAt(0).toUpperCase() + safeAgentId.slice(1);
      const time = document.createElement('span');
      time.textContent = formatTime(Date.now());
      meta.append(author, time);

      const textEl = document.createElement('div');
      textEl.className = 'msg-text stream-cursor';

      msgEl.append(meta, textEl);
      messagesEl.appendChild(msgEl);

      state.streamBuffer.msgEl  = msgEl;
      state.streamBuffer.textEl = textEl;
    }
    hideThinking();
    showLlmIndicator(safeAgentId);
  }

  state.streamBuffer.text += delta;
  if (state.streamBuffer.textEl) {
    // Use textContent during stream — render markdown only on finalize.
    state.streamBuffer.textEl.textContent = state.streamBuffer.text;
    scrollBottom();
  }
}

function finalizeStream() {
  if (!state.streamBuffer) return;
  const buf = state.streamBuffer;
  state.streamBuffer = null;
  if (buf.textEl) {
    buf.textEl.classList.remove('stream-cursor');
    // Render any markdown / code blocks that streamed in.
    if (buf.text) buf.textEl.innerHTML = renderMarkdown(buf.text);
  }
  hideLlmIndicator();
}

// ── Typing/Thinking Indicators (inline) ──────────────────────────────────────

const typingIndicatorsEl = document.createElement('div');
typingIndicatorsEl.id = 'typing-indicators';

function getParticipantColor(name) {
  const lower = name?.toLowerCase() || '';
  if (lower === 'jon') return 'var(--jon)';
  if (lower === 'mack') return 'var(--mack)';
  if (lower === 'michael') return 'var(--michael)';
  if (lower === 'rex') return 'var(--rex)';
  if (lower === 'burt' || lower === 'alex') return 'var(--text-dim)';
  return 'var(--text-dim)';
}

function showTypingIndicator(participantId, isThinking = false) {
  if (!participantId) return;
  const id = String(participantId).toLowerCase();
  if (state.typingIndicators[id]) {
    clearTimeout(state.typingIndicators[id]);
  }

  let indicatorEl = document.getElementById(`typing-${id}`);
  if (!indicatorEl) {
    indicatorEl = document.createElement('div');
    indicatorEl.id = `typing-${id}`;
    indicatorEl.className = 'typing-indicator';
    typingIndicatorsEl.appendChild(indicatorEl);
  }

  const displayName = id.charAt(0).toUpperCase() + id.slice(1);
  const color = getParticipantColor(id);
  // Build via DOM to avoid HTML injection through participant ids.
  indicatorEl.textContent = '';
  const nameEl = document.createElement('span');
  nameEl.style.color = color;
  nameEl.style.fontWeight = '600';
  nameEl.textContent = displayName;
  const dotsEl = document.createElement('span');
  dotsEl.className = 'typing-dots';
  dotsEl.textContent = ' ' + (isThinking ? '∴' : '...');
  indicatorEl.append(nameEl, dotsEl);

  // Auto-hide after 10 seconds if no update
  state.typingIndicators[id] = setTimeout(() => {
    hideTypingIndicator(id);
  }, 10000);

  // Ensure indicators container is in DOM
  if (!typingIndicatorsEl.parentNode) {
    const inputArea = document.getElementById('input-area');
    inputArea.parentNode.insertBefore(typingIndicatorsEl, inputArea);
  }

  scrollBottom();
}

function hideTypingIndicator(participantId) {
  if (!participantId) return;
  const id = String(participantId).toLowerCase();
  if (state.typingIndicators[id]) {
    clearTimeout(state.typingIndicators[id]);
    delete state.typingIndicators[id];
  }
  const indicatorEl = document.getElementById(`typing-${id}`);
  if (indicatorEl) {
    indicatorEl.remove();
  }
}

function hideAllTypingIndicators() {
  Object.keys(state.typingIndicators).forEach(id => hideTypingIndicator(id));
}

// Legacy functions for backwards compatibility
function showThinking(agentId) {
  // Only show if we have a valid agentId - don't default to 'jon'
  if (agentId) {
    showTypingIndicator(agentId, true);
    showLlmIndicator(agentId);
  }
  // Hide old top-right indicator
  thinkingEl.classList.add('hidden');
}

function hideThinking() {
  // Hide old top-right indicator (inline indicators clear on message receipt)
  thinkingEl.classList.add('hidden');
  hideLlmIndicator();
}

// ── Connection status ─────────────────────────────────────────────────────

function setConnStatus(status) {
  // status: 'online' | 'connecting' | 'reconnecting' | 'offline'
  connDot.className = `status-dot ${status}`;
  const labels = {
    online:       'Online',
    connecting:   'Connecting…',
    reconnecting: 'Reconnecting…',
    offline:      'Offline',
  };
  connDot.title = labels[status] || status;
  connDot.setAttribute('aria-label', connDot.title);
}

// When the user comes back to the tab or network returns, kick reconnect
// if the socket has dropped (timers can freeze in background tabs).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.token && !state.authFailed) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      state.reconnectAttempts = 0;
      scheduleReconnect();
    }
  }
});
window.addEventListener('online', () => {
  if (state.token && !state.authFailed) {
    state.reconnectAttempts = 0;
    scheduleReconnect();
  }
});
window.addEventListener('offline', () => {
  setConnStatus('offline');
  updateSendBtn();
});

// ── Agent roster ──────────────────────────────────────────────────────────

function updateRoster(agents) {
  state.agents = {};
  agents.forEach(a => { state.agents[a.id] = a; });

  document.querySelectorAll('.agent-dot[data-agent]').forEach(dot => {
    const agentId = dot.dataset.agent;
    const agent   = state.agents[agentId];
    const status  = agent ? (agent.status || 'offline') : 'offline';
    dot.className = `agent-dot ${status}`;
    dot.setAttribute('aria-label', `${agentId} ${status}`);

    const btn = dot.closest('.channel-btn');
    if (!btn) return;
    let modelEl = btn.querySelector('.agent-model');
    if (agent?.model) {
      if (!modelEl) {
        modelEl = document.createElement('span');
        modelEl.className = 'agent-model';
        btn.appendChild(modelEl);
      }
      const shortModel = shortenModelName(agent.model);
      modelEl.textContent = shortModel;
      modelEl.title = agent.model;
    } else if (modelEl) {
      // Agent went offline / model removed — drop the badge.
      modelEl.remove();
    }
  });
}

function shortenModelName(m) {
  if (!m) return '';
  return m
    .replace('anthropic/', '')
    .replace('claude-opus-4-7',  'Opus 4.7')
    .replace('claude-opus-4-6',  'Opus 4.6')
    .replace('claude-opus-4-5',  'Opus 4.5')
    .replace('claude-sonnet-4-6', 'Sonnet 4.6')
    .replace('claude-haiku-4-5',  'Haiku 4.5')
    .replace('openai/', '')
    .replace('gpt-5.4', 'GPT-5.4')
    .replace('xai/', '')
    .replace('grok-4', 'Grok-4');
}

// ── Channel switching ─────────────────────────────────────────────────────

function activateChannelBtn(btn) {
  document.querySelectorAll('.channel-btn').forEach(b => {
    b.classList.remove('active');
    b.setAttribute('aria-selected', 'false');
  });
  btn.classList.add('active');
  btn.setAttribute('aria-selected', 'true');
  state.channel = btn.dataset.channel;
  state.agentId = btn.dataset.agent || null;

  const label = state.channel === 'tnt'
    ? '#TNT'
    : state.channel === 'jmab'
    ? '#JMAB'
    : `@${state.agentId || 'direct'}`;
  chatTitle.textContent = label;
  textInputEl.placeholder = `Message ${label}…`;

  // Clear ephemeral UI from previous channel
  finalizeStream();
  hideThinking();
  hideAllTypingIndicators();

  rerenderMessagesForChannel();
  scrollBottom(true);
  // Close drawer if open (mobile)
  document.body.classList.remove('sidebar-open');
}

document.querySelectorAll('.channel-btn').forEach(btn => {
  btn.addEventListener('click', () => activateChannelBtn(btn));
});

// ── Input mode ────────────────────────────────────────────────────────────

function setInputMode(mode) {
  state.inputMode = mode;
  inputModeBtn.textContent = MODE_ICONS[mode];
  inputModeBtn.className   = '';
  inputModeBtn.classList.add(mode);
  inputModeBtn.title = `Input mode: ${mode}`;
}

setInputMode('silent');

inputModeBtn.addEventListener('click', () => {
  const idx  = INPUT_MODES.indexOf(state.inputMode);
  const next = INPUT_MODES[(idx + 1) % INPUT_MODES.length];
  setInputMode(next);
  // TODO: wire ambient VAD and PTT recording when audio pipeline is ready
  if (next !== 'silent') {
    addSystemMsg(`Audio input (${next}) requires ThunderMind integration — text input active.`);
    setInputMode('silent');
  }
});

// ── Sending messages ──────────────────────────────────────────────────────

function sendText() {
  const text = textInputEl.value.trim();
  if (!text) return;
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    addSystemMsg('Not connected. Reconnecting…');
    return;
  }

  const idempotencyKey = uuid();
  const msg = {
    type: 'message',
    channel: state.channel,
    text,
    idempotencyKey,
  };
  if (state.channel === 'direct' && state.agentId) {
    msg.agentId = state.agentId;
  }

  state.sentKeys.add(idempotencyKey);
  // Cap sentKeys to avoid unbounded growth if the server never echoes some.
  if (state.sentKeys.size > MAX_SENT_KEYS) {
    const first = state.sentKeys.values().next().value;
    state.sentKeys.delete(first);
  }
  renderUserMsg(text);
  send(msg);
  // Show a thinking indicator for the agent we expect to respond.
  // For #TNT default to Jon; for #JMAB don't assume (any team member may respond).
  if (state.channel === 'direct' && state.agentId) {
    showThinking(state.agentId);
  } else if (state.channel === 'tnt') {
    showThinking('jon');
  }

  textInputEl.value = '';
  autoResize();
  textInputEl.focus();
}

function uuid() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  // Fallback for older browsers / non-secure contexts
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

sendBtn.addEventListener('click', sendText);

textInputEl.addEventListener('keydown', e => {
  // Enter = send, Shift+Enter = newline
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendText();
  }
});

textInputEl.addEventListener('input', autoResize);

function autoResize() {
  textInputEl.style.height = 'auto';
  const next = Math.max(38, Math.min(textInputEl.scrollHeight, 160));
  textInputEl.style.height = next + 'px';
}

// ── Utilities ─────────────────────────────────────────────────────────────

function isNearBottom() {
  const distance = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  return distance < 300;
}

function scrollBottom(force) {
  // Suppressed during batch history load (state.batchingHistory)
  if (state.batchingHistory) return;
  // Don't yank the scroll back down if the user is reading history.
  if (force || isNearBottom()) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function updateSendBtn() {
  const connected = state.ws && state.ws.readyState === WebSocket.OPEN;
  sendBtn.disabled = !connected;
  sendBtn.title = connected ? 'Send (Enter)' : 'Not connected';
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fingerprint() {
  // Stable-ish browser fingerprint for device tracking
  const key = 'tc_device_id';
  let id = localStorage.getItem(key);
  if (!id) {
    id = uuid().slice(0, 8);
    localStorage.setItem(key, id);
  }
  return id;
}

// ── Mobile sidebar toggle ─────────────────────────────────────────────────

function setupMobileSidebar() {
  const toggle = document.getElementById('sidebar-toggle');
  if (!toggle) return;
  toggle.addEventListener('click', () => {
    document.body.classList.toggle('sidebar-open');
  });
  // Close drawer when tapping outside the sidebar.
  document.addEventListener('click', e => {
    if (!document.body.classList.contains('sidebar-open')) return;
    if (e.target.closest('#sidebar') || e.target.closest('#sidebar-toggle')) return;
    document.body.classList.remove('sidebar-open');
  });
}

// ── Header collapse toggle ───────────────────────────────────────────────

function setupHeaderCollapse() {
  const btn = document.getElementById('header-collapse-btn');
  const header = document.getElementById('chat-header');
  if (!btn || !header) return;
  btn.addEventListener('click', () => {
    const collapsed = header.classList.toggle('collapsed');
    btn.textContent = collapsed ? '▼' : '▲';
    btn.title = collapsed ? 'Expand header' : 'Collapse header';
  });
}

// ── Add Channel modal ───────────────────────────────────────────────────────

function setupAddChannel() {
  const openBtn   = document.getElementById('add-channel-btn');
  const modal     = document.getElementById('add-channel-modal');
  const cancelBtn = document.getElementById('add-channel-cancel');
  const confirmBtn= document.getElementById('add-channel-confirm');
  const nameInput = document.getElementById('add-channel-name');
  if (!openBtn || !modal) return;

  openBtn.addEventListener('click', () => {
    modal.classList.remove('hidden');
    nameInput && nameInput.focus();
  });

  const closeModal = () => {
    modal.classList.add('hidden');
    if (nameInput) nameInput.value = '';
  };

  cancelBtn && cancelBtn.addEventListener('click', closeModal);

  confirmBtn && confirmBtn.addEventListener('click', () => {
    const raw = nameInput ? nameInput.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') : '';
    if (!raw) { nameInput && nameInput.focus(); return; }
    // Check if already exists
    if (document.querySelector(`.channel-btn[data-channel="${raw}"][data-agent=""]`)) {
      addSystemMsg(`Channel #${raw} already in sidebar.`);
      closeModal();
      return;
    }
    // Inject channel button before sidebar-footer
    const nav = document.getElementById('channels');
    const btn = document.createElement('button');
    btn.className = 'channel-btn';
    btn.dataset.channel = raw;
    btn.dataset.agent = '';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.textContent = `# ${raw}`;
    // Wire click via existing delegation
    nav.appendChild(btn);
    // Save to localStorage so it persists on reload
    const saved = JSON.parse(localStorage.getItem('tc_custom_channels') || '[]');
    if (!saved.includes(raw)) {
      saved.push(raw);
      localStorage.setItem('tc_custom_channels', JSON.stringify(saved));
    }
    addSystemMsg(`Channel #${raw} added.`);
    closeModal();
    // Auto-switch to the new channel
    btn.click();
  });

  // Close on backdrop click
  modal.addEventListener('click', e => {
    if (e.target === modal) closeModal();
  });

  nameInput && nameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmBtn && confirmBtn.click();
    if (e.key === 'Escape') closeModal();
  });
}

// ── Add Human modal ───────────────────────────────────────────────────────

function setupAddHuman() {
  const openBtn   = document.getElementById('add-human-btn');
  const modal     = document.getElementById('add-human-modal');
  const cancelBtn = document.getElementById('add-human-cancel');
  const confirmBtn= document.getElementById('add-human-confirm');
  const phoneInput= document.getElementById('add-human-phone');
  if (!openBtn || !modal) return;

  openBtn.addEventListener('click', () => {
    modal.classList.remove('hidden');
    phoneInput && phoneInput.focus();
  });

  const closeModal = () => modal.classList.add('hidden');

  cancelBtn && cancelBtn.addEventListener('click', closeModal);

  confirmBtn && confirmBtn.addEventListener('click', () => {
    const phone = phoneInput ? phoneInput.value.trim() : '';
    if (!phone) { phoneInput && phoneInput.focus(); return; }
    // Placeholder: log intent. Real invite flow wires in here when backend supports it.
    console.log('[ThunderCommo] Add human invite intent:', phone);
    addSystemMsg(`📱 Human invite queued for ${phone} — KYABYOAA onboarding coming soon.`);
    phoneInput.value = '';
    closeModal();
  });

  // Close on backdrop click
  modal.addEventListener('click', e => {
    if (e.target === modal) closeModal();
  });

  phoneInput && phoneInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmBtn && confirmBtn.click();
    if (e.key === 'Escape') closeModal();
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────

(function init() {
  // Sync chat title + placeholder with whichever channel button is active in HTML.
  const activeBtn = document.querySelector('.channel-btn.active') || document.querySelector('.channel-btn');
  if (activeBtn) {
    const channel = activeBtn.dataset.channel;
    const agentId = activeBtn.dataset.agent || null;
    state.channel = channel;
    state.agentId = agentId;
    const label = channel === 'tnt' ? '#TNT'
      : channel === 'jmab' ? '#JMAB'
      : `@${agentId || 'direct'}`;
    chatTitle.textContent = label;
    textInputEl.placeholder = `Message ${label}…`;
    activeBtn.setAttribute('aria-selected', 'true');
  }
  updateSendBtn();
  autoResize();
  setupMobileSidebar();
  setupHeaderCollapse();
  setupAddChannel();
  setupAddHuman();
  // Restore any custom channels saved from previous sessions
  {
    const saved = JSON.parse(localStorage.getItem('tc_custom_channels') || '[]');
    const nav = document.getElementById('channels');
    saved.forEach(raw => {
      if (!document.querySelector(`.channel-btn[data-channel="${raw}"][data-agent=""]`)) {
        const btn = document.createElement('button');
        btn.className = 'channel-btn';
        btn.dataset.channel = raw;
        btn.dataset.agent = '';
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', 'false');
        btn.textContent = `# ${raw}`;
        nav.appendChild(btn);
      }
    });
  }
  // Focus token input if visible (no saved creds)
  if (!tokenInput.value) tokenInput.focus();
})();
