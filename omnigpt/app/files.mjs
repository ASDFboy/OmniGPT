// Reads any file for the agents: text, Office and OpenDocument files, PDFs, e-books, archives, images, audio, video,
// databases and programs. Nothing is executed. Unknown formats get a signature report and a hint to research a tool.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const MAX_READ = 64 * 1024 * 1024;
const kb = (n) => (n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB");
const xmlText = (s) => String(s).replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n)).replace(/&amp;/g, "&");
const RESEARCH = (ext) => `OmniGPT has no built-in reader for this format. Research a tool before guessing: web_search for "${ext || "this"} file format python library" (PyPI, GitHub), prefer a widely used, maintained package, install it with run_command: python -m pip install --user <package>, then write a script with write_file and run it with run_command. Never run downloaded programs.`;

// ---------- zip (docx, xlsx, pptx, odt, epub, jar, plain zip)
export function unzip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error("not a zip archive");
  const count = buf.readUInt16LE(e + 10), cdOff = buf.readUInt32LE(e + 16), entries = [];
  let p = cdOff;
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    entries.push({ name, size, csize, method, local });
    p += 46 + nlen + xlen + clen;
  }
  const read = (ent) => {
    if (ent.size > 50 * 1024 * 1024) throw new Error("entry too large");
    const l = ent.local, start = l + 30 + buf.readUInt16LE(l + 26) + buf.readUInt16LE(l + 28), data = buf.subarray(start, start + ent.csize);
    if (ent.method === 0) return data;
    if (ent.method === 8) return zlib.inflateRawSync(data);
    throw new Error("unsupported zip compression " + ent.method);
  };
  return { entries, get: (name) => { const ent = entries.find((x) => x.name === name); return ent ? read(ent).toString("utf8") : null; }, read };
}
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });

