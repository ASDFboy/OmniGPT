// PC tools for OmniRoute Chat. Every call goes through precheck() (hard rules) before run().
// Hard rules are a seatbelt, not a sandbox: the reviewer agent and the user's approval are the real gates.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import dns from "node:dns/promises";
import net from "node:net";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { webOpen, webSearch } from "./web.mjs";
import { inspect } from "./files.mjs";

const HOME = os.homedir();
// ---------- code sandbox (AppContainer helper, see Sandbox.cs): code runs with no network and no access to the user's files
const ROOT = process.env.OMNIGPT_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SBX = path.join(ROOT, "OmniGPT.Sandbox.exe");
export function sandboxInfo() {
  return { available: fs.existsSync(SBX), python: fs.existsSync(path.join(ROOT, "sandbox", "python", "python.exe")), javascript: fs.existsSync(path.join(ROOT, "runtime", "node.exe")) };
}
const LANG = { python: "python", py: "python", python3: "python", javascript: "javascript", js: "javascript", node: "javascript", nodejs: "javascript" };
// models sometimes name the field differently or leave the language out: accept "lang" and otherwise infer it from the code
export function langOf(i) {
  const named = LANG[String(i.language || i.lang || "").toLowerCase()];
  if (named) return named;
  const code = String(i.code ?? "");
  if (/\b(def |import |print\()/.test(code) && !/\b(console\.log|const |let |=>)/.test(code)) return "python";
  if (/\b(console\.log|const |let |=>|function\s)/.test(code)) return "javascript";
  return undefined;
}
export function runSandboxRaw(language, code, timeoutSec = 10, memMB = 256) {
  return new Promise((ok) => {
    const lang = LANG[String(language || "").toLowerCase()];
    if (!lang) return ok({ error: "unsupported language: " + language, stdout: "", stderr: "", exitCode: -1 });
    if (!fs.existsSync(SBX)) return ok({ error: "the code sandbox is not installed", stdout: "", stderr: "", exitCode: -1 });
    const secs = Math.min(Math.max(Number(timeoutSec) | 0 || 10, 1), 30);
    const c = spawn(SBX, [ROOT, lang, String(secs), String(memMB)], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
    const kill = setTimeout(() => { try { c.kill(); } catch {} }, (secs + 25) * 1000);
    c.on("close", () => { clearTimeout(kill); try { ok(JSON.parse(out)); } catch { ok({ error: "sandbox helper failed: " + (err || out).slice(0, 200), stdout: "", stderr: "", exitCode: -1 }); } });
    c.on("error", (e) => { clearTimeout(kill); ok({ error: String(e.message), stdout: "", stderr: "", exitCode: -1 }); });
    c.stdin.on("error", () => {}); c.stdin.end(String(code));
  });
}
export function formatSandbox(r) {
  const head = r.error ? `The sandbox could not run the code: ${r.error}` : r.timedOut ? "The program was stopped because it ran too long." : `exit code ${r.exitCode} (${r.ms} ms)`;
  return [head, r.stdout ? "--- stdout ---\n" + r.stdout.trimEnd() : "", r.stderr ? "--- stderr ---\n" + r.stderr.trimEnd() : ""].filter(Boolean).join("\n");
}

const CFG_DIR = path.join(process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local"), "OmniRouteChat");
const CFG = path.join(CFG_DIR, "config.json");
const BACKUPS = path.join(CFG_DIR, "backups");
// OmniRoute's data folder (it holds provider keys): from DATA_DIR, the "omnirouteDataDir" setting, or OmniRoute's default ~/.omniroute
export const omnirouteDataDir = () => { let c = {}; try { c = JSON.parse(fs.readFileSync(CFG, "utf8")); } catch {} return process.env.DATA_DIR || c.omnirouteDataDir || path.join(HOME, ".omniroute"); };
const WORKSPACE = path.join(HOME, "Documents", "OmniRoute Workspace");
const DEFAULTS = {
  approval: "ask", // "ask" | "auto" | "highonly" (highonly = only high-risk actions are stopped; auto = reviewer-approved low-risk actions run without a click; deletes always ask)
  cwd: WORKSPACE,
  roots: [WORKSPACE, path.join(HOME, "Documents"), path.join(HOME, "Downloads"), path.join(HOME, "Desktop")],
};

export function loadConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CFG, "utf8")); } catch {}
  const cfg = { ...DEFAULTS, ...c };
  fs.mkdirSync(WORKSPACE, { recursive: true });
  return cfg;
}
export function saveConfig(input) {
  const cur = loadConfig();
  const next = {
    ...cur, // keeps settings this form does not edit (attached folders, OmniRoute data folder)
    approval: ["auto", "highonly", "bypass"].includes(input.approval) ? input.approval : "ask",
    cwd: String(input.cwd || cur.cwd),
    roots: (Array.isArray(input.roots) ? input.roots : cur.roots).map(String).filter(Boolean),
    granted: (cur.granted || []).map(String), // only changed by grantFolder/ungrantFolder (the user's own folder picker)
    omnirouteDataDir: typeof input.omnirouteDataDir === "string" ? input.omnirouteDataDir.trim() : (cur.omnirouteDataDir || ""),
  };
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(CFG, JSON.stringify(next, null, 2));
  return next;
}

