// Built with Claude (Anthropic) - see CREDITS.md
// Builds real sample files of many formats and checks that OmniGPT's file reader understands each one.
// Run: node files-test.mjs [folder]   (the folder is kept so the samples can be reused for end-to-end tests)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = ["app", "OmniGPT"].map((d) => path.resolve(here, "..", "..", d)).find((d) => fs.existsSync(path.join(d, "server.mjs"))); // repository layout or development layout
const { inspect } = await import(pathToFileURL(path.join(appDir, "files.mjs")).href);
const dir = process.argv[2] || path.join(os.tmpdir(), "omnigpt-file-samples");
fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
const put = (name, data) => { const p = path.join(dir, name); fs.writeFileSync(p, data); return p; };

// ---------- tiny writers
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(files) { // [name, string|Buffer]
  const locals = [], central = []; let off = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content), comp = zlib.deflateRawSync(data), n = Buffer.from(name), c = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(c, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(c, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, comp); central.push(ch, n); off += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb, y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function pdfDoc(text, compress) {
  const content = Buffer.from(`BT /F1 18 Tf 72 720 Td (${text}) Tj 0 -24 Td [(Second) -300 (line)] TJ ET`);
  const body = compress ? zlib.deflateSync(content) : content;
  const objs = [`<< /Type /Catalog /Pages 2 0 R >>`, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`, null, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`];
  const parts = [Buffer.from("%PDF-1.4\n")], offs = [];
  objs.forEach((o, i) => { offs.push(parts.reduce((s, b) => s + b.length, 0)); if (o) parts.push(Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`)); else parts.push(Buffer.from(`${i + 1} 0 obj\n<< /Length ${body.length}${compress ? " /Filter /FlateDecode" : ""} >>\nstream\n`), body, Buffer.from("\nendstream\nendobj\n")); });
  const xref = parts.reduce((s, b) => s + b.length, 0);
  parts.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(parts);
}
// a PDF like Word, Chrome or Apache FOP make: two-byte glyph codes in hex strings, text only through the font's ToUnicode map
function cidPdf(text) {
  const chars = [...new Set(text)], code = (c) => (chars.indexOf(c) + 3).toString(16).padStart(4, "0");
  const hex = (s) => "<" + [...s].map(code).join("") + ">";
  const content = zlib.deflateSync(Buffer.from(`BT /F1 12 Tf 72 720 Td ${hex(text.slice(0, 5))} Tj [${hex(text.slice(5))}] TJ ET`));
  const cmap = zlib.deflateSync(Buffer.from(`/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange ${chars.length} beginbfchar ${chars.map((c) => `<${code(c)}> <${c.charCodeAt(0).toString(16).padStart(4, "0")}>`).join(" ")} endbfchar endcmap end end`));
  const objs = [`<< /Type /Catalog /Pages 2 0 R >>`, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`, `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`, content, `<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Arial /Encoding /Identity-H /ToUnicode 6 0 R >>`, cmap];
  const parts = [Buffer.from("%PDF-1.7\n")];
  objs.forEach((o, i) => parts.push(Buffer.isBuffer(o) ? Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< /Length ${o.length} /Filter /FlateDecode >>\nstream\n`), o, Buffer.from("\nendstream\nendobj\n")]) : Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`)));
  parts.push(Buffer.from("trailer << /Root 1 0 R >>\n%%EOF\n"));
  return Buffer.concat(parts);
}
function tar(files) {
  const out = [];
  for (const [name, content] of files) { const d = Buffer.from(content), h = Buffer.alloc(512); h.write(name, 0); h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116); h.write(d.length.toString(8).padStart(11, "0") + "\0", 124); h.write("00000000000\0", 136); h.write("        ", 148); h.write("0", 156); h.write("ustar\0", 257); h.write("00", 263);
    let s = 0; for (const b of h) s += b; h.write(s.toString(8).padStart(6, "0") + "\0 ", 148); out.push(h, d, Buffer.alloc((512 - (d.length % 512)) % 512)); }
  out.push(Buffer.alloc(1024)); return Buffer.concat(out);
}
const wav = () => { const rate = 8000, n = rate, h = Buffer.alloc(44); h.write("RIFF", 0); h.writeUInt32LE(36 + n * 2, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(n * 2, 40); return Buffer.concat([h, Buffer.alloc(n * 2)]); };
const box = (t, d) => { const h = Buffer.alloc(8); h.writeUInt32BE(8 + d.length); h.write(t, 4); return Buffer.concat([h, d]); };
const mp4 = () => { const mv = Buffer.alloc(100); mv.writeUInt32BE(1000, 12); mv.writeUInt32BE(12500, 16); return Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isom")), box("moov", box("mvhd", mv))]); };
const id3 = () => { const title = Buffer.from("\0Marker Song"), fr = Buffer.alloc(10); fr.write("TIT2"); fr.writeUInt32BE(title.length, 4); const tag = Buffer.concat([fr, title]); const h = Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x00", "latin1"); h[9] = tag.length; return Buffer.concat([h, tag, Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(400)]); };
const W = (t) => `<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>${t}</w:t></w:r></w:p><w:p><w:r><w:t>Paragraph two</w:t></w:r></w:p></w:body></w:document>`;

// ---------- samples: [file, contents, text the reader must report]
const MARK = "ZEBRA-4471";
const cases = [
  ["notes.txt", `Plain text with ${MARK} and unicode: café, 東京`, MARK],
  ["utf16.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`UTF-16 text ${MARK}`, "utf16le")]), MARK],
  ["readme.md", `# Title\n\n- item ${MARK}`, MARK],
  ["data.csv", `name,score\nalice,${MARK}\nbob,7`, MARK],
  ["data.json", JSON.stringify({ key: MARK, n: [1, 2] }), MARK],
  ["config.yaml", `server:\n  name: ${MARK}`, MARK], ["settings.ini", `[main]\nname=${MARK}`, MARK],
  ["page.html", `<html><body><h1>${MARK}</h1></body></html>`, MARK], ["feed.xml", `<feed><title>${MARK}</title></feed>`, MARK],
  ["script.py", `print("${MARK}")`, MARK], ["app.js", `console.log("${MARK}")`, MARK], ["style.css", `/* ${MARK} */ body{}`, MARK],
  ["Main.java", `class Main { String s = "${MARK}"; }`, MARK], ["app.log", `2026-10-08 INFO ${MARK}`, MARK], ["drawing.svg", `<svg xmlns="http://www.w3.org/2000/svg"><text>${MARK}</text></svg>`, MARK],
  ["memo.rtf", `{\\rtf1\\ansi{\\fonttbl\\f0 Arial;}\\f0 Hello ${MARK}\\par}`, MARK],
  ["report.docx", zip([["[Content_Types].xml", "<Types/>"], ["word/document.xml", W(MARK)]]), MARK],
  ["budget.xlsx", zip([["[Content_Types].xml", "<Types/>"], ["xl/workbook.xml", `<workbook><sheets><sheet name="Budget" sheetId="1"/></sheets></workbook>`], ["xl/sharedStrings.xml", `<sst><si><t>${MARK}</t></si><si><t>Total</t></si></sst>`], ["xl/worksheets/sheet1.xml", `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><f>SUM(B1)</f><v>42</v></c></row></sheetData></worksheet>`]]), MARK],
  ["deck.pptx", zip([["ppt/presentation.xml", "<p/>"], ["ppt/slides/slide1.xml", `<p:sld><a:t>${MARK}</a:t></p:sld>`], ["ppt/slides/slide2.xml", `<p:sld><a:t>Second slide</a:t></p:sld>`]]), MARK],
  ["letter.odt", zip([["mimetype", "application/vnd.oasis.opendocument.text"], ["content.xml", `<office:document-content><text:p>${MARK}</text:p></office:document-content>`]]), MARK],
  ["book.epub", zip([["mimetype", "application/epub+zip"], ["META-INF/container.xml", "<container/>"], ["OEBPS/ch1.xhtml", `<html><body><p>${MARK}</p></body></html>`]]), MARK],
  ["bundle.zip", zip([["folder/inner-" + MARK + ".txt", "x"], ["b.txt", "y"]]), MARK],
  ["lib.jar", zip([["META-INF/MANIFEST.MF", "Main-Class: X"], ["X-" + MARK + ".class", "x"]]), MARK],
  ["plain.pdf", pdfDoc(`Hello ${MARK}`, false), MARK], ["compressed.pdf", pdfDoc(`Packed ${MARK}`, true), MARK], ["cid-fonts.pdf", cidPdf(`Font ${MARK}`), MARK],
  ["photo.png", png(64, 48, [10, 200, 30]), "64 x 48"],
  ["pixel.jpg", Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64"), "1 x 1"],
  ["anim.gif", Buffer.concat([Buffer.from("GIF89a"), Buffer.from([20, 0, 10, 0, 0, 0, 0]), Buffer.from([0x3b])]), "20 x 10"],
  ["pic.bmp", (() => { const b = Buffer.alloc(58); b.write("BM"); b.writeUInt32LE(58, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14); b.writeInt32LE(3, 18); b.writeInt32LE(2, 22); return b; })(), "3 x 2"],
  ["img.webp", (() => { const b = Buffer.alloc(30); b.write("RIFF"); b.writeUInt32LE(22, 4); b.write("WEBPVP8L", 8); b.writeUInt32LE(10, 16); b[20] = 0x2f; b.writeUInt32LE((99) | (49 << 14), 21); return b; })(), "100 x 50"],
  ["favicon.ico", (() => { const b = Buffer.alloc(22); b.writeUInt16LE(1, 2); b.writeUInt16LE(1, 4); b[6] = 32; b[7] = 32; return b; })(), "32 x 32"],
  ["tone.wav", wav(), "seconds: 1"], ["clip.mp4", mp4(), "seconds: 12.5"], ["song.mp3", id3(), "Marker Song"],
  ["log.txt.gz", zlib.gzipSync(`compressed ${MARK}`), MARK], ["src.tar", tar([["src/" + MARK + ".c", "int main(){}"]]), MARK],
  ["src.tar.gz", zlib.gzipSync(tar([["pkg/" + MARK + ".h", "x"]])), MARK],
  ["old.doc", Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(504), Buffer.from(`Legacy ${MARK} text`, "utf16le")]), MARK],
  ["archive.7z", Buffer.concat([Buffer.from("377abcaf271c0004", "hex"), Buffer.alloc(64, 7)]), "Research a tool"],
  ["mystery.xyz", Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 37 + 11) % 256)), "Research a tool"],
];
for (const [name, data] of cases) put(name, data);
// formats made by real tools on this PC
try { execFileSync("python", ["-c", `import sqlite3;c=sqlite3.connect(r"${path.join(dir, "store.db")}");c.execute("create table customers_${MARK.replace("-", "_")}(id int, name text)");c.commit()`]); cases.push(["store.db", null, "customers_ZEBRA_4471"]); } catch { console.log("SKIP  sqlite (python not available)"); }
try { fs.copyFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "notepad.exe"), path.join(dir, "notepad.exe")); cases.push(["notepad.exe", null, "will not run it"]); } catch {}

let failed = 0;
for (const [name, , want] of cases) {
  let out; try { out = inspect(path.join(dir, name)); } catch (e) { out = "THREW " + e.message; }
  const ok = out.includes(want); if (!ok) failed++;
  const type = (/^Type: (.*)$/m.exec(out) || [])[1] || "?";
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(16)} ${type.slice(0, 44).padEnd(44)} ${ok ? "" : "missing: " + want + "\n" + out.slice(0, 600)}`);
}
console.log(failed ? `\n${failed} of ${cases.length} file types FAILED` : `\nAll ${cases.length} file types read correctly. Samples kept in ${dir}`);
process.exit(failed ? 1 : 0);
