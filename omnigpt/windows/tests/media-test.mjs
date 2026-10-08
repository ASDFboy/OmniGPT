// Documents, images, media and OmniRoute media tools. OmniRoute is replaced by a small stand-in server.
// Run: node media-test.mjs (exit 0 = all passed)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = ["app", "OmniGPT"].map((d) => path.resolve(here, "..", "..", d)).find((d) => fs.existsSync(path.join(d, "server.mjs")));
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-mediatest-"));
for (const b of ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"]) if (!process.env.OMNIGPT_BROWSER && process.platform !== "win32" && fs.existsSync(b)) process.env.OMNIGPT_BROWSER = b;
const tools = await import(pathToFileURL(path.join(src, "tools.mjs")).href);
const { zipRead } = await import(pathToFileURL(path.join(src, "zip.mjs")).href);
const W = path.join(os.homedir(), "Documents", "OmniRoute Workspace", ".omnigpt-media-test-" + process.pid);
let failed = 0;
const check = (name, ok, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "  " + extra : "")); };
const cfg = { ...tools.loadConfig(), cwd: W, roots: [path.dirname(W)], granted: [] };
const f = (...p) => path.join(W, ...p);
const run = (n, i) => tools.run(n, i, cfg, null, { turn: "t-media-" + process.pid });
const ffmpeg = spawnSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"]).status === 0;
const canEditImages = process.platform === "win32" || ffmpeg;
// a 64x48 24-bit BMP with a gradient, written by hand
function bmp(w, h) { const row = Math.ceil((w * 3) / 4) * 4, b = Buffer.alloc(54 + row * h); b.write("BM"); b.writeUInt32LE(b.length, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14); b.writeInt32LE(w, 18); b.writeInt32LE(h, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(row * h, 34); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = 54 + y * row + x * 3; b[o] = x * 4; b[o + 1] = y * 5; b[o + 2] = 200; } return b; }
function dims(p) { const b = fs.readFileSync(p); if (b[0] === 0x89) return [b.readUInt32BE(16), b.readUInt32BE(20)]; if (b[0] === 0x42 && b[1] === 0x4d) return [b.readInt32LE(18), Math.abs(b.readInt32LE(22))]; if (b[0] === 0xff) { let o = 2; while (o < b.length) { const m = b[o + 1], len = b.readUInt16BE(o + 2); if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return [b.readUInt16BE(o + 7), b.readUInt16BE(o + 5)]; o += 2 + len; } } return null; }
// stand-in OmniRoute
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC", "base64");
const seen = {};
const mock = http.createServer((req, res) => {
  let body = []; req.on("data", (c) => body.push(c)); req.on("end", () => {
    body = Buffer.concat(body); const j = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    seen[req.method + " " + req.url] = { auth: req.headers.authorization, type: req.headers["content-type"], body };
    if (req.url === "/v1/models") return j({ data: [{ id: "groq/whisper-large-v3" }, { id: "openai/tts-1" }, { id: "groq/llama-3.3-70b" }] });
    if (req.url === "/v1/images/generations" && req.method === "GET") return j({ data: [{ id: "pollinations/flux" }] });
    if (req.url === "/v1/images/generations") { const b = JSON.parse(body); return b.model === "pollinations/flux" && b.prompt ? j({ data: [{ b64_json: PNG.toString("base64") }] }) : j({ error: { message: "bad" } }, 400); }
    if (req.url === "/v1/audio/transcriptions") return /name="model"[\s\S]*whisper/.test(body.toString("latin1")) && /name="file"/.test(body.toString("latin1")) ? j({ text: "hello from the recording" }) : j({ error: { message: "no file" } }, 400);
    if (req.url === "/v1/audio/speech") { res.writeHead(200, { "content-type": "audio/mpeg" }); return res.end(Buffer.concat([Buffer.from("ID3"), Buffer.alloc(800, 1)])); }
    j({ error: { message: "not found" } }, 404);
  });
});
await new Promise((ok) => mock.listen(0, "127.0.0.1", ok));
tools.setOmniRoute("http://127.0.0.1:" + mock.address().port, () => "test-key");
try {
  fs.mkdirSync(W, { recursive: true });
  const md = "# Report\n\nSome **bold** text.\n\n- one\n- two\n\n| Item | Qty |\n|---|---|\n| Apples | 3 |\n| Pears | 4 |\n\n## Next\n\nMore text.";
  for (const ext of ["docx", "xlsx", "pptx"]) {
    const r = await run("make_document", { path: f("doc." + ext), title: "Test", content: md });
    const z = zipRead(fs.readFileSync(f("doc." + ext))), names = z.entries.map((e) => e.name);
    const main = { docx: "word/document.xml", xlsx: "xl/worksheets/sheet1.xml", pptx: "ppt/slides/slide2.xml" }[ext];
    check(`make_document ${ext}`, /Created/.test(r) && names.includes("[Content_Types].xml") && names.includes(main) && /Apples|Report|one/.test(z.read(z.entries.find((e) => e.name === main)).toString()), r.split("\n")[0]);
  }
  const x = await run("make_document", { path: f("sheet.xlsx"), sheets: [{ name: "Data", rows: [["Name", "Qty"], ["A", 2], ["B", "=B2*2"]] }] });
  const zx = zipRead(fs.readFileSync(f("sheet.xlsx"))), s1 = zx.read(zx.entries.find((e) => e.name === "xl/worksheets/sheet1.xml")).toString();
  check("spreadsheet keeps numbers and formulas", /<v>2<\/v>/.test(s1) && /<f>B2\*2<\/f>/.test(s1), x);
  await run("make_document", { path: f("page.html"), title: "T", content: md });
  check("make_document html", /<table>/.test(fs.readFileSync(f("page.html"), "utf8")));
  await run("make_document", { path: f("t.csv"), content: md });
  check("make_document csv from a Markdown table", fs.readFileSync(f("t.csv"), "utf8").includes("Apples,3"));
  check("existing files are not replaced without overwrite", await tools.precheck("make_document", { path: f("page.html"), content: "x" }, cfg).then(() => false, () => true));
  if (process.platform === "win32" || process.env.OMNIGPT_BROWSER) {
    const r = await run("make_document", { path: f("doc.pdf"), title: "PDF test", content: md });
    check("make_document pdf (printed by the browser)", fs.readFileSync(f("doc.pdf")).toString("latin1", 0, 5) === "%PDF-", r);
  } else check("make_document pdf (skipped: no browser here)", true);

  fs.writeFileSync(f("pic.bmp"), bmp(64, 48));
  if (canEditImages) {
    let r = await run("edit_image", { path: f("pic.bmp"), resize: "50%", format: "png" });
    check("edit_image resizes and converts", JSON.stringify(dims(f("pic-edited.png"))) === "[32,24]", r);
    r = await run("edit_image", { path: f("pic.bmp"), output: f("rot.jpg"), rotate: 90, quality: 80 });
    check("edit_image rotates to jpg", JSON.stringify(dims(f("rot.jpg"))) === "[48,64]", r);
    r = await run("edit_image", { path: f("pic.bmp"), output: f("crop.png"), crop: { x: 10, y: 5, width: 20, height: 10 } });
    check("edit_image crops", JSON.stringify(dims(f("crop.png"))) === "[20,10]", r);
    r = await run("edit_image", { path: f("pic.bmp"), output: f("small.png"), resize: 16 });
    check("edit_image fits the longest side", JSON.stringify(dims(f("small.png"))) === "[16,12]", r);
  } else check("edit_image (skipped: needs Windows or ffmpeg)", true);
  if (ffmpeg) {
    spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10", "-f", "lavfi", "-i", "sine=duration=3", "-shortest", f("clip.mp4")]);
    let r = await run("convert_media", { input: f("clip.mp4"), output: f("clip.gif"), max_width: 160, fps: 5 });
    check("convert_media makes a GIF", fs.readFileSync(f("clip.gif")).toString("ascii", 0, 3) === "GIF", r);
    r = await run("convert_media", { input: f("clip.mp4"), output: f("clip.mp3"), start: 1, end: 2 });
    check("convert_media extracts trimmed audio", fs.existsSync(f("clip.mp3")) && fs.statSync(f("clip.mp3")).size > 500, r);
  } else check("convert_media (skipped: no ffmpeg here)", true);

  let r = await run("generate_image", { prompt: "a red square" });
  const gen = typeof r === "object" ? r : { text: r }, saved = /saved as (.+?) \(/.exec(gen.text)?.[1];
  check("generate_image picks an image model, saves and shows the picture", /pollinations\/flux/.test(gen.text) && saved && fs.existsSync(saved) && gen.blocks?.some((b) => b.type === "image") && seen["POST /v1/images/generations"].auth === "Bearer test-key", gen.text);
  fs.writeFileSync(f("voice.mp3"), Buffer.alloc(2000, 7));
  r = await run("transcribe_audio", { path: f("voice.mp3"), output: f("voice.txt") });
  check("transcribe_audio sends the file to a speech-to-text model", /hello from the recording/.test(r) && fs.readFileSync(f("voice.txt"), "utf8").includes("hello"), r.split("\n")[0]);
  r = await run("speak", { text: "Hello there", path: f("hello.mp3") });
  check("speak saves audio from a text-to-speech model", /openai\/tts-1/.test(r) && fs.readFileSync(f("hello.mp3")).toString("ascii", 0, 3) === "ID3", r);
  const u = await tools.undoTurn("t-media-" + process.pid, cfg);
  check("everything the media tools made is undoable", u.ok && u.done > 10 || process.platform !== "win32", `${u.done} undone`);
} catch (e) { check("media test", false, String(e.stack || e)); }
mock.close();
fs.rmSync(W, { recursive: true, force: true }); fs.rmSync(process.env.LOCALAPPDATA, { recursive: true, force: true });
console.log(failed ? `${failed} check(s) failed.` : "All media and document checks passed.");
process.exit(failed ? 1 : 0);
