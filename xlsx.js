// ── xlsx.js ─────────────────────────────────────────────────────────────────
// Builds a real .xlsx (Excel) file inside the extension – no libraries, no internet.
// An .xlsx is just a ZIP of small XML files, so we write those XML files and
// pack them into a ZIP ("store" mode = no compression, which Excel accepts).

// ── ZIP writer ───────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(files) {                       // files: [{ name, data(string) }]
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  const chunks = [];
  const central = [];
  let offset = 0;

  const u16 = (v) => [v & 255, (v >>> 8) & 255];
  const u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];

  for (const f of files) {
    const name = enc.encode(f.name);
    const data = enc.encode(f.data);
    const crc  = crc32(data);

    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(dosTime), ...u16(dosDate), ...u32(crc),
      ...u32(data.length), ...u32(data.length),
      ...u16(name.length), ...u16(0),
    ]);
    chunks.push(local, name, data);

    central.push(new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(dosTime), ...u16(dosDate), ...u32(crc),
      ...u32(data.length), ...u32(data.length),
      ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset),
    ]), name);

    offset += local.length + name.length + data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length),
    ...u32(centralSize), ...u32(offset), ...u16(0),
  ]);

  const parts = [...chunks, ...central, end];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

// ── Excel sheet ──────────────────────────────────────────────────────────────

const xmlEsc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const cText = (ref, text, style) =>
  `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t>${xmlEsc(text)}</t></is></c>`;
const cNum = (ref, num, style) =>
  `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${num}</v></c>`;
const cSum = (ref, formula, cached, style) =>
  `<c r="${ref}"${style ? ` s="${style}"` : ""}><f>${formula}</f><v>${cached}</v></c>`;

// entries: [{ number: "21223707", ms: 8992 }, ...]   totalLabel: e.g. "0h 0m 15.62s"
function buildDurationXlsx(entries, totalLabel) {
  const n    = entries.length;
  const last = n + 1;                                   // last data row (row 1 = header)
  const tot  = n + 2;                                   // total row
  const sum  = entries.reduce((s, e) => s + (e.ms || 0), 0);

  let rows = `<row r="1">${cText("A1", "No.", 1)}${cText("B1", "Job ID", 1)}` +
             `${cText("C1", "Duration (ms)", 1)}${cText("D1", "Duration (sec)", 1)}</row>`;

  entries.forEach((e, i) => {
    const r = i + 2;
    const dur = e.ms == null
      ? `${cText("C" + r, "fail to detect duration", 0)}${cText("D" + r, "fail to detect duration", 0)}`
      : `${cNum("C" + r, e.ms)}${cNum("D" + r, e.ms / 1000, 3)}`;
    rows += `<row r="${r}">${cNum("A" + r, i + 1)}${cNum("B" + r, e.number)}${dur}</row>`;
  });

  rows += `<row r="${tot}">${cText("A" + tot, "Total", 2)}${cText("B" + tot, `${n} jobs`, 2)}` +
          `${cSum("C" + tot, `SUM(C2:C${last})`, sum, 2)}` +
          `${cSum("D" + tot, `SUM(D2:D${last})`, sum / 1000, 4)}</row>`;
  rows += `<row r="${tot + 1}">${cText("A" + (tot + 1), "Total time", 2)}` +
          `${cText("B" + (tot + 1), totalLabel, 2)}</row>`;

  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<cols><col min="1" max="1" width="8" customWidth="1"/><col min="2" max="2" width="14" customWidth="1"/>` +
    `<col min="3" max="4" width="18" customWidth="1"/></cols>` +
    `<sheetData>${rows}</sheetData></worksheet>`;

  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<numFmts count="1"><numFmt numFmtId="164" formatCode="0.000"/></numFmts>` +
    `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>` +
    `<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="5">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +                                   // 0 normal
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +                       // 1 header
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +                       // 2 bold
    `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +             // 3 0.000
    `<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>` + // 4 bold 0.000
    `</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

  return zipStore([
    { name: "[Content_Types].xml", data:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      `</Types>` },
    { name: "_rels/.rels", data:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>` },
    { name: "xl/workbook.xml", data:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="Job Durations" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>` },
    { name: "xl/styles.xml", data: styles },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
  ]);
}

if (typeof module !== "undefined") module.exports = { buildDurationXlsx, zipStore, crc32 };
