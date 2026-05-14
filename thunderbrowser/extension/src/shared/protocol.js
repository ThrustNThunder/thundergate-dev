// ThunderBrowser wire protocol — shared between SW, CS, mock TG, and real bridge.
// Envelope shape per THUNDERBROWSER_EXTENSION_DESIGN.md §2.1.

export const PROTOCOL_VERSION = 1;
export const SUBPROTOCOL = "thunderbrowser.v1";

export function envelope({ type, body, id, ref = null, scope = null, ts = Date.now() }) {
  if (!type) throw new Error("envelope: type required");
  return {
    v: PROTOCOL_VERSION,
    id: id ?? uuid(),
    ts,
    type,
    scope,
    ref,
    body: body ?? {},
  };
}

export function validateEnvelope(msg) {
  if (!msg || typeof msg !== "object") return "not_object";
  for (const k of ["v", "id", "ts", "type"]) {
    if (!(k in msg)) return `missing_${k}`;
  }
  if (msg.v !== PROTOCOL_VERSION) return "version_mismatch";
  if (!["command", "result", "event", "ack", "error"].includes(msg.type)) return "bad_type";
  return null;
}

export function uuid() {
  // Use crypto.randomUUID when available (SW, modern Node).
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Canonical JSON: sorted keys, no whitespace. Used for hash inputs and signatures.
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

// SHA-256 hex digest. Works in SW (SubtleCrypto) and Node (web crypto polyfill in v22+).
export async function sha256Hex(input) {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
