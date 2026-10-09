// Tries to escape the code sandbox. Every attack must FAIL. Usage: node sandbox-test.mjs <installRoot>
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.argv[2];
if (!ROOT || !fs.existsSync(path.join(ROOT, "OmniGPT.Sandbox.exe"))) { console.error("usage: node sandbox-test.mjs <installRoot>"); process.exit(2); }
function sbx(lang, code, secs = 10, mem = 256, io = []) {
  const r = spawnSync(path.join(ROOT, "OmniGPT.Sandbox.exe"), [ROOT, lang, String(secs), String(mem), ...io], { input: code, encoding: "utf8", timeout: (secs + 40) * 1000, windowsHide: true, maxBuffer: 50e6 });
  try { return JSON.parse(r.stdout); } catch { return { error: "bad output: " + String(r.stdout).slice(0, 200), stdout: "", stderr: String(r.stderr).slice(0, 200), exitCode: -9 }; }
}
const HOME = os.homedir().replace(/\\/g, "\\\\");
const SECRET_FILE = path.join(os.homedir(), "Documents", "OmniRoute Workspace", "sandbox-canary.txt");
fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
fs.writeFileSync(SECRET_FILE, "CANARY-SECRET-DO-NOT-LEAK");
const WRITE_TARGET = path.join(os.homedir(), "Documents", "OmniRoute Workspace", "sandbox-escape.txt");
try { fs.unlinkSync(WRITE_TARGET); } catch {}
process.env.OMNIROUTE_API_KEY = "sk-canary-env-secret"; process.env.GROQ_API_KEY_TEST = "canary-2";

let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? "   " + detail : "")); };
const out = (r) => (r.stdout || "") + (r.stderr || "") + (r.error || "");
const S = SECRET_FILE.replace(/\\/g, "\\\\"), W = WRITE_TARGET.replace(/\\/g, "\\\\");

// ---- legitimate work must still function
let r = sbx("python", "print(sum(range(101)), 2**100)"); check("python runs and computes", r.exitCode === 0 && r.stdout.trim() === "5050 1267650600228229401496703205376", r.stdout.trim().slice(0, 60));
r = sbx("javascript", "console.log([1,2,3].reduce((a,b)=>a+b))"); check("javascript runs and computes", r.exitCode === 0 && r.stdout.trim() === "6", r.stdout.trim());
r = sbx("python", "open('note.txt','w').write('hi'); print(open('note.txt').read())"); check("python can use its own scratch folder", r.stdout.trim() === "hi", out(r).slice(0, 80));

