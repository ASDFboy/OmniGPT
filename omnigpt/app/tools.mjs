// PC tools for OmniRoute Chat. Every call goes through precheck() (hard rules) before run().
// Hard rules are a seatbelt, not a sandbox: the reviewer agent and the user's approval are the real gates.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import { webOpen, webSearch } from "./web.mjs";
import { inspect } from "./files.mjs";
import { zipBuild, zipRead } from "./zip.mjs";
import { browserAction } from "./browser.mjs";
import { startJob, stopJob, readJob, PASS_CODE } from "./jobs.mjs";
export { listJobs, stopAllJobs, stopJob } from "./jobs.mjs";
import { parseMarkdown, toHtml, toDocx, toXlsx, toPptx, sheetsFromText, slidesFromText } from "./docs.mjs";

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

// Never deleted, whatever folders the user has allowed: allowed roots, drives, the home folder and its main personal folders.
const PERSONAL = ["Documents", "Desktop", "Downloads", "Pictures", "Music", "Videos", "OneDrive", "AppData", ".ssh"];
const noDelete = (p, cfg) => { const x = lc(p).replace(/[\\/]+$/, "");
  return /^[a-z]:$/.test(x) || x === "" || cfg.roots.map(real).some((r) => lc(r) === lc(p)) || [HOME, ...PERSONAL.map((d) => path.join(HOME, d))].some((d) => lc(real(d)) === lc(p)); };

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
const under = (p, root) => { const a = lc(p), r = lc(root).replace(/[\\/]+$/, ""); return a === r || a.startsWith(r + path.sep); }; // path.sep is "\\" on Windows
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
  if (abs.split(path.sep).some((s) => DENY_SEG.has(lc(s)))) throw new Error(`Protected location: ${abs}`);
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
    case "start_process": {
      if (scope) throw new Error("Background jobs are not available to parallel workers");
      checkCommand(i.command, cfg.approval === "bypass");
      const d = i.cwd ? checkPath(i.cwd, cfg) : cfg.cwd;
      return { class: "exec", summary: `Start in the background${i.name ? ` ("${String(i.name).slice(0, 60)}")` : ""}, PowerShell in ${d}:\n${i.command}\n(It keeps running until it ends, is stopped, or OmniGPT closes.)` };
    }
    case "read_process": return { class: "read", summary: i.id ? `Read the output of background job ${i.id}${i.wait ? ` (waiting up to ${Math.min(Number(i.wait) || 0, 60)} s${i.until ? ` for "${String(i.until).slice(0, 60)}"` : ""})` : ""}` : "List the background jobs" };
    case "stop_process": if (!String(i.id ?? "").trim()) throw new Error("id is required (read_process with no id lists the jobs)"); return { class: "read", summary: `Stop background job ${i.id} (started by OmniGPT)` };
    case "read_file": { const p = checkPath(i.path, cfg); return { class: "read", summary: `Read ${p}` }; }
    case "list_dir": { const p = checkPath(i.path || ".", cfg); return { class: "read", summary: `List ${p}${i.recursive ? " (recursive)" : ""}` }; }
    case "write_file": { const p = W(i.path); return { class: "write", summary: `${fs.existsSync(p) ? "OVERWRITE" : "Create"} ${p} (${String(i.content ?? "").length} chars)` }; }
    case "edit_file": { const p = W(i.path); return { class: "write", summary: `Edit ${p}\n- ${String(i.old_string ?? "").slice(0, 400)}\n+ ${String(i.new_string ?? "").slice(0, 400)}` }; }
    case "make_dir": { const p = checkPath(i.path, cfg); laneCheck(p, scope, cfg, true); return { class: "write", summary: `Create folder ${p}` }; } // a parent folder of your own lane is allowed
    case "copy_file": { const a = checkPath(i.source, cfg), b = W(i.destination); return { class: "write", summary: `Copy ${a}\n  to ${b}` }; }
    case "move_file": { const a = W(i.source), b = W(i.destination); return { class: "write", summary: `Move ${a}\n  to ${b}` }; }
    case "delete_file": {
      const p = W(i.path);
      if (noDelete(p, cfg)) throw new Error("Refusing to delete an allowed root, a drive, or a main personal folder");
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
      const L = list(i.paths, 50).map((p) => { const a = W(p); if (noDelete(a, cfg)) throw new Error("Refusing to delete an allowed root, a drive, or a main personal folder"); return a; });
      return { class: "delete", summary: `Move ${L.length} items to the Recycle Bin:\n${L.map((p) => "- " + p).join("\n")}` };
    }
    case "download_file": { const u = await checkUrl(i.url); const p = W(i.path); return { class: "network", summary: `Download ${u.href}\n  to ${p}` }; }
    case "inspect_file": { const p = checkPath(i.path, cfg); return { class: "read", summary: `Inspect ${p}` }; }
    case "find_files": { const p = checkPath(i.path || ".", cfg); return { class: "read", summary: `Find ${i.pattern || "*"} in ${p}` }; }
    case "search_files": { const p = checkPath(i.path || ".", cfg); if (!String(i.query || "")) throw new Error("query is required"); if (i.regex) new RegExp(String(i.query)); return { class: "read", summary: `Search for "${String(i.query).slice(0, 120)}" in ${p}` }; }
    case "system_info": return { class: "read", summary: "Read system information (Windows version, memory, disks, installed runtimes)" };
    case "notify": return { class: "read", summary: `Notification: ${String(i.title || "OmniGPT").slice(0, 80)}` };
    case "open_path": {
      if (i.url) { const u = new URL(String(i.url)); if (!/^https?:$/.test(u.protocol)) throw new Error("only http(s) addresses can be opened"); return { class: "read", summary: `Open ${u.href} in the default browser` }; }
      const p = checkPath(i.path, cfg);
      if (!i.reveal && RUN_EXT.test(p)) throw new Error("Programs and scripts are never opened. Use reveal to show the file in File Explorer instead.");
      return { class: "read", summary: `${i.reveal ? "Show in File Explorer" : "Open"} ${p}` };
    }
    case "clipboard": {
      if (i.action === "read") return { class: "read", confirm: true, summary: "Read the clipboard (it can contain passwords, so this always asks)" };
      if (i.action === "write") { if (String(i.text ?? "").length > 1e6) throw new Error("text too long"); return { class: "write", summary: `Copy to the clipboard: ${String(i.text ?? "").slice(0, 200)}` }; }
      throw new Error('action must be "read" or "write"');
    }
    case "archive": {
      const a = String(i.action || "");
      if (a === "list") return { class: "read", summary: `List the contents of ${checkPath(i.source, cfg)}` };
      if (a === "unzip") { const s = checkPath(i.source, cfg), d = W(i.destination || s.replace(/\.(zip|7z|rar|tar|gz|tgz|bz2|xz)$/i, "").replace(/\.tar$/i, "")); return { class: "write", summary: `Extract ${s}\n  to ${d}` }; }
      if (a === "zip") { const L = (Array.isArray(i.source) ? i.source : [i.source]).map((p) => checkPath(p, cfg)); if (!L.length) throw new Error("source is required"); const d = W(i.destination || L[0] + ".zip"); return { class: "write", summary: `Pack ${L.length > 1 ? L.length + " items" : L[0]}\n  into ${d}` }; }
      throw new Error('action must be "zip", "unzip" or "list"');
    }
    case "browser": {
      const a = String(i.action || "");
      if (!BROWSER_ACTIONS.has(a)) throw new Error("action must be one of: " + [...BROWSER_ACTIONS].join(", "));
      if (a === "open") { const u = new URL(String(i.url || "")); if (!/^https?:$/.test(u.protocol)) throw new Error("only http(s) addresses can be opened"); await browserUrlOk(u.href); }
      const what = a === "open" ? `open ${i.url}` : a === "type" ? `type into ${i.ref ? "[" + i.ref + "]" : i.selector || i.text}: ${String(i.value ?? "").slice(0, 120)}${i.submit ? " and submit" : ""}` : a === "click" ? `click ${i.ref ? "[" + i.ref + "]" : i.selector || JSON.stringify(i.text)}` : a === "press" ? `press ${i.key}` : a === "select" ? `choose "${i.value}" in [${i.ref}]` : a;
      return { class: /^(click|type|select|press)$/.test(a) ? "browser" : "read", summary: "Browser: " + what };
    }
    case "make_document": {
      const p = W(i.path), ext = path.extname(p).toLowerCase();
      if (!DOC_EXT.has(ext)) throw new Error("path must end in .docx, .xlsx, .pptx, .pdf, .html, .md, .txt or .csv");
      if (fs.existsSync(p) && !i.overwrite) throw new Error("file exists: " + p + " (set overwrite to replace it; the old version is backed up)");
      if (!i.content && !i.sheets && !i.slides) throw new Error("content (Markdown), sheets or slides is required");
      return { class: "write", summary: `${fs.existsSync(p) ? "OVERWRITE" : "Create"} ${p}${i.title ? ` ("${String(i.title).slice(0, 80)}")` : ""}` };
    }
    case "edit_image": {
      const s = checkPath(i.path, cfg), d = W(i.output || editedName(s, i.format));
      if (fs.existsSync(d) && d !== s && !i.overwrite) throw new Error("output exists: " + d);
      return { class: "write", summary: `Edit ${s}${d === s ? " (in place, backed up)" : `\n  save as ${d}`}: ${imageOpsText(i)}` };
    }
    case "convert_media": {
      const s = checkPath(i.input, cfg), d = W(i.output);
      if (fs.existsSync(d) && !i.overwrite) throw new Error("output exists: " + d);
      if (s === d) throw new Error("output must be a different file");
      return { class: "write", summary: `Convert ${s}\n  to ${d}${i.start || i.end ? ` (from ${i.start || "start"} to ${i.end || "end"})` : ""}` };
    }
    case "generate_image": { if (!String(i.prompt || "").trim()) throw new Error("prompt is required"); const d = i.path ? W(i.path) : null; return { class: "write", summary: `Generate an image: ${String(i.prompt).slice(0, 200)}${d ? `\n  save as ${d}` : ""}` }; }
    case "transcribe_audio": { const s = checkPath(i.path, cfg); if (i.output) W(i.output); return { class: "read", summary: `Transcribe ${s}${i.output ? " into " + i.output : ""}` }; }
    case "speak": { if (!String(i.text || "").trim()) throw new Error("text is required"); if (String(i.text).length > 20000) throw new Error("text is too long (20000 characters max)"); const d = i.path ? W(i.path) : null; return { class: "write", summary: `Read aloud into an audio file${d ? " " + d : ""}: ${String(i.text).slice(0, 160)}` }; }
    case "view_images": {
      const L = list(i.paths, 8).map((p) => checkPath(p, cfg));
      return { class: "read", summary: `Look at ${L.length} image${L.length > 1 ? "s" : ""}:\n${L.map((p) => "- " + p).join("\n")}` };
    }
    case "install_tool": {
      if (scope) throw new Error("Installing programs is not available to parallel workers");
      const m = String(i.manager || ""), pkg = String(i.package || "").trim();
      if (!INSTALL_RE[m]) throw new Error('manager must be "winget", "pip" or "npm"');
      if (!INSTALL_RE[m].test(pkg)) throw new Error(`"${pkg.slice(0, 80)}" is not a valid ${m} package name`);
      return { class: "exec", summary: `Install ${pkg} with ${m}${i.reason ? ` (${String(i.reason).slice(0, 160)})` : ""}` };
    }
    case "find_duplicates": { const p = checkPath(i.path || ".", cfg); return { class: "read", summary: `Find duplicate files in ${p}${i.recursive === false ? "" : " and its subfolders"}` }; }
    case "web_search": { const q = String(i.query || "").trim(); if (!q) throw new Error("query is required"); if (q.length > 300) throw new Error("query is too long (300 chars max)"); return { class: "web", summary: `Search the web: ${q}` }; }
    case "web_open": { const u = await checkUrl(i.url); return { class: "web", summary: `Open ${u.href}` }; }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------- finding, searching, system information, notifications, archives
