// Built with Claude (Anthropic) - see CREDITS.md
// Local shell for OmniRoute Chat. Serves the UI, proxies to OmniRoute (adding the API key from the
// OMNIROUTE_API_KEY env var so the page never sees it), and executes reviewed PC tools.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { loadConfig, saveConfig, precheck, run, resolveScope, runSandboxRaw, sandboxInfo, checkPath, grantFolder, ungrantFolder, folderConfig, insideFolder, undoTurn, undoInfo, readActivity, setOmniRoute, listJobs, stopJob, stopAllJobs } from "./tools.mjs";
import { inspect, MIME, RUNNABLE } from "./files.mjs";
import { embedApi, embedModels, meaningSettings, isLocalModel } from "./embed.mjs";
import { indexInfo, clearIndexQueued } from "./docindex.mjs";
import { publicList, saveConnection, deleteConnection, testConnection, ghStatus, ghLogin } from "./connections.mjs";
import { stopPs } from "./psworker.mjs";
import { stopRender } from "./render.mjs";
import { pipeline } from "node:stream/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const OR = process.env.OMNIROUTE_URL || "http://127.0.0.1:20128";
const PORT = Number(process.env.OMNIGPT_PORT || 20129); // a different port lets a development copy run beside the installed app
const TOKEN = crypto.randomBytes(24).toString("hex"); // per launch; only the served page knows it
export const VERSION = "1.0.3";
const REPO = "ASDFboy/OmniGPT"; // GitHub repository whose releases are checked for updates
const CHAT_DIR_ = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "OmniRouteChat");
const KEYFILE = path.join(CHAT_DIR_, "omniroute-key.txt"); // the key can also be saved from Settings instead of an environment variable
const key = () => { if (process.env.OMNIROUTE_API_KEY) return process.env.OMNIROUTE_API_KEY; try { return fs.readFileSync(KEYFILE, "utf8").trim(); } catch { return ""; } };
let updateCache = { at: 0, data: null };
setOmniRoute(OR, () => key()); // media tools (images, speech) use the user's OmniRoute providers
const semver = (v) => String(v).split(".").map((n) => parseInt(n, 10) || 0);
const newer = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
async function checkUpdate(force) {
  if (!force && updateCache.data && Date.now() - updateCache.at < 6 * 3600e3) return updateCache.data;
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, { headers: { "user-agent": "OmniGPT/" + VERSION, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("GitHub answered " + r.status);
  let best = null;
  for (const rel of await r.json()) {
    const m = /^omnigpt-v(\d+\.\d+\.\d+)$/.exec(rel.tag_name || ""); if (!m || rel.draft || rel.prerelease) continue;
    if (!best || newer(m[1], best.version)) {
      const asset = (n) => (rel.assets || []).find((a) => a.name === n)?.browser_download_url || null;
      best = { version: m[1], url: rel.html_url, exe: asset("OmniGPT-Setup.exe"), sha: asset("OmniGPT-Setup.exe.sha256") };
    }
  }
  const data = { current: VERSION, latest: best ? best.version : VERSION, newer: !!best && newer(best.version, VERSION), url: best ? best.url : `https://github.com/${REPO}/releases`, installable: !!(best && best.exe && best.sha) };
  Object.defineProperty(data, "assets", { value: best ? { exe: best.exe, sha: best.sha } : null, enumerable: false }); // used by the installer download, not sent to the page
  updateCache = { at: Date.now(), data }; return data;
}
// One-click update: download the newest installer from the GitHub release, check it against the release's SHA-256 file,
// then start it outside this process tree (closing the window stops this backend) so it can replace the app and reopen it.
let installing = false;
async function installUpdate() {
  if (installing) throw new Error("An update is already being installed.");
  installing = true;
  try {
    const u = await checkUpdate(true);
    if (!u.newer) throw new Error("OmniGPT is already up to date.");
    if (!u.installable || !u.assets) throw new Error("This release has no installer to download. Use the release page instead.");
    const okHost = (s) => { const h = new URL(s).hostname; return h === "github.com" || h.endsWith(".githubusercontent.com"); };
    if (!okHost(u.assets.exe) || !okHost(u.assets.sha)) throw new Error("Unexpected download location.");
    const shaText = await (await fetch(u.assets.sha, { signal: AbortSignal.timeout(30000) })).text();
    const want = (/\b[0-9a-f]{64}\b/i.exec(shaText) || [])[0];
    if (!want) throw new Error("The release's checksum file could not be read.");
    const r = await fetch(u.assets.exe, { signal: AbortSignal.timeout(600000) });
    if (!r.ok) throw new Error("Download failed: HTTP " + r.status);
    const dir = path.join(os.tmpdir(), "OmniGPT-update"); fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, "OmniGPT-Setup-" + u.latest.replace(/[^0-9.]/g, "") + ".exe"), part = exe + ".part";
    const h = crypto.createHash("sha256"); let n = 0;
    await pipeline(Readable.fromWeb(r.body), async function* (src) { for await (const c of src) { n += c.length; if (n > 300 * 1024 * 1024) throw new Error("installer is unexpectedly large"); h.update(c); yield c; } }, fs.createWriteStream(part));
    const got = h.digest("hex");
    if (got.toLowerCase() !== want.toLowerCase()) { try { fs.unlinkSync(part); } catch {} throw new Error("The download did not match the release checksum, so it was not run."); }
    fs.renameSync(part, exe);
    // "start" gives the installer its own process tree, so it survives this backend being stopped when the window closes
    spawn("cmd.exe", ["/d", "/c", 'start "" "%ORC_EXE%" /S /launch'], { env: { ...process.env, ORC_EXE: exe }, detached: true, windowsHide: true, stdio: "ignore" }).unref();
    return { version: u.latest };
  } finally { installing = false; }
}

// Model prices from OmniRoute (per 1M tokens), used to show what a conversation cost. Empty when OmniRoute does not share them.
let priceCache = { at: 0, data: {} };
async function pricing() {
  if (Date.now() - priceCache.at < 3600e3) return priceCache.data;
  let data = {};
  try {
    const r = await fetch(OR + "/api/pricing", { headers: key() ? { authorization: "Bearer " + key() } : {}, signal: AbortSignal.timeout(8000) });
    if (r.ok) { const j = await r.json(); if (j && typeof j === "object" && !Array.isArray(j)) data = j; }
  } catch {}
  priceCache = { at: Date.now(), data }; return data;
}

// A cancelled request must never take the whole app down.
process.on("uncaughtException", (e) => console.error("uncaught:", e.message));
process.on("unhandledRejection", (e) => console.error("unhandled:", e?.message || e));

async function orUp() {
  try { return (await fetch(OR + "/api/settings/require-login", { signal: AbortSignal.timeout(2500) })).ok; }
  catch { return false; }
}
// Starts OmniRoute directly and hidden (no console window). If it was already running we leave it alone;
// if we started it, it stops when this server stops.
let omniChild = null;
async function ensureOmniRoute() {
  if (await orUp()) return;
  const script = process.env.OMNIROUTE_SCRIPT || path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "npm", "node_modules", "omniroute", "bin", "omniroute.mjs");
  if (!fs.existsSync(script)) { console.error("OmniRoute not found at " + script); return; }
  const dataDir = process.env.DATA_DIR || loadConfig().omnirouteDataDir; // empty: OmniRoute uses its own default folder
  const env = { ...process.env, ...(dataDir ? { DATA_DIR: dataDir } : {}), OMNIROUTE_SERVER_HOST: "127.0.0.1", OMNIROUTE_NO_UPDATE_NOTIFIER: "1", NO_UPDATE_NOTIFIER: "1" };
  delete env.OMNIROUTE_API_KEY; // OmniRoute does not need our client key
  omniChild = spawn(process.execPath, [script, "serve", "--no-tray", "--log", "--ready-timeout", "180000"], { windowsHide: true, stdio: "ignore", env });
  omniChild.on("exit", () => { omniChild = null; });
}
const killTree = (c) => { try { if (c && c.pid) spawn("taskkill", ["/pid", String(c.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }); } catch {} };
function shutdown() { stopAllJobs(); stopPs(); stopRender(); killTree(omniChild); setTimeout(() => process.exit(0), 300); } // background jobs, the PowerShell worker and the drawing browser end with the app
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(sig, shutdown);
const parentPid = Number(process.env.OMNIGPT_PARENT_PID || 0); // exit when the app window process is gone
if (parentPid) setInterval(() => { try { process.kill(parentPid, 0); } catch { shutdown(); } }, 4000);

// ---------- scheduled tasks: stored here, fired into the open app window (the page polls /api/due)
const TASKS_FILE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "OmniRouteChat", "tasks.json");
let tasks = [];
try { tasks = JSON.parse(fs.readFileSync(TASKS_FILE, "utf8")); } catch {}
const due = [];
const persist = () => { fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true }); fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2)); };
function nextRun(s, from) {
  if (s.type === "once") return s.at;
  if (s.type === "interval") return from + s.minutes * 60000;
  const [h, m] = s.time.split(":").map(Number);
  for (let d = 0; d < 8; d++) {
    const c = new Date(from); c.setDate(c.getDate() + d); c.setHours(h, m, 0, 0);
    if (c.getTime() > from && (s.type === "daily" || s.days.includes(c.getDay()))) return c.getTime();
  }
  return null;
}
function normalize(t) {
  const sc = t.schedule || {}, clean = { type: sc.type };
  if (sc.type === "once") { clean.at = Number(sc.at); if (!clean.at) throw new Error("bad time"); }
  else if (sc.type === "interval") { clean.minutes = Math.max(1, Math.min(Number(sc.minutes) || 0, 100000)); if (!sc.minutes) throw new Error("bad interval"); }
  else if (sc.type === "daily" || sc.type === "weekly") {
    if (!/^\d{1,2}:\d{2}$/.test(sc.time || "")) throw new Error("bad time");
    clean.time = sc.time;
    if (sc.type === "weekly") { clean.days = (sc.days || []).map(Number).filter((d) => d >= 0 && d <= 6); if (!clean.days.length) throw new Error("pick at least one day"); }
  } else throw new Error("bad schedule type");
  const name = String(t.name || "").trim().slice(0, 80), prompt = String(t.prompt || "").trim().slice(0, 8000);
  if (!name || !prompt) throw new Error("name and prompt are required");
  return { id: String(t.id || crypto.randomUUID()), name, prompt, schedule: clean, enabled: t.enabled !== false, pc: !!t.pc, project: t.project ? String(t.project) : null, lastRun: Number(t.lastRun) || 0, nextRun: null };
}
const fire = (t, now) => { due.push({ id: t.id, name: t.name, prompt: t.prompt, pc: t.pc, project: t.project, at: now }); t.lastRun = now; };
for (const t of tasks) if (t.enabled && !t.nextRun) t.nextRun = nextRun(t.schedule, Date.now());
setInterval(() => { // a missed run (app was closed) fires once on the next tick, then reschedules from now
  const now = Date.now(); let changed = false;
  for (const t of tasks) if (t.enabled && t.nextRun && t.nextRun <= now) {
    fire(t, now); changed = true;
    if (t.schedule.type === "once") { t.enabled = false; t.nextRun = null; } else t.nextRun = nextRun(t.schedule, now);
  }
  if (changed) persist();
}, 15000);

