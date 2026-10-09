// Background jobs: start_process / read_process / stop_process. Starts small Node programs as jobs, waits for their
// output, stops them, and checks the safety rules. Run: node jobs-test.mjs (exit 0 = all passed)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = ["app", "OmniGPT"].map((d) => path.resolve(here, "..", "..", d)).find((d) => fs.existsSync(path.join(d, "server.mjs")));
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-jobstest-"));
process.env.OMNIGPT_TEST_SECRET_TOKEN = "s3cr3t"; // must never reach a job
const tools = await import(pathToFileURL(path.join(src, "tools.mjs")).href);
const W = path.join(os.homedir(), "Documents", "OmniRoute Workspace", ".omnigpt-jobs-test-" + process.pid);
let failed = 0;
const check = (name, ok, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "  " + extra : "")); };
const cfg = { ...tools.loadConfig(), cwd: W, roots: [path.dirname(W)], granted: [], approval: "ask" };
const refused = (name, input, scope) => tools.precheck(name, input, cfg, scope).then(() => false, () => true);
const R = (name, input, meta) => tools.run(name, input, cfg, undefined, meta);
const idOf = (r) => (/Started background job (\d+)/.exec(r) || [])[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { // a finished process that nobody has collected yet (a zombie, in containers without an init) counts as gone
  if (process.platform === "linux") { try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; } }
  try { process.kill(pid, 0); return true; } catch { return false; } };
