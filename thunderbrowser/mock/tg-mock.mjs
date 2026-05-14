// Mock ThunderGate — runs a WSS server on :7861 that the dev extension talks
// to. Loads a .tbscript file and walks the commands sequentially, asserting
// on the events that come back. Exit 0 on pass, non-zero on first failure.
//
// .tbscript format (line-oriented, comment-friendly):
//   # comments
//   EXPECT_READY
//   EXPECT_EVENT state_detected aa.dashboard within 30s
//   SEND_COMMAND navigate {"url":"http://localhost:7860/aa/dashboard","new_tab":true}
//   EXPECT_RESULT
//   SEND_EVENT scope_warning {"kind":"expires_soon","remaining_s":60}
//   ASSERT no_errors
//
// Interactive mode (REPL): `--interactive` instead of a script file.

import { WebSocketServer } from "ws";
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

const PROTOCOL_VERSION = 1;
const SUBPROTOCOL = "thunderbrowser.v1";

const args = process.argv.slice(2);
const interactive = args.includes("--interactive");
const scriptIdx = args.findIndex((a) => a.endsWith(".tbscript"));
const scriptPath = scriptIdx >= 0 ? args[scriptIdx] : null;
const port = parseInt(process.env.TB_MOCK_PORT || "7861", 10);

if (!interactive && !scriptPath) {
  console.error("usage: node tg-mock.mjs <path.tbscript>  |  --interactive");
  process.exit(2);
}
if (scriptPath && !existsSync(scriptPath)) {
  console.error(`script not found: ${scriptPath}`);
  process.exit(2);
}

const state = {
  ws: null,
  events: [],
  inflight: new Map(),
  errors: [],
  ready: false,
  csReady: false,
  startTs: Date.now(),
};

function nowRel() { return ((Date.now() - state.startTs) / 1000).toFixed(2) + "s"; }
function log(...a) { console.log(`[${nowRel()}]`, ...a); }

const wss = new WebSocketServer({ port, handleProtocols: (protos) => {
  if (Array.from(protos).includes(SUBPROTOCOL)) return SUBPROTOCOL;
  return false;
}});

wss.on("connection", (ws) => {
  state.ws = ws;
  log("extension connected");
  ws.send(JSON.stringify({
    v: PROTOCOL_VERSION, id: randomUUID(), ts: Date.now(),
    type: "event", ref: null, scope: null,
    body: { kind: "hello", server_ts: Date.now() },
  }));
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    onMessage(msg);
  });
  ws.on("close", () => { log("extension disconnected"); state.ws = null; });
});

wss.on("listening", () => {
  log(`mock TG listening on ws://localhost:${port}/browser`);
  if (interactive) runRepl();
  else runScript();
});

function onMessage(msg) {
  if (msg.type === "event") {
    const kind = msg.body?.kind;
    if (kind === "ready") state.ready = true;
    if (kind === "cs_ready") state.csReady = true;
    state.events.push({ kind, body: msg.body, ts: Date.now() });
    log("event:", kind, JSON.stringify(msg.body).slice(0, 160));
  } else if (msg.type === "ack") {
    const p = state.inflight.get(msg.ref);
    if (p) p.ack(msg);
  } else if (msg.type === "result") {
    const p = state.inflight.get(msg.ref);
    if (p) { state.inflight.delete(msg.ref); p.resolve(msg.body); }
  } else if (msg.type === "error") {
    state.errors.push(msg);
    const p = state.inflight.get(msg.ref);
    if (p) { state.inflight.delete(msg.ref); p.reject(new Error(`${msg.body?.code}: ${msg.body?.message}`)); }
    else log("unsolicited error:", msg.body);
  }
}

function sendCommand(action, params = {}) {
  if (!state.ws) throw new Error("no extension connection");
  const id = randomUUID();
  const cmd = {
    v: PROTOCOL_VERSION, id, ts: Date.now(),
    type: "command", ref: null, scope: null,
    body: { action, ...params },
  };
  log("→ command:", action, JSON.stringify(params).slice(0, 120));
  state.ws.send(JSON.stringify(cmd));
  return new Promise((resolve, reject) => {
    state.inflight.set(id, { ack() {}, resolve, reject });
    setTimeout(() => {
      if (state.inflight.has(id)) {
        state.inflight.delete(id);
        reject(new Error("command timeout"));
      }
    }, 30_000);
  });
}