// ---------- key/value storage for chats, folders, projects and model health (no browser quota)
const KVDIR = path.join(path.dirname(TASKS_FILE), "kv");
const kvFile = (k) => path.join(KVDIR, k.replace(/[^a-z.]/g, "_") + ".json");
const kvAll = () => { const o = {}; try { for (const f of fs.readdirSync(KVDIR)) if (f.endsWith(".json") && f !== "orc.chats.json") { const n = f.slice(0, -5); try { o[n] = JSON.parse(fs.readFileSync(path.join(KVDIR, f), "utf8")); } catch { try { o[n] = JSON.parse(fs.readFileSync(path.join(KVDIR, f + ".bak"), "utf8")); } catch {} } } } catch {} return o; }; // a damaged file falls back to the previous copy
const kvSet = (k, v) => { if (!/^orc\.[a-z]+$/.test(k)) throw new Error("bad key"); fs.mkdirSync(KVDIR, { recursive: true }); const t = kvFile(k) + ".tmp"; fs.writeFileSync(t, JSON.stringify(v)); try { fs.copyFileSync(kvFile(k), kvFile(k) + ".bak"); } catch {} fs.renameSync(t, kvFile(k)); };

// ---------- chats: one file per chat (kv/chats/<id>.json) and a small index (title, time, folder, project, mode, short
// previews), so saving a chat writes only that chat. The page loads the index at start and a chat's full record on demand.
// The old single orc.chats file is moved over once, checked, and kept as orc.chats.json.migrated-backup.
const CHATDIR = path.join(KVDIR, "chats"), CHATIDX = path.join(CHATDIR, "_index.json"); // ids never start with "_"
const okId = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(id); // CON, NUL, COM1...: Windows devices, not files
const badReq = (m) => Object.assign(new Error(m), { status: 400 });
const chatFile = (id) => { if (!okId(id)) throw badReq("bad chat id"); return path.join(CHATDIR, id + ".json"); };
const writeAtomic = (f, s) => { const t = f + ".tmp"; fs.writeFileSync(t, s); fs.renameSync(t, f); };
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b && b.type === "text" ? String(b.text || "") : b && b.type === "image" ? "[image]" : "")).join("\n") : "");
const oneLine = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
const hist = (c) => (Array.isArray(c.history) ? c.history : []);
const entryOf = (c) => { const h = hist(c); return { id: c.id, title: String(c.title || "").slice(0, 200), ts: Number(c.ts) || 0, folder: c.folder || null, project: c.project || null, mode: c.mode || "default", n: h.length,
  q: oneLine(textOf(h.find((m) => m && m.role === "user")?.content), 160), last: oneLine(textOf([...h].reverse().find((m) => m && m.role === "assistant")?.content), 200) }; };
