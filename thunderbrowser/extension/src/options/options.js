const ALLOWLIST_DISPLAY = [
  "http://localhost:7860/*",
  "https://*.aa.com/*",
];

async function init() {
  const { tb_endpoint } = await chrome.storage.local.get(["tb_endpoint"]);
  document.getElementById("endpoint").value = tb_endpoint || "ws://localhost:7861/browser";
  document.getElementById("allowlist").textContent = ALLOWLIST_DISPLAY.join("\n");

  // Read recent audit records straight from IDB.
  try {
    const db = await openDb();
    const tx = db.transaction("audit", "readonly");
    const store = tx.objectStore("audit");
    const idx = store.index("by_ts");
    const recent = [];
    await new Promise((resolve) => {
      const req = idx.openCursor(null, "prev");
      req.onsuccess = () => {
        const c = req.result;
        if (!c || recent.length >= 10) return resolve();
        recent.push(c.value);
        c.continue();
      };
    });
    document.getElementById("audit").textContent = recent.length
      ? recent.map((r) => `${new Date(r.ts).toISOString()}  ${r.action}  ${r.result?.ok ? "ok" : "fail"}  hash=${r.hash.slice(0,12)}`).join("\n")
      : "(no audit records yet)";
  } catch (e) {
    document.getElementById("audit").textContent = "audit unavailable: " + e.message;
  }
}

document.getElementById("save").onclick = async () => {
  const endpoint = document.getElementById("endpoint").value.trim();
  await chrome.runtime.sendMessage({ kind: "set_endpoint", endpoint });
};

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("thunderbrowser", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("audit")) {
        const s = db.createObjectStore("audit", { keyPath: "action_id" });
        s.createIndex("by_ts", "ts");
        s.createIndex("by_acked", "server_acked");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

init();
