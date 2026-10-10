// Built with Claude (Anthropic) - see CREDITS.md
// Draws HTML pages to PNG and prints them to PDF with Edge (or Chrome) in the background, through the DevTools protocol.
// (The browser's --screenshot switch cannot be used: in the current headless mode it cuts off the bottom of the page.)
// One browser is kept open for 3 minutes after the last page (OMNIGPT_RENDER_IDLE_MS) instead of starting one per page;
// every page gets a new tab that is closed afterwards, and pages are drawn one at a time. The browser is driven over a
// pipe, so it also ends when this process ends.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idleMs = () => Math.max(Number(process.env.OMNIGPT_RENDER_IDLE_MS) || 180000, 200);
let B = null, live = new Set(), queue = Promise.resolve(), idleT = null, pages = 0;
const stat = { launches: 0 };
// for tests: whether the browser is open, its process id and folder, and how often one was started
export const renderInfo = () => ({ running: !!(B && !B.dead), pid: B && !B.dead ? B.proc.pid : null, dir: B && !B.dead ? B.dir : null, launches: stat.launches });
const hold = (b, on) => { for (const h of [b.proc, b.proc.stdio[3], b.proc.stdio[4]]) { try { on ? h.ref() : h.unref(); } catch {} } }; // an idle browser never keeps this process from exiting