let chatIdx = new Map(), chatTxt = null, txtTimer = null; // chatTxt: each chat's text for searching, read on the first search and dropped after 10 idle minutes
const txtOf = (c) => { const b = hist(c).map((m) => textOf(m && m.content)).join("\n"); return { b, l: b.toLowerCase() }; };
const saveIdx = () => { fs.mkdirSync(CHATDIR, { recursive: true }); writeAtomic(CHATIDX, JSON.stringify([...chatIdx.values()])); };
const readChat = (id) => { try { const c = JSON.parse(fs.readFileSync(chatFile(id), "utf8")); return c && typeof c === "object" && c.id === id ? c : null; } catch { return null; } };
const chatList = () => [...chatIdx.values()].sort((a, b) => b.ts - a.ts);
function putChat(c, idx = true) {
  if (!c || typeof c !== "object" || Array.isArray(c)) throw badReq("bad chat");
  const id = String(c.id ?? ""); chatFile(id);
  const rec = { ...c, id, ts: Number(c.ts) || Date.now(), history: hist(c) }, s = JSON.stringify(rec);
  fs.mkdirSync(CHATDIR, { recursive: true }); writeAtomic(chatFile(id), s);
  const e = entryOf(rec); chatIdx.set(id, e); if (chatTxt) chatTxt.set(id, txtOf(rec)); if (idx) saveIdx();
  return { entry: e, hash: crypto.createHash("sha1").update(s).digest("hex") };
}
// older copies (the old orc.chats file, an old window that is still open, the old browser storage): a chat is written
// only when it is new or newer than the stored one, so running this twice changes nothing
function importChats(list) {
  const done = [], seen = new Set();
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    let id = String(c.id ?? ""); if (!okId(id)) id = id.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^[_-]+/, "").slice(0, 56);
    if (!okId(id)) id = "c" + crypto.createHash("sha1").update(JSON.stringify(c)).digest("hex").slice(0, 12);
    for (let k = 2; seen.has(id); k++) id = id.slice(0, 56) + "-" + k; seen.add(id);
    const ts = Number(c.ts) || 0, old = chatIdx.get(id);
    if (old && old.ts >= ts && readChat(id)) { done.push({ id, ts }); continue; }
    done.push({ id, ts, hash: putChat({ ...c, id, ts: ts || Date.now() }, false).hash });
  }
  if (done.some((d) => d.hash)) saveIdx(); return done;
}
function metaChats(items) {
  const out = [], L = (Array.isArray(items) ? items : []).slice(0, 5000).filter((it) => it && typeof it === "object");
  L.forEach((it) => chatFile(String(it.id ?? ""))); // every id is checked before anything changes
  for (const it of L) {
    const id = String(it.id), c = readChat(id); if (!c) continue;
    if (typeof it.title === "string" && it.title.trim()) c.title = it.title.trim().slice(0, 200);
    for (const k of ["folder", "project"]) if (k in it) c[k] = it[k] == null ? null : String(it[k]).slice(0, 64);
    writeAtomic(chatFile(id), JSON.stringify(c)); const e = entryOf(c); chatIdx.set(id, e); out.push(e);
  }
  saveIdx(); return out;
}
function delChats(ids) {
  const L = (Array.isArray(ids) ? ids : []).map(String); L.forEach(chatFile);
  for (const id of L) { const f = chatFile(id); try { fs.unlinkSync(f); } catch (e) { if (e.code !== "ENOENT") throw e; } chatIdx.delete(id); if (chatTxt) chatTxt.delete(id); }
  saveIdx();
}
function wipeChats() { // "Delete all chats" also removes the copies kept from the move to one file per chat
  try { for (const f of fs.readdirSync(CHATDIR)) if (/\.(json|tmp)$/.test(f) && f !== "_index.json") fs.unlinkSync(path.join(CHATDIR, f)); } catch (e) { if (e.code !== "ENOENT") throw e; }
  try { for (const f of fs.readdirSync(KVDIR)) if (/^orc\.chats\.json(\.bak|\.migrated-backup.*)?$/.test(f)) fs.unlinkSync(path.join(KVDIR, f)); } catch {}
  chatIdx = new Map(); chatTxt = null; saveIdx();
}
function searchChats(q) { // every word must appear in the title or the conversation; the text is read once and kept for 10 minutes
  if (!chatTxt) { chatTxt = new Map(); for (const id of chatIdx.keys()) { const c = readChat(id); if (c) chatTxt.set(id, txtOf(c)); } }
  clearTimeout(txtTimer); txtTimer = setTimeout(() => { chatTxt = null; }, 600000); txtTimer.unref();
  const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 12), hits = [];
  if (!words.length) return hits; // an empty search only reads the text in advance
  for (const e of chatList()) {
    const t = chatTxt.get(e.id) || { b: "", l: "" }, tl = e.title.toLowerCase();
    if (!words.every((w) => t.l.includes(w) || tl.includes(w))) continue;
    const at = t.l.indexOf(words[0]); hits.push({ id: e.id, snip: at < 0 ? "" : t.b.slice(Math.max(0, at - 30), at + 70).replace(/\s+/g, " ") });
    if (hits.length >= 100) break;
  }
  return hits;
}
// at start: read the index and bring it up to date with the chat files (a chat saved just before a crash is picked up)
function loadChats() {
  fs.mkdirSync(CHATDIR, { recursive: true });
  let at = 0, list = null; try { list = JSON.parse(fs.readFileSync(CHATIDX, "utf8")); at = fs.statSync(CHATIDX).mtimeMs; } catch {}
  chatIdx = new Map((Array.isArray(list) ? list : []).filter((e) => e && okId(e.id)).map((e) => [e.id, e]));
  let changed = !Array.isArray(list); const ids = new Set();
  for (const f of fs.readdirSync(CHATDIR)) {
    if (f.endsWith(".tmp")) { try { fs.unlinkSync(path.join(CHATDIR, f)); } catch {} continue; } // a write that never finished; the previous copy is intact
    const id = f.slice(0, -5); if (!f.endsWith(".json") || !okId(id)) continue; ids.add(id);
    let m = 0; try { m = fs.statSync(path.join(CHATDIR, f)).mtimeMs; } catch {}
    if (!chatIdx.has(id) || m >= at) { const c = readChat(id); if (c) { const e = entryOf(c); if (JSON.stringify(e) !== JSON.stringify(chatIdx.get(id))) { chatIdx.set(id, e); changed = true; } } }
  }
  for (const id of [...chatIdx.keys()]) if (!ids.has(id)) { chatIdx.delete(id); changed = true; }
  if (changed) saveIdx();
}
function migrateChats() {
  const old = path.join(KVDIR, "orc.chats.json"); if (!fs.existsSync(old)) return;
  let list = null; for (const f of [old, old + ".bak"]) { try { list = JSON.parse(fs.readFileSync(f, "utf8")); break; } catch {} }
  if (!Array.isArray(list)) { console.error("orc.chats.json could not be read, so it was left as it is."); return; }
  const done = importChats(list);
  const bad = done.filter((d) => { try { const s = fs.readFileSync(chatFile(d.id), "utf8"); return d.hash ? crypto.createHash("sha1").update(s).digest("hex") !== d.hash : !((Number(JSON.parse(s).ts) || 0) >= d.ts); } catch { return true; } });
  if (bad.length) { console.error(bad.length + " chats could not be checked after the move; orc.chats.json is kept and the move runs again next start."); return; }
  let bak = old + ".migrated-backup"; if (fs.existsSync(bak)) bak += "-" + Date.now();
  fs.renameSync(old, bak);
  console.log("Moved " + done.length + " chats to one file each; the old file is kept as " + path.basename(bak));
}
try { loadChats(); migrateChats(); } catch (e) { console.error("chat storage: " + e.message); }

