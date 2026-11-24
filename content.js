// ── content.js ───────────────────────────────────────────────────────────────
// Runs on prodbsmt.shaip.com — detects new tasks by URL change,
// reads the audio duration, and sends it to the background worker.

let lastDetected = null;
let lastEndText  = null;
let draftedId    = null;   // id just drafted; ignored while the URL still shows it
const retries    = {};     // timeouts per task id (slow-network retries)
const MAX_RETRIES = 3;

const IS_SHAIP = location.hostname === "prodbsmt.shaip.com";

function getLastDigits(url) {
  const path = new URL(url).pathname;
  const matches = path.match(/\d{8}/g);
  return matches ? matches[matches.length - 1] : null;
}

// ── Duration detection ────────────────────────────────────────────────────────
// Uses a generation counter so DRAFT (or a new task) can cancel any
// in-progress detectDuration without racing with the next call.

let detectGen = 0;   // incremented every time we want to cancel the current run

function parseEndTime(text) {
  const m = (text || "").trim().match(/^(\d+):(\d{1,3})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 1000 + parseInt(m[2].padEnd(3, "0"), 10);
}

function readEndTime() {
  const el = document.querySelector("app-audio .endTime") || document.querySelector(".endTime");
  return el ? el.textContent.trim() : null;
}

const TIMEOUT = "timeout";            // resolve value when audio never loaded in time

// Slow-network friendly: waits up to 60s for the audio player to show its
// length, and only accepts a value that is stable across two reads so a
// half-loaded player can't give a wrong number.
// A value identical to the previous task's is treated as "old player still on
// screen" for the first 12s, then accepted (the new task may truly be the same length).
function detectDuration(timeoutMs = 60000, staleWaitMs = 12000) {
  const myGen = ++detectGen;           // claim this generation
  return new Promise((resolve) => {
    const start = Date.now();
    let prevText = null, stable = 0;
    const tryRead = () => {
      if (detectGen !== myGen) return resolve(null);  // cancelled — a newer call took over
      const text = readEndTime();
      const ms   = parseEndTime(text);
      if (ms && ms > 0) {
        stable   = (text === prevText) ? stable + 1 : 1;
        prevText = text;
        const fresh = text !== lastEndText || Date.now() - start > staleWaitMs;
        if (fresh && stable >= 2) {
          lastEndText = text;
          return resolve(ms);
        }
      } else {
        prevText = null;
        stable   = 0;
      }
      if (Date.now() - start >= timeoutMs) return resolve(TIMEOUT);
      setTimeout(tryRead, 300);
    };
    tryRead();
  });
}

// ── On-page duration badge ────────────────────────────────────────────────────

function formatTotal(ms) {
  const cs = Math.round((ms || 0) / 10);
  const h  = Math.floor(cs / 360000);
  const m  = Math.floor((cs % 360000) / 6000);
  const s  = (cs % 6000) / 100;
  return `${h}h ${m}m ${s.toFixed(2)}s`;
}

// ── Shared look (matches the dark "timer bar" toast) ─────────────────────────
const UI_FONT  = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const UI_GREEN = "#5bd47f";
const UI_AMBER = "#ffb040";
const ICON_CLOCK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
const ICON_UNDO  = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/></svg>';
const ICON_WARN  = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg>';
const REDUCE_MOTION = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

// ── On-page total badge ───────────────────────────────────────────────────────

let badgeEl = null, badgeTotalEl = null, badgeCountEl = null;

function renderBadge(totalMs, taskCount) {
  if (!badgeEl) {
    badgeEl = document.createElement("div");
    Object.assign(badgeEl.style, {
      position: "fixed", bottom: "36px", left: "20px", zIndex: 2147483646,
      display: "inline-flex", alignItems: "center", gap: "12px",
      color: "#fff", height: "45px", boxSizing: "border-box", padding: "0 18px 0 16px",
      background: "rgba(16,20,24,.88)", backdropFilter: "blur(16px) saturate(1.6)",
    WebkitBackdropFilter: "blur(16px) saturate(1.6)", border: "1px solid rgba(255,255,255,.14)",
      borderRadius: "12px", font: `600 15px/1.2 ${UI_FONT}`,
      boxShadow: "0 8px 24px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.08)", pointerEvents: "none",
    });

    const ic = document.createElement("span");
    ic.innerHTML = ICON_CLOCK;
    Object.assign(ic.style, { display: "grid", placeItems: "center", color: UI_GREEN });

    badgeTotalEl = document.createElement("span");
    badgeTotalEl.style.fontVariantNumeric = "tabular-nums";

    const sep = document.createElement("span");
    Object.assign(sep.style, { width: "1px", height: "14px", background: "rgba(255,255,255,.25)" });

    badgeCountEl = document.createElement("span");
    Object.assign(badgeCountEl.style, { fontWeight: "400", opacity: ".7", fontSize: "13px" });

    badgeEl.append(ic, badgeTotalEl, sep, badgeCountEl);
    document.body.appendChild(badgeEl);
  }
  badgeTotalEl.textContent = formatTotal(totalMs);
  badgeCountEl.textContent = `${taskCount} task${taskCount === 1 ? "" : "s"}`;
}

function refreshBadge() {
  chrome.storage.local.get(["totalMs", "durationLog"], (d) => {
    renderBadge(d.totalMs || 0, (d.durationLog || []).length);
  });
}

if (IS_SHAIP) {
  refreshBadge();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.totalMs || changes.durationLog)) refreshBadge();
  });
}

