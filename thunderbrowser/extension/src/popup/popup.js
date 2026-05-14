async function refresh() {
  const status = await chrome.runtime.sendMessage({ kind: "status" });
  const pill = document.getElementById("status");
  if (status?.paused) {
    pill.className = "pill paused";
    pill.textContent = "paused";
  } else if (status?.connected) {
    pill.className = "pill ok";
    pill.textContent = "connected";
  } else {
    pill.className = "pill bad";
    pill.textContent = "disconnected";
  }
  document.getElementById("endpoint").textContent = status?.endpoint || "(no endpoint)";
  document.getElementById("queue").textContent =
    `queue: ${status?.queueDepth ?? 0}  audit pending: ${status?.auditPending ?? 0}`;
  document.getElementById("pause").textContent = status?.paused ? "Resume" : "Pause";
}

document.getElementById("reconnect").onclick = async () => {
  await chrome.runtime.sendMessage({ kind: "reconnect" });
  refresh();
};

document.getElementById("pause").onclick = async () => {
  const status = await chrome.runtime.sendMessage({ kind: "status" });
  await chrome.runtime.sendMessage({ kind: status?.paused ? "resume" : "pause" });
  refresh();
};

document.getElementById("options").onclick = () => {
  chrome.runtime.openOptionsPage();
};

refresh();
setInterval(refresh, 2000);