const RUN_EXT = /\.(exe|com|bat|cmd|ps1|psm1|psd1|vbs|vbe|js|jse|wsf|wsh|msi|msp|mst|scr|hta|cpl|lnk|url|jar|reg|pif|appx|appxbundle|msix|msixbundle|application|gadget|inf|scf|ws|sct|py|pyw|sh)$/i;
function globRe(g) {
  let s = "";
  for (let k = 0; k < g.length; k++) {
    const c = g[k];
    if (c === "*") { if (g[k + 1] === "*") { s += ".*"; k++; if (g[k + 1] === "/" || g[k + 1] === "\\") k++; } else s += "[^/]*"; }
    else if (c === "?") s += "[^/]";
    else if (c === "/" || c === "\\") s += "/";
    else s += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + s + "$", "i");
}
function* walk(root, { recursive = true, dirs = false, max = 200000 } = {}) {
  let seen = 0; const stack = [[root, 0]];
  while (stack.length) {
    const [d, depth] = stack.pop(); let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (++seen > max) return;
      if (DENY_SEG.has(lc(e.name))) continue;
      const full = path.join(d, e.name), rel = path.relative(root, full).split(path.sep).join("/");
      if (e.isDirectory()) { if (dirs) yield { full, rel, dir: true }; if (recursive && depth < 40) stack.push([full, depth + 1]); }
      else if (e.isFile() && !DENY_FILE.test(e.name)) yield { full, rel, dir: false };
    }
  }
}
const fmtB = (n) => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : n < 1073741824 ? (n / 1048576).toFixed(1) + " MB" : (n / 1073741824).toFixed(2) + " GB";
const when = (v) => { if (v === undefined || v === null || v === "") return null; const t = Date.parse(String(v)); if (Number.isNaN(t)) throw new Error("bad date: " + v); return t; };
async function findFiles(root, i) {
  if (!fs.statSync(root).isDirectory()) throw new Error("not a folder");
  const pat = String(i.pattern || "*"), re = globRe(pat), byPath = /[\\/]/.test(pat), type = i.type || "file";
  const minS = Number(i.min_size) || 0, maxS = Number(i.max_size) || Infinity, after = when(i.modified_after) ?? -Infinity, before = when(i.modified_before) ?? Infinity;
  const limit = Math.min(Math.max(Number(i.limit) | 0 || 300, 1), 2000), hits = [];
  for (const f of walk(root, { recursive: i.recursive !== false, dirs: type !== "file" })) {
    if (type === "folder" && !f.dir) continue;
    if (!re.test(byPath ? f.rel : f.rel.split("/").pop())) continue;
    let st; try { st = fs.statSync(f.full); } catch { continue; }
    if (!f.dir && (st.size < minS || st.size > maxS)) continue;
    if (st.mtimeMs < after || st.mtimeMs > before) continue;
    hits.push({ rel: f.rel + (f.dir ? "/" : ""), size: f.dir ? 0 : st.size, mtime: st.mtimeMs, dir: f.dir });
  }
  const sort = i.sort || "name";
  hits.sort(sort === "newest" ? (a, b) => b.mtime - a.mtime : sort === "oldest" ? (a, b) => a.mtime - b.mtime : sort === "largest" ? (a, b) => b.size - a.size : sort === "smallest" ? (a, b) => a.size - b.size : (a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }));
  const shown = hits.slice(0, limit), total = hits.reduce((s, h) => s + h.size, 0);
  return `Found ${hits.length} ${type === "folder" ? "folders" : "matches"} for ${pat} in ${root}${hits.length ? ` (${fmtB(total)} in total)` : ""}${hits.length > limit ? `; showing ${limit}` : ""}.\n` +
    shown.map((h) => `${h.rel}${h.dir ? "" : "  " + fmtB(h.size)}  ${new Date(h.mtime).toISOString().slice(0, 16).replace("T", " ")}`).join("\n");
}
async function searchFiles(root, i) {
  const q = String(i.query || ""), flags = i.case_sensitive ? "" : "i";
  const re = i.regex ? new RegExp(q, flags) : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  const only = i.glob ? globRe(String(i.glob)) : null, byPath = i.glob && /[\\/]/.test(String(i.glob));
  const max = Math.min(Math.max(Number(i.max_results) | 0 || 200, 1), 1000), out = []; let files = 0, matchedFiles = 0, skipped = 0;
  const one = (full, rel) => {
    let st; try { st = fs.statSync(full); } catch { return; }
    if (st.size > 5 * 1024 * 1024) { skipped++; return; }
    const buf = fs.readFileSync(full); if (buf.subarray(0, 8000).includes(0)) return; // binary
    files++; let hit = false;
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let n = 0; n < lines.length && out.length < max; n++) {
      const L = lines[n].length > 2000 ? lines[n].slice(0, 2000) : lines[n];
      if (!re.test(L)) continue; hit = true;
      const m = L.search(re), s = Math.max(0, m - 120);
      out.push(`${rel}:${n + 1}: ${(s ? "…" : "") + L.slice(s, s + 300).trim()}`);
    }
    if (hit) matchedFiles++;
  };
  if (fs.statSync(root).isFile()) one(root, path.basename(root));
  else for (const f of walk(root, { recursive: i.recursive !== false, max: 100000 })) { if (out.length >= max) break; if (only && !only.test(byPath ? f.rel : f.rel.split("/").pop())) continue; one(f.full, f.rel); }
  return `${out.length ? `${out.length} matching lines in ${matchedFiles} files` : "No matches"} for ${i.regex ? "/" + q + "/" : JSON.stringify(q)} (searched ${files} text files${skipped ? `, skipped ${skipped} over 5 MB` : ""}${out.length >= max ? `; stopped at ${max} matches` : ""}).\n` + out.join("\n");
}
const TOOLS_TO_FIND = ["python", "py", "node", "npm", "git", "gh", "ffmpeg", "winget", "7z", "magick", "code"];
async function systemInfo(cfg) {
  const L = [`System: ${os.type()} ${os.release()} (${os.arch()})`, `CPU: ${os.cpus()[0]?.model || "?"} (${os.cpus().length} threads)`, `Memory: ${fmtB(os.totalmem())} total, ${fmtB(os.freemem())} free`, `User folder: ${HOME}`, `Working folder: ${cfg.cwd}`];
  if (process.platform === "win32") {
    const r = await ps(`$o=Get-CimInstance Win32_OperatingSystem; "Windows: $($o.Caption) $($o.Version)"
Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | ForEach-Object { "Drive $($_.Name): $([math]::Round($_.Free/1GB,1)) GB free of $([math]::Round(($_.Used+$_.Free)/1GB,1)) GB" }
Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { "Display: $($_.Bounds.Width)x$($_.Bounds.Height)$(if($_.Primary){' (main)'})" }
foreach($c in ($env:ORC_C -split ',')){ $g=Get-Command $c -ErrorAction SilentlyContinue | Select-Object -First 1; if($g){ "Installed: $c ($($g.Source))" } else { "Not installed: $c" } }`, { ORC_C: TOOLS_TO_FIND.join(",") }, cfg.cwd, 30000);
    L.push(...r.out.trim().split(/\r?\n/).filter(Boolean));
  } else {
    for (const c of TOOLS_TO_FIND) { const f = String(process.env.PATH || "").split(":").map((d) => path.join(d, c)).find((x) => fs.existsSync(x)); L.push(f ? `Installed: ${c} (${f})` : `Not installed: ${c}`); }
  }
  return L.join("\n");
}
// Windows toast through PowerShell's registered app id, so it shows without registering OmniGPT
const TOAST_PS = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t=$x.GetElementsByTagName("text"); [void]$t.Item(0).AppendChild($x.CreateTextNode($env:ORC_T)); [void]$t.Item(1).AppendChild($x.CreateTextNode($env:ORC_M))
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))`;
async function find7z(cwd) {
  if (process.platform !== "win32") return null;
  const r = await ps("$g=Get-Command 7z -ErrorAction SilentlyContinue; if($g){$g.Source}elseif(Test-Path \"$env:ProgramFiles\\7-Zip\\7z.exe\"){\"$env:ProgramFiles\\7-Zip\\7z.exe\"}", {}, cwd, 15000);
  const f = r.out.trim().split(/\r?\n/).pop(); return f && fs.existsSync(f) ? f : null;
}
const ZIP_EXT = /\.(zip|docx|xlsx|pptx|odt|ods|odp|epub|jar|apk|cbz|xpi|vsix|nupkg|whl)$/i;
async function archiveTool(i, cfg, jr) {
  const a = String(i.action);
  if (a === "list") {
    const s = checkPath(i.source, cfg);
    if (!ZIP_EXT.test(s)) { const z = await find7z(cfg.cwd); if (!z) throw new Error("listing this archive type needs 7-Zip: install_tool winget 7zip.7zip"); const r = await execFile(z, ["l", s], 120000); return cap(r.out); }
    const z = zipRead(fs.readFileSync(s)), files = z.entries.filter((e) => !e.dir);
    return `${s}: ${files.length} files, ${fmtB(files.reduce((t, e) => t + e.size, 0))} unpacked.\n` + z.entries.slice(0, 1000).map((e) => `${e.name}${e.dir ? "" : "  " + fmtB(e.size)}${e.encrypted ? "  (password)" : ""}`).join("\n");
  }
  if (a === "zip") {
    const L = (Array.isArray(i.source) ? i.source : [i.source]).map((p) => checkPath(p, cfg)), d = checkPath(i.destination || L[0] + ".zip", cfg);
    if (fs.existsSync(d)) throw new Error("destination already exists: " + d);
    if (/\.7z$/i.test(d)) { const z = await find7z(cfg.cwd); if (!z) throw new Error("making .7z needs 7-Zip: install_tool winget 7zip.7zip, or use a .zip destination"); const r = await execFile(z, ["a", d, ...L], 3600000); if (r.code !== 0) throw new Error(r.out.slice(-400)); jr.push({ op: "created", path: d }); return `Packed into ${d}.`; }
    const files = []; let total = 0;
    for (const s of L) {
      const st = fs.statSync(s), base = path.basename(s);
      if (st.isFile()) { files.push({ name: base, full: s, mtime: st.mtime }); total += st.size; continue; }
      files.push({ name: base + "/" });
      for (const f of walk(s, { dirs: true })) { if (f.dir) { files.push({ name: `${base}/${f.rel}/` }); continue; } const fst = fs.statSync(f.full); total += fst.size; files.push({ name: `${base}/${f.rel}`, full: f.full, mtime: fst.mtime }); }
      if (total > 1024 * 1024 * 1024) throw new Error("more than 1 GB to pack; use 7-Zip (install_tool winget 7zip.7zip) with run_command");
    }
    const buf = zipBuild(files.map((f) => ({ name: f.name, data: f.full ? fs.readFileSync(f.full) : undefined, mtime: f.mtime })));
    fs.mkdirSync(path.dirname(d), { recursive: true }); fs.writeFileSync(d, buf); jr.push({ op: "created", path: d });
    return `Packed ${files.filter((f) => !f.name.endsWith("/")).length} files (${fmtB(total)}) into ${d} (${fmtB(buf.length)}).`;
  }
  // unzip
  const s = checkPath(i.source, cfg), d = checkPath(i.destination || s.replace(/\.(zip|7z|rar|tar|gz|tgz|bz2|xz)$/i, "").replace(/\.tar$/i, ""), cfg);
  const fresh = !fs.existsSync(d);
  if (!ZIP_EXT.test(s)) {
    const z = await find7z(cfg.cwd); if (!z) throw new Error("extracting this archive type needs 7-Zip: install_tool winget 7zip.7zip");
    const r = await execFile(z, ["x", s, "-o" + d, i.overwrite ? "-aoa" : "-aos", "-y"], 3600000); if (r.code !== 0) throw new Error(r.out.slice(-400));
    if (fresh) jr.push({ op: "created", path: d }); return `Extracted to ${d}.\n` + r.out.split(/\r?\n/).filter((l) => /files|folders|size/i.test(l)).join("\n");
  }
  const z = zipRead(fs.readFileSync(s)); let wrote = 0, skipped = [];
  fs.mkdirSync(d, { recursive: true }); if (fresh) jr.push({ op: "created", path: d });
  for (const e of z.entries) {
    const name = e.name.replace(/\\/g, "/");
    if (/^([a-z]:|\/)/i.test(name) || name.split("/").includes("..")) { skipped.push(name + " (unsafe path)"); continue; } // zip-slip
    let t; try { t = checkPath(path.join(d, ...name.split("/").filter(Boolean)), cfg); } catch (err) { skipped.push(name + " (" + err.message + ")"); continue; }
    if (!under(t, real(d))) { skipped.push(name + " (outside the folder)"); continue; }
    if (e.dir) { fs.mkdirSync(t, { recursive: true }); continue; }
    if (fs.existsSync(t) && !i.overwrite) { skipped.push(name + " (exists)"); continue; }
    let data; try { data = z.read(e); } catch (err) { skipped.push(name + " (" + err.message + ")"); continue; }
    fs.mkdirSync(path.dirname(t), { recursive: true });
    if (!fresh) { const b = backup(t); jr.push(b ? { op: "modified", path: t, backup: b } : { op: "created", path: t }); }
    fs.writeFileSync(t, data); wrote++;
  }
  return `Extracted ${wrote} files to ${d}.` + (skipped.length ? `\nSkipped ${skipped.length}: ${skipped.slice(0, 30).join("; ")}` : "");
}

// ---------- browser: public web pages only (tests may allow local pages with OMNIGPT_TEST_ALLOW_LOCAL=1)
const BROWSER_ACTIONS = new Set(["open", "read", "screenshot", "click", "type", "select", "press", "scroll", "back", "forward", "wait", "tabs", "close"]);
const browserUrlOk = async (u) => { if (process.env.OMNIGPT_TEST_ALLOW_LOCAL === "1" && /^http:\/\/127\.0\.0\.1:/.test(u)) return; await checkUrl(u); };

// ---------- documents, images, media
const DOC_EXT = new Set([".docx", ".xlsx", ".pptx", ".pdf", ".html", ".htm", ".md", ".txt", ".csv"]);
const stampName = (s) => String(s || "file").replace(/[<>:"/\\|?*\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "file";
// a new file that replaces nothing, or an explicit overwrite with a backup: both undoable
function saveNew(p, data, jr, overwrite) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (fs.existsSync(p)) { if (!overwrite) throw new Error("file exists: " + p); jr.push({ op: "modified", path: p, backup: backup(p) }); } else jr.push({ op: "created", path: p });
  fs.writeFileSync(p, data);
}
function findBrowser() {
  if (process.env.OMNIGPT_BROWSER && fs.existsSync(process.env.OMNIGPT_BROWSER)) return process.env.OMNIGPT_BROWSER;
  const pf = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  for (const base of pf) for (const rel of ["Microsoft\\Edge\\Application\\msedge.exe", "Google\\Chrome\\Application\\chrome.exe"]) { const f = path.join(base, rel); if (fs.existsSync(f)) return f; }
  return null;
}
// prints an HTML file to PDF with Edge (or Chrome) in the background, using a throwaway profile
async function htmlToPdf(html, out) {
  const b = findBrowser(); if (!b) throw new Error("Microsoft Edge was not found, so the PDF could not be printed. Make an .html or .docx instead, or install Edge.");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-pdf-")), src = path.join(tmp, "doc.html"), pdf = path.join(tmp, "doc.pdf");
  try {
    fs.writeFileSync(src, html);
    const args = ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync", `--user-data-dir=${path.join(tmp, "profile")}`, "--no-pdf-header-footer", `--print-to-pdf=${pdf}`, pathToFileURL(src).href];
    if (process.platform !== "win32" && process.getuid && process.getuid() === 0) args.unshift("--no-sandbox");
    const r = await execFile(b, args, 90000);
    if (!fs.existsSync(pdf) || fs.statSync(pdf).size < 100) throw new Error("the browser did not produce a PDF: " + r.out.trim().slice(-200));
    return fs.readFileSync(pdf);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
async function makeDocument(i, cfg, jr) {
  const p = checkPath(i.path, cfg), ext = path.extname(p).toLowerCase(), title = i.title ? String(i.title) : "";
  const content = String(i.content ?? ""), blocks = () => parseMarkdown(content);
  let data, what;
  if (ext === ".docx") { const b = blocks(); data = toDocx(b, title); what = `${b.length} blocks`; }
  else if (ext === ".xlsx") { const sh = Array.isArray(i.sheets) && i.sheets.length ? i.sheets : sheetsFromText(content); data = toXlsx(sh, title); what = `${sh.length} sheet${sh.length > 1 ? "s" : ""}, ${sh.reduce((n, s) => n + (s.rows || []).length, 0)} rows`; }
  else if (ext === ".pptx") { const sl = Array.isArray(i.slides) && i.slides.length ? i.slides : slidesFromText(content, title); data = toPptx(sl, title); what = `${sl.length} slides`; }
  else if (ext === ".html" || ext === ".htm") { data = toHtml(blocks(), title); what = "web page"; }
  else if (ext === ".pdf") { data = await htmlToPdf(toHtml(blocks(), title), p); what = "PDF"; }
  else if (ext === ".csv") { const sh = Array.isArray(i.sheets) && i.sheets.length ? i.sheets : sheetsFromText(content); data = "\ufeff" + (sh[0]?.rows || []).map((r) => r.map((c) => { const t = String(c ?? ""); return /[",\n;]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; }).join(",")).join("\r\n"); what = `${(sh[0]?.rows || []).length} rows`; }
  else { data = (title ? `# ${title}\n\n` : "") + content; what = "text"; }
  saveNew(p, data, jr, !!i.overwrite);
  return `Created ${p} (${what}, ${fmtB(Buffer.byteLength(data))}). Show it to the user with open_path if they want to see it.`;
}
function parseResize(r) {
  if (r === undefined || r === null || r === "") return {};
  if (typeof r === "number") return { max: r };
  if (typeof r === "object") return { width: Number(r.width) || undefined, height: Number(r.height) || undefined, max: Number(r.max) || undefined };
  const s = String(r).trim(); let m;
  if ((m = /^(\d+(?:\.\d+)?)%$/.exec(s))) return { scale: Number(m[1]) / 100 };
  if ((m = /^(\d+)?\s*[x×]\s*(\d+)?$/i.exec(s)) && (m[1] || m[2])) return { width: m[1] ? +m[1] : undefined, height: m[2] ? +m[2] : undefined };
  if (/^\d+$/.test(s)) return { max: +s };
  throw new Error("resize must be a number (longest side), WIDTHxHEIGHT, or a percentage like 50%");
}
const IMG_FMT = { jpg: "jpg", jpeg: "jpg", png: "png", bmp: "bmp", gif: "gif", tif: "tiff", tiff: "tiff", webp: "webp" };
const editedName = (s, fmt) => { const e = fmt ? "." + (IMG_FMT[String(fmt).toLowerCase()] || fmt) : path.extname(s); return path.join(path.dirname(s), path.basename(s, path.extname(s)) + "-edited" + e); };
const imageOpsText = (i) => [i.crop && `crop ${i.crop.width}x${i.crop.height} at ${i.crop.x},${i.crop.y}`, i.rotate && `rotate ${i.rotate}°`, i.flip && `flip ${i.flip}`, i.resize && `resize ${typeof i.resize === "object" ? JSON.stringify(i.resize) : i.resize}`, i.format && `as ${i.format}`, i.quality && `quality ${i.quality}`].filter(Boolean).join(", ") || "re-save";
const EDIT_PS = `Add-Type -AssemblyName System.Drawing
$j=$env:ORC_JOB | ConvertFrom-Json
$src=[System.Drawing.Image]::FromFile($j.src); $bmp=New-Object System.Drawing.Bitmap $src; $src.Dispose()
if($j.crop){ $r=New-Object System.Drawing.Rectangle ([int]$j.crop.x),([int]$j.crop.y),([int]$j.crop.width),([int]$j.crop.height); $r=[System.Drawing.Rectangle]::Intersect($r,(New-Object System.Drawing.Rectangle 0,0,$bmp.Width,$bmp.Height)); if($r.Width -lt 1 -or $r.Height -lt 1){ throw "the crop area is outside the image" }; $c=$bmp.Clone($r,$bmp.PixelFormat); $bmp.Dispose(); $bmp=$c }
switch([int]$j.rotate){ 90 {$bmp.RotateFlip('Rotate90FlipNone')} 180 {$bmp.RotateFlip('Rotate180FlipNone')} 270 {$bmp.RotateFlip('Rotate270FlipNone')} }
if($j.flip -eq 'horizontal'){ $bmp.RotateFlip('RotateNoneFlipX') } elseif($j.flip -eq 'vertical'){ $bmp.RotateFlip('RotateNoneFlipY') }
$W=$bmp.Width; $H=$bmp.Height; $nw=$W; $nh=$H
if($j.max){ $s=[Math]::Min(1.0, $j.max/[Math]::Max($W,$H)); $nw=[int]($W*$s); $nh=[int]($H*$s) }
if($j.scale){ $nw=[int]($W*$j.scale); $nh=[int]($H*$j.scale) }
if($j.width -and $j.height){ $nw=[int]$j.width; $nh=[int]$j.height } elseif($j.width){ $nw=[int]$j.width; $nh=[int]($H*$j.width/$W) } elseif($j.height){ $nh=[int]$j.height; $nw=[int]($W*$j.height/$H) }
if($nw -ne $W -or $nh -ne $H){ $o=New-Object System.Drawing.Bitmap ([Math]::Max(1,$nw)),([Math]::Max(1,$nh)); $g=[System.Drawing.Graphics]::FromImage($o); $g.InterpolationMode='HighQualityBicubic'; $g.PixelOffsetMode='HighQuality'; $g.DrawImage($bmp,0,0,$o.Width,$o.Height); $g.Dispose(); $bmp.Dispose(); $bmp=$o }
if($j.format -eq 'jpg'){
  $enc=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $p=New-Object System.Drawing.Imaging.EncoderParameters 1; $p.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality),([long]$j.quality)
  $f=New-Object System.Drawing.Bitmap $bmp.Width,$bmp.Height; $g=[System.Drawing.Graphics]::FromImage($f); $g.Clear([System.Drawing.Color]::White); $g.DrawImage($bmp,0,0,$bmp.Width,$bmp.Height); $g.Dispose(); $f.Save($j.dst,$enc,$p); $f.Dispose()
} else { $bmp.Save($j.dst, [System.Drawing.Imaging.ImageFormat]::($j.format.Substring(0,1).ToUpper()+$j.format.Substring(1))) }
Write-Output ("OK|"+$bmp.Width+"x"+$bmp.Height); $bmp.Dispose()`;
async function editImage(i, cfg, jr) {
  const s = checkPath(i.path, cfg), d = checkPath(i.output || editedName(s, i.format), cfg);
  if (!fs.existsSync(s)) throw new Error("not found: " + s);
  const fmt = IMG_FMT[String(i.format || path.extname(d).slice(1)).toLowerCase()];
  if (!fmt) throw new Error("output format must be jpg, png, bmp, gif, tiff or webp");
  const rs = parseResize(i.resize), quality = Math.min(100, Math.max(1, Number(i.quality) || 90));
  const rot = i.rotate ? ((Number(i.rotate) % 360) + 360) % 360 : 0; if (rot && ![90, 180, 270].includes(rot)) throw new Error("rotate must be 90, 180 or 270");
  if (i.flip && !["horizontal", "vertical"].includes(i.flip)) throw new Error('flip must be "horizontal" or "vertical"');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-edit-")), out = path.join(tmp, "out." + (fmt === "tiff" ? "tif" : fmt));
  try {
    let size = "";
    if (process.platform === "win32" && fmt !== "webp") {
      const r = await ps(EDIT_PS, { ORC_JOB: JSON.stringify({ src: s, dst: out, crop: i.crop || null, rotate: rot, flip: i.flip || null, ...rs, format: fmt, quality }) }, cfg.cwd, 120000);
      const m = /OK\|(\d+x\d+)/.exec(r.out); if (m) size = m[1];
    }
    if (!fs.existsSync(out)) { // ffmpeg: other formats (webp, heic) and other systems
      const ff = await findFfmpeg(cfg.cwd);
      if (!ff) throw new Error(`this image could not be edited with the built-in tools${process.platform === "win32" ? " (format not supported)" : ""}. Install ffmpeg: install_tool winget Gyan.FFmpeg`);
      const vf = [];
      if (i.crop) vf.push(`crop=${i.crop.width | 0}:${i.crop.height | 0}:${i.crop.x | 0}:${i.crop.y | 0}`);
      if (rot === 90) vf.push("transpose=1"); else if (rot === 180) vf.push("transpose=1,transpose=1"); else if (rot === 270) vf.push("transpose=2");
      if (i.flip === "horizontal") vf.push("hflip"); else if (i.flip === "vertical") vf.push("vflip");
      if (rs.max) vf.push(`scale='if(gte(iw,ih),min(${rs.max},iw),-2)':'if(gte(iw,ih),-2,min(${rs.max},ih))'`);
      if (rs.scale) vf.push(`scale=trunc(iw*${rs.scale}/2)*2:-2`);
      if (rs.width || rs.height) vf.push(`scale=${rs.width || -2}:${rs.height || -2}`);
      const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", s, ...(vf.length ? ["-vf", vf.join(",")] : []), "-frames:v", "1", ...(fmt === "jpg" ? ["-q:v", String(Math.round(2 + ((100 - quality) * 29) / 100))] : fmt === "webp" ? ["-quality", String(quality)] : []), out];
      const r = await execFile(ff, args, 120000);
      if (!fs.existsSync(out)) throw new Error("ffmpeg could not edit the image: " + r.out.trim().slice(-300));
    }
    saveNew(d, fs.readFileSync(out), jr, d === s || !!i.overwrite);
    return `Saved ${d}${size ? ` (${size})` : ""}, ${fmtB(fs.statSync(d).size)}: ${imageOpsText(i)}.`;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
const tsec = (v) => { if (v === undefined || v === null || v === "") return null; if (typeof v === "number") return v; const p = String(v).split(":").map(Number); if (p.some(isNaN)) throw new Error("times look like 90, 1:30 or 0:01:30"); return p.reduce((a, b) => a * 60 + b, 0); };
async function convertMedia(i, cfg, jr) {
  const s = checkPath(i.input, cfg), d = checkPath(i.output, cfg), ext = path.extname(d).slice(1).toLowerCase();
  if (!fs.existsSync(s)) throw new Error("not found: " + s);
  const ff = await findFfmpeg(cfg.cwd); if (!ff) throw new Error("convert_media needs ffmpeg. Install it with install_tool (winget, Gyan.FFmpeg), then try again.");
  const q = ({ high: 0, medium: 1, small: 2 })[i.quality || "medium"] ?? 1, start = tsec(i.start), end = tsec(i.end);
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
  if (start !== null) args.push("-ss", String(start));
  if (end !== null) args.push("-to", String(end));
  args.push("-i", s);
  const audioOut = /^(mp3|wav|m4a|aac|ogg|opus|flac|wma)$/.test(ext) || i.audio_only;
  const scale = i.max_width ? `scale='min(${Number(i.max_width) | 0},iw)':-2` : null;
  if (ext === "gif") args.push("-vf", `fps=${Number(i.fps) || 10},${scale || "scale='min(480,iw)':-2"}:flags=lanczos`, "-loop", "0");
  else if (audioOut) {
    args.push("-vn");
    if (ext === "mp3") args.push("-c:a", "libmp3lame", "-q:a", String([2, 4, 6][q]));
    else if (ext === "m4a" || ext === "aac") args.push("-c:a", "aac", "-b:a", ["192k", "128k", "96k"][q]);
    else if (ext === "ogg" || ext === "opus") args.push("-c:a", "libopus", "-b:a", ["160k", "96k", "64k"][q]);
  } else if (/^(mp4|mov|mkv|m4v)$/.test(ext)) { if (scale) args.push("-vf", scale); args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", String([20, 24, 30][q]), "-pix_fmt", "yuv420p", ...(i.mute ? ["-an"] : ["-c:a", "aac", "-b:a", "128k"]), "-movflags", "+faststart"); }
  else if (ext === "webm") { if (scale) args.push("-vf", scale); args.push("-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String([28, 33, 40][q]), ...(i.mute ? ["-an"] : ["-c:a", "libopus"])); }
  else if (/^(jpg|jpeg|png|webp)$/.test(ext)) { if (scale) args.push("-vf", scale); args.push("-frames:v", "1"); }
  else if (scale) args.push("-vf", scale);
  const tmp = d + ".part." + ext; args.push(tmp);
  const r = await execFile(ff, args, 3600000);
  if (r.code !== 0 || !fs.existsSync(tmp)) { try { fs.unlinkSync(tmp); } catch {} throw new Error("ffmpeg failed: " + r.out.trim().slice(-400)); }
  if (fs.existsSync(d)) { if (!i.overwrite) { fs.unlinkSync(tmp); throw new Error("output exists: " + d); } jr.push({ op: "modified", path: d, backup: backup(d) }); fs.unlinkSync(d); } else jr.push({ op: "created", path: d });
  fs.renameSync(tmp, d);
  return `Saved ${d} (${fmtB(fs.statSync(d).size)}, from ${fmtB(fs.statSync(s).size)}).`;
}
// ---- OmniRoute media: image generation, speech-to-text, text-to-speech through the user's own providers
let OR_URL = process.env.OMNIROUTE_URL || "http://127.0.0.1:20128", OR_KEY = () => "";
export function setOmniRoute(url, keyFn) { OR_URL = String(url || OR_URL).replace(/\/$/, ""); if (keyFn) OR_KEY = keyFn; }
const orFetch = (p, opts = {}) => fetch(OR_URL + p, { ...opts, headers: { ...(OR_KEY() ? { authorization: "Bearer " + OR_KEY() } : {}), ...(opts.headers || {}) }, signal: AbortSignal.timeout(opts.timeout || 180000) });
const KIND = { image: /(image|dall-?e|flux|imagen|sdxl|stable-?diffusion|gpt-image|midjourney|seedream|ideogram|recraft|kolors)/i, stt: /(whisper|transcri|speech-to-text|\bstt\b|asr|parakeet)/i, tts: /(tts|text-to-speech|kokoro|eleven|speech|voice|orpheus|playai)/i };
async function pickModels(kind) {
  const ids = new Set();
  try { if (kind === "image") { const r = await orFetch("/v1/images/generations", { timeout: 15000 }); if (r.ok) for (const m of (await r.json()).data || []) if (m && m.id) ids.add(m.id); } } catch {}
  try { const r = await orFetch("/v1/models", { timeout: 15000 }); if (r.ok) for (const m of (await r.json()).data || []) { const id = String(m.id || ""), t = String(m.type || m.modality || ""); if ((kind === "image" && (t === "image" || KIND.image.test(id))) || (kind === "stt" && (/transcri|stt|asr/.test(t) || KIND.stt.test(id))) || (kind === "tts" && (/tts|speech/.test(t) && !/transcri|stt/.test(t) || (KIND.tts.test(id) && !KIND.stt.test(id))))) ids.add(id); } } catch {}
  return [...ids];
}
const noModel = (what, kind) => new Error(`No ${what} model is available in OmniRoute. Add a provider that offers ${what} in the OmniRoute console (free options exist${kind === "stt" ? ", for example Whisper on Groq" : kind === "image" ? ", for example Pollinations" : ""}), or pass model as provider/model.`);
const sniff = (b) => b[0] === 0x89 && b[1] === 0x50 ? "png" : b[0] === 0xff && b[1] === 0xd8 ? "jpg" : b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" ? "webp" : b.toString("ascii", 0, 3) === "GIF" ? "gif" : null;
async function generateImage(i, cfg, jr) {
  const prompt = String(i.prompt).trim(), models = i.model ? [String(i.model)] : await pickModels("image");
  if (!models.length) throw noModel("image generation", "image");
  const errs = []; let buf = null, used = null;
  for (const m of models.slice(0, 4)) {
    try {
      const r = await orFetch("/v1/images/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: m, prompt, n: 1, size: i.size || "1024x1024", response_format: "b64_json" }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { errs.push(`${m}: ${j.error?.message || "HTTP " + r.status}`); continue; }
      const d = (j.data || [])[0] || {};
      if (d.b64_json) buf = Buffer.from(d.b64_json, "base64");
      else if (d.url) { const u = new URL(d.url, OR_URL); if (u.origin !== new URL(OR_URL).origin) await checkUrl(u.href); const g = await fetch(u, { signal: AbortSignal.timeout(120000) }); if (g.ok) buf = Buffer.from(await g.arrayBuffer()); }
      if (buf && (sniff(buf) || buf.length > 1000)) { used = m; break; } errs.push(`${m}: no image in the reply`); buf = null;
    } catch (e) { errs.push(`${m}: ${String(e.message || e).slice(0, 120)}`); }
  }
  if (!buf) throw new Error("No image was generated. " + errs.join("; "));
  const kind = sniff(buf) || "png";
  let d = i.path ? checkPath(i.path, cfg) : checkPath(path.join(cfg.cwd, "Generated images", `${stampName(prompt).slice(0, 40)} ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${kind}`), cfg);
  if (path.extname(d).slice(1).toLowerCase().replace("jpeg", "jpg") !== kind) d = d.replace(/\.[^.\\/]*$/, "") + "." + kind;
  saveNew(d, buf, jr, !!i.overwrite);
  const text = `Generated with ${used} and saved as ${d} (${fmtB(buf.length)}).`;
  return buf.length <= 3.5e6 ? { text, blocks: [{ type: "text", text: "The generated image:" }, { type: "image", source: { type: "base64", media_type: kind === "jpg" ? "image/jpeg" : "image/" + kind, data: buf.toString("base64") } }] } : text;
}
const AUDIO_OK = /\.(mp3|wav|m4a|ogg|oga|opus|flac|webm|mpga|mpeg)$/i;
async function transcribeAudio(i, cfg, jr) {
  const s = checkPath(i.path, cfg); if (!fs.existsSync(s)) throw new Error("not found: " + s);
  let file = s, tmp = null;
  try {
    if (!AUDIO_OK.test(s) || fs.statSync(s).size > 24 * 1024 * 1024) { // video, or too large: a small mono mp3 of the sound
      const ff = await findFfmpeg(cfg.cwd); if (!ff) throw new Error("this file needs converting first and ffmpeg is not installed: install_tool winget Gyan.FFmpeg");
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-stt-")); file = path.join(tmp, "audio.mp3");
      const r = await execFile(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", s, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", file], 1800000);
      if (!fs.existsSync(file)) throw new Error("could not extract the sound: " + r.out.trim().slice(-200));
      if (fs.statSync(file).size > 24 * 1024 * 1024) throw new Error("the recording is too long for one transcription (about 70 minutes at most); cut it into parts with convert_media first");
    }
    const models = i.model ? [String(i.model)] : await pickModels("stt"); if (!models.length) throw noModel("speech-to-text", "stt");
    const errs = [];
    for (const m of models.slice(0, 3)) {
      const fd = new FormData(); fd.append("file", new Blob([fs.readFileSync(file)]), path.basename(file)); fd.append("model", m); fd.append("response_format", "json"); if (i.language) fd.append("language", String(i.language));
      try {
        const r = await orFetch("/v1/audio/transcriptions", { method: "POST", body: fd, timeout: 600000 }); const j = await r.json().catch(() => ({}));
        if (!r.ok || typeof j.text !== "string") { errs.push(`${m}: ${j.error?.message || "HTTP " + r.status}`); continue; }
        let out = `Transcript of ${s} (${m}):\n${j.text.trim()}`;
        if (i.output) { const o = checkPath(i.output, cfg); saveNew(o, j.text.trim() + "\n", jr, !!i.overwrite); out = `Saved the transcript to ${o}.\n` + out; }
        return out.length > 60000 ? out.slice(0, 60000) + "\n…[cut; the full text is in the saved file]" : out;
      } catch (e) { errs.push(`${m}: ${String(e.message || e).slice(0, 120)}`); }
    }
    throw new Error("Transcription failed. " + errs.join("; "));
  } finally { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); }
}
async function speak(i, cfg, jr) {
  const text = String(i.text).trim();
  let d = checkPath(i.path || path.join(cfg.cwd, "Audio", stampName(text.slice(0, 40)) + ".mp3"), cfg);
  const models = i.model ? [String(i.model)] : (i.offline ? [] : await pickModels("tts")), errs = [];
  for (const m of models.slice(0, 3)) {
    try {
      const r = await orFetch("/v1/audio/speech", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: m, input: text, voice: i.voice || "alloy", response_format: "mp3" }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); errs.push(`${m}: ${j.error?.message || "HTTP " + r.status}`); continue; }
      const buf = Buffer.from(await r.arrayBuffer()); if (buf.length < 200) { errs.push(`${m}: empty audio`); continue; }
      const ct = r.headers.get("content-type") || "", ext = /wav/.test(ct) ? ".wav" : /ogg|opus/.test(ct) ? ".ogg" : ".mp3";
      if (path.extname(d).toLowerCase() !== ext) d = d.replace(/\.[^.\\/]*$/, "") + ext;
      saveNew(d, buf, jr, !!i.overwrite); return `Saved speech (${m}) to ${d} (${fmtB(buf.length)}).`;
    } catch (e) { errs.push(`${m}: ${String(e.message || e).slice(0, 120)}`); }
  }
  if (process.platform !== "win32") throw new Error("No text-to-speech model worked" + (errs.length ? ": " + errs.join("; ") : "") + ".");
  d = d.replace(/\.[^.\\/]*$/, "") + ".wav"; // the voice built into Windows, offline
  if (fs.existsSync(d) && !i.overwrite) throw new Error("file exists: " + d);
  const tmp = d + ".part.wav";
  const r = await ps(`Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer
if($env:ORC_V){ $v=$s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Name -like "*$($env:ORC_V)*" } | Select-Object -First 1; if($v){ $s.SelectVoice($v.VoiceInfo.Name) } }
$s.SetOutputToWaveFile($env:ORC_D); $s.Speak($env:ORC_T); $s.Dispose(); Write-Output OK`, { ORC_T: text, ORC_D: tmp, ORC_V: i.voice && !/^(alloy|echo|fable|onyx|nova|shimmer)$/i.test(i.voice) ? String(i.voice) : "" }, cfg.cwd, 300000);
  if (!fs.existsSync(tmp)) throw new Error("Windows speech failed: " + r.out.trim().slice(-200));
  if (fs.existsSync(d)) { jr.push({ op: "modified", path: d, backup: backup(d) }); fs.unlinkSync(d); } else jr.push({ op: "created", path: d });
  fs.renameSync(tmp, d);
  return `Saved speech (Windows voice, offline${errs.length ? "; OmniRoute: " + errs.join("; ") : ""}) to ${d} (${fmtB(fs.statSync(d).size)}).`;
}

// ---------- install_tool: package names only, never a path, URL or extra arguments
const INSTALL_RE = { winget: /^[A-Za-z0-9][\w.+-]{0,99}$/, pip: /^[A-Za-z0-9][A-Za-z0-9._\-\[\],<>=!~]{0,99}$/, npm: /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(@[\w.^~<>=-]+)?$/ };

// ---------- view_images: the agent looks at pictures itself. Images are scaled down (smaller and cheaper for the model);
// GIFs give their first frame; videos give 3 frames when ffmpeg is installed. Returned as image blocks the model sees.
const IMG_EXT = /\.(jpe?g|png|gif|bmp|tiff?|webp|heic|heif|avif|ico|jfif)$/i, VID_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|wmv|flv|3gp|mpe?g)$/i;
const RAW_OK = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".jfif": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };
let ffmpegPath;
async function findFfmpeg(cwd) {
  if (ffmpegPath) return ffmpegPath; // found once; a later install is picked up on the next call (null is not cached)
  if (process.platform === "win32") { const r = await ps("(Get-Command ffmpeg -ErrorAction SilentlyContinue).Source", {}, cwd, 15000); const f = r.out.trim().split(/\r?\n/).pop(); if (f && fs.existsSync(f)) ffmpegPath = f; }
  else { for (const d of String(process.env.PATH || "").split(":")) if (d && fs.existsSync(path.join(d, "ffmpeg"))) { ffmpegPath = path.join(d, "ffmpeg"); break; } }
  return ffmpegPath || null;
}
const execFile = (exe, args, ms) => new Promise((ok) => { const c = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d)); const t = setTimeout(() => { try { c.kill(); } catch {} }, ms); c.on("close", (code) => { clearTimeout(t); ok({ code, out }); }); c.on("error", (e) => { clearTimeout(t); ok({ code: -1, out: String(e) }); }); });
const SHRINK_PS = `Add-Type -AssemblyName System.Drawing
$max=[int]$env:ORC_MAX
foreach($j in ($env:ORC_JOBS | ConvertFrom-Json)){ try{
  $img=[System.Drawing.Image]::FromFile($j.src); $W=$img.Width; $H=$img.Height
  $s=[Math]::Min(1.0, $max/[Math]::Max($W,$H)); $w=[int][Math]::Max(1,$W*$s); $h=[int][Math]::Max(1,$H*$s)
  $bmp=New-Object System.Drawing.Bitmap $w,$h; $g=[System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode='HighQualityBicubic'; $g.Clear([System.Drawing.Color]::White); $g.DrawImage($img,0,0,$w,$h)
  $enc=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|Where-Object{$_.MimeType -eq 'image/jpeg'}
  $p=New-Object System.Drawing.Imaging.EncoderParameters 1; $p.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality),([long]82)
  $bmp.Save($j.dst,$enc,$p); $g.Dispose(); $bmp.Dispose(); $img.Dispose(); Write-Output ("OK|"+$j.dst+"|"+$W+"x"+$H)
} catch { Write-Output ("ERR|"+$j.dst+"|"+$_.Exception.Message) } }`;
async function viewImages(paths, maxSide, cfg) {
  const max = Math.min(Math.max(maxSide | 0 || 768, 256), 1568);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-view-"));
  const out = []; // { path, note, frames: [{ file, mime }] }
  try {
    const jobs = [];
    for (const [n, p] of paths.entries()) {
      const item = { path: p, note: "", frames: [] }; out.push(item);
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) { item.note = "not found"; continue; }
      if (VID_EXT.test(p)) {
        const ff = await findFfmpeg(cfg.cwd);
        if (!ff) { item.note = "this is a video and ffmpeg is not installed, so no frames could be taken. Install it with install_tool (manager winget, package Gyan.FFmpeg) and call view_images again."; continue; }
        let dur = 0; const pr = await execFile(ff, ["-hide_banner", "-i", p], 30000); const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(pr.out); if (m) dur = +m[1] * 3600 + +m[2] * 60 + +m[3];
        for (const [k, f] of [0.15, 0.5, 0.85].entries()) {
          const dst = path.join(tmp, `v${n}_${k}.jpg`);
          await execFile(ff, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(dur ? (dur * f).toFixed(2) : k * 2), "-i", p, "-frames:v", "1", "-vf", `scale='min(${max},iw)':-2`, "-q:v", "4", dst], 60000);
          if (fs.existsSync(dst)) item.frames.push({ file: dst, mime: "image/jpeg" });
        }
        item.note = item.frames.length ? `video${dur ? ", " + Math.round(dur) + " s" : ""}: ${item.frames.length} frames at 15%, 50% and 85%` : "ffmpeg could not read this video";
        continue;
      }
      if (!IMG_EXT.test(p)) { item.note = "not an image or video file"; continue; }
      jobs.push({ src: p, dst: path.join(tmp, `i${n}.jpg`), item });
    }
    if (jobs.length && process.platform === "win32") {
      const r = await ps(SHRINK_PS, { ORC_MAX: String(max), ORC_JOBS: JSON.stringify(jobs.map(({ src, dst }) => ({ src, dst }))) }, cfg.cwd, 120000);
      for (const line of r.out.split(/\r?\n/)) { const [st, dst, info] = line.split("|"); const j = jobs.find((x) => x.dst === dst); if (!j) continue; if (st === "OK" && fs.existsSync(dst)) { j.item.frames.push({ file: dst, mime: "image/jpeg" }); j.item.note = (info || "") + (/\.gif$/i.test(j.src) ? ", first frame of the GIF" : ""); } else j.item.err = info; }
    }
    for (const j of jobs) {
      if (j.item.frames.length) continue;
      const ext = path.extname(j.src).toLowerCase(), size = fs.statSync(j.src).size, ff = await findFfmpeg(cfg.cwd);
      if (ff) { const dst = j.dst; await execFile(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", j.src, "-frames:v", "1", "-vf", `scale='min(${max},iw)':-2`, "-q:v", "4", dst], 60000); if (fs.existsSync(dst)) { j.item.frames.push({ file: dst, mime: "image/jpeg" }); continue; } }
      if (RAW_OK[ext] && size <= 3.5e6) { j.item.frames.push({ file: j.src, mime: RAW_OK[ext] }); j.item.note = "original file"; continue; }
      j.item.note = `could not be converted (${(j.item.err || ext + " is not supported").slice(0, 120)}). Installing ffmpeg (install_tool winget Gyan.FFmpeg) lets view_images read more formats.`;
    }
    const blocks = []; let shown = 0;
    for (const [n, it] of out.entries()) {
      blocks.push({ type: "text", text: `Image ${n + 1}: ${it.path}${it.note ? " (" + it.note + ")" : ""}` });
      for (const f of it.frames) { blocks.push({ type: "image", source: { type: "base64", media_type: f.mime, data: fs.readFileSync(f.file).toString("base64") } }); shown++; }
    }
    const summary = `Showing ${shown} picture${shown === 1 ? "" : "s"} from ${paths.length} file${paths.length === 1 ? "" : "s"}. Describe only what you can actually see in them.`;
    return { text: summary + "\n" + out.map((it, n) => `Image ${n + 1}: ${it.path}${it.note ? " (" + it.note + ")" : ""}`).join("\n"), blocks };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---------- duplicates: same size first (cheap), then SHA-256 of the content of same-size files only. Read-only.
async function findDuplicates(root, recursive) {
  if (!fs.statSync(root).isDirectory()) throw new Error("not a folder");
  const files = []; let unreadable = 0, capped = false;
  const walk = (d, depth) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { unreadable++; return; }
    for (const e of ents) {
      if (files.length >= 100000) { capped = true; return; }
      if (DENY_SEG.has(lc(e.name))) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (recursive && depth < 30) walk(full, depth + 1); continue; }
      if (!e.isFile() || DENY_FILE.test(e.name)) continue;
      try { const st = fs.statSync(full); if (st.size > 0) files.push({ p: full, size: st.size }); } catch { unreadable++; }
    }
  };
  walk(root, 0);
  const bySize = new Map();
  for (const f of files) { if (!bySize.has(f.size)) bySize.set(f.size, []); bySize.get(f.size).push(f.p); }
  const sha = (p) => new Promise((ok, bad) => { const h = crypto.createHash("sha256"); fs.createReadStream(p, { highWaterMark: 1 << 20 }).on("error", bad).on("data", (c) => h.update(c)).on("end", () => ok(h.digest("hex"))); });
  const groups = []; let hashed = 0;
  for (const [size, L] of bySize) {
    if (L.length < 2) continue;
    const byHash = new Map();
    for (const p of L) { try { const k = await sha(p); hashed++; if (!byHash.has(k)) byHash.set(k, []); byHash.get(k).push(p); } catch { unreadable++; } }
    for (const [k, P] of byHash) if (P.length > 1) groups.push({ size, hash: k, paths: P.sort() });
  }
  groups.sort((a, b) => b.size * (b.paths.length - 1) - a.size * (a.paths.length - 1));
  const mb = (n) => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : n < 1073741824 ? (n / 1048576).toFixed(1) + " MB" : (n / 1073741824).toFixed(2) + " GB";
  const extra = groups.reduce((s, g) => s + g.size * (g.paths.length - 1), 0), copies = groups.reduce((s, g) => s + g.paths.length - 1, 0);
  const head = `Checked ${files.length} files in ${root}${recursive ? " and its subfolders" : ""} (${hashed} with a same-size twin were compared by content).` +
    (capped ? " Stopped at 100000 files." : "") + (unreadable ? ` ${unreadable} files or folders could not be read.` : "");
  if (!groups.length) return head + "\nNo duplicates: every file's content is unique.";
  const lines = groups.slice(0, 300).map((g, n) => `Group ${n + 1}: ${g.paths.length} identical files, ${mb(g.size)} each (sha256 ${g.hash.slice(0, 12)})\n` + g.paths.map((p) => "  " + p).join("\n"));
  return `${head}\nFound ${groups.length} groups of identical files: ${copies} extra copies using ${mb(extra)}.` + (groups.length > 300 ? " The 300 largest groups are listed." : "") +
    "\nNothing was changed. To remove extra copies, keep one file per group and delete the others with delete_files (they go to the Recycle Bin).\n\n" + lines.join("\n\n");
}