// ── Toast ─────────────────────────────────────────────────────────────────────

let toastBox = null;

// kind: "ok" (counted) | "rm" (removed) | "fail" (could not read duration)
function showToast(kind, title, sub, showMs = 2500) {
  if (!toastBox || !toastBox.isConnected) {
    toastBox = document.createElement("div");
    Object.assign(toastBox.style, {
      position: "fixed", bottom: "89px", left: "20px", zIndex: 2147483647,
      display: "flex", flexDirection: "column-reverse", gap: "8px",
      alignItems: "flex-start", pointerEvents: "none",
    });
    document.body.appendChild(toastBox);
  }

  const accent = kind === "ok" ? UI_GREEN : UI_AMBER;
  const SHOW_MS = showMs;

  const el = document.createElement("div");
  Object.assign(el.style, {
    position: "relative", overflow: "hidden", display: "inline-flex",
    alignItems: "center", gap: "10px", color: "#fff",
    background: "rgba(16,20,24,.88)", backdropFilter: "blur(16px) saturate(1.6)",
    WebkitBackdropFilter: "blur(16px) saturate(1.6)", border: "1px solid rgba(255,255,255,.14)",
    padding: "11px 18px 14px 14px", borderRadius: "12px",
    font: `14px/1.3 ${UI_FONT}`, boxShadow: "0 8px 24px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.08)",
  });

  const ic = document.createElement("span");
  ic.innerHTML = kind === "rm" ? ICON_UNDO : kind === "fail" ? ICON_WARN : ICON_CLOCK;
  Object.assign(ic.style, { display: "grid", placeItems: "center", color: accent });

  const tx = document.createElement("div");
  const t1 = document.createElement("b");
  t1.textContent = title;
  Object.assign(t1.style, { display: "block", fontSize: "14px", fontWeight: "600", fontVariantNumeric: "tabular-nums" });
  const t2 = document.createElement("span");
  t2.textContent = sub;
  Object.assign(t2.style, { display: "block", fontSize: "12px", opacity: ".7" });
  tx.append(t1, t2);

  const bar = document.createElement("i");
  Object.assign(bar.style, {
    position: "absolute", left: "0", bottom: "0", height: "3px", width: "100%",
    background: accent, transformOrigin: "left",
  });

  el.append(ic, tx, bar);
  toastBox.appendChild(el);

  if (!REDUCE_MOTION && el.animate) {
    el.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }],
               { duration: 280, easing: "cubic-bezier(.2,.8,.3,1)" });
    bar.animate([{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }],
                { duration: SHOW_MS, easing: "linear", fill: "forwards" });
  }

  setTimeout(() => {
    if (!REDUCE_MOTION && el.animate) {
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: "forwards" })
        .onfinish = () => el.remove();
    } else {
      el.remove();
    }
  }, SHOW_MS);
}

