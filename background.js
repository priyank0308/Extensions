// ── background.js ─────────────────────────────────────────────────────────────
// Duration Counter — listens for duration events from content.js.

// ── Storage helpers ───────────────────────────────────────────────────────────

const getStore = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));
const setStore = (obj)  => new Promise((r) => chrome.storage.local.set(obj, r));
const notifyPopup = () => chrome.runtime.sendMessage({ action: "counterUpdated" }).catch(() => {});

// ── Duration counter ──────────────────────────────────────────────────────────
// Total kept in ms. Each task is counted once until Reset.
// Chain ensures concurrent messages never overwrite each other.

let durationChain = Promise.resolve();

function countDuration(number, durationMs) {
  durationChain = durationChain
    .then(() => addDuration(number, durationMs))
    .catch(console.error);
  return durationChain;
}

async function addDuration(number, durationMs) {
  const d   = await getStore(["durationLog", "totalMs"]);
  const log = d.durationLog || [];

  if (durationMs == null) return;                      // no audio — skip silently

  const existing = log.find((e) => e.number === number);
  if (existing) {
    // A task that earlier failed to detect gets its real duration once it loads.
    if (existing.failed) {
      existing.ms = durationMs;
      delete existing.failed;
      await setStore({ durationLog: log, totalMs: (d.totalMs || 0) + durationMs });
    }
    return;                                            // already counted
  }

  log.push({ number, ms: durationMs });
  await setStore({ durationLog: log, totalMs: (d.totalMs || 0) + durationMs });
}

// Task id was detected but its duration could not be read: keep the id in the
// log, marked as failed, with no time added to the total.
async function logFailure(number) {
  const d   = await getStore(["durationLog"]);
  const log = d.durationLog || [];
  if (log.some((e) => e.number === number)) return;
  log.push({ number, ms: null, failed: true });
  await setStore({ durationLog: log });
}

// ── Remove duration (Draft) ───────────────────────────────────────────────────
// Called when the user clicks DRAFT — undoes the count for that task.

async function removeDuration(number) {
  const d   = await getStore(["durationLog", "totalMs"]);
  const log = d.durationLog || [];
  const idx = log.findIndex((e) => e.number === number);
  if (idx === -1) return;                               // not in log — nothing to do
  const removed = log.splice(idx, 1)[0];
  const newTotal = Math.max(0, (d.totalMs || 0) - (removed.ms || 0));
  await setStore({ durationLog: log, totalMs: newTotal });
}

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "durationDetected") {
    countDuration(msg.number, msg.duration)
      .then(() => notifyPopup())
      .catch(console.error);
    return false;
  }

  if (msg.action === "durationFailed") {
    durationChain = durationChain
      .then(() => logFailure(msg.number))
      .then(() => notifyPopup())
      .catch(console.error);
    return false;
  }

  if (msg.action === "draftClicked") {
    // Chain through durationChain so it never races with a concurrent addDuration write
    durationChain = durationChain
      .then(() => removeDuration(msg.number))
      .then(() => notifyPopup())
      .catch(console.error);
    return false;
  }
});
