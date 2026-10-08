// Tries to escape the code sandbox. Every attack must FAIL. Usage: node sandbox-test.mjs <installRoot>
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.argv[2];
if (!ROOT || !fs.existsSync(path.join(ROOT, "OmniGPT.Sandbox.exe"))) { console.error("usage: node sandbox-test.mjs <installRoot>"); process.exit(2); }
function sbx(lang, code, secs = 10, mem = 256) {
  const r = spawnSync(path.join(ROOT, "OmniGPT.Sandbox.exe"), [ROOT, lang, String(secs), String(mem)], { input: code, encoding: "utf8", timeout: (secs + 40) * 1000, windowsHide: true, maxBuffer: 50e6 });
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

// ---- cleanup
const leftovers = (() => { try { return fs.readdirSync(path.join(process.env.LOCALAPPDATA, "OmniGPT", "sandbox", "runs")).filter((n) => !n.startsWith(".")).length; } catch { return 0; } })();
check("scratch folders are deleted after each run", leftovers === 0, `${leftovers} left`);
try { fs.unlinkSync(SECRET_FILE); } catch {}
console.log(failed ? `\n${failed} sandbox check(s) FAILED.` : "\nSandbox held against every attack.");
process.exit(failed ? 1 : 0);
