// Draws an HTML page to a PNG with Edge (or Chrome) in the background, at an exact size, through the DevTools protocol.
// (The browser's --screenshot switch cannot be used: in the current headless mode it cuts off the bottom of the page.)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function htmlToPng(browser, html, width, height, scale = 2) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-render-")), page = path.join(tmp, "page.html"), profile = path.join(tmp, "profile");
  fs.writeFileSync(page, html);
  const args = ["--headless=new", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--hide-scrollbars", "about:blank"];
  if (process.platform !== "win32" && process.getuid && process.getuid() === 0) args.unshift("--no-sandbox");
  const proc = spawn(browser, args, { stdio: "ignore", windowsHide: true });
  let ws = null;
  try {
    let port = 0;
    for (let k = 0; k < 150 && !port; k++) { await sleep(100); if (proc.exitCode !== null) throw new Error("the browser closed while starting"); try { port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0]) || 0; } catch {} }
    if (!port) throw new Error("the browser did not start");
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10000) })).json()).find((t) => t.type === "page");
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error("could not connect to the browser")); });
    const pending = new Map(); let id = 0, loaded = null;
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.bad(new Error(m.error.message)) : p.ok(m.result); } else if (m.method === "Page.loadEventFired" && loaded) loaded(); };
    const send = (method, params = {}) => new Promise((ok, bad) => { const n = ++id; pending.set(n, { ok, bad }); ws.send(JSON.stringify({ id: n, method, params })); setTimeout(() => { if (pending.has(n)) { pending.delete(n); bad(new Error(method + " timed out")); } }, 60000); });
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: Math.round(width), height: Math.round(height), deviceScaleFactor: scale, mobile: false });
    const done = new Promise((r) => { loaded = r; setTimeout(r, 15000); });
    await send("Page.navigate", { url: pathToFileURL(page).href }); await done; await sleep(150); // fonts settle
    const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: Math.round(width), height: Math.round(height), scale: 1 }, captureBeyondViewport: false });
    return Buffer.from(shot.data, "base64");
  } finally {
    try { ws && ws.close(); } catch {}
    try { proc.kill(); } catch {}
    for (let k = 0; k < 20 && proc.exitCode === null && proc.signalCode === null; k++) await sleep(100);
    for (let k = 0; k < 10; k++) { try { fs.rmSync(tmp, { recursive: true, force: true }); break; } catch { await sleep(200); } }
  }
}
