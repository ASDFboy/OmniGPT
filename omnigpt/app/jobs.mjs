// Background jobs: long-running commands (dev servers, builds, watchers) started by an agent with start_process.
// Their output is kept in memory (the most recent 400,000 characters per job) so read_process can return what is new.
// Every job is listed in the app, can be stopped from there, and is stopped when OmniGPT closes.
import { spawn } from "node:child_process";

const MAX_RUNNING = 8, KEEP = 400000;
// PowerShell reports 1 for any failed program; this passes the program's own exit code through (and 1 for a failed command)
export const PASS_CODE = "\n$__ok=$?; if ($LASTEXITCODE) { exit $LASTEXITCODE }; if (-not $__ok) { exit 1 }";
const jobs = new Map(); let nextId = 1;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r(?!\n)/g;

const ago = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? s + " s" : s < 3600 ? Math.floor(s / 60) + " min " + (s % 60) + " s" : Math.floor(s / 3600) + " h " + Math.floor((s % 3600) / 60) + " min"; };
const state = (j) => j.code === undefined ? "running" : j.stopped ? "stopped" : `exited with code ${j.code}`;
export const runningJobs = () => [...jobs.values()].filter((j) => j.code === undefined).length;

// env: the environment with secrets already removed (the caller builds it)
export function startJob({ command, name, cwd, env }) {
  if (runningJobs() >= MAX_RUNNING) throw new Error(`${MAX_RUNNING} background jobs are already running; stop one first with stop_process`);
  const win = process.platform === "win32";
  const refresh = "$env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')+';'+$env:Path\n";
  const c = win
    ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8\n" + refresh + command + PASS_CODE], { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    : spawn("/bin/sh", ["-c", command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] }); // own process group, so stop reaches its children
  const j = { id: String(nextId++), name: String(name || command).replace(/\s+/g, " ").slice(0, 60), command: String(command), cwd, pid: c.pid, started: Date.now(), out: "", dropped: 0, read: 0, child: c, code: undefined, ended: 0, stopped: false };
  const add = (d) => { j.out += String(d).replace(ANSI, ""); if (j.out.length > KEEP) { const cut = j.out.length - KEEP; j.out = j.out.slice(cut); j.dropped += cut; } };
  c.stdout.on("data", add); c.stderr.on("data", add);
  c.on("error", (e) => { add("\n[could not start: " + e.message + "]\n"); if (j.code === undefined) { j.code = -1; j.ended = Date.now(); } });
  c.on("close", (code, sig) => { if (j.code === undefined) { j.code = code ?? (sig ? -1 : 0); j.ended = Date.now(); } });
  jobs.set(j.id, j);
  for (const [id, old] of jobs) if (jobs.size > 40 && old.code !== undefined) jobs.delete(id); // forget the oldest finished jobs
  return j;
}
const killTree = (j) => {
  if (!j.child || j.code !== undefined) return;
  try { if (process.platform === "win32") spawn("taskkill", ["/pid", String(j.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }); else process.kill(-j.pid, "SIGTERM"); } catch { try { j.child.kill(); } catch {} }
};
export async function stopJob(id) {
  const j = jobs.get(String(id)); if (!j) throw new Error("no background job with id " + id + " (read_process with no id lists them)");
  if (j.code !== undefined) return `Job ${j.id} "${j.name}" had already ${state(j)}.`;
  j.stopped = true; killTree(j);
  for (let k = 0; k < 50 && j.code === undefined; k++) await new Promise((r) => setTimeout(r, 100));
  if (j.code === undefined && process.platform !== "win32") { try { process.kill(-j.pid, "SIGKILL"); } catch {} }
  for (let k = 0; k < 20 && j.code === undefined; k++) await new Promise((r) => setTimeout(r, 100));
  return `Stopped job ${j.id} "${j.name}" after ${ago(Date.now() - j.started)}.` + (j.code === undefined ? " (It is still shutting down.)" : "");
}
export function stopAllJobs() { for (const j of jobs.values()) { j.stopped = true; killTree(j); } }

export function listJobs() {
  return [...jobs.values()].map((j) => ({ id: j.id, name: j.name, command: j.command.slice(0, 300), cwd: j.cwd, pid: j.pid, started: j.started, ended: j.ended || null, state: state(j), running: j.code === undefined, tail: j.out.slice(-1500) }));
}
const listText = () => {
  const L = [...jobs.values()];
  return L.length ? "Background jobs:\n" + L.map((j) => `${j.id}  ${j.name}  ${state(j)}  started ${ago(Date.now() - j.started)} ago  (${j.command.slice(0, 80)})`).join("\n") : "No background jobs.";
};

// read_process: what the job printed since the last read (or all of it), waiting up to wait seconds for new output,
// for the text in until to appear, or for the job to end
export async function readJob({ id, all, wait, until }) {
  if (id === undefined || id === null || id === "") return listText();
  const j = jobs.get(String(id)); if (!j) throw new Error("no background job with id " + id + "\n" + listText());
  const secs = Math.min(Math.max(Number(wait) || 0, 0), 60);
  let re = null; if (until) { try { re = new RegExp(String(until), "i"); } catch { re = new RegExp(String(until).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); } }
  const fresh = () => j.out.slice(Math.max(0, j.read - j.dropped));
  const end = Date.now() + secs * 1000;
  while (Date.now() < end && j.code === undefined && (re ? !re.test(fresh()) : !fresh())) await new Promise((r) => setTimeout(r, 200));
  const text = all ? j.out : fresh();
  j.read = j.dropped + j.out.length;
  const max = 12000, shown = text.length > max ? `…[${text.length - max} earlier characters not shown]\n` + text.slice(-max) : text;
  const head = `Job ${j.id} "${j.name}": ${state(j)}${j.code === undefined ? ", running for " + ago(Date.now() - j.started) : " after " + ago(j.ended - j.started)}.`;
  const found = re ? (re.test(text) ? `\n"${until}" appeared in the output.` : `\n"${until}" did not appear${secs ? " within " + secs + " s" : ""}.`) : "";
  return head + found + "\n" + (shown.trim() ? (all ? "Output (most recent):\n" : "New output:\n") + shown : all ? "(no output yet)" : "(no new output since the last read)");
}