function sendEvent(kind, body = {}) {
  if (!state.ws) throw new Error("no extension connection");
  state.ws.send(JSON.stringify({
    v: PROTOCOL_VERSION, id: randomUUID(), ts: Date.now(),
    type: "event", ref: null, scope: null,
    body: { kind, ...body },
  }));
  log("← event:", kind);
}

async function waitFor(pred, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// --- script runner --------------------------------------------------------
async function runScript() {
  const text = readFileSync(scriptPath, "utf8");
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  let pass = 0;
  let fail = null;
  for (const line of lines) {
    try {
      await runDirective(line);
      pass++;
    } catch (e) {
      fail = { line, error: e.message };
      break;
    }
  }
  log(`\n=== script ${scriptPath} ===`);
  if (fail) {
    log(`FAIL at: ${fail.line}`);
    log(`reason: ${fail.error}`);
    process.exit(1);
  } else {
    log(`PASS — ${pass} directives`);
    process.exit(0);
  }
}

async function runDirective(line) {
  log(`▶ ${line}`);
  if (line.startsWith("EXPECT_READY")) {
    const ok = await waitFor(() => state.ready, 10_000);
    if (!ok) throw new Error("no ready event within 10s");
    return;
  }
  if (line.startsWith("EXPECT_CS_READY")) {
    const ok = await waitFor(() => state.csReady, 30_000);
    if (!ok) throw new Error("no cs_ready event within 30s");
    return;
  }
  const eventM = line.match(/^EXPECT_EVENT\s+(\S+)(?:\s+(\S+))?(?:\s+within\s+(\d+)s)?$/);
  if (eventM) {
    const [, kind, payloadMatch, t] = eventM;
    const timeoutMs = (parseInt(t || "30", 10)) * 1000;
    const ok = await waitFor(() => state.events.some((e) => {
      if (e.kind !== kind) return false;
      if (!payloadMatch) return true;
      const flat = JSON.stringify(e.body);
      return flat.includes(payloadMatch);
    }), timeoutMs);
    if (!ok) throw new Error(`event ${kind} ${payloadMatch || ""} not seen within ${t || 30}s`);
    return;
  }
  const cmdM = line.match(/^SEND_COMMAND\s+(\S+)(?:\s+(.+))?$/);
  if (cmdM) {
    const [, action, rest] = cmdM;
    const params = rest ? JSON.parse(rest) : {};
    const out = await sendCommand(action, params);
    log("  result:", JSON.stringify(out).slice(0, 160));
    return;
  }
  if (line.startsWith("ASSERT no_errors")) {
    if (state.errors.length) throw new Error(`saw ${state.errors.length} errors`);
    return;
  }
  if (line.startsWith("SLEEP")) {
    const ms = parseInt(line.split(/\s+/)[1], 10);
    await new Promise((r) => setTimeout(r, ms));
    return;
  }
  throw new Error("unknown directive: " + line);
}

// --- REPL -----------------------------------------------------------------
function runRepl() {
  log("interactive mode — commands:");
  log("  cmd <action> <jsonParams>     send command");
  log("  event <kind> <jsonBody>       send event");
  log("  state                         show state");
  log("  quit");
  const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rl.on("line", async (line) => {
    line = line.trim();
    if (!line) return;
    try {
      if (line.startsWith("cmd ")) {
        const m = line.match(/^cmd\s+(\S+)(?:\s+(.+))?$/);
        const out = await sendCommand(m[1], m[2] ? JSON.parse(m[2]) : {});
        log("→", JSON.stringify(out));
      } else if (line.startsWith("event ")) {
        const m = line.match(/^event\s+(\S+)(?:\s+(.+))?$/);
        sendEvent(m[1], m[2] ? JSON.parse(m[2]) : {});
      } else if (line === "state") {
        log(JSON.stringify({ ready: state.ready, csReady: state.csReady, events: state.events.length, errors: state.errors.length, inflight: state.inflight.size }));
      } else if (line === "quit") process.exit(0);
      else log("?", line);
    } catch (e) { log("err:", e.message); }
  });
}