function docx(z) {
  const x = z.get("word/document.xml") || "";
  return xmlText(x.replace(/<w:tab\/>/g, "\t").replace(/<\/w:p>/g, "\n").replace(/<\/w:tc>/g, "\t").replace(/<w:br\/>/g, "\n")).replace(/\n{3,}/g, "\n\n").trim();
}
// every sheet of a workbook as rows of cell text (analyze_data turns them into CSV files)
export function xlsxSheets(buf, maxCells = 2000000) {
  const z = unzip(buf), shared = [...(z.get("xl/sharedStrings.xml") || "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1]));
  const names = [...(z.get("xl/workbook.xml") || "").matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => xmlText(m[1]));
  const col = (s) => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  let cells = 0;
  return z.entries.map((e) => e.name).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(natural).map((s, i) => {
    const rows = [];
    for (const r of (z.get(s) || "").matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const c of r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        if (++cells > maxCells) throw new Error("the workbook is too large to convert");
        const t = /t="(\w+)"/.exec(c[2] || ""), v = /<v>([\s\S]*?)<\/v>/.exec(c[3] || ""), is = /<is>([\s\S]*?)<\/is>/.exec(c[3] || "");
        row[col(c[1])] = t && t[1] === "s" && v ? shared[+v[1]] : is ? xmlText(is[1]) : v ? xmlText(v[1]) : "";
      }
      rows.push(Array.from(row, (x) => x ?? ""));
    }
    return { name: names[i] || "Sheet" + (i + 1), rows };
  });
}
function xlsx(z) {
  const shared = [...(z.get("xl/sharedStrings.xml") || "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1]));
  const names = [...(z.get("xl/workbook.xml") || "").matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => xmlText(m[1]));
  const sheets = z.entries.map((e) => e.name).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(natural);
  const out = [];
  sheets.slice(0, 5).forEach((s, i) => {
    const rows = [...(z.get(s) || "").matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)];
    out.push(`## Sheet: ${names[i] || "Sheet" + (i + 1)} (${rows.length} rows)`);
    for (const r of rows.slice(0, 60)) {
      const cells = [...r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((c) => {
        const t = /t="(\w+)"/.exec(c[2] || ""), v = /<v>([\s\S]*?)<\/v>/.exec(c[3] || ""), is = /<is>([\s\S]*?)<\/is>/.exec(c[3] || ""), f = /<f>([\s\S]*?)<\/f>/.exec(c[3] || "");
        let val = t && t[1] === "s" && v ? shared[+v[1]] : is ? xmlText(is[1]) : v ? xmlText(v[1]) : "";
        if (f) val += ` [=${xmlText(f[1])}]`;
        return c[1] + ":" + val;
      });
      out.push(cells.join(" | "));
    }
    if (rows.length > 60) out.push(`... ${rows.length - 60} more rows`);
  });
  return out.join("\n");
}
function pptx(z) {
  const slides = z.entries.map((e) => e.name).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(natural);
  return slides.map((s, i) => `## Slide ${i + 1}\n` + [...(z.get(s) || "").matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => xmlText(m[1])).join("\n")).join("\n\n");
}
const odf = (z) => xmlText((z.get("content.xml") || "").replace(/<\/text:(p|h)>/g, "\n").replace(/<\/table:table-cell>/g, "\t").replace(/<\/table:table-row>/g, "\n")).replace(/\n{3,}/g, "\n\n").trim();
function epub(z) {
  const pages = z.entries.map((e) => e.name).filter((n) => /\.x?html?$/i.test(n)).sort(natural);
  return pages.map((p) => xmlText((z.get(p) || "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<\/(p|h\d|div|li)>/gi, "\n"))).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------- pdf: plain text from the content streams (works for most generated PDFs; scanned ones need OCR)
function pdfString(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (m, c) => ({ n: "\n", r: "\r", t: "\t", b: "", f: "", "(": "(", ")": ")", "\\": "\\" }[c] ?? String.fromCharCode(parseInt(c, 8))));
}
function pdf(buf) {
  const raw = buf.toString("latin1"), pages = (raw.match(/\/Type\s*\/Page[^s]/g) || []).length, out = [];
  const re = /<<([\s\S]*?)>>\s*stream\r?\n/g; let m;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length, end = raw.indexOf("endstream", start); if (end < 0) break;
    let data = buf.subarray(start, end);
    if (/\/FlateDecode/.test(m[1])) { try { data = zlib.inflateSync(data); } catch { try { data = zlib.inflateRawSync(data.subarray(2)); } catch { continue; } } }
    else if (/\/Filter/.test(m[1])) continue;
    const s = data.toString("latin1"); if (!/\bBT\b/.test(s)) continue;
    for (const bt of s.match(/BT[\s\S]*?ET/g) || []) {
      let line = "";
      for (const t of bt.matchAll(/\((?:\\.|[^\\)])*\)\s*(?:Tj|'|")|\[((?:\\.|[^\]])*)\]\s*TJ|(T\*|Td|TD|Tm)/g)) {
        if (t[2]) { if (line.trim()) { out.push(line); line = ""; } continue; }
        const parts = t[1] !== undefined ? [...t[1].matchAll(/\((?:\\.|[^\\)])*\)|(-?\d+\.?\d*)/g)].map((p) => p[1] && +p[1] < -200 ? " " : p[1] ? "" : pdfString(p[0].slice(1, -1))) : [pdfString(t[0].replace(/\)\s*(Tj|'|")$/, "").slice(1))];
        line += parts.join("");
      }
      if (line.trim()) out.push(line);
    }
    if (out.join("\n").length > 200000) break;
  }
  return { pages, text: out.join("\n").replace(/[^\S\n]+/g, " ").trim() };
}

// ---------- media details from file headers
function image(buf, kind) {
  try {
    if (kind === "png") return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (kind === "gif") return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (kind === "bmp") return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
    if (kind === "webp") { const f = buf.toString("ascii", 12, 16); if (f === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }; if (f === "VP8L") { const b = buf.readUInt32LE(21); return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; } return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }; }
    if (kind === "jpeg") { let p = 2; while (p < buf.length) { if (buf[p] !== 0xff) { p++; continue; } const mk = buf[p + 1], len = buf.readUInt16BE(p + 2); if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return { height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7) }; p += 2 + len; } }
    if (kind === "ico") return { images: buf.readUInt16LE(4), width: buf[6] || 256, height: buf[7] || 256 };
  } catch {}
  return {};
}
function audio(buf, kind) {
  try {
    if (kind === "wav") { let p = 12, fmt = null; while (p + 8 <= buf.length) { const id = buf.toString("ascii", p, p + 4), sz = buf.readUInt32LE(p + 4); if (id === "fmt ") fmt = { channels: buf.readUInt16LE(p + 10), rate: buf.readUInt32LE(p + 12), byteRate: buf.readUInt32LE(p + 16), bits: buf.readUInt16LE(p + 22) }; if (id === "data" && fmt) return { ...fmt, seconds: +(sz / fmt.byteRate).toFixed(2) }; p += 8 + sz + (sz & 1); } return fmt || {}; }
    if (kind === "flac") { const rate = (buf.readUInt32BE(18) >>> 12), ch = ((buf[20] >> 1) & 7) + 1, total = ((buf[21] & 15) * 2 ** 32) + buf.readUInt32BE(22); return { rate, channels: ch, seconds: rate ? +(total / rate).toFixed(2) : null }; }
    if (kind === "mp4") { const i = buf.indexOf("mvhd"); if (i > 0) { const v = buf[i + 4], ts = v === 1 ? buf.readUInt32BE(i + 24) : buf.readUInt32BE(i + 16), d = v === 1 ? Number(buf.readBigUInt64BE(i + 28)) : buf.readUInt32BE(i + 20); return { brand: buf.toString("ascii", 8, 12), seconds: ts ? +(d / ts).toFixed(2) : null }; } return { brand: buf.toString("ascii", 8, 12) }; }
    if (kind === "mp3") { const tag = buf.toString("ascii", 0, 3) === "ID3"; const t = (id) => { const i = buf.indexOf(id); if (i < 0 || i > 4096) return null; const sz = buf.readUInt32BE(i + 4); return buf.toString("latin1", i + 11, i + 10 + sz).replace(/\0/g, "").trim() || null; }; return tag ? { title: t("TIT2"), artist: t("TPE1") } : {}; }
  } catch {}
  return {};
}
function tarList(b) {
  const L = [];
  for (let p = 0; p + 512 <= b.length && L.length < 150; ) {
    const name = b.toString("utf8", p, p + 100).replace(/\0.*$/s, ""); if (!name) break;
    const size = parseInt(b.toString("ascii", p + 124, p + 136).replace(/\0/g, "").trim() || "0", 8) || 0;
    L.push(`${name}  ${kb(size)}`); p += 512 + Math.ceil(size / 512) * 512;
  }
  return L.length + " entries:\n" + L.join("\n");
}
const SIGS = [
  ["tar", (b) => b.length > 262 && b.toString("ascii", 257, 262) === "ustar"],
  ["pdf", (b) => b.toString("ascii", 0, 5) === "%PDF-"], ["zip", (b) => b.readUInt32LE(0) === 0x04034b50 || b.readUInt32LE(0) === 0x06054b50],
  ["png", (b) => b.readUInt32BE(0) === 0x89504e47], ["jpeg", (b) => b[0] === 0xff && b[1] === 0xd8], ["gif", (b) => b.toString("ascii", 0, 3) === "GIF"],
  ["bmp", (b) => b.toString("ascii", 0, 2) === "BM"], ["webp", (b) => b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP"],
  ["wav", (b) => b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE"], ["avi", (b) => b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 11) === "AVI"],
  ["ico", (b) => b.readUInt32LE(0) === 0x00010000], ["flac", (b) => b.toString("ascii", 0, 4) === "fLaC"], ["ogg", (b) => b.toString("ascii", 0, 4) === "OggS"],
  ["mp3", (b) => b.toString("ascii", 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)], ["mp4", (b) => b.toString("ascii", 4, 8) === "ftyp"],
  ["mkv", (b) => b.readUInt32BE(0) === 0x1a45dfa3], ["gzip", (b) => b[0] === 0x1f && b[1] === 0x8b], ["7z", (b) => b.toString("hex", 0, 6) === "377abcaf271c"],
  ["rar", (b) => b.toString("ascii", 0, 4) === "Rar!"], ["sqlite", (b) => b.toString("ascii", 0, 15) === "SQLite format 3"], ["exe", (b) => b.toString("ascii", 0, 2) === "MZ"],
  ["rtf", (b) => b.toString("ascii", 0, 5) === "{\\rtf"], ["ole", (b) => b.toString("hex", 0, 8) === "d0cf11e0a1b11ae1"], ["psd", (b) => b.toString("ascii", 0, 4) === "8BPS"],
  ["tiff", (b) => ["49492a00", "4d4d002a"].includes(b.toString("hex", 0, 4))], ["woff", (b) => ["wOFF", "wOF2"].includes(b.toString("ascii", 0, 4))],
];
const looksText = (b) => { const s = b.subarray(0, 8192); if (s.includes(0) && !(s[0] === 0xff && s[1] === 0xfe) && !(s[0] === 0xfe && s[1] === 0xff)) return false; let bad = 0; for (const c of s) if (c < 9 || (c > 13 && c < 32)) bad++; return bad / Math.max(1, s.length) < 0.02; };
const decodeText = (b) => b[0] === 0xff && b[1] === 0xfe ? b.subarray(2).toString("utf16le") : b[0] === 0xfe && b[1] === 0xff ? Buffer.from(b.subarray(2)).swap16().toString("utf16le") : b.toString("utf8").replace(/^﻿/, "");

export function kindOf(buf, ext) {
  if (((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) && !/[\x00-\x08\x0e-\x1f]/.test(decodeText(buf.subarray(0, 4096)))) return "text"; // UTF-16 text, before the MP3 frame check
  for (const [k, test] of SIGS) { try { if (buf.length >= 4 && test(buf)) return k; } catch {} }
  return looksText(buf) ? "text" : "binary";
}

// Returns a readable report of the file. offset pages through long text.
export function inspect(abs, offset = 0) {
  const st = fs.statSync(abs);
  if (st.isDirectory()) return `Folder: ${abs}\n` + fs.readdirSync(abs).slice(0, 200).join("\n");
  if (st.size > MAX_READ) return `File: ${abs}\nSize: ${kb(st.size)}\nToo large to read here (over ${kb(MAX_READ)}). Use a streaming tool (for example a Python script) to process it.`;
  const buf = fs.readFileSync(abs), ext = path.extname(abs).slice(1).toLowerCase();
  let kind = kindOf(buf, ext), info = "", text = "", hint = "";
  try {
    if (kind === "zip") {
      const z = unzip(buf), names = z.entries.map((e) => e.name);
      if (names.includes("word/document.xml")) { kind = "Word document (docx)"; text = docx(z); }
      else if (names.includes("xl/workbook.xml")) { kind = "Excel workbook (xlsx)"; text = xlsx(z); }
      else if (names.includes("ppt/presentation.xml")) { kind = "PowerPoint presentation (pptx)"; text = pptx(z); }
      else if (names.includes("content.xml") && names.includes("mimetype")) { kind = "OpenDocument (" + (z.get("mimetype") || "").trim() + ")"; text = odf(z); }
      else if (names.includes("META-INF/container.xml") && names.some((n) => /\.x?html?$/i.test(n))) { kind = "EPUB e-book"; text = epub(z); }
      else { kind = ext === "jar" ? "Java archive (jar)" : "ZIP archive"; text = `${z.entries.length} entries:\n` + z.entries.slice(0, 150).map((e) => `${e.name}  ${kb(e.size)}`).join("\n"); hint = "To unpack it, use run_command: Expand-Archive -Path <file> -DestinationPath <folder>."; }
    } else if (kind === "pdf") {
      const p = pdf(buf); kind = "PDF document"; info = `Pages: ${p.pages}`; text = p.text;
      if (text.length < 20) hint = "No text layer could be read (the PDF may be scanned, encrypted, or use embedded font encodings). " + RESEARCH("pdf").replace("OmniGPT has no built-in reader for this format. ", "") + " (pypdf or pdfminer.six for text; an OCR tool for scans.)";
    } else if (["png", "jpeg", "gif", "bmp", "webp", "ico"].includes(kind)) {
      const d = image(buf, kind); kind = kind.toUpperCase() + " image"; info = d.width ? `Dimensions: ${d.width} x ${d.height} px` : "";
      hint = "The image content itself is shown to a vision model when the user attaches it. To edit or convert images, research and install a library such as Pillow.";
    } else if (["wav", "flac", "mp4", "mp3"].includes(kind)) {
      const d = audio(buf, kind); info = Object.entries(d).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${v}`).join(", ");
      kind = { wav: "WAV audio", flac: "FLAC audio", mp4: "MP4/MOV media", mp3: "MP3 audio" }[kind];
      hint = "Transcribing or editing media needs a tool (for example ffmpeg or a Python audio library); research and install one first.";
    } else if (kind === "gzip") {
      const inner = zlib.gunzipSync(buf, { maxOutputLength: 64 * 1024 * 1024 });
      if (inner.toString("ascii", 257, 262) === "ustar") { kind = "TAR.GZ archive"; text = tarList(inner); hint = "To unpack it, use run_command: tar -xzf <file> -C <folder>."; }
      else { kind = "GZIP file"; text = looksText(inner) ? decodeText(inner) : "(compressed binary data)"; }
    } else if (kind === "text" || kind === "rtf") {
      text = decodeText(buf);
      if (kind === "rtf") { kind = "RTF document"; text = text.replace(/\\par[d]?/g, "\n").replace(/\{\\\*[^{}]*\}|\\[a-z]+-?\d* ?|[{}]/gi, "").replace(/\n{3,}/g, "\n\n").trim(); }
      else if (buf.toString("ascii", 0, 4) === "ustar" || buf.toString("ascii", 257, 262) === "ustar") { kind = "TAR archive"; text = "(tar archive; unpack with run_command: tar -xf <file> -C <folder>)"; }
      else kind = "text (" + (ext || "no extension") + ")";
    } else if (kind === "tar") { kind = "TAR archive"; text = tarList(buf); hint = "To unpack it, use run_command: tar -xf <file> -C <folder>."; }
    else if (kind === "sqlite") { kind = "SQLite database"; info = `Page size: ${buf.readUInt16BE(16) === 1 ? 65536 : buf.readUInt16BE(16)} bytes`; text = "Tables: " + ([...buf.toString("latin1").matchAll(/CREATE TABLE\s+["`]?(\w+)/gi)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i).join(", ") || "(none found)"); hint = "Query it with Python's built-in sqlite3 module: write a script with write_file and run it with run_command."; }
    else if (kind === "exe") { kind = "Windows program or library (PE)"; const pe = buf.readUInt32LE(60); if (buf.toString("ascii", pe, pe + 4) === "PE\0\0") info = `Machine: 0x${buf.readUInt16LE(pe + 4).toString(16)}, built ${new Date(buf.readUInt32LE(pe + 8) * 1000).toISOString().slice(0, 10)}`; hint = "This is executable code. It was not run, and OmniGPT will not run it."; }
    else if (kind === "ole") { kind = "Legacy Office/OLE file (doc, xls, ppt or msg)"; text = (buf.toString("utf16le").match(/[\x20-\x7e -ɏ]{4,}/g) || []).join(" ").slice(0, 20000); hint = RESEARCH(ext) + " (olefile, or convert to the modern format.)"; }
    else if (kind === "7z" || kind === "rar") { kind = kind === "7z" ? "7-Zip archive" : "RAR archive"; hint = RESEARCH(ext) + " (for example py7zr or rarfile.)"; }
    else { if (kind !== "binary") kind = kind.toUpperCase() + " file"; hint = RESEARCH(ext); }
  } catch (e) { hint = `Reading this file failed (${e.message}). ` + RESEARCH(ext); }
  if (kind === "binary") { kind = "unknown binary (." + (ext || "no extension") + ")"; info = "First bytes: " + buf.subarray(0, 32).toString("hex").replace(/(..)/g, "$1 ").trim(); }
  const WIN = 12000, body = text.slice(offset, offset + WIN);
  return [`File: ${abs}`, `Type: ${kind}`, `Size: ${kb(st.size)}, modified ${st.mtime.toISOString().slice(0, 16).replace("T", " ")}`, info,
    text ? `Content${text.length > WIN ? ` (characters ${offset}-${Math.min(text.length, offset + WIN)} of ${text.length}; call again with offset ${offset + WIN} for more)` : ""}:\n${body}` : "", hint && "Note: " + hint].filter(Boolean).join("\n");
}

export const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml", pdf: "application/pdf", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" };
export const RUNNABLE = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|hta|cpl|lnk|jar|reg|url|pif|appx|msix|py|pyw)$/i;
