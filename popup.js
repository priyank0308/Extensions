// ── Helpers ───────────────────────────────────────────────────────────────────

// Format milliseconds → "0h 31m 58.78s"
function fmtHMS(ms) {
  const cs = Math.round((ms || 0) / 10);   // centiseconds
  const h  = Math.floor(cs / 360000);
  const m  = Math.floor((cs % 360000) / 6000);
  const s  = (cs % 6000) / 100;
  return `${h}h ${m}m ${s.toFixed(2)}s`;
}

// ── Load & render ─────────────────────────────────────────────────────────────

function loadAll() {
  chrome.storage.local.get(["durationLog", "totalMs"], (data) => {
    const dlog = data.durationLog || [];

    document.getElementById("totalDuration").textContent = fmtHMS(data.totalMs);
    document.getElementById("taskCount").textContent = dlog.length;
    document.getElementById("durList").innerHTML = dlog.length
      ? dlog.slice().reverse()
          .map((e) => e.ms == null
            ? `${e.number} → fail to detect duration`
            : `${e.number} → ${(e.ms / 1000).toFixed(3)} s`)
          .join("<br>")
      : "No audio counted yet.";
  });
}

const ICON_DL = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/></svg>';
const ICON_OK = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>';

// ── Export Data (Excel) ───────────────────────────────────────────────────────

document.getElementById("exportBtn").addEventListener("click", () => {
  chrome.storage.local.get(["durationLog", "totalMs"], (data) => {
    const entries = data.durationLog || [];
    if (!entries.length) {
      alert("Nothing to export yet – no task durations have been counted.");
      return;
    }

    const bytes = buildDurationXlsx(entries, fmtHMS(data.totalMs));
    const blob  = new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    // File name: TR_Report_19 Nov 2026_10:30:32 PM.xlsx
    const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const d    = new Date();
    const p2   = (n) => String(n).padStart(2, "0");
    const hr24 = d.getHours();
    const hr12 = hr24 % 12 || 12;
    const ampm = hr24 < 12 ? "AM" : "PM";
    const name = `TR_Report_${p2(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` +
                 `_${p2(hr12)}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${ampm}.xlsx`;

    const url = URL.createObjectURL(blob);
    const a   = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);

    const btn = document.getElementById("exportBtn");
    btn.innerHTML = ICON_OK + "<span>Exported!</span>";
    setTimeout(() => (btn.innerHTML = ICON_DL + "<span>Export (Excel)</span>"), 1500);
  });
});

// ── Reset ─────────────────────────────────────────────────────────────────────

document.getElementById("resetBtn").addEventListener("click", () => {
  if (!confirm("Reset total duration and task list?")) return;
  // Remove lastNumber entirely so the first task after reset is never skipped
  chrome.storage.local.remove("lastNumber", () => {
    chrome.storage.local.set({ totalMs: 0, durationLog: [] }, loadAll);
  });
});

// ── Listen for updates from background ───────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "counterUpdated") loadAll();
});

// ── Init ──────────────────────────────────────────────────────────────────────

loadAll();
