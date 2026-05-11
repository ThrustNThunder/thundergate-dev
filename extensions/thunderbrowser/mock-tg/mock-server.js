// Mock ThunderGate WSS server (TB-0-10).
//
// One process, one port, one REPL. Speaks the ThunderBrowser protocol from
// `THUNDERBROWSER_EXTENSION_DESIGN.md` §2.2 in its narrowest form: accept a
// WS connection at /browser, send `hello` on open, accept `ready`, then act
// as a scenario dispatcher driven by the REPL.
//
// This is a *mock*. JWT verification is relaxed (any well-formed token, or
// none, passes). Subprotocol negotiation is permissive. Resume-cursor
// bookkeeping is in-memory and forgets on restart. The real bridge
// (TB-0-6 in the design-doc-original sense) replaces this in Phase 2+.
//
// REPL commands:
//   help                              show usage
//   list                              connected extensions
//   scenario hello                    re-send hello
//   scenario navigate [url]           send navigate command
//   scenario snapshot                 send snapshot_dom command
//   scenario click [ref]              send click command
//   scenario scope [label]            mint fake scope token + announce run
//   scenario pair <code>              confirm the pending pairing for <code>
//   raw <json>                        send a literal JSON envelope
//   quit                              exit

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import readline from 'node:readline';

const PORT = Number(process.env.PORT || 9876);

const httpServer = createServer((req, res) => {
  // The extension hits /browser via WS; HTTP GETs are useful for health checks.
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ts: Date.now() }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ThunderBrowser mock TG — WebSocket on /browser\n');
});

const wss = new WebSocketServer({ server: httpServer, path: '/browser' });

const sessions = new Map(); // ws → { id, sentReady, lastSeq, runId, scopeLabel }
let nextSessionId = 1;
let nextEnvelopeId = 1;

function ts() { return new Date().toISOString(); }
function log(...args) { console.log(`[${ts()}]`, ...args); }

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${(nextEnvelopeId++).toString(36)}`;
}

function send(ws, obj) {
  if (ws.readyState !== ws.OPEN) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch (e) {
    log('send error', e && e.message ? e.message : String(e));
    return false;
  }
}

function broadcast(obj) {
  let sent = 0;
  for (const ws of wss.clients) if (send(ws, obj)) sent++;
  return sent;
}

function pickTarget() {
  // Phase 0 mock: target the first connected extension. Multi-extension routing
  // is not in scope here.
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) return ws;
  }
  return null;
}

// ── WSS lifecycle ──────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const sid = nextSessionId++;
  sessions.set(ws, { id: sid, sentReady: false, lastSeq: 0, runId: null, scopeLabel: null });
  log(`extension connected (session ${sid}) from ${req.socket.remoteAddress}`);

  send(ws, {
    v: 1,
    id: newId('hello'),
    ts: Date.now(),
    type: 'hello',
    body: { server: 'tg-mock', protocol: 'thunderbrowser.v1' },
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) {
      log(`session ${sid} bad JSON: ${String(raw).slice(0, 120)}`);
      return;
    }
    const t = msg && msg.type;
    if (t === 'ready') {
      sessions.get(ws).sentReady = true;
      log(`session ${sid} READY:`, JSON.stringify(msg.body || {}));
    } else if (t === 'ack') {
      log(`session ${sid} ack ref=${msg.ref} body=${JSON.stringify(msg.body || {})}`);
    } else if (t === 'result' || t === 'event' || t === 'error') {
      log(`session ${sid} ${t} id=${msg.id} body=${JSON.stringify(msg.body || {})}`);
    } else {
      log(`session ${sid} ${t || '<no-type>'} ${JSON.stringify(msg)}`);
    }
  });

  ws.on('close', (code, reason) => {
    log(`session ${sid} closed code=${code} reason=${reason ? reason.toString() : ''}`);
    sessions.delete(ws);
  });

  ws.on('error', (e) => {
    log(`session ${sid} error`, e && e.message ? e.message : String(e));
  });
});

// ── Scenarios ──────────────────────────────────────────────────────────────

const scenarios = {
  hello(_args, target) {
    return send(target, {
      v: 1, id: newId('hello'), ts: Date.now(), type: 'hello',
      body: { server: 'tg-mock', resent: true },
    });
  },
  navigate(args, target) {
    const url = args[0] || 'http://localhost:7860/dashboard';
    return send(target, {
      v: 1, id: newId('cmd'), ts: Date.now(), type: 'command',
      body: { action: 'navigate', params: { url, wait_for: 'load', timeout_ms: 10000 } },
    });
  },
  snapshot(_args, target) {
    return send(target, {
      v: 1, id: newId('cmd'), ts: Date.now(), type: 'command',
      body: { action: 'snapshot_dom', params: { mode: 'structured' } },
    });
  },
  click(args, target) {
    const ref = args[0] || 'el#1';
    return send(target, {
      v: 1, id: newId('cmd'), ts: Date.now(), type: 'command',
      body: { action: 'click', params: { ref, expect_navigation: false } },
    });
  },
  scope(args, target) {
    const label = args.join(' ') || 'AA dry-run';
    const runId = newId('run');
    const scopeId = newId('scope');
    sessions.get(target).runId = runId;
    sessions.get(target).scopeLabel = label;
    return send(target, {
      v: 1, id: newId('scope-evt'), ts: Date.now(), type: 'scope',
      body: {
        runId, scopeId, label,
        actions: ['navigate', 'snapshot_dom', 'click', 'fill'],
        max_actions: 50,
        expires_at: Date.now() + 5 * 60 * 1000,
        token: 'tbscope.MOCK.' + Buffer.from(JSON.stringify({ runId, label })).toString('base64url'),
      },
    });
  },
  pair(args, target) {
    const code = args[0];
    if (!code) {
      log('scenario pair: usage — scenario pair <6-digit-code>');
      return false;
    }
    return send(target, {
      v: 1, id: newId('paired'), ts: Date.now(), type: 'paired',
      body: {
        pairingCode: code,
        endpoint: `ws://localhost:${PORT}/browser`,
        tg_kid_pubkeys: [
          { kid: 'mock-kid-1', alg: 'EdDSA', pubkeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'AAAAmockAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } },
        ],
      },
    });
  },
};

