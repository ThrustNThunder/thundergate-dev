// End-to-end test for the bridge surface: spin up the bridge on an ephemeral
// port, connect a fake extension over WS, exchange the hello/ready handshake,
// and round-trip a command + result.

import { WebSocket } from "ws";
import { BrowserBridge } from "../bridge/server.mjs";
import { randomUUID } from "node:crypto";

let fails = 0;
function ok(msg) { console.log("  ok  " + msg); }
function fail(msg) { console.log("  FAIL " + msg); fails++; }

const port = 17861 + Math.floor(Math.random() * 100);
const bridge = new BrowserBridge({ port });
bridge.start();
await new Promise((r) => setTimeout(r, 100));

const ws = new WebSocket(`ws://localhost:${port}/browser`, "thunderbrowser.v1");
const incoming = [];
let helloSeen = false;
ws.on("message", (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type === "event" && msg.body?.kind === "hello") helloSeen = true;
  if (msg.type === "command") {
    ws.send(JSON.stringify({ v: 1, id: randomUUID(), ts: Date.now(),
      type: "ack", ref: msg.id, scope: null, body: { received_at: Date.now() } }));
    ws.send(JSON.stringify({ v: 1, id: randomUUID(), ts: Date.now(),
      type: "result", ref: msg.id, scope: null,
      body: { echoed: msg.body, ok: true } }));
  }
  incoming.push(msg);
});

await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
  setTimeout(() => reject(new Error("open timeout")), 2000);
});
ok("ws open");

const helloOk = await waitFor(() => helloSeen, 1000);
if (helloOk) ok("got hello");
else fail("never got hello");

// Send ready.
ws.send(JSON.stringify({
  v: 1, id: randomUUID(), ts: Date.now(),
  type: "event", ref: null, scope: null,
  body: { kind: "ready", bundle: "test/0", ua: "test-ua" },
}));

await new Promise((r) => setTimeout(r, 50));
const sessions = bridge.listSessions();
if (sessions.length === 1) ok("session registered");
else fail("sessions: " + JSON.stringify(sessions));

function waitFor(pred, ms) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve(true);
      if (Date.now() - start > ms) return resolve(false);
      setTimeout(tick, 25);
    };
    tick();
  });
}

const result = await bridge.sendCommand({
  session_id: sessions[0].session_id,
  action: "ping",
  params: { hello: "world" },
});
if (result.ok && result.echoed.hello === "world") ok("command round-trip");
else fail("command round-trip: " + JSON.stringify(result));

ws.close();
await bridge.stop();
console.log(`\n${fails === 0 ? "PASS" : "FAIL"}: bridge.e2e (${fails} failures)`);
process.exit(fails === 0 ? 0 : 1);