try {
  fs.mkdirSync(path.join(W, "site"), { recursive: true });
  // a small "server": says it is ready, then keeps printing (with colour codes, which are removed)
  fs.writeFileSync(path.join(W, "site", "server.js"), "let n=0;console.log('\\x1b[32mready on port 4321\\x1b[0m');setInterval(()=>console.log('tick '+(++n)),150);");
  fs.writeFileSync(path.join(W, "quick.js"), "console.log('finished the build');process.exit(3);");
  fs.writeFileSync(path.join(W, "env.js"), "console.log('secret='+(process.env.OMNIGPT_TEST_SECRET_TOKEN||'none'));setTimeout(()=>{},60000);");
  fs.writeFileSync(path.join(W, "pid.js"), "console.log('pid='+process.pid);setInterval(()=>{},1000);");

  check("parallel workers cannot start background jobs", await refused("start_process", { command: "node server.js" }, { writes: [W] }));
  check("the command rules apply (drive wipe refused)", await refused("start_process", { command: "Remove-Item C:\\ -Recurse -Force" }));
  check("the command rules apply (reading secrets refused)", await refused("start_process", { command: "Get-Content $env:OMNIROUTE_API_KEY" }));
  check("a working folder outside the allowed folders is refused", await refused("start_process", { command: "node server.js", cwd: path.join(os.homedir(), ".ssh") }));
  check("stop needs an id", await refused("stop_process", {}));
  const pre = await tools.precheck("start_process", { command: "node server.js", cwd: path.join(W, "site"), name: "dev server" }, cfg);
  check("starting a job is an action that asks (exec class)", pre.class === "exec" && /Start in the background \("dev server"\)/.test(pre.summary), pre.summary.split("\n")[0]);

  const meta = { turn: "t-jobs-" + process.pid };
  let r = await R("start_process", { command: "node server.js", cwd: path.join(W, "site"), name: "dev server", until: "ready on port" }, meta);
  const id = idOf(r);
  check("start_process returns a job id and waits for the ready message", !!id && /"ready on port" appeared/.test(r) && /ready on port 4321/.test(r), r.split("\n").slice(0, 3).join(" | "));
  check("colour codes are removed from the output", !/\x1b\[/.test(r));
  await sleep(700);
  r = await R("read_process", { id });
  check("read_process returns what is new since the last read", /New output:/.test(r) && /tick \d+/.test(r) && !/ready on port/.test(r), r.split("\n").slice(0, 3).join(" | "));
  r = await R("read_process", { id, wait: 5, until: "tick 2\\d" });
  check("read_process can wait for a pattern", /"tick 2\\d" appeared/.test(r) && /tick 2\d/.test(r), r.split("\n")[1]);
  r = await R("read_process", { id, all: true });
  check("all: true returns the whole recent output", /ready on port 4321/.test(r) && /tick 1\b/.test(r));
  r = await R("read_process", {});
  check("read_process with no id lists the jobs", new RegExp(`^Background jobs:\\n${id}  dev server  running`).test(r), r.split("\n").slice(0, 2).join(" | "));
  check("the app's job list shows it running", tools.listJobs().some((j) => j.id === id && j.running && /tick/.test(j.tail)));
  r = await R("stop_process", { id });
  check("stop_process stops the job", /^Stopped job/.test(r), r);
  await sleep(500);
  r = await R("read_process", { id });
  const after = /tick (\d+)/g, n1 = [...r.matchAll(after)].length; await sleep(600); const r2 = await R("read_process", { id });
  check("a stopped job prints nothing more", /stopped/.test(r2) && !/tick/.test(r2), `${n1} ticks right after the stop, then: ${r2.split("\n").slice(-1)[0]}`);
  r = await R("stop_process", { id });
  check("stopping it again just says so", /had already stopped/.test(r), r);

  r = await R("start_process", { command: "node quick.js", wait: 0 });
  const q = idOf(r); await R("read_process", { id: q, wait: 20 }); r = await R("read_process", { id: q, all: true });
  check("a job that ends by itself reports its exit code and output", /exited with code 3/.test(r) && /finished the build/.test(r), r.split("\n")[0]);

  r = await R("start_process", { command: "node env.js", until: "secret=" });
  check("secrets in the environment never reach a job", /secret=none/.test(r), (/secret=\w+/.exec(r) || ["(no output)"])[0]);
  await R("stop_process", { id: idOf(r) });

  r = await R("start_process", { command: "node pid.js", until: "pid=" });
  const pid = Number((/pid=(\d+)/.exec(r) || [])[1]), pj = idOf(r);
  await R("stop_process", { id: pj }); await sleep(800);
  check("stopping a job also ends the programs it started", pid > 0 && !alive(pid), "node pid " + pid + (alive(pid) ? " still running" : " gone"));

  const ids = [];
  for (let k = 0; k < 8; k++) ids.push(idOf(await R("start_process", { command: "node pid.js", wait: 0 })));
  check("at most 8 jobs run at once", ids.every(Boolean) && (await R("start_process", { command: "node pid.js", wait: 0 }).then(() => false, (e) => /8 background jobs/.test(e.message))));
  const pids = []; for (const j of ids) { const t = await R("read_process", { id: j, wait: 10, until: "pid=" }); pids.push(Number((/pid=(\d+)/.exec(t) || [])[1])); }
  tools.stopAllJobs(); await sleep(1500);
  check("all jobs stop when OmniGPT closes", pids.every((p) => p > 0 && !alive(p)) && tools.listJobs().every((j) => !j.running), pids.filter(alive).length + " still running; listed as running: " + tools.listJobs().filter((j) => j.running).map((j) => j.id).join(","));

  const info = tools.undoInfo(meta.turn);
  check("the job is recorded in the undo journal as a command (cannot be undone)", info.commands === 1 && info.changes === 0, JSON.stringify(info));
  check("the activity log lists the job tools", ["start_process", "read_process", "stop_process"].every((t) => tools.readActivity(100).some((a) => a.tool === t)));
} catch (e) { check("jobs test", false, String(e.stack || e)); }
tools.stopAllJobs(); await sleep(300);
fs.rmSync(W, { recursive: true, force: true }); try { fs.rmSync(process.env.LOCALAPPDATA, { recursive: true, force: true }); } catch {}
console.log(failed ? `${failed} check(s) failed.` : "All background job checks passed.");
process.exit(failed ? 1 : 0);