// ---------- folders the user attached with the folder picker: the agents may do anything inside them
export function grantFolder(p) {
  const abs = real(path.resolve(String(p || "")));
  let st; try { st = fs.statSync(abs); } catch { throw new Error("That folder does not exist."); }
  if (!st.isDirectory()) throw new Error("That is not a folder.");
  if (/^[a-z]:\\?$/i.test(abs)) throw new Error("A whole drive is too broad. Choose a folder inside it.");
  if (lc(abs) === lc(real(HOME)) || lc(abs) === lc(real(path.dirname(HOME)))) throw new Error("Your whole user folder is too broad. Choose a folder inside it.");
  const dataDir = lc(real(omnirouteDataDir())); // a folder may contain OmniRoute's data folder: the file tools still refuse to touch it
  if (DENY_DIRS().some((d) => under(abs, d) || (lc(d) !== dataDir && under(d, abs))) || abs.split("\\").some((s) => DENY_SEG.has(lc(s)))) throw new Error("That folder is, or contains, a protected location (Windows, program files, app data or credentials).");
  const cur = loadConfig(), granted = [...(cur.granted || []).filter((g) => lc(g) !== lc(abs)), abs];
  fs.mkdirSync(CFG_DIR, { recursive: true }); fs.writeFileSync(CFG, JSON.stringify({ ...cur, granted }, null, 2));
  return abs;
}
export function ungrantFolder(p) {
  const cur = loadConfig(), granted = (cur.granted || []).filter((g) => lc(g) !== lc(String(p || "")));
  fs.writeFileSync(CFG, JSON.stringify({ ...cur, granted }, null, 2)); return granted;
}
// The working configuration for a conversation with an attached folder. A folder the user did not attach is refused.
export function folderConfig(cfg, folder) {
  if (!folder) return cfg;
  const f = (cfg.granted || []).find((g) => lc(g) === lc(real(path.resolve(String(folder)))));
  if (!f) throw new Error("This folder was not attached by the user.");
  return { ...cfg, cwd: f, roots: [...cfg.roots, f], folder: f };
}
// true when every path an action touches is inside the attached folder; "command" for shell commands (they cannot be checked by path)
export function insideFolder(name, input, cfg) {
  if (!cfg.folder) return false;
  const i = input || {}, ps = [];
  if (name === "run_command") { // a command that names anything outside the folder goes through normal approval
    const c = String(i.command || ""), quoted = [...c.matchAll(/(["'])([a-z]:[\\/][^"']*)\1/gi)].map((m) => m[2]);
    const named = [...quoted, ...[...c.replace(/(["'])[a-z]:[\\/][^"']*\1/gi, " ").matchAll(/[a-z]:[\\/][^"'\s;|,)]*/gi)].map((m) => m[0])];
    if (/\.\.[\\/]|\$home|\$env:|\$profile|~[\\/]|(^|[\s"'])\\\\[^\\]|\b(cd|set-location|push-location|pushd)\s+[a-z]:/i.test(c) || named.some((p) => !under(real(p), cfg.folder))) return false;
    return "command";
  }
  for (const k of ["path", "source", "destination"]) if (typeof i[k] === "string") ps.push(i[k]);
  for (const p of i.paths || []) ps.push(p);
  for (const f of i.files || []) if (f) ps.push(f.path);
  for (const m of i.moves || []) if (m) ps.push(m.source, m.destination);
  if (!ps.length || ps.some((p) => typeof p !== "string")) return false;
  return ps.every((p) => under(real(path.isAbsolute(p) ? p : path.join(cfg.folder, p)), cfg.folder));
}

// ---------- path policy
const lc = (s) => s.toLowerCase();
function real(p) { // realpath of the deepest existing ancestor + the remainder, so symlinks/junctions can't escape
  let cur = path.resolve(p), rest = [];
  while (!fs.existsSync(cur)) { const up = path.dirname(cur); if (up === cur) break; rest.unshift(path.basename(cur)); cur = up; }
  try { cur = fs.realpathSync.native(cur); } catch {}
  return path.join(cur, ...rest);
}
const under = (p, root) => { const a = lc(p), r = lc(root).replace(/[\\/]+$/, ""); return a === r || a.startsWith(r + "\\"); };
const DENY_DIRS = () => [
  omnirouteDataDir(), CFG_DIR, path.join(HOME, "AppData"), path.join(HOME, ".claude"), path.join(HOME, ".ssh"), path.join(HOME, ".aws"),
  path.join(HOME, ".gnupg"), path.join(HOME, ".azure"), path.join(HOME, ".kube"),
  process.env.SystemRoot || "C:\\Windows", process.env.ProgramFiles || "C:\\Program Files",
  process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", process.env.ProgramData || "C:\\ProgramData",
].map(real);
const DENY_SEG = new Set([".ssh", ".aws", ".gnupg", ".azure", ".kube", ".claude", "appdata", "$recycle.bin", "system volume information"]);
const DENY_FILE = /^(id_(rsa|ed25519|ecdsa|dsa)|\.env(\..*)?|.*\.(pem|pfx|p12|key|kdbx|ppk)|credentials(\..*)?|\.npmrc|\.netrc|.*cookies.*|login data|web data)$/i;

export function checkPath(p, cfg) {
  if (typeof p !== "string" || !p.trim()) throw new Error("path is required");
  const abs = real(path.isAbsolute(p) ? p : path.join(cfg.cwd, p));
  if (!cfg.roots.map(real).some((r) => under(abs, r))) throw new Error(`Path is outside the allowed folders: ${abs}`);
  const bad = DENY_DIRS().find((d) => under(abs, d));
  if (bad) throw new Error(`Protected location: ${abs}`);
  if (abs.split("\\").some((s) => DENY_SEG.has(lc(s)))) throw new Error(`Protected location: ${abs}`);
  if (DENY_FILE.test(path.basename(abs))) throw new Error(`Credential-style file name is blocked: ${path.basename(abs)}`);
  return abs;
}

// ---------- command policy (seatbelt only)
const CMD_RULES = [
  [/\b(format-volume|diskpart|bcdedit|cipher\s+\/w|vssadmin|wbadmin|clear-disk|remove-partition|initialize-disk)\b/i, "disk/boot/backup destruction"],
  [/\b(set-mppreference|add-mppreference|disable-windowsoptionalfeature|stop-service\s+\S*(defender|windefend|mpssvc|wuauserv))/i, "disabling security features"],
  [/netsh\s+advfirewall|set-netfirewall|new-netfirewallrule|set-executionpolicy|\bsecedit\b|\bauditpol\b|\bgpupdate\b|\bwmic\b/i, "security/system configuration"],
  [/\breg(\.exe)?\s+(add|delete|import|load|save)|new-itemproperty|set-itemproperty\s+\S*(hk[lc][mu]|registry::)|remove-itemproperty|\bhk(lm|cu|cr|u):/i, "registry changes"],
  [/\b(schtasks|register-scheduledtask|new-scheduledtask|new-service|\bsc(\.exe)?\s+(create|config)|set-service|new-scheduledtasktrigger)\b|\\startup\\|run\\?once|\bnssm\b/i, "persistence (services, tasks, startup)"],
  [/\b(iex|invoke-expression)\b|\bdownloadstring\b|\bdownloadfile\b.*\b(start|iex)|-enc(odedcommand)?\b|frombase64string|\bcertutil\b.*-(urlcache|decode)|\bbitsadmin\b|\bmshta\b|\bregsvr32\b|\brundll32\b|\bwscript\b|\bcscript\b/i, "obfuscated or download-and-execute code"],
  [/\b(invoke-webrequest|iwr|invoke-restmethod|irm|curl|wget|start-bitstransfer)\b/i, "network downloads must use the download_file tool"],
  [/\b(get-childitem|gci|dir|ls|get-item|gi|get-content|gc|cat|type)\b[^|;]*\benv:|\bprintenv\b|\[environment\]::getenvironmentvariable|\$env:\w*(key|token|secret|pass|omniroute)|\bgetenvironmentvariables\b|(^|[;|&]\s*)set\s*($|[;|&])/i, "reading environment variables"],
  [/\.ssh|\.aws|\.gnupg|\.azure|\.kube|\.claude|\\appdata\\|omniroute\\data|id_rsa|id_ed25519|\.pem\b|\.kdbx|\.env\b|cookies|login data|credential|\bcmdkey\b|vaultcmd|get-credential|security\s+find|lsass|mimikatz|sam\b.*system/i, "credential or protected-location access"],
  [/\b(remove-item|rm|del|erase|rd|rmdir|ri)\b[^;|]*(\s|^)(['"]?[a-z]:[\\/]?['"]?(\s|$|[;|&])|['"]?[a-z]:[\\/]\*|[\\/]\*|~(\s|$|[;|&])|\$home(\s|$|[;|&])|\$home[\\/](documents|desktop|downloads)([\\/]?\*)?(\s|$|[;|&])|\$env:(userprofile|systemroot|windir|programfiles))/i, "deleting a drive root or home folder"],
  [/\bstart-process\b[^;|]*\b-verb\s+runas\b|\bnet\s+(user|localgroup)\b|\bnew-localuser\b|\badd-localgroupmember\b|\btakeown\b|\bicacls\b[^;|]*\/(grant|reset|setowner)/i, "privilege or account changes"],
  [/\b(stop-process|taskkill|kill)\b[^;|]*\b(node|omniroute|python|explorer|csrss|winlogon|lsass|msedge)\b/i, "stopping core or app processes"],
  [/\b(shutdown|restart-computer|stop-computer|logoff)\b/i, "shutting down the computer"],
];
// In bypass mode only the rules that protect secrets and the machine itself stay: disk destruction, reading environment or credentials, wiping a drive or home folder, shutdown.
const BYPASS_KEEPS = new Set([0, 7, 8, 9, 12]);
export function checkCommand(cmd, bypass = false) {
  if (typeof cmd !== "string" || !cmd.trim()) throw new Error("command is required");
  if (cmd.length > (bypass ? 50000 : 4000)) throw new Error(`command is too long (${bypass ? 50000 : 4000} chars max)`);
  for (const [k, [re, why]] of CMD_RULES.entries()) if ((!bypass || BYPASS_KEEPS.has(k)) && re.test(cmd)) throw new Error(`Blocked by safety rules: ${why}`);
}

// ---------- URL policy (download_file)
export async function checkUrl(u) {
  const url = new URL(u);
  if (!/^https?:$/.test(url.protocol)) throw new Error("only http(s) URLs are allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  for (const { address: a } of addrs) {
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a) || /^(::1?$|fc|fd|fe80)/i.test(a) || /^::ffff:(127|10|192\.168|169\.254)/i.test(a))
      throw new Error(`URL resolves to a private/local address (${a})`);
  }
  return url;
}

// ---------- lanes: a parallel worker may only modify the paths assigned to it
function laneCheck(abs, scope, cfg, ancestorOk) {
  if (!scope) return;
  const lanes = (scope.writes || []).map((w) => checkPath(w, cfg));
  if (!lanes.some((r) => under(abs, r) || (ancestorOk && under(r, abs)))) throw new Error(`Outside this worker's lane (it may only modify: ${lanes.join("; ") || "nothing"})`);
}
export function resolveScope(lists, cfg = loadConfig()) { return lists.map((l) => (l || []).map((p) => checkPath(p, cfg))); }

// ---------- precheck: validate + classify. Throws on a hard block.
const list = (v, max) => { if (!Array.isArray(v) || !v.length) throw new Error("a non-empty list is required"); if (v.length > max) throw new Error(`at most ${max} items per call`); return v; };
export async function precheck(name, input, cfg = loadConfig(), scope) {
  const i = input || {};
  const W = (p) => { const a = checkPath(p, cfg); laneCheck(a, scope, cfg); return a; }; // write-class paths must be inside the lane
  switch (name) {
    case "run_command": if (scope) throw new Error("Commands are not available to parallel workers"); checkCommand(i.command, cfg.approval === "bypass"); return { class: "exec", summary: `PowerShell in ${cfg.cwd}:\n${i.command}` };
    case "read_file": { const p = checkPath(i.path, cfg); return { class: "read", summary: `Read ${p}` }; }
    case "list_dir": { const p = checkPath(i.path || ".", cfg); return { class: "read", summary: `List ${p}${i.recursive ? " (recursive)" : ""}` }; }
    case "write_file": { const p = W(i.path); return { class: "write", summary: `${fs.existsSync(p) ? "OVERWRITE" : "Create"} ${p} (${String(i.content ?? "").length} chars)` }; }
    case "edit_file": { const p = W(i.path); return { class: "write", summary: `Edit ${p}\n- ${String(i.old_string ?? "").slice(0, 400)}\n+ ${String(i.new_string ?? "").slice(0, 400)}` }; }
    case "make_dir": { const p = checkPath(i.path, cfg); laneCheck(p, scope, cfg, true); return { class: "write", summary: `Create folder ${p}` }; } // a parent folder of your own lane is allowed
    case "copy_file": { const a = checkPath(i.source, cfg), b = W(i.destination); return { class: "write", summary: `Copy ${a}\n  to ${b}` }; }
    case "move_file": { const a = W(i.source), b = W(i.destination); return { class: "write", summary: `Move ${a}\n  to ${b}` }; }
    case "delete_file": {
      const p = W(i.path);
      if (cfg.roots.map(real).some((r) => lc(r) === lc(p)) || lc(p) === lc(real(HOME))) throw new Error("Refusing to delete an allowed root or home folder");
      return { class: "delete", summary: `Move to Recycle Bin: ${p}` };
    }
    case "run_code": {
      const lang = langOf(i);
      if (!lang) throw new Error("language must be python or javascript");
      const code = String(i.code ?? ""); if (!code.trim()) throw new Error("code is required"); if (code.length > 100000) throw new Error("code is too long (100000 chars max)");
      const secs = Math.min(Math.max(Number(i.timeout_sec) || 10, 1), 30);
      return { class: "sandbox", summary: `Run ${lang} in the isolated sandbox (no network, no access to your files; ${secs}s limit)\n${code.slice(0, 700)}` };
    }
    case "read_files": {
      const L = list(i.paths, 20).map((p) => checkPath(p, cfg));
      return { class: "read", summary: `Read ${L.length} files:\n${L.map((p) => "- " + p).join("\n")}` };
    }
    case "write_files": {
      const L = list(i.files, 20).map((f) => { if (!f || typeof f !== "object") throw new Error("files must be objects with path and content"); const p = W(f.path); return `- ${fs.existsSync(p) ? "OVERWRITE" : "create"} ${p} (${String(f.content ?? "").length} chars)`; });
      return { class: "write", summary: `Write ${L.length} files:\n${L.join("\n")}` };
    }
    case "move_files": {
      const L = list(i.moves, 50).map((m) => { if (!m || typeof m !== "object") throw new Error("moves must be objects with source and destination"); return `- ${W(m.source)}\n    to ${W(m.destination)}`; });
      return { class: "write", summary: `Move ${L.length} items:\n${L.join("\n")}` };
    }
    case "delete_files": {
      const L = list(i.paths, 50).map((p) => { const a = W(p); if (cfg.roots.map(real).some((r) => lc(r) === lc(a)) || lc(a) === lc(real(HOME))) throw new Error("Refusing to delete an allowed root or home folder"); return a; });
      return { class: "delete", summary: `Move ${L.length} items to the Recycle Bin:\n${L.map((p) => "- " + p).join("\n")}` };
    }
    case "download_file": { const u = await checkUrl(i.url); const p = W(i.path); return { class: "network", summary: `Download ${u.href}\n  to ${p}` }; }
    case "inspect_file": { const p = checkPath(i.path, cfg); return { class: "read", summary: `Inspect ${p}` }; }
    case "web_search": { const q = String(i.query || "").trim(); if (!q) throw new Error("query is required"); if (q.length > 300) throw new Error("query is too long (300 chars max)"); return { class: "web", summary: `Search the web: ${q}` }; }
    case "web_open": { const u = await checkUrl(i.url); return { class: "web", summary: `Open ${u.href}` }; }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------- run
const cap = (s, n = 12000) => (s.length > n ? s.slice(0, n / 2) + `\n…[${s.length - n} chars omitted]…\n` + s.slice(-n / 2) : s);
function backup(p) {
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return;
  fs.mkdirSync(BACKUPS, { recursive: true });
  fs.copyFileSync(p, path.join(BACKUPS, `${new Date().toISOString().replace(/[:.]/g, "-")}__${path.basename(p)}`));
}
function ps(script, env, cwd, timeoutMs) {
  return new Promise((ok) => {
    const clean = Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([k]) => !/key|token|secret|passw|omniroute|api/i.test(k) || k in env));
    const c = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8\n" + script], { cwd, env: clean, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", timedOut = false;
    c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => { timedOut = true; spawn("taskkill", ["/pid", String(c.pid), "/t", "/f"], { windowsHide: true }); }, timeoutMs);
    c.on("close", (code) => { clearTimeout(t); ok({ code, out: cap(out), timedOut }); });
    c.on("error", (e) => { clearTimeout(t); ok({ code: -1, out: String(e), timedOut: false }); });
  });
}

// File changes run one at a time so parallel workers can never interleave writes.
let chain = Promise.resolve();
export function run(name, input, cfg = loadConfig(), scope) {
  const go = async () => { await precheck(name, input, cfg, scope); return runInner(name, input, cfg); };
  if (["run_command", "run_code", "read_file", "read_files", "list_dir", "download_file", "web_search", "web_open", "inspect_file"].includes(name)) return go();
  const p = chain.then(go, go); chain = p.catch(() => {}); return p;
}
async function runInner(name, input, cfg) {
  await precheck(name, input, cfg); // re-validate: never trust an earlier check
  const i = input || {};
  switch (name) {
    case "run_command": {
      const secs = Math.min(Math.max(Number(i.timeout_sec) || 60, 1), 300);
      const r = await ps(i.command, {}, cfg.cwd, secs * 1000);
      return `${r.timedOut ? `[timed out after ${secs}s and was stopped]\n` : ""}${r.out || "(no output)"}\n[exit code ${r.code}]`;
    }
    case "read_file": {
      const p = checkPath(i.path, cfg), st = fs.statSync(p);
      if (!st.isFile()) throw new Error("not a file");
      const max = Math.min(Number(i.max_bytes) || 100000, 500000);
      const buf = Buffer.alloc(Math.min(st.size, max)); const fd = fs.openSync(p, "r"); fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
      if (buf.includes(0)) throw new Error("binary file; cannot display");
      return buf.toString("utf8") + (st.size > max ? `\n…[truncated; file is ${st.size} bytes]` : "");
    }
    case "list_dir": {
      const root = checkPath(i.path || ".", cfg), rows = [];
      const walk = (d, depth) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (rows.length >= 300) return;
          if (DENY_SEG.has(lc(e.name))) continue;
          const full = path.join(d, e.name);
          let size = ""; try { if (e.isFile()) size = " " + fs.statSync(full).size + "B"; } catch {}
          rows.push(`${e.isDirectory() ? "[dir] " : "      "}${path.relative(root, full)}${size}`);
          if (i.recursive && e.isDirectory() && depth < 3) walk(full, depth + 1);
        }
      };
      walk(root, 1);
      return rows.join("\n") || "(empty)" + (rows.length >= 300 ? "\n…[first 300 entries]" : "");
    }
    case "write_file": { const p = checkPath(i.path, cfg); backup(p); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, String(i.content ?? "")); return `Wrote ${p}`; }
    case "edit_file": {
      const p = checkPath(i.path, cfg), txt = fs.readFileSync(p, "utf8"), o = String(i.old_string ?? "");
      if (!o) throw new Error("old_string is required");
      const n = txt.split(o).length - 1;
      if (n === 0) throw new Error("old_string not found");
      if (n > 1 && !i.replace_all) throw new Error(`old_string matches ${n} places; make it unique or set replace_all`);
      backup(p); fs.writeFileSync(p, txt.split(o).join(String(i.new_string ?? ""))); return `Edited ${p} (${n} replacement${n > 1 ? "s" : ""})`;
    }
    case "make_dir": { const p = checkPath(i.path, cfg); fs.mkdirSync(p, { recursive: true }); return `Created ${p}`; }
    case "copy_file": { const a = checkPath(i.source, cfg), b = checkPath(i.destination, cfg); if (fs.existsSync(b)) throw new Error("destination already exists"); fs.mkdirSync(path.dirname(b), { recursive: true }); await fsp.cp(a, b, { recursive: true }); return `Copied to ${b}`; }
    case "move_file": { const a = checkPath(i.source, cfg), b = checkPath(i.destination, cfg); if (fs.existsSync(b)) throw new Error("destination already exists"); fs.mkdirSync(path.dirname(b), { recursive: true }); try { fs.renameSync(a, b); } catch { await fsp.cp(a, b, { recursive: true }); await fsp.rm(a, { recursive: true }); } return `Moved to ${b}`; }
    case "delete_file": {
      const p = checkPath(i.path, cfg); if (!fs.existsSync(p)) throw new Error("not found");
      const dir = fs.statSync(p).isDirectory();
      const r = await ps(`Add-Type -AssemblyName Microsoft.VisualBasic; $p=$env:ORC_P; if(${dir ? "$true" : "$false"}){[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin')}else{[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin')}`, { ORC_P: p }, cfg.cwd, 30000);
      if (r.code !== 0) throw new Error(r.out);
      return `Moved to Recycle Bin: ${p}`;
    }
    case "run_code": return formatSandbox(await runSandboxRaw(langOf(i), i.code, i.timeout_sec));
    case "read_files": case "write_files": case "move_files": case "delete_files": {
      const single = { read_files: ["read_file", (p) => ({ path: p }), i.paths], write_files: ["write_file", (f) => f, i.files], move_files: ["move_file", (m) => m, i.moves], delete_files: ["delete_file", (p) => ({ path: p }), i.paths] }[name];
      const out = []; let failed = 0;
      for (const item of single[2]) {
        const label = typeof item === "string" ? item : item.path || item.source;
        try { const r = await runInner(single[0], single[1](item), cfg); out.push(name === "read_files" ? `=== ${label} ===\n${r}` : `OK    ${label}`); }
        catch (e) { failed++; out.push(`ERROR ${label}: ${e.message}`); }
      }
      return out.join("\n") + (failed ? `\n[${failed} of ${single[2].length} failed]` : "");
    }
    case "inspect_file": return inspect(checkPath(i.path, cfg), Math.max(0, Number(i.offset) || 0));
    case "web_search": return webSearch(i);
    case "web_open": return webOpen(i);
    case "download_file": {
      let url = await checkUrl(i.url); const p = checkPath(i.path, cfg);
      if (fs.existsSync(p)) throw new Error("destination already exists");
      let res;
      for (let hop = 0; hop < 5; hop++) {
        res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(120000) });
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) { url = await checkUrl(new URL(res.headers.get("location"), url).href); continue; }
        break;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const LIMIT = 200 * 1024 * 1024; let n = 0;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = p + ".part";
      try {
        await pipeline(Readable.fromWeb(res.body), async function* (src) { for await (const c of src) { n += c.length; if (n > LIMIT) throw new Error("download exceeds 200 MB limit"); yield c; } }, fs.createWriteStream(tmp));
        fs.renameSync(tmp, p);
      } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
      return `Downloaded ${n} bytes to ${p}. The file was NOT opened or executed.`;
    }
  }
}