// ---------- run
const cap = (s, n = 12000) => (s.length > n ? s.slice(0, n / 2) + `\n…[${s.length - n} chars omitted]…\n` + s.slice(-n / 2) : s);
function backup(p) {
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return;
  fs.mkdirSync(BACKUPS, { recursive: true });
  const b = path.join(BACKUPS, `${new Date().toISOString().replace(/[:.]/g, "-")}__${Math.random().toString(36).slice(2, 6)}__${path.basename(p)}`);
  fs.copyFileSync(p, b); return b;
}
// the environment for programs the agents start: anything that looks like a secret is left out
const cleanEnv = (env = {}) => Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([k]) => !/key|token|secret|passw|omniroute|api/i.test(k) || k in env));
function ps(script, env, cwd, timeoutMs) {
  return new Promise((ok) => {
    const clean = cleanEnv(env);
    const refresh = "$env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')+';'+$env:Path\n"; // programs installed during this session are found
    const c = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8\n" + refresh + script + PASS_CODE], { cwd, env: clean, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", timedOut = false;
    c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => { timedOut = true; spawn("taskkill", ["/pid", String(c.pid), "/t", "/f"], { windowsHide: true }); }, timeoutMs);
    c.on("close", (code) => { clearTimeout(t); ok({ code, out: cap(out), timedOut }); });
    c.on("error", (e) => { clearTimeout(t); ok({ code: -1, out: String(e), timedOut: false }); });
  });
}