// ── REPL ───────────────────────────────────────────────────────────────────

function showHelp() {
  console.log(`
ThunderBrowser mock TG REPL — port ${PORT}

  help                              show this table
  list                              connected extensions
  scenario hello                    re-send hello event
  scenario navigate [url]           send navigate command (default: dashboard)
  scenario snapshot                 send snapshot_dom command
  scenario click [ref]              send click command (default ref el#1)
  scenario scope [label]            mint fake scope token + announce run
  scenario pair <code>              confirm pending pairing for <code>
  raw <json>                        send a literal JSON envelope
  quit                              shut down
`);
}

function startRepl() {
  if (!process.stdin.isTTY) {
    log('stdin is not a TTY — running as daemon, REPL disabled');
    log('use SIGINT/SIGTERM to shut down; HTTP /health for liveness');
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'tg-mock> ' });
  rl.prompt();

  rl.on('line', (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    const [cmd, ...rest] = input.split(/\s+/);
    if (cmd === 'help') { showHelp(); rl.prompt(); return; }
    if (cmd === 'quit' || cmd === 'exit') {
      log('shutting down');
      for (const ws of wss.clients) ws.close(1001, 'mock-tg shutdown');
      httpServer.close(() => process.exit(0));
      return;
    }
    if (cmd === 'list') {
      if (sessions.size === 0) { console.log('(no connected extensions)'); }
      else {
        for (const [ws, s] of sessions) {
          console.log(`  session ${s.id} ready=${s.sentReady} runId=${s.runId || '-'} scope=${s.scopeLabel || '-'} state=${ws.readyState}`);
        }
      }
      rl.prompt();
      return;
    }
    if (cmd === 'raw') {
      const target = pickTarget();
      if (!target) { console.log('(no extension connected)'); rl.prompt(); return; }
      try {
        const obj = JSON.parse(rest.join(' '));
        const ok = send(target, obj);
        console.log(ok ? '(sent)' : '(send failed)');
      } catch (e) {
        console.log('bad JSON:', e && e.message ? e.message : String(e));
      }
      rl.prompt();
      return;
    }
    if (cmd === 'scenario') {
      const [name, ...args] = rest;
      const fn = scenarios[name];
      if (!fn) { console.log(`unknown scenario: ${name}`); rl.prompt(); return; }
      const target = pickTarget();
      if (!target) { console.log('(no extension connected)'); rl.prompt(); return; }
      const ok = fn(args, target);
      console.log(ok ? `(scenario ${name} dispatched)` : '(send failed)');
      rl.prompt();
      return;
    }
    console.log(`unknown command: ${cmd} — type "help"`);
    rl.prompt();
  });

  rl.on('close', () => {
    log('REPL closed; exiting');
    process.exit(0);
  });
}

httpServer.listen(PORT, () => {
  console.log(`ThunderBrowser mock TG listening on ws://localhost:${PORT}/browser`);
  console.log('Type "help" for REPL commands.');
  startRepl();
});