const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const readBody = (req, max = 8e6) => new Promise((ok, bad) => {
  let b = ""; req.on("data", (c) => { b += c; if (b.length > max) { bad(new Error("body too large")); req.destroy(); } }); req.on("end", () => ok(b));
});

http.createServer(async (req, res) => {
  try {
    // DNS-rebinding / cross-site guard: only our own origin and host may talk to us.
    if (req.headers.host !== `127.0.0.1:${PORT}`) return json(res, 403, { error: { message: "bad host" } });
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" });
      return res.end(fs.readFileSync(path.join(here, "index.html"), "utf8").replace("__TOKEN__", TOKEN));
    }
    const STATIC = { "/app.js": "text/javascript", "/brain.js": "text/javascript", "/style.css": "text/css" }; // the page's own code: not secret, loaded by <script>/<link>, which cannot send the token
    if (req.method === "GET" && STATIC[req.url]) {
      res.writeHead(200, { "content-type": STATIC[req.url] + "; charset=utf-8", "cache-control": "no-store" });
      return res.end(fs.readFileSync(path.join(here, req.url.slice(1)), "utf8"));
    }
    const qtok = req.method === "GET" && req.url.startsWith("/api/file?") ? new URL(req.url, "http://x").searchParams.get("t") : null; // previews load through <img>/<iframe>, which cannot send headers
    if (req.headers["x-app-token"] !== TOKEN && qtok !== TOKEN) return json(res, 403, { error: { message: "bad token" } });
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${PORT}`) return json(res, 403, { error: { message: "bad origin" } });

    // ---------- files: attachments, previews, File Explorer
    if (req.method === "POST" && req.url.startsWith("/api/upload?")) {
      try {
        const cfg = loadConfig(), raw = String(new URL(req.url, "http://x").searchParams.get("name") || "file");
        const name = path.basename(raw).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+/, "").slice(0, 150) || "file";
        const d = path.join(cfg.cwd, "Attachments", new Date().toISOString().slice(0, 10)); fs.mkdirSync(d, { recursive: true });
        let p = path.join(d, name); for (let k = 2; fs.existsSync(p); k++) { const e = path.extname(name); p = path.join(d, path.basename(name, e) + ` (${k})` + e); }
        p = checkPath(p, cfg);
        let n = 0; const LIMIT = 500 * 1024 * 1024;
        await pipeline(req, async function* (src) { for await (const c of src) { n += c.length; if (n > LIMIT) throw new Error("file is over 500 MB"); yield c; } }, fs.createWriteStream(p));
        let report = ""; try { report = inspect(p).slice(0, 6000); } catch (e) { report = "Could not read: " + e.message; }
        return json(res, 200, { ok: true, path: p, size: n, report });
      } catch (e) { return json(res, 200, { ok: false, error: String(e.message || e) }); }
    }
    const absOf = (p) => { const cfg = loadConfig(); const s = String(p || "").trim().replace(/^["'`]|["'`]$/g, ""); return path.resolve(path.isAbsolute(s) ? s : path.join(cfg.cwd, s)); };
    if (req.method === "POST" && (req.url === "/api/reveal" || req.url === "/api/open")) {
      const b = JSON.parse(await readBody(req)), abs = absOf(b.path);
      if (!fs.existsSync(abs)) return json(res, 200, { ok: false, error: "File not found: " + abs });
      if (/["\r\n]/.test(abs)) return json(res, 200, { ok: false, error: "Unusual path" });
      if (req.url === "/api/open") {
        if (RUNNABLE.test(abs)) return json(res, 200, { ok: false, error: "Programs and scripts are not opened from here. Use Show in folder." });
        spawn("explorer.exe", [`"${abs}"`], { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
      } else spawn("explorer.exe", [fs.statSync(abs).isDirectory() ? `"${abs}"` : `/select,"${abs}"`], { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref(); // Explorer needs the quotes exactly like this, or paths with spaces open the wrong folder
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/api/fileinfo") {
      const b = JSON.parse(await readBody(req));
      return json(res, 200, (b.paths || []).slice(0, 30).map((p) => { const abs = absOf(p); try { const st = fs.statSync(abs), ext = path.extname(abs).slice(1).toLowerCase(); return { path: abs, exists: true, isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs, ext, mime: MIME[ext] || "", runnable: RUNNABLE.test(abs) }; } catch { return { path: abs, exists: false }; } }));
    }
    if (req.method === "POST" && req.url === "/api/changed") { // files in the working folder created or changed since a time
      const since = Number(JSON.parse(await readBody(req)).since) || Date.now(), cfg = loadConfig(), found = []; let seen = 0;
      const walk = (d, depth) => { let list = []; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of list) { if (++seen > 5000) return; if (/^(node_modules|\.git|__pycache__|\.venv|venv)$/i.test(e.name)) continue; const f = path.join(d, e.name);
          if (e.isDirectory()) { if (depth < 5) walk(f, depth + 1); } else { try { const m = fs.statSync(f).mtimeMs; if (m >= since) found.push([f, m]); } catch {} } } };
      walk(cfg.cwd, 0);
      return json(res, 200, { files: found.sort((a, b) => b[1] - a[1]).slice(0, 20).map((x) => x[0]) });
    }
    if (req.method === "GET" && req.url.startsWith("/api/file?")) {
      try {
        const cfg = loadConfig(), abs = checkPath(absOf(new URL(req.url, "http://x").searchParams.get("path")), cfg), ext = path.extname(abs).slice(1).toLowerCase(), st = fs.statSync(abs);
        if (!st.isFile()) return json(res, 404, { error: { message: "not a file" } });
        // anything that could run script (html, svg, js) is served as plain text or sandboxed, never as a live page
        const type = MIME[ext] || "text/plain; charset=utf-8";
        res.writeHead(200, { "content-type": type, "content-length": st.size, "x-content-type-options": "nosniff", "cache-control": "no-store", ...(ext === "svg" ? { "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'" } : {}) });
        return fs.createReadStream(abs).pipe(res);
      } catch (e) { return json(res, 404, { error: { message: String(e.message || e) } }); }
    }
    if (req.url === "/api/tasks" && req.method === "GET") return json(res, 200, tasks);
    if (req.url === "/api/due") return json(res, 200, due.splice(0));
    if (req.method === "POST" && req.url.startsWith("/api/tasks/")) {
      try {
        const b = JSON.parse(await readBody(req));
        if (req.url === "/api/tasks/save") {
          const t = normalize(b.task); t.nextRun = t.enabled ? nextRun(t.schedule, Date.now()) : null;
          tasks = [...tasks.filter((x) => x.id !== t.id), t]; persist(); return json(res, 200, { ok: true, task: t });
        }
        if (req.url === "/api/tasks/delete") { tasks = tasks.filter((x) => x.id !== b.id); persist(); return json(res, 200, { ok: true }); }
        if (req.url === "/api/tasks/run") { const t = tasks.find((x) => x.id === b.id); if (t) { fire(t, Date.now()); persist(); } return json(res, 200, { ok: !!t }); }
      } catch (e) { return json(res, 200, { ok: false, error: String(e.message || e) }); }
    }
    if (req.url === "/api/kv") {
      if (req.method === "POST") { const b = JSON.parse(await readBody(req, 60e6)); if (b.key === "orc.chats") importChats(b.value); else kvSet(b.key, b.value); return json(res, 200, { ok: true }); } // orc.chats: from a window of the old version
      return json(res, 200, kvAll());
    }
    if (req.url === "/api/chats" || req.url.startsWith("/api/chats/")) {
      try {
        if (req.method === "GET" && req.url === "/api/chats") return json(res, 200, { ok: true, chats: chatList() });
        if (req.method === "GET" && req.url.startsWith("/api/chats/get?")) { const id = String(new URL(req.url, "http://x").searchParams.get("id") || ""); chatFile(id); const c = readChat(id); return json(res, c ? 200 : 404, c ? { ok: true, chat: c } : { ok: false, error: "No such chat." }); }
        if (req.method === "GET" && req.url === "/api/chats/all") return json(res, 200, { ok: true, chats: chatList().map((e) => readChat(e.id)).filter(Boolean) }); // export
        if (req.method === "POST") {
          const b = JSON.parse((await readBody(req, 60e6)) || "{}"), u = req.url;
          if (u === "/api/chats/save") return json(res, 200, { ok: true, chat: putChat(b.chat).entry });
          if (u === "/api/chats/meta") return json(res, 200, { ok: true, chats: metaChats(b.items) });
          if (u === "/api/chats/delete") { delChats(b.ids); return json(res, 200, { ok: true }); }
          if (u === "/api/chats/wipe") { wipeChats(); return json(res, 200, { ok: true }); }
          if (u === "/api/chats/search") return json(res, 200, { ok: true, hits: searchChats(b.q) });
          if (u === "/api/chats/import") return json(res, 200, { ok: true, chats: importChats(b.chats).length });
        }
        return json(res, 404, { ok: false, error: "not found" });
      } catch (e) { return json(res, e.status || (e instanceof SyntaxError ? 400 : 500), { ok: false, error: String(e.message || e) }); }
    }
    if (req.url === "/api/status") return json(res, 200, { omniroute: await orUp(), key: !!key(), keyFromEnv: !!process.env.OMNIROUTE_API_KEY, sandbox: sandboxInfo(), version: VERSION, omniroute_url: OR });
    if (req.url.startsWith("/api/update") && req.url !== "/api/update/install") { try { return json(res, 200, { ok: true, ...(await checkUpdate(req.url.includes("force"))) }); } catch (e) { return json(res, 200, { ok: false, current: VERSION, error: String(e.message || e) }); } }
    if (req.method === "POST" && req.url === "/api/apikey") { // saved for this Windows user only; never sent back to the page
      const k = String(JSON.parse(await readBody(req)).key || "").trim();
      if (k.length > 500 || /[\r\n\s]/.test(k)) return json(res, 200, { ok: false, error: "That does not look like an API key." });
      fs.mkdirSync(CHAT_DIR_, { recursive: true });
      if (k) fs.writeFileSync(KEYFILE, k); else { try { fs.unlinkSync(KEYFILE); } catch {} }
      return json(res, 200, { ok: true, key: !!key() });
    }
    if (req.method === "POST" && req.url === "/api/sandbox") { // raw result for the code-verification pipeline
      const b = JSON.parse(await readBody(req));
      if (String(b.code ?? "").length > 100000) return json(res, 200, { error: "code is too long", stdout: "", stderr: "", exitCode: -1 });
      return json(res, 200, await runSandboxRaw(b.language, b.code, b.timeout));
    }
    if (req.url === "/api/config") {
      if (req.method === "POST") return json(res, 200, saveConfig(JSON.parse(await readBody(req))));
      return json(res, 200, loadConfig());
    }
    if (req.method === "POST" && req.url === "/api/pickfolder") { // the Windows folder picker; only a folder chosen here can be granted
      const ps = "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false; Opacity=0}; $f.Show(); $f.Activate(); " +
        "$d = New-Object System.Windows.Forms.OpenFileDialog; $d.ValidateNames=$false; $d.CheckFileExists=$false; $d.CheckPathExists=$true; $d.FileName='Select this folder'; $d.Title='Choose a folder for OmniGPT to work in'; " +
        "if ($d.ShowDialog($f) -eq 'OK') { [Console]::Out.Write((Split-Path -Parent $d.FileName)) }; $f.Close()";
      const out = await new Promise((ok) => { let o = ""; const c = spawn("powershell.exe", ["-NoProfile", "-Sta", "-Command", ps], { windowsHide: true }); c.stdout.on("data", (d) => (o += d)); c.on("close", () => ok(o.trim())); c.on("error", () => ok("")); });
      if (!out) return json(res, 200, { ok: false, cancelled: true });
      try { return json(res, 200, { ok: true, path: grantFolder(out) }); } catch (e) { return json(res, 200, { ok: false, error: String(e.message || e) }); }
    }
    if (req.method === "POST" && req.url === "/api/ungrant") return json(res, 200, { ok: true, granted: ungrantFolder(JSON.parse(await readBody(req)).path) });
    if (req.method === "POST" && req.url === "/api/undo") {
      try { const b = JSON.parse(await readBody(req)); return json(res, 200, await undoTurn(b.turn, folderConfig(loadConfig(), b.folder))); }
      catch (e) { return json(res, 200, { ok: false, error: String(e.message || e) }); }
    }
    if (req.method === "POST" && req.url === "/api/undo/info") return json(res, 200, { ok: true, ...undoInfo(JSON.parse(await readBody(req)).turn) });
    if (req.url === "/api/jobs") return json(res, 200, { ok: true, jobs: listJobs() }); // the user's own view: lists and stops jobs without approval
    if (req.method === "POST" && req.url === "/api/jobs/stop") { try { return json(res, 200, { ok: true, text: await stopJob(JSON.parse(await readBody(req)).id) }); } catch (e) { return json(res, 200, { ok: false, error: String(e.message || e) }); } }
    if (req.url === "/api/activity") return json(res, 200, { ok: true, items: readActivity(400) });
    // ---------- Settings > Accounts: the page sends links and keys here once; it only ever gets names, hosts and masked hints back
    if (req.method === "GET" && req.url === "/api/connections") return json(res, 200, { ok: true, connections: publicList(), github: await ghStatus() });
    if (req.method === "POST" && req.url.startsWith("/api/connections/")) {
      try {
        const b = JSON.parse((await readBody(req, 64000)) || "{}");
        if (req.url === "/api/connections/save") return json(res, 200, { ok: true, connection: await saveConnection(b) });
        if (req.url === "/api/connections/delete") { deleteConnection(b.id); return json(res, 200, { ok: true }); }
        if (req.url === "/api/connections/test") return json(res, 200, { ok: true, message: await testConnection(b.id) });
        if (req.url === "/api/connections/github-login") return json(res, 200, { ok: true, message: await ghLogin() });
      } catch (e) { return json(res, 200, { ok: false, error: String(e.message || e) }); }
    }
    if (req.url === "/api/pricing") return json(res, 200, { ok: true, pricing: await pricing() });
    // ---------- finding things by meaning: memories, skills and recall (scores from OmniRoute embeddings), Settings > Search by meaning
    if (req.method === "POST" && req.url === "/api/embed") { // keeps going if the page stops waiting, so the cache is warm next time
      try { return json(res, 200, { ok: true, ...(await embedApi(JSON.parse(await readBody(req, 8e6)))) }); } catch (e) { return json(res, 200, { ok: false, error: String(e.message || e) }); }
    }
    if (req.method === "GET" && req.url.startsWith("/api/meaning")) {
      const s = meaningSettings(); let models = [], error = "";
      try { models = await embedModels(req.url.includes("refresh")); } catch (e) { error = String(e.message || e); }
      return json(res, 200, { ok: true, models, auto: models[0] || null, autoLocal: !!(models[0] && isLocalModel(models[0])), setting: s.model, docs: s.docs, error, index: indexInfo() });
    }
    if (req.method === "POST" && req.url === "/api/meaning/clear") return json(res, 200, { ok: true, index: await clearIndexQueued() });
    if (req.method === "POST" && req.url === "/api/update/install") {
      try { return json(res, 200, { ok: true, ...(await installUpdate()) }); }
      catch (e) { return json(res, 200, { ok: false, error: String(e.message || e) }); }
    }
    if (req.method === "POST" && req.url === "/api/resolve") {
      try { const b = JSON.parse(await readBody(req)); return json(res, 200, { ok: true, lists: resolveScope(b.lists, folderConfig(loadConfig(), b.folder)) }); }
      catch (e) { return json(res, 200, { ok: false, error: String(e.message || e) }); }
    }
    if (req.method === "POST" && (req.url === "/api/precheck" || req.url === "/api/run")) {
      const { name, input, scope, folder, turn, chat } = JSON.parse(await readBody(req));
      try {
        const cfg = folderConfig(loadConfig(), folder);
        if (req.url === "/api/precheck") return json(res, 200, { ok: true, ...(await precheck(name, input, cfg, scope)), inside: insideFolder(name, input, cfg) });
        return json(res, 200, { ok: true, output: await run(name, input, cfg, scope, { turn, chat }) });
      } catch (e) {
        return json(res, 200, { ok: false, error: String(e.message || e) });
      }
    }
    if (!key()) return json(res, 500, { error: { message: "OMNIROUTE_API_KEY is not set in your Windows user environment." } });
    const headers = { authorization: "Bearer " + key(), "anthropic-version": "2023-06-01", "content-type": "application/json" };
    if (req.url === "/api/models") {
      const r = await fetch(OR + "/v1/models", { headers });
      return json(res, r.status, await r.json());
    }
    if (req.method === "POST" && req.url === "/api/messages") {
      const body = await readBody(req, 80e6); // attached images travel inside the message
      const ac = new AbortController();
      res.on("close", () => ac.abort());
      const r = await fetch(OR + "/v1/messages", { method: "POST", headers, body, signal: ac.signal });
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/json", "cache-control": "no-cache" });
      const rs = Readable.fromWeb(r.body);
      rs.on("error", () => res.end());
      res.on("error", () => {});
      return rs.pipe(res);
    }
    json(res, 404, { error: { message: "not found" } });
  } catch (e) {
    if (!res.headersSent) json(res, 502, { error: { message: String(e.message || e) } });
    else res.end();
  }
}).on("error", (e) => { console.error("Cannot listen on " + PORT + ": " + e.message); process.exit(1); }).listen(PORT, "127.0.0.1", () => { console.log("OmniRoute Chat on http://127.0.0.1:" + PORT); ensureOmniRoute(); });