async function launch(exe) {
  sweep(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-render-"));
  const args = ["--headless=new", "--disable-gpu", "--remote-debugging-pipe", `--user-data-dir=${path.join(dir, "profile")}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--hide-scrollbars",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "about:blank"];
  if (process.platform !== "win32" && process.getuid && process.getuid() === 0) args.unshift("--no-sandbox");
  const proc = spawn(exe, args, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true });
  const b = { exe, dir, proc, dead: false, id: 0, pending: new Map(), waits: new Map() }; stat.launches++; live.add(b);
  let rest = [];
  proc.stdio[4].on("data", (d) => {
    let s = 0;
    for (let k = d.indexOf(0); k !== -1; s = k + 1, k = d.indexOf(0, s)) {
      rest.push(d.subarray(s, k)); let m = {}; try { m = JSON.parse(Buffer.concat(rest).toString("utf8")); } catch {} rest = [];
      if (m.id && b.pending.has(m.id)) { const p = b.pending.get(m.id); b.pending.delete(m.id); clearTimeout(p.t); m.error ? p.bad(new Error(m.error.message)) : p.ok(m.result); }
      else if (m.method && m.sessionId) { const w = b.waits.get(m.sessionId + " " + m.method); if (w) { b.waits.delete(m.sessionId + " " + m.method); w(m.params); } }
    }
    if (s < d.length) rest.push(d.subarray(s));
  });
  proc.stdio[3].on("error", () => {}); proc.stdio[4].on("error", () => {});
  const end = () => { if (b.dead) return; b.dead = true; live.delete(b); if (B === b) B = null; for (const p of b.pending.values()) { clearTimeout(p.t); p.bad(new Error("the browser closed")); } b.pending.clear(); clean(b); };
  proc.on("exit", end); proc.on("error", end);
  // sessionId: a tab's session (flat mode); ms: how long the browser may take to answer
  b.send = (method, params = {}, sessionId, ms = 60000) => new Promise((ok, bad) => {
    if (b.dead) return bad(new Error("the browser closed"));
    const n = ++b.id, t = setTimeout(() => { b.pending.delete(n); bad(new Error(method + " timed out")); close(b, true); }, ms);
    b.pending.set(n, { ok, bad, t }); proc.stdio[3].write(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
  b.wait = (sessionId, method, ms) => new Promise((ok) => { const t = setTimeout(() => { b.waits.delete(sessionId + " " + method); ok(null); }, ms); b.waits.set(sessionId + " " + method, (p) => { clearTimeout(t); ok(p); }); });
  try { await b.send("Browser.getVersion", {}, undefined, 15000); }
  catch (e) { close(b, true); throw new Error(b.dead && proc.exitCode !== null ? "the browser closed while starting" : "the browser did not start"); }
  return b;
}
function clean(b) { for (let k = 0; k < 5; k++) { try { fs.rmSync(b.dir, { recursive: true, force: true }); return; } catch {} } setTimeout(() => { try { fs.rmSync(b.dir, { recursive: true, force: true }); } catch {} }, 2000).unref(); }
function close(b, now) {
  if (!b || b.dead) return; if (B === b) B = null;
  if (!now) { b.send("Browser.close", {}, undefined, 3000).catch(() => {}); const t = setTimeout(() => { try { b.proc.kill(); } catch {} }, 3000); t.unref(); }
  else { try { b.proc.kill(); } catch {} }
}
// stops the browser (the app closing); the next page starts a new one
export function stopRender() { clearTimeout(idleT); close(B, false); }
process.on("exit", () => { for (const b of live) { try { b.proc.kill("SIGKILL"); } catch {} try { fs.rmSync(b.dir, { recursive: true, force: true }); } catch {} } }); // a browser still closing goes too
// folders a browser left behind (the app was closed while one was open, or killed): removed once nothing touched them for a day
function sweep() {
  try { for (const d of fs.readdirSync(os.tmpdir())) { if (!d.startsWith("omnigpt-render-")) continue; const p = path.join(os.tmpdir(), d); try { if (Date.now() - fs.statSync(p).mtimeMs > 86400000 && ![...live].some((b) => b.dir === p)) fs.rm(p, { recursive: true, force: true }, () => {}); } catch {} } } catch {}
}

// opens the page in a new tab of the shared browser (at size.width x size.height when given) and returns fn(send); one page at a time
function inTab(exe, html, size, fn) {
  const job = queue.then(async () => {
    clearTimeout(idleT);
    try {
      if (B && (B.dead || B.exe !== exe)) close(B, true);
      const b = B || (B = await launch(exe)); hold(b, true);
      const file = path.join(b.dir, `page${++pages}.html`); fs.writeFileSync(file, html);
      const { targetId } = await b.send("Target.createTarget", { url: "about:blank" });
      try {
        const { sessionId } = await b.send("Target.attachToTarget", { targetId, flatten: true });
        const send = (m, p) => b.send(m, p, sessionId);
        await send("Page.enable");
        if (size) await send("Emulation.setDeviceMetricsOverride", { width: Math.round(size.width), height: Math.round(size.height), deviceScaleFactor: size.scale, mobile: false });
        const loaded = b.wait(sessionId, "Page.loadEventFired", 15000);
        const nav = await send("Page.navigate", { url: pathToFileURL(file).href }); if (nav && nav.errorText) throw new Error("the page could not be opened: " + nav.errorText);
        await loaded; // then fonts loaded and two frames drawn (at most a second)
        await send("Runtime.evaluate", { expression: "Promise.race([document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))), new Promise((r) => setTimeout(r, 1000))])", awaitPromise: true }).catch(() => sleep(150));
        return await fn(send);
      } finally { b.send("Target.closeTarget", { targetId }, undefined, 10000).catch(() => {}); try { fs.unlinkSync(file); } catch {} }
    } finally { // the next page (queued) clears this timer
      if (B) { hold(B, false); const b = B; idleT = setTimeout(() => close(b, false), idleMs()); idleT.unref(); }
    }
  });
  queue = job.catch(() => {}); return job;
}
export function htmlToPng(browser, html, width, height, scale = 2) {
  return inTab(browser, html, { width, height, scale }, async (send) => Buffer.from((await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: Math.round(width), height: Math.round(height), scale: 1 }, captureBeyondViewport: false })).data, "base64"));
}
// the same output as the browser's --print-to-pdf with --no-pdf-header-footer: backgrounds printed, the page's own @page size
export function printToPdf(browser, html) {
  return inTab(browser, html, null, async (send) => Buffer.from((await send("Page.printToPDF", { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false })).data, "base64"));
}