// ---------- undo journal and activity log
// Every change an agent makes is recorded per answer ("turn") so it can be undone: files created, files overwritten (with
// their backup), moves, and items sent to the Recycle Bin. Commands are recorded too, but cannot be reversed.
const UNDO = path.join(CFG_DIR, "undo.json"), ACT = path.join(CFG_DIR, "activity.jsonl");
const readJ = () => { try { return JSON.parse(fs.readFileSync(UNDO, "utf8")); } catch { return {}; } };
const writeJ = (j) => { const keep = Object.entries(j).sort((a, b) => b[1].t - a[1].t).slice(0, 40); fs.mkdirSync(CFG_DIR, { recursive: true }); fs.writeFileSync(UNDO, JSON.stringify(Object.fromEntries(keep))); };
function journal(meta, entries) {
  if (!meta || !meta.turn || !entries.length) return;
  const j = readJ(), k = String(meta.turn).slice(0, 40), t = j[k] || { t: Date.now(), chat: meta.chat || null, entries: [], undone: false };
  t.entries.push(...entries); t.t = Date.now(); t.undone = false; j[k] = t; writeJ(j);
}
function logActivity(e) {
  try {
    fs.mkdirSync(CFG_DIR, { recursive: true });
    if (fs.existsSync(ACT) && fs.statSync(ACT).size > 1.5e6) { const L = fs.readFileSync(ACT, "utf8").split("\n").filter(Boolean); fs.writeFileSync(ACT, L.slice(-2000).join("\n") + "\n"); }
    fs.appendFileSync(ACT, JSON.stringify(e) + "\n");
  } catch {}
}
export function readActivity(n = 300) {
  try { return fs.readFileSync(ACT, "utf8").split("\n").filter(Boolean).slice(-n).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
export function undoInfo(turn) {
  const t = readJ()[String(turn)]; if (!t) return { changes: 0, commands: 0, undone: false };
  return { changes: t.entries.filter((e) => e.op !== "command").length, commands: t.entries.filter((e) => e.op === "command").length, undone: !!t.undone };
}
// Put a Recycle Bin item back where it came from: the most recently deleted item with that name from that folder.
const RESTORE_PS = `$t=$env:ORC_P; $dir=[IO.Path]::GetDirectoryName($t); $nm=[IO.Path]::GetFileName($t)
$base=[IO.Path]::GetFileNameWithoutExtension($nm); $ext=[IO.Path]::GetExtension($nm)
$rb=(New-Object -ComObject Shell.Application).Namespace(10); $best=$null; $bd=[datetime]::MinValue
foreach($i in $rb.Items()){
  $from=[string]$i.ExtendedProperty("System.Recycle.DeletedFrom"); if($from.TrimEnd('\\') -ne $dir.TrimEnd('\\')){continue}
  $shown=[string]$i.Name; $iext=[IO.Path]::GetExtension([string]$i.Path)
  if(-not ($shown -eq $nm -or (($shown -eq $base -or [IO.Path]::GetFileNameWithoutExtension($shown) -eq $base) -and $iext -eq $ext))){continue}
  $d=$i.ExtendedProperty("System.Recycle.DateDeleted"); if($d -and $d -gt $bd){$bd=$d;$best=$i}elseif(-not $best){$best=$i}
}
if(-not $best){Write-Output "NOTFOUND"; exit 3}
if(Test-Path -LiteralPath $t){Write-Output "EXISTS"; exit 4}
Move-Item -LiteralPath ([string]$best.Path) -Destination $t; Write-Output "OK"`;
const recycle = (p, cwd) => ps(`Add-Type -AssemblyName Microsoft.VisualBasic; $p=$env:ORC_P; if(Test-Path -LiteralPath $p -PathType Container){[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin')}else{[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin')}`, { ORC_P: p }, cwd, 30000);
export async function undoTurn(turn, cfg = loadConfig()) {
  const j = readJ(), t = j[String(turn)];
  if (!t || !t.entries.length) return { ok: false, error: "Nothing to undo for this answer." };
  if (t.undone) return { ok: false, error: "These changes were already undone." };
  const out = []; let done = 0, skipped = 0;
  const ok = (s) => { done++; out.push("Undone: " + s); }, skip = (s) => { skipped++; out.push("Skipped: " + s); };
  for (const e of [...t.entries].reverse()) {
    try {
      if (e.op === "command") { skip("command cannot be reversed: " + e.text); continue; }
      if (e.op === "created") {
        const p = checkPath(e.path, cfg);
        if (!fs.existsSync(p)) { skip(`${p} is already gone`); continue; }
        if (e.dir) { try { fs.rmdirSync(p); ok(`removed folder ${p}`); } catch { skip(`kept folder ${p} (it is not empty)`); } continue; }
        const r = await recycle(p, cfg.cwd); r.code === 0 ? ok(`moved new file ${p} to the Recycle Bin`) : skip(`${p}: ${r.out.trim().slice(0, 200)}`); continue;
      }
      if (e.op === "modified") {
        const p = checkPath(e.path, cfg);
        if (!e.backup || !fs.existsSync(e.backup)) { skip(`no backup left for ${p}`); continue; }
        backup(p); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.copyFileSync(e.backup, p); ok(`restored the earlier version of ${p}`); continue;
      }
      if (e.op === "moved") {
        const a = checkPath(e.from, cfg), b = checkPath(e.to, cfg);
        if (!fs.existsSync(b)) { skip(`${b} is no longer there`); continue; }
        if (fs.existsSync(a)) { skip(`${a} already exists again, so ${b} was left where it is`); continue; }
        fs.mkdirSync(path.dirname(a), { recursive: true }); try { fs.renameSync(b, a); } catch { await fsp.cp(b, a, { recursive: true }); await fsp.rm(b, { recursive: true }); }
        ok(`moved ${b} back to ${a}`); continue;
      }
      if (e.op === "deleted") {
        const p = checkPath(e.path, cfg);
        const r = await ps(RESTORE_PS, { ORC_P: p }, cfg.cwd, 60000);
        /OK\s*$/.test(r.out) ? ok(`restored ${p} from the Recycle Bin`) : skip(`${p}: ${/NOTFOUND/.test(r.out) ? "not in the Recycle Bin any more" : /EXISTS/.test(r.out) ? "a file with that name exists again" : r.out.trim().slice(0, 200)}`);
      }
    } catch (err) { skip(String(err.message || err)); }
  }
  t.undone = true; j[String(turn)] = t; writeJ(j);
  logActivity({ t: Date.now(), chat: t.chat, turn, tool: "undo", summary: `Undo: ${done} undone, ${skipped} skipped`, ok: true });
  return { ok: true, done, skipped, report: out.join("\n") };
}

// File changes run one at a time so parallel workers can never interleave writes.
let chain = Promise.resolve();
export function run(name, input, cfg = loadConfig(), scope, meta) {
  const go = async () => {
    const pre = await precheck(name, input, cfg, scope), jr = [];
    try { const r = await runInner(name, input, cfg, jr); logActivity({ t: Date.now(), chat: meta?.chat || null, turn: meta?.turn || null, tool: name, summary: String(pre.summary || "").slice(0, 600), ok: true }); return r; }
    catch (e) { logActivity({ t: Date.now(), chat: meta?.chat || null, turn: meta?.turn || null, tool: name, summary: String(pre.summary || "").slice(0, 600), ok: false, error: String(e.message || e).slice(0, 300) }); throw e; }
    finally { journal(meta, jr); } // a bulk action that partly failed still records what it did
  };
  if (["run_command", "run_code", "read_file", "read_files", "list_dir", "download_file", "web_search", "web_open", "inspect_file", "find_duplicates", "view_images", "install_tool", "find_files", "search_files", "system_info", "notify", "open_path", "clipboard", "convert_media", "generate_image", "transcribe_audio", "speak", "browser", "start_process", "read_process", "stop_process"].includes(name)) return go();
  const p = chain.then(go, go); chain = p.catch(() => {}); return p;
}
async function runInner(name, input, cfg, jr = []) {
  await precheck(name, input, cfg); // re-validate: never trust an earlier check
  const i = input || {};
  switch (name) {
    case "run_command": {
      jr.push({ op: "command", text: String(i.command || "").slice(0, 300) });
      const secs = Math.min(Math.max(Number(i.timeout_sec) || 60, 1), 300);
      const r = await ps(i.command, {}, cfg.cwd, secs * 1000);
      return `${r.timedOut ? `[timed out after ${secs}s and was stopped]\n` : ""}${r.out || "(no output)"}\n[exit code ${r.code}]`;
    }
    case "start_process": {
      const d = i.cwd ? checkPath(i.cwd, cfg) : cfg.cwd;
      if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) throw new Error("not a folder: " + d);
      jr.push({ op: "command", text: ("background: " + String(i.command || "")).slice(0, 300) });
      const j = startJob({ command: String(i.command), name: i.name, cwd: d, env: cleanEnv() });
      const first = await readJob({ id: j.id, wait: Math.min(Math.max(i.wait === undefined || i.wait === null || i.wait === "" ? 3 : Number(i.wait) || 0, 0), 30), until: i.until });
      return `Started background job ${j.id} "${j.name}" (process ${j.pid}). Use read_process with id ${j.id} to see new output and stop_process to end it.\n` + first;
    }
    case "read_process": return readJob(i);
    case "stop_process": return stopJob(i.id);
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
    case "write_file": { const p = checkPath(i.path, cfg), b = backup(p); jr.push(b ? { op: "modified", path: p, backup: b } : { op: "created", path: p }); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, String(i.content ?? "")); return `Wrote ${p}`; }
    case "edit_file": {
      const p = checkPath(i.path, cfg), txt = fs.readFileSync(p, "utf8"), o = String(i.old_string ?? "");
      if (!o) throw new Error("old_string is required");
      const n = txt.split(o).length - 1;
      if (n === 0) throw new Error("old_string not found");
      if (n > 1 && !i.replace_all) throw new Error(`old_string matches ${n} places; make it unique or set replace_all`);
      jr.push({ op: "modified", path: p, backup: backup(p) }); fs.writeFileSync(p, txt.split(o).join(String(i.new_string ?? ""))); return `Edited ${p} (${n} replacement${n > 1 ? "s" : ""})`;
    }
    case "make_dir": { const p = checkPath(i.path, cfg); if (!fs.existsSync(p)) jr.push({ op: "created", path: p, dir: true }); fs.mkdirSync(p, { recursive: true }); return `Created ${p}`; }
    case "copy_file": { const a = checkPath(i.source, cfg), b = checkPath(i.destination, cfg); if (fs.existsSync(b)) throw new Error("destination already exists"); fs.mkdirSync(path.dirname(b), { recursive: true }); await fsp.cp(a, b, { recursive: true }); jr.push({ op: "created", path: b }); return `Copied to ${b}`; }
    case "move_file": { const a = checkPath(i.source, cfg), b = checkPath(i.destination, cfg); if (fs.existsSync(b)) throw new Error("destination already exists"); fs.mkdirSync(path.dirname(b), { recursive: true }); try { fs.renameSync(a, b); } catch { await fsp.cp(a, b, { recursive: true }); await fsp.rm(a, { recursive: true }); } jr.push({ op: "moved", from: a, to: b }); return `Moved to ${b}`; }
    case "delete_file": {
      const p = checkPath(i.path, cfg); if (!fs.existsSync(p)) throw new Error("not found");
      const dir = fs.statSync(p).isDirectory();
      const r = await ps(`Add-Type -AssemblyName Microsoft.VisualBasic; $p=$env:ORC_P; if(${dir ? "$true" : "$false"}){[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin')}else{[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin')}`, { ORC_P: p }, cfg.cwd, 30000);
      if (r.code !== 0) throw new Error(r.out);
      jr.push({ op: "deleted", path: p, dir });
      return `Moved to Recycle Bin: ${p}`;
    }
    case "run_code": return formatSandbox(await runSandboxRaw(langOf(i), i.code, i.timeout_sec));
    case "read_files": case "write_files": case "move_files": case "delete_files": {
      const single = { read_files: ["read_file", (p) => ({ path: p }), i.paths], write_files: ["write_file", (f) => f, i.files], move_files: ["move_file", (m) => m, i.moves], delete_files: ["delete_file", (p) => ({ path: p }), i.paths] }[name];
      const out = []; let failed = 0;
      for (const item of single[2]) {
        const label = typeof item === "string" ? item : item.path || item.source;
        try { const r = await runInner(single[0], single[1](item), cfg, jr); out.push(name === "read_files" ? `=== ${label} ===\n${r}` : `OK    ${label}`); }
        catch (e) { failed++; out.push(`ERROR ${label}: ${e.message}`); }
      }
      return out.join("\n") + (failed ? `\n[${failed} of ${single[2].length} failed]` : "");
    }
    case "inspect_file": return inspect(checkPath(i.path, cfg), Math.max(0, Number(i.offset) || 0));
    case "find_duplicates": return findDuplicates(checkPath(i.path || ".", cfg), i.recursive !== false);
    case "find_files": return findFiles(checkPath(i.path || ".", cfg), i, cfg);
    case "search_files": return searchFiles(checkPath(i.path || ".", cfg), i, cfg);
    case "system_info": return systemInfo(cfg);
    case "notify": {
      const t = String(i.title || "OmniGPT").slice(0, 120), m = String(i.message || "").slice(0, 400);
      if (process.platform !== "win32") return `Notification (shown in the app only on this system): ${t} - ${m}`;
      const r = await ps(TOAST_PS, { ORC_T: t, ORC_M: m }, cfg.cwd, 20000);
      return r.code === 0 ? `Notification shown: ${t}` : `The Windows notification could not be shown (${r.out.trim().slice(0, 160)}); the app shows it instead.`;
    }
    case "open_path": {
      if (i.url) { const u = new URL(String(i.url)); if (process.platform === "win32") spawn("explorer.exe", [u.href], { windowsHide: true, detached: true, stdio: "ignore" }).unref(); return `Opened ${u.href} in the default browser.`; }
      const p = checkPath(i.path, cfg); if (!fs.existsSync(p)) throw new Error("not found: " + p);
      if (!i.reveal && RUN_EXT.test(p)) throw new Error("Programs and scripts are never opened.");
      if (process.platform === "win32") spawn("explorer.exe", i.reveal ? ["/select," + p] : [p], { windowsHide: true, detached: true, stdio: "ignore" }).unref();
      return i.reveal ? `Showed ${p} in File Explorer.` : `Opened ${p}${fs.statSync(p).isDirectory() ? " in File Explorer" : " in its default app"}.`;
    }
    case "clipboard": {
      if (process.platform !== "win32") throw new Error("the clipboard tool needs Windows");
      if (i.action === "read") { const r = await ps("Get-Clipboard -Raw", {}, cfg.cwd, 15000); return r.out ? "Clipboard text:\n" + r.out : "The clipboard holds no text."; }
      const r = await ps("Set-Clipboard -Value $env:ORC_T", { ORC_T: String(i.text ?? "") }, cfg.cwd, 15000); if (r.code !== 0) throw new Error(r.out.trim().slice(0, 200)); return "Copied to the clipboard.";
    }
    case "archive": return archiveTool(i, cfg, jr);
    case "browser": return browserAction(i, { exe: findBrowser(), profile: path.join(CFG_DIR, "browser"), downloads: path.join(cfg.cwd, "Browser downloads"), headless: !!i.headless || process.env.OMNIGPT_BROWSER_HEADLESS === "1", checkUrl: browserUrlOk });
    case "make_document": return makeDocument(i, cfg, jr);
    case "edit_image": return editImage(i, cfg, jr);
    case "convert_media": return convertMedia(i, cfg, jr);
    case "generate_image": return generateImage(i, cfg, jr);
    case "transcribe_audio": return transcribeAudio(i, cfg, jr);
    case "speak": return speak(i, cfg, jr);
    case "view_images": return viewImages(i.paths.map((p) => checkPath(p, cfg)), Number(i.max_side) || 768, cfg);
    case "install_tool": {
      const m = String(i.manager), pkg = String(i.package).trim();
      const script = m === "winget" ? 'winget install --id "$env:ORC_PKG" -e --silent --accept-package-agreements --accept-source-agreements --disable-interactivity'
        : m === "pip" ? 'if(Get-Command py -ErrorAction SilentlyContinue){py -m pip install --user --upgrade "$env:ORC_PKG"}elseif(Get-Command python -ErrorAction SilentlyContinue){python -m pip install --user --upgrade "$env:ORC_PKG"}else{Write-Output "Python is not installed. Install it first: install_tool winget Python.Python.3.12"; exit 9}'
        : 'npm install -g "$env:ORC_PKG"';
      jr.push({ op: "command", text: `install ${pkg} with ${m}` });
      const r = await ps(script, { ORC_PKG: pkg }, cfg.cwd, 15 * 60000);
      return `${r.timedOut ? "[timed out after 15 minutes]\n" : ""}${r.out || "(no output)"}\n[exit code ${r.code}]` + (r.code === 0 ? "\nInstalled. run_command finds new programs right away (PATH is refreshed for every command)." : "");
    }
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
        fs.renameSync(tmp, p); jr.push({ op: "created", path: p });
      } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
      return `Downloaded ${n} bytes to ${p}. The file was NOT opened or executed.`;
    }
  }
}
