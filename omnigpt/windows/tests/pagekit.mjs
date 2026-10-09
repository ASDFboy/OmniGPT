// Test helper: starts a throwaway OmniGPT backend and opens its page in a headless Edge (Windows) or Chromium
// (Linux), driven over the DevTools protocol, so tests can run the page's own code with a fake model.
// const app = await openApp({ port: "20171" }); await app.evaluate("1+1"); await app.close();
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const src = ["app", "OmniGPT"].map((d) => path.resolve(here, "..", "..", d)).find((d) => fs.existsSync(path.join(d, "server.mjs")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findBrowser() {
  if (process.env.OMNIGPT_BROWSER && fs.existsSync(process.env.OMNIGPT_BROWSER)) return process.env.OMNIGPT_BROWSER;
  if (process.platform === "win32") {
    for (const base of [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean))
      for (const rel of ["Microsoft\\Edge\\Application\\msedge.exe", "Google\\Chrome\\Application\\chrome.exe"]) { const f = path.join(base, rel); if (fs.existsSync(f)) return f; }
    return null;
  }
  const pw = "/opt/pw-browsers"; // the preinstalled Playwright Chromium in development containers
  try { for (const d of fs.readdirSync(pw).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) { const f = path.join(pw, d, "chrome-linux", "chrome"); if (fs.existsSync(f)) return f; } } catch {}
  for (const f of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) if (fs.existsSync(f)) return f;
  return null;
}

// OMNIGPT_TEST_PORT moves every test backend to another port, so two copies of the tests can run at the same time
export const testPort = (p) => String(process.env.OMNIGPT_TEST_PORT ? Number(process.env.OMNIGPT_TEST_PORT) + (Number(p) % 10) : p);
export async function openApp({ port = "20171", env: extra = {} } = {}) {
  port = testPort(port);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-page-"));
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, OMNIGPT_PORT: port, LOCALAPPDATA: data, OMNIROUTE_URL: "http://127.0.0.1:9", OMNIROUTE_SCRIPT: path.join(data, "no-omniroute.mjs"), ...extra };
  delete env.OMNIGPT_PARENT_PID; if (!extra.OMNIROUTE_API_KEY) delete env.OMNIROUTE_API_KEY; // only a caller that passes a key (the benchmark) gets one
  const server = spawn(process.execPath, [path.join(src, "server.mjs")], { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let serverErr = ""; server.stderr.on("data", (d) => { serverErr = (serverErr + d).slice(-2000); });
  let browser = null, ws = null;
  const close = async () => {
    try { ws && ws.close(); } catch {}
    for (const p of [browser, server]) if (p && p.exitCode === null) { p.kill(); for (let i = 0; i < 30 && p.exitCode === null && p.signalCode === null; i++) await sleep(100); }
    for (let i = 0; i < 10; i++) { try { fs.rmSync(data, { recursive: true, force: true }); break; } catch { await sleep(300); } } // the browser can hold its profile for a moment
  };
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(base + "/")).ok; } catch { await sleep(250); } }
    if (!up) throw new Error("the backend did not start: " + serverErr);
    const exe = findBrowser(); if (!exe) throw new Error("no Edge or Chromium found for the page test");
    const profile = path.join(data, "profile");
    const args = ["--headless=new", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--disable-background-networking", "--window-size=1280,900", "about:blank"];
    if (process.platform !== "win32" && process.getuid && process.getuid() === 0) args.unshift("--no-sandbox");
    browser = spawn(exe, args, { stdio: "ignore", windowsHide: true });
    let dport = 0;
    for (let k = 0; k < 100 && !dport; k++) { await sleep(200); try { dport = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0]) || 0; } catch {} }
    if (!dport) throw new Error("the browser did not open its DevTools port");
    const target = (await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json()).find((t) => t.type === "page");
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error("could not connect to the page")); });
    const pending = new Map(); let id = 0; const logs = [];
    ws.onmessage = (e) => { const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.bad(new Error(m.error.message)) : p.ok(m.result); }
      else if (m.method === "Runtime.exceptionThrown") logs.push("page error: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || "").split("\n")[0]); };
    const send = (method, params = {}, ms = 120000) => new Promise((ok, bad) => { const n = ++id; pending.set(n, { ok, bad }); ws.send(JSON.stringify({ id: n, method, params })); setTimeout(() => { if (pending.has(n)) { pending.delete(n); bad(new Error(method + " timed out")); } }, ms); });
    const evaluate = async (expression, ms) => {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, ms);
      if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || "").split("\n").slice(0, 3).join(" "));
      return r.result.value;
    };
    await send("Runtime.enable"); await send("Page.enable");
    await send("Page.navigate", { url: base + "/" });
    let ready = false; // the page has loaded its settings store from the backend
    for (let i = 0; i < 120 && !ready; i++) { await sleep(250); try { ready = await evaluate('typeof KVOK!=="undefined"&&KVOK===true'); } catch {} }
    if (!ready) throw new Error("the page did not finish loading: " + logs.join("; "));
    return { base, data, evaluate, close, logs };
  } catch (e) { await close(); throw e; }
}
