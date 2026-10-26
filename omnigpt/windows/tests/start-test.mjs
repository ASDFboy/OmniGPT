// Built with Claude (Anthropic) - see CREDITS.md
// OmniRoute starting and stopping: (1) a message sent while OmniRoute is still starting waits for it, and gives up with a clear
// message after the timeout; (2) the backend starts OmniRoute again when it died, and leaves it alone while it is up.
// Uses a tiny stand-in for OmniRoute (a script that answers every request and writes its process id to a file).
// Run: node start-test.mjs (exit 0 = all passed)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openApp } from "./pagekit.mjs";

let failed = 0;
const check = (name, ok, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "  " + String(extra).replace(/\n/g, "\\n").slice(0, 300) : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-start-"));
const PIDFILE = path.join(T, "pid.txt"), FAKE = path.join(T, "fake-omniroute.mjs"), PORT = "20319";
fs.writeFileSync(FAKE, `import http from "node:http"; import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(PIDFILE)}, String(process.pid));
const port = Number(new URL(process.env.OMNIROUTE_URL).port);
http.createServer((q, r) => { r.writeHead(200, { "content-type": "application/json" }); r.end("{}"); }).listen(port, "127.0.0.1");`);
const readPid = () => { try { return Number(fs.readFileSync(PIDFILE, "utf8")); } catch { return 0; } };
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; };

let app, app2;
try {
  // ---- 1. the page waits for OmniRoute instead of failing
  app = await openApp({ port: "20236" });
  const E = (js, ms) => app.evaluate(js, ms);
  await E(`window.__calls = 0; STATUS = { key: true, omniroute: false }; status = async () => { __calls++; if (__calls >= 3) { STATUS = { key: true, omniroute: true }; return true; } return false; }; true`);
  check("it waits until OmniRoute answers", (await E(`readyWait(5000, 40)`, 20000)) === true && (await E("__calls")) >= 3);
  await E(`window.__calls = -1000000; STATUS = { key: true, omniroute: false }; true`);
  const t0 = Date.now();
  check("it gives up after the timeout", (await E(`readyWait(300, 40)`, 20000)) === false && Date.now() - t0 < 5000);
  check("the waiting note says how long it has been", /Waiting for OmniRoute to finish starting/.test(await E(`$("#note").textContent`)));
  await app.close(); app = null;

  // ---- 2. the backend starts OmniRoute again when it died
  app2 = await openApp({ port: "20237", env: { OMNIROUTE_URL: "http://127.0.0.1:" + PORT, OMNIROUTE_SCRIPT: FAKE, OMNIGPT_WATCH_MS: "250" } });
  const first = await until(readPid);
  check("the backend starts OmniRoute when it is not running", !!first, first);
  await sleep(1500);
  check("it leaves OmniRoute alone while it is up", readPid() === first);
  try { process.kill(first, "SIGKILL"); } catch {}
  const again = await until(() => readPid() && readPid() !== first && readPid(), 20000);
  check("it starts OmniRoute again after it died", !!again && again !== first, `first ${first}, then ${again}`);
} catch (e) { check("start test", false, e.stack || e.message); }
finally {
  if (app) await app.close();
  if (app2) await app2.close();
  const p = readPid(); if (p) try { process.kill(p, "SIGKILL"); } catch {}
  fs.rmSync(T, { recursive: true, force: true });
}
console.log(failed ? `${failed} check(s) failed.` : "All start checks passed.");
process.exit(failed ? 1 : 0);