// ---- python escape attempts
r = sbx("python", `print(open(r"${S}").read())`); check("python cannot read a user file", !/CANARY/.test(out(r)) && r.exitCode !== 0, (r.stderr || "").trim().split("\n").pop());
r = sbx("python", `import os\nprint(os.listdir(r"${HOME}"))`); check("python cannot list the user profile", r.exitCode !== 0 && !/Documents/.test(out(r)), (r.stderr || "").trim().split("\n").pop());
r = sbx("python", `open(r"${W}","w").write("pwned")`); check("python cannot write outside its folder", r.exitCode !== 0 && !fs.existsSync(WRITE_TARGET), (r.stderr || "").trim().split("\n").pop());
r = sbx("python", `import socket\ns=socket.socket(); s.settimeout(4); s.connect(("1.1.1.1",443)); print("CONN"+"ECTED")`); check("python has no internet", !/CONNECTED/.test(out(r)), (r.stderr || "").trim().split("\n").pop());
r = sbx("python", `import socket\ns=socket.socket(); s.settimeout(4); s.connect(("127.0.0.1",20128)); print("CONN"+"ECTED")`); check("python cannot reach OmniRoute on localhost", !/CONNECTED/.test(out(r)), (r.stderr || "").trim().split("\n").pop());
r = sbx("python", `import urllib.request\nprint(urllib.request.urlopen("http://example.com",timeout=4).status)`); check("python cannot fetch a web page", r.exitCode !== 0 && !/^200/.test(r.stdout.trim()), (r.stderr || "").trim().split("\n").pop().slice(0, 70));
r = sbx("python", `import subprocess\nprint(subprocess.run("cmd /c echo SPAW"+"NED",shell=True,capture_output=True,text=True).stdout)`); check("python cannot start other programs", !/SPAWNED/.test(out(r)), (r.stderr || "").trim().split("\n").pop().slice(0, 70));
r = sbx("python", `import os\nprint([k for k in os.environ if 'KEY' in k.upper() or 'TOKEN' in k.upper() or 'OMNI' in k.upper()], os.environ.get('OMNIROUTE_API_KEY'))`); check("python sees no secrets in its environment", !/canary/.test(out(r)) && /\[\] None/.test(r.stdout), r.stdout.trim().slice(0, 60));
r = sbx("python", `import os\nstartup=os.path.expandvars(r"%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup")\nopen(r"${HOME}\\\\AppData\\\\Roaming\\\\Microsoft\\\\Windows\\\\Start Menu\\\\Programs\\\\Startup\\\\evil.bat","w").write("calc")`); check("python cannot plant a startup program", r.exitCode !== 0 && !fs.existsSync(path.join(os.homedir(), "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "evil.bat")), (r.stderr || "").trim().split("\n").pop().slice(0, 70));
r = sbx("python", `import winreg\nk=winreg.CreateKey(winreg.HKEY_CURRENT_USER, r"Software\\\\OmniGPTSandboxTest")\nprint("REGISTRY-"+"WRITTEN")`); check("python cannot write the registry", !/REGISTRY-WRITTEN/.test(out(r)), (r.stderr || "").trim().split("\n").pop().slice(0, 70));

// ---- limits
let t0 = Date.now(); r = sbx("python", "while True: pass", 3); check("infinite loop is stopped at the time limit", r.timedOut === true && Date.now() - t0 < 15000, `timedOut=${r.timedOut} after ${Date.now() - t0} ms`);
r = sbx("python", "x = bytearray(1024*1024*1500)\nprint('ALLOC'+'ATED')", 10, 128); check("memory bomb is stopped by the memory cap", !/ALLOCATED/.test(out(r)) && r.exitCode !== 0, (r.stderr || "").trim().split("\n").pop().slice(0, 70));
r = sbx("python", "for i in range(3000000): print('A'*60)", 10); check("output flood is capped (no hang, no huge reply)", (r.stdout || "").length <= 70000, `stdout length ${(r.stdout || "").length}`);
r = sbx("python", "import threading, time\nfor i in range(50): threading.Thread(target=lambda: time.sleep(1)).start()\nprint('THREADS-OK')", 10, 256); check("threads still allowed (not a process)", /THREADS-OK/.test(r.stdout) || r.exitCode !== undefined);

// ---- javascript escape attempts
r = sbx("javascript", `console.log(require('fs').readFileSync(String.raw\`${SECRET_FILE}\`,'utf8'))`); check("javascript cannot read a user file", !/CANARY/.test(out(r)), (r.stderr || "").trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 70));
r = sbx("javascript", `require('fs').writeFileSync(String.raw\`${WRITE_TARGET}\`,'pwned')`); check("javascript cannot write outside its folder", !fs.existsSync(WRITE_TARGET));
r = sbx("javascript", `const s=require('net').connect(20128,'127.0.0.1');s.on('connect',()=>console.log('CONN'+'ECTED'));s.on('error',e=>console.log('ERR',e.code));setTimeout(()=>process.exit(),3000)`); check("javascript cannot reach OmniRoute on localhost", !/CONNECTED/.test(out(r)), out(r).trim().slice(0, 60));
r = sbx("javascript", `console.log(require('child_process').execSync('cmd /c echo SPAW'+'NED').toString())`); check("javascript cannot start other programs", !/SPAWNED/.test(out(r)));
r = sbx("javascript", `console.log(process.env.OMNIROUTE_API_KEY, Object.keys(process.env).filter(k=>/KEY|TOKEN|OMNI/i.test(k)).length)`); check("javascript sees no secrets", !/canary/.test(out(r)) && /undefined 0/.test(r.stdout), r.stdout.trim());

// ---- analyze_data: copies of chosen files in, result files out, and nothing else
{
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-sbx-io-")), inD = path.join(stage, "in"), outD = path.join(stage, "out"), WS = path.dirname(SECRET_FILE); // used inside Python raw strings
  fs.mkdirSync(inD); fs.writeFileSync(path.join(inD, "data.csv"), "item,amount\napples,3\npears,4.5\n");
  const io = (o) => ["--in", inD, "--out", o];
  r = sbx("python", `import csv, os\nrows=list(csv.DictReader(open("input/data.csv")))\nt=sum(float(x["amount"]) for x in rows)\nos.makedirs("output/charts", exist_ok=True)\nopen("output/summary.csv","w").write("total\\n%s\\n" % t)\nopen("output/charts/c.svg","w").write("<svg/>")\nprint("TOTAL", t)`, 20, 512, io(outD));
  check("analysis code reads its input copies and its result files come out", r.exitCode === 0 && /TOTAL 7\.5/.test(r.stdout) && JSON.stringify((r.files || []).sort()) === JSON.stringify(["charts\\c.svg", "summary.csv"]) && /7\.5/.test(fs.readFileSync(path.join(outD, "summary.csv"), "utf8")), out(r).slice(0, 160) + " files=" + JSON.stringify(r.files));
  r = sbx("python", `import os\nprint(sorted(os.listdir("input")))\nprint(open(r"${S}").read())`, 10, 256, io(path.join(stage, "o2")));
  check("analysis code sees only its copies, not the original folder", /\['data\.csv'\]/.test(r.stdout) && !/CANARY/.test(out(r)), r.stdout.trim().split("\n")[0]);
  r = sbx("python", `import _winapi, os\nos.makedirs("output", exist_ok=True)\ntry:\n  _winapi.CreateJunction(r"${WS}", r"output\\evil")\n  print("JUNCTION-MADE")\nexcept Exception as e: print("no junction:", e)\nopen("output/ok.txt","w").write("fine")`, 10, 256, io(path.join(stage, "o3")));
  const o3 = path.join(stage, "o3"), got3 = fs.existsSync(o3) ? fs.readdirSync(o3, { recursive: true }).map(String) : [];
  check("a link planted in output/ is never followed (no user file comes out)", !got3.some((n) => /canary/i.test(n)) && JSON.stringify(r.files) === JSON.stringify(["ok.txt"]), `${/JUNCTION-MADE/.test(r.stdout) ? "junction made" : "junction refused"}; copied: ${got3.join(", ")}`);
  r = sbx("python", `import _winapi, os, shutil\nshutil.rmtree("output", ignore_errors=True)\ntry:\n  _winapi.CreateJunction(r"${WS}", "output")\n  print("SWAPPED")\nexcept Exception as e: print("no swap:", e)`, 10, 256, io(path.join(stage, "o4")));
  const o4 = path.join(stage, "o4"), got4 = fs.existsSync(o4) ? fs.readdirSync(o4) : [];
  check("output/ itself swapped for a link copies nothing", got4.length === 0 && (r.files || []).length === 0, `${/SWAPPED/.test(r.stdout) ? "swapped" : "swap refused"}; copied ${got4.length}`);
  r = sbx("python", `import os\nfor i in range(60): open("output/f%02d.txt" % i,"w").write("x")`, 10, 256, io(path.join(stage, "o5")));
  check("at most 50 result files come out", (r.files || []).length === 50 && r.skipped === 10, `${(r.files || []).length} files, ${r.skipped} skipped`);
  fs.rmSync(stage, { recursive: true, force: true });
  // the whole tool, as the app runs it: CSV and Excel copies in, a summary file saved in the results folder, undoable
  const lad = process.env.LOCALAPPDATA; process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-sbx-cfg-")); process.env.OMNIGPT_ROOT = ROOT;
  const { pathToFileURL } = await import("node:url");
  const tools = await import(pathToFileURL(path.join(ROOT, "app", "tools.mjs")).href), { toXlsx } = await import(pathToFileURL(path.join(ROOT, "app", "docs.mjs")).href);
  const cfgDir = process.env.LOCALAPPDATA; process.env.LOCALAPPDATA = lad;
  const Wd = path.join(path.dirname(SECRET_FILE), ".omnigpt-analyze-test-" + process.pid); fs.mkdirSync(Wd, { recursive: true });
  fs.writeFileSync(path.join(Wd, "sales.csv"), "month,units\nJan,10\nFeb,32\n"); fs.writeFileSync(path.join(Wd, "budget.xlsx"), toXlsx([{ name: "Plan", rows: [["month", "budget"], ["Jan", 100], ["Feb", 250]] }], "Budget"));
  const cfg = { ...tools.loadConfig(), cwd: Wd, roots: [path.dirname(Wd)], granted: [] }, meta = { turn: "t-analyze-" + process.pid };
  const code = `import csv, os\nprint(sorted(os.listdir("input")))\nu=sum(int(r["units"]) for r in csv.DictReader(open("input/sales.csv")))\nb=sum(float(r["budget"]) for r in csv.DictReader(open("input/budget.Plan.csv")))\nopen("output/summary.csv","w").write("units,budget\\n%d,%g\\n" % (u,b))\nprint("UNITS", u, "BUDGET", b)`;
  const pre = await tools.precheck("analyze_data", { files: [path.join(Wd, "sales.csv"), path.join(Wd, "budget.xlsx")], code, output: path.join(Wd, "results") }, cfg);
  check("analyze_data asks before it saves result files", pre.class === "write" && /Analyze 2 files with python/.test(pre.summary));
  const res = await tools.run("analyze_data", { files: [path.join(Wd, "sales.csv"), path.join(Wd, "budget.xlsx")], code, output: path.join(Wd, "results") }, cfg, undefined, meta).catch((e) => "ERROR " + e.message);
  check("analyze_data: Excel sheets arrive as CSV, results are saved", /UNITS 42 BUDGET 350/.test(res) && /input\/budget\.Plan\.csv/.test(res) && fs.existsSync(path.join(Wd, "results", "summary.csv")) && /42,350/.test(fs.readFileSync(path.join(Wd, "results", "summary.csv"), "utf8")), res.replace(/\n/g, " | ").slice(0, 300));
  check("analyze_data results are in the undo journal", tools.undoInfo(meta.turn).changes === 2, JSON.stringify(tools.undoInfo(meta.turn)));
  check("analyze_data never fills a folder that already has files", await tools.precheck("analyze_data", { files: [], code: "print(1)", output: path.join(Wd, "results") }, cfg).then(() => false, (e) => /not empty/.test(e.message)));
  fs.rmSync(Wd, { recursive: true, force: true }); fs.rmSync(cfgDir, { recursive: true, force: true });
}

// ---- cleanup
const leftovers = (() => { try { return fs.readdirSync(path.join(process.env.LOCALAPPDATA, "OmniGPT", "sandbox", "runs")).filter((n) => !n.startsWith(".")).length; } catch { return 0; } })();
check("scratch folders are deleted after each run", leftovers === 0, `${leftovers} left`);
try { fs.unlinkSync(SECRET_FILE); } catch {}
console.log(failed ? `\n${failed} sandbox check(s) FAILED.` : "\nSandbox held against every attack.");
process.exit(failed ? 1 : 0);