// ── Main check ────────────────────────────────────────────────────────────────

async function check() {
  if (!IS_SHAIP) return;

  const digits = getLastDigits(location.href);

  // A drafted id is fully forgotten. While the page still shows that id we
  // must not re-count it; as soon as the URL moves away, the id is free to be
  // counted again if the user starts it later.
  if (draftedId) {
    if (digits === draftedId) return;
    draftedId = null;
  }

  if (!digits) return;

  // In-memory guard: same URL polled again
  if (digits === lastDetected) return;

  // Persistent guard: skip if same as very last job (survives page refresh)
  // Check storage BEFORE setting lastDetected so a storage-blocked task
  // can still be retried on the next poll cycle.
  const stored = await new Promise((r) => chrome.storage.local.get("lastNumber", r));
  if (stored.lastNumber === digits) {
    lastDetected = digits;   // suppress further polls for this URL
    return;
  }

  lastDetected = digits;   // commit only after all guards pass

  // Cancel any previous detectDuration, then start fresh for this task
  const capturedDigits = digits;
  detectDuration().then(async (duration) => {
    if (duration == null) return;   // cancelled by a newer task / DRAFT

    if (duration === TIMEOUT) {
      retries[capturedDigits] = (retries[capturedDigits] || 0) + 1;

      // First failure: save the task id in the log as "fail to detect duration"
      // and tell the user for 10 seconds.
      if (retries[capturedDigits] === 1) {
        try { chrome.runtime.sendMessage({ action: "durationFailed", number: capturedDigits }); } catch (e) {}
        showToast("fail", capturedDigits, "fail to detect duration", 10000);
      }

      // Keep trying quietly while the user is still on this task. If the audio
      // finally loads, the background upgrades the failed entry to the real duration.
      const stillHere = getLastDigits(location.href) === capturedDigits && draftedId !== capturedDigits;
      if (stillHere && retries[capturedDigits] <= MAX_RETRIES) lastDetected = null;
      return;
    }

    try {
      chrome.runtime.sendMessage({ action: "durationDetected", number: capturedDigits, duration });
    } catch (e) { return; }
    // Remember this id only now, after a successful read, so a refresh or a
    // slow load in the middle can never mark a task as "seen" without counting it.
    chrome.storage.local.set({ lastNumber: capturedDigits });
    showToast("ok", `+${duration.toLocaleString("en-US")} ms`, `Task ${capturedDigits}`);
  });
}

// Initial check + poll for SPA URL changes
check();
setInterval(check, 1000);

// ── DRAFT button listener ─────────────────────────────────────────────────────

function onDraftClicked() {
  const digits = getLastDigits(location.href);
  if (!digits) return;

  // Cancel any in-progress detectDuration for this task by bumping the generation.
  // The pending promise will resolve with null and send nothing to background.
  detectGen++;

  chrome.runtime.sendMessage({ action: "draftClicked", number: digits });

  // Forget this id completely (in-memory + stored last id) so that starting
  // the same id again later is detected and counted as a fresh task.
  // draftedId stops the 1-second poll from re-counting it while the page
  // is still on this URL.
  draftedId    = digits;
  lastDetected = null;
  chrome.storage.local.get("lastNumber", (d) => {
    if (d.lastNumber === digits) chrome.storage.local.remove("lastNumber");
  });

  showToast("rm", "Task removed", digits);
}

// Attach to DRAFT button — uses MutationObserver because Angular renders it dynamically.
// Debounced so the observer doesn't run on every single DOM mutation (waveform etc.)
function attachDraftListener() {
  document.querySelectorAll("button .mat-button-wrapper").forEach((span) => {
    if (span.textContent.trim() === "DRAFT" && !span._draftListened) {
      span._draftListened = true;
      span.closest("button").addEventListener("click", onDraftClicked);
    }
  });
}

if (IS_SHAIP) {
  attachDraftListener();
  let debounceTimer = null;
  new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(attachDraftListener, 300);
  }).observe(document.body, { childList: true, subtree: true });
}
