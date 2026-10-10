// Built with Claude (Anthropic) - see CREDITS.md
// http_request (against a local test server), make_chart (SVG and PNG), pdf_tools (qpdf; installed with install_tool on
// Windows when missing) and ocr (the Windows OCR engine; on other systems only the checks that need no Windows).
// Run: node tier2-test.mjs (exit 0 = all passed)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = ["app", "OmniGPT"].map((d) => path.resolve(here, "..", "..", d)).find((d) => fs.existsSync(path.join(d, "server.mjs")));
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-tier2test-"));
process.env.OMNIGPT_TEST_ALLOW_LOCAL = "1";
if (!process.env.OMNIGPT_BROWSER && process.platform !== "win32") { const { findBrowser } = await import("./pagekit.mjs"); const b = findBrowser(); if (b) process.env.OMNIGPT_BROWSER = b; }
const tools = await import(pathToFileURL(path.join(src, "tools.mjs")).href);
const { htmlToPng } = await import(pathToFileURL(path.join(src, "render.mjs")).href);
const W = path.join(os.homedir(), "Documents", "OmniRoute Workspace", ".omnigpt-tier2-test-" + process.pid);
const win = process.platform === "win32";
let failed = 0;
const check = (name, ok, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "  " + extra : "")); };
const cfg = { ...tools.loadConfig(), cwd: W, roots: [path.dirname(W)], granted: [], approval: "ask" };
const f = (...p) => path.join(W, ...p);
const refused = (name, input) => tools.precheck(name, input, cfg).then(() => "", (e) => e.message);
const R = (name, input, meta) => tools.run(name, input, cfg, undefined, meta);
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const pngSize = (p) => { const b = fs.readFileSync(p); return b.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null; };
// a small valid PDF with one line of text per page, written by hand
function makePdf(pages) {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", null, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"], kids = [];
  for (const t of pages) {
    const s = `BT /F1 48 Tf 72 640 Td (${t}) Tj ET`; objs.push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objs.length} 0 R >>`); kids.push(objs.length + " 0 R");
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  let out = "%PDF-1.4\n"; const at = [];
  objs.forEach((o, k) => { at.push(out.length); out += `${k + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length; out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + at.map((n) => String(n).padStart(10, "0") + " 00000 n \n").join("") + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const site = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/json") { res.writeHead(200, { "content-type": "application/json", "x-ratelimit-remaining": "41" }); return res.end(JSON.stringify({ name: "OmniGPT", items: [1, 2, 3] })); }
  if (u.pathname === "/echo") { res.writeHead(201, { "content-type": "application/json" }); return res.end(JSON.stringify({ method: req.method, type: req.headers["content-type"] || "", body, ua: req.headers["user-agent"] })); }
  if (u.pathname === "/to-private") { res.writeHead(302, { location: "http://10.0.0.1/secret" }); return res.end(); }
  if (u.pathname === "/to-json") { res.writeHead(301, { location: "/json" }); return res.end(); }
  if (u.pathname === "/bin") { res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(Buffer.alloc(3000, 0)); }
  if (u.pathname === "/big") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("x".repeat(60000)); }
  res.writeHead(404, { "content-type": "text/plain" }); res.end("no such page");
});
await new Promise((ok) => site.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${site.address().port}`;
try {
  fs.mkdirSync(W, { recursive: true });

  // ---- http_request
  let r = await R("http_request", { url: base + "/json" });
  check("http_request GET reads JSON with status and rate-limit headers", /^HTTP 200 OK/.test(r) && /x-ratelimit-remaining: 41/.test(r) && /"name": "OmniGPT"/.test(r), r.split("\n")[0]);
  r = await R("http_request", { method: "POST", url: base + "/echo", body: { title: "hello", n: 2 } });
  check("http_request POST sends an object as JSON", /^HTTP 201/.test(r) && /\\"title\\":\\"hello\\"/.test(r) && /"type": "application\/json"/.test(r), r.slice(0, 200).replace(/\n/g, " | "));
  r = await R("http_request", { method: "PUT", url: base + "/echo", body: "plain text", headers: { "Content-Type": "text/plain", Accept: "text/plain" } });
  check("http_request sends text bodies and chosen headers", /"method": "PUT"/.test(r) && /"type": "text\/plain"/.test(r) && /"body": "plain text"/.test(r));
  r = await R("http_request", { url: base + "/to-json" });
  check("redirects are followed", /^HTTP 200/.test(r) && /\/json/.test(r.split("\n")[0]));
  check("a redirect to a private address is refused", await R("http_request", { url: base + "/to-private" }).then(() => false, (e) => /private\/local address/.test(e.message)));
  r = await R("http_request", { url: base + "/nothing" });
  check("an error status is reported, not thrown", /^HTTP 404/.test(r) && /no such page/.test(r));
  r = await R("http_request", { url: base + "/bin" });
  check("binary responses are described, not dumped", /Binary content \(2\.9 KB\)/.test(r) && /download_file/.test(r), r.split("\n").pop());
  r = await R("http_request", { url: base + "/big" });
  check("long responses are cut", /more characters\]/.test(r) && r.length < 21000);
  r = await R("http_request", { method: "HEAD", url: base + "/json" });
  check("HEAD returns headers only", /^HTTP 200/.test(r) && /\(no body\)/.test(r));
  check("an Authorization header is refused (keys belong in Settings > Accounts)", /secret.*Settings > Accounts/.test(await refused("http_request", { url: base + "/json", headers: { Authorization: "Bearer abc" } })));
  check("API key and cookie headers are refused", !!(await refused("http_request", { url: base + "/json", headers: { "X-API-Key": "k" } })) && !!(await refused("http_request", { url: base + "/json", headers: { Cookie: "a=b" } })));
  check("private and local addresses are refused", !!(await refused("http_request", { url: "http://192.168.1.1/" })) && !!(await refused("http_request", { url: "http://169.254.169.254/latest" })) && !!(await refused("http_request", { url: "file:///c:/x" })));
  check("a GET with a body is refused", !!(await refused("http_request", { url: base + "/json", body: "x" })));
  const pg = await tools.precheck("http_request", { url: base + "/json" }, cfg), pp = await tools.precheck("http_request", { method: "POST", url: base + "/echo", body: "x" }, cfg);
  check("GET is a web read; sending data is a network action that asks", pg.class === "web" && pp.class === "network");

  // ---- make_chart
  const meta = { turn: "t-tier2-" + process.pid };
  r = await R("make_chart", { path: f("sales.svg"), type: "bar", title: "Monthly sales", labels: ["Jan", "Feb", "Mar"], series: [{ name: "Sales", values: [3, 5, 2] }] }, meta);
  let svg = fs.readFileSync(f("sales.svg"), "utf8");
  check("make_chart writes an SVG with the title, one bar per value and value labels", /^Created .*sales\.svg: bar chart, 1 series, 3 categories/.test(r) && /<svg /.test(svg) && />Monthly sales</.test(svg) && (svg.match(/fill="#2a78d6"/g) || []).length === 3 && />5</.test(svg), r.split("(")[0]);
  check("chart text never uses a series colour", !/<text[^>]*fill="#(2a78d6|eb6834|1baf7a|eda100)"/.test(svg));
  r = await R("make_chart", { path: f("trend.png"), type: "line", title: "Visitors", labels: ["Mon", "Tue", "Wed", "Thu"], series: [{ name: "This week", values: [10, 14, 9, 20] }, { name: "Last week", values: [8, 9, 12, 11] }], width: 800, height: 450 }, meta);
  check("make_chart draws a sharp PNG at twice the size", /^Created .*trend\.png: line chart, 2 series/.test(r) && JSON.stringify(pngSize(f("trend.png"))) === "[1600,900]", JSON.stringify(pngSize(f("trend.png"))) + " " + r.split("\n")[0].slice(0, 100));
  fs.writeFileSync(f("data.csv"), "Region,2025,2026\nNorth,120,150\nSouth,\"1,090\",130\nWest,60,95\n");
  r = await R("make_chart", { path: f("regions.svg"), type: "bar", csv: f("data.csv"), columns: ["2026"], title: "Regions" }, meta);
  svg = fs.readFileSync(f("regions.svg"), "utf8");
  check("make_chart reads a CSV file and picks columns", /1 series, 3 categories/.test(r) && />North</.test(svg) && />West</.test(svg));
  r = await R("make_chart", { path: f("pie.svg"), type: "pie", labels: Array.from({ length: 11 }, (_, k) => "Item " + k), series: [{ name: "Share", values: Array.from({ length: 11 }, (_, k) => 20 - k) }] }, meta);
  svg = fs.readFileSync(f("pie.svg"), "utf8");
  check("a pie with more than 8 slices combines the smallest into Other", />Other\s+[\d.]+%</.test(svg) && (svg.match(/<path d="M [\d.]+ [\d.]+ L/g) || []).length === 8);
  const bad = [
    [{ type: "radar", series: [{ values: [1] }] }, /type must be/], [{ type: "scatter", series: [1, 2, 3, 4].map((k) => ({ name: "S" + k, points: [[1, 2]] })) }, /at most 3 series/],
    [{ type: "pie", series: [{ values: [3, -1] }] }, /negative/], [{ type: "pie", series: [{ values: [1, 2] }, { values: [3, 4] }] }, /one series/],
    [{ type: "bar", series: Array.from({ length: 9 }, () => ({ values: [1] })) }, /at most 8 series/], [{ type: "line", series: [{ values: [1, "abc"] }] }, /not a number/],
  ];
  const badRes = await Promise.all(bad.map(([i]) => refused("make_chart", { path: f("x.svg"), ...i })));
  check("charts that would mislead or cannot be drawn are refused with a reason", badRes.every((m, k) => bad[k][1].test(m)), badRes.map((m, k) => bad[k][1].test(m) ? "" : m || "(accepted)").filter(Boolean).join(" | "));
  check("make_chart only writes .png or .svg and never replaces a file unasked", /\.png or \.svg/.test(await refused("make_chart", { path: f("x.jpg"), type: "bar", series: [{ values: [1] }] })) && /file exists/.test(await refused("make_chart", { path: f("sales.svg"), type: "bar", series: [{ values: [1] }] })));

  // ---- pdf_tools
  fs.writeFileSync(f("three.pdf"), makePdf(["Page one", "Page two", "Page three"])); fs.writeFileSync(f("two.pdf"), makePdf(["Second file A", "Second file B"]));
  const h3 = sha(f("three.pdf"));
  let ok = (await R("pdf_tools", { action: "info", path: f("three.pdf") }).then(() => true, (e) => e.message));
  if (ok !== true && win && /not installed/.test(ok)) { // what an agent does: install the free program, then try again
    const inst = await R("install_tool", { manager: "winget", package: "QPDF.QPDF" }).catch((e) => String(e.message));
    console.log("      qpdf was missing; install_tool winget QPDF.QPDF: " + String(inst).trim().split("\n").slice(-2).join(" | ").slice(0, 200));
    ok = (await R("pdf_tools", { action: "info", path: f("three.pdf") }).then(() => true, (e) => e.message));
  }
  check("qpdf is available (installed on demand with install_tool)", ok === true, ok === true ? "" : ok);
  if (ok === true) {
    r = await R("pdf_tools", { action: "info", path: f("three.pdf") });
    check("info reports the page count", /: 3 pages/.test(r), r.split("\n")[0]);
    r = await R("pdf_tools", { action: "extract", path: f("three.pdf"), pages: "2-3" }, meta);
    check("extract copies chosen pages into a new PDF", /\(2 pages\)/.test(r) && fs.existsSync(f("three pages 2-3.pdf")), r);
    r = await R("pdf_tools", { action: "merge", paths: [f("three.pdf"), f("two.pdf")], output: f("all.pdf") }, meta);
    check("merge joins PDFs in order", /Merged 2 PDFs .* \(5 pages\)/.test(r), r);
    r = await R("pdf_tools", { action: "rotate", path: f("three.pdf"), angle: 90, pages: "1" }, meta);
    check("rotate turns the chosen pages", /Rotated pages 1/.test(r) && /\/Rotate 90/.test(fs.readFileSync(f("three rotated.pdf"), "latin1")), r);
    r = await R("pdf_tools", { action: "split", path: f("three.pdf") }, meta);
    const parts = fs.existsSync(f("three pages")) ? fs.readdirSync(f("three pages")) : [];
    check("split writes one file per page into a new folder", /into 3 files/.test(r) && parts.length === 3 && parts.every((p) => /^three-\d+\.pdf$/.test(p)), parts.join(", "));
    check("the original PDF is never changed", sha(f("three.pdf")) === h3);
    check("an existing output is not replaced unasked", /output exists/.test(await refused("pdf_tools", { action: "merge", paths: [f("three.pdf"), f("two.pdf")], output: f("all.pdf") })));
    check("the output cannot be one of the inputs", /new file/.test(await refused("pdf_tools", { action: "rotate", path: f("three.pdf"), output: f("three.pdf"), overwrite: true })));
    check("page ranges are checked", /pages must look like/.test(await refused("pdf_tools", { action: "extract", path: f("three.pdf"), pages: "1;calc" })));
    const info = tools.undoInfo(meta.turn);
    check("every new PDF is in the undo journal", info.changes >= 11, JSON.stringify(info));
  }
  check("pdf_tools only takes PDFs", /not a \.pdf/.test(await refused("pdf_tools", { action: "info", path: f("data.csv") })));

  // ---- analyze_data (the sandbox run itself is tested on Windows in sandbox-test.mjs, against the built app)
  const pa = await tools.precheck("analyze_data", { files: [f("data.csv")], code: "print(1)" }, cfg);
  check("analyze_data is a change that asks (it saves result files)", pa.class === "write" && /Analyze 1 file with python/.test(pa.summary) && /Analysis results/.test(pa.summary), pa.summary.split("\n")[0]);
  check("analyze_data takes at most 20 files, only from the allowed folders", /at most 20/.test(await refused("analyze_data", { files: Array(21).fill(f("data.csv")), code: "print(1)" })) && /outside the allowed/.test(await refused("analyze_data", { files: ["/etc/passwd"], code: "print(1)" })));
  check("analyze_data needs code", /code is required/.test(await refused("analyze_data", { files: [], code: " " })));
  const { xlsxSheets } = await import(pathToFileURL(path.join(src, "files.mjs")).href), { toXlsx } = await import(pathToFileURL(path.join(src, "docs.mjs")).href);
  const sh = xlsxSheets(toXlsx([{ name: "Plan", rows: [["month", "budget"], ["Jan", 100], ["Feb", "=B2*2"]] }, { name: "Notes", rows: [["a"]] }], "x"));
  check("Excel sheets are read as rows for the sandbox's CSV copies", sh.length === 2 && sh[0].name === "Plan" && JSON.stringify(sh[0].rows[1]) === '["Jan","100"]' && sh[1].name === "Notes", JSON.stringify(sh).slice(0, 160));

  // ---- ocr
  check("ocr only takes pictures and PDFs", /pictures/.test(await refused("ocr", { path: f("data.csv") })));
  check("ocr checks page ranges", /pages must look like/.test(await refused("ocr", { path: f("three.pdf"), pages: "x" })));
  check("reading text is read-only; saving it is a change", (await tools.precheck("ocr", { path: f("a.png") }, cfg)).class === "read" && (await tools.precheck("ocr", { path: f("a.png"), output: f("a.txt") }, cfg)).class === "write");
  if (win) {
    fs.writeFileSync(f("scan.png"), await htmlToPng(process.env.OMNIGPT_BROWSER || (await import("./pagekit.mjs")).findBrowser(), `<body style="margin:0;background:#fff;font:64px Arial,sans-serif;padding:40px">INVOICE 4821<br>TOTAL 96.50 EUR</body>`, 900, 300, 1));
    r = await R("ocr", { path: f("scan.png"), output: f("scan.txt") }, meta).catch((e) => "ERROR " + e.message);
    check("ocr reads the text in a picture (Windows OCR engine)", /4821/.test(r) && /96[.,]50/.test(r) && fs.existsSync(f("scan.txt")), r.replace(/\n/g, " | ").slice(0, 240));
    r = await R("ocr", { path: f("three.pdf"), pages: "2-3" }).catch((e) => "ERROR " + e.message);
    check("ocr reads chosen pages of a PDF", /Page 2 ---\nPage two/i.test(r) && /Page 3 ---\nPage three/i.test(r) && !/Page one/i.test(r), r.replace(/\n/g, " | ").slice(0, 240));
  } else check("ocr explains that it needs Windows (the OCR checks run on Windows)", /built into Windows/.test(await R("ocr", { path: f("three.pdf") }).then(() => "", (e) => e.message)));
} catch (e) { check("tier 2 test", false, String(e.stack || e)); }
site.close();
fs.rmSync(W, { recursive: true, force: true }); try { fs.rmSync(process.env.LOCALAPPDATA, { recursive: true, force: true }); } catch {}
console.log(failed ? `${failed} check(s) failed.` : "All http, chart, PDF and OCR checks passed.");
process.exit(failed ? 1 : 0);
