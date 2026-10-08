// The browser tool: a separate Microsoft Edge (or Chrome) window with its own profile, driven over the DevTools
// protocol. It never uses the user's normal browser profile, cookies or saved passwords, and never types into password
// fields (the user types those in the visible window). Only public http(s) pages can be opened.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

let proc = null, port = 0, ws = null, msgId = 0, pageId = null, lastUrl = "";
const pending = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(exe, profile, headless) {
  fs.mkdirSync(profile, { recursive: true });
  try { fs.unlinkSync(path.join(profile, "DevToolsActivePort")); } catch {}
  const args = ["--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-features=Translate,msEdgeFirstRunExperience", "--window-size=1280,900", ...(headless ? ["--headless=new"] : []), "about:blank"];
  if (process.platform !== "win32" && process.getuid && process.getuid() === 0) args.unshift("--no-sandbox");
  proc = spawn(exe, args, { stdio: "ignore", windowsHide: false });
  proc.on("exit", () => { proc = null; ws = null; port = 0; pageId = null; });
  for (let k = 0; k < 100 && !port; k++) {
    await sleep(200);
    try { port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0]) || 0; } catch {}
    if (!proc) throw new Error("the browser closed while starting");
  }
  if (!port) throw new Error("the browser did not start its remote-control port");
}
const http = async (p, method = "GET") => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error(`browser: HTTP ${r.status}`); return r.json(); };
const pages = async () => (await http("/json/list")).filter((t) => t.type === "page");
async function connect(target) {
  if (ws) { try { ws.close(); } catch {} ws = null; }
  ws = new WebSocket(target.webSocketDebuggerUrl); pageId = target.id;
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error("could not connect to the browser tab")); });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.bad(new Error(m.error.message)) : p.ok(m.result); } };
  ws.onclose = () => { ws = null; for (const p of pending.values()) p.bad(new Error("the browser tab closed")); pending.clear(); };
  await send("Page.enable"); await send("Runtime.enable");
}
function send(method, params = {}, ms = 30000) {
  if (!ws) return Promise.reject(new Error("the browser is not open"));
  return new Promise((ok, bad) => { const id = ++msgId; pending.set(id, { ok, bad }); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); bad(new Error(method + " timed out")); } }, ms); });
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("page script error: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || "").split("\n")[0]);
  return r.result.value;
}
async function settle(ms = 15000) { // wait for the page to finish loading after an action
  const end = Date.now() + ms; await sleep(300);
  while (Date.now() < end) { try { if ((await evaluate("document.readyState")) === "complete") break; } catch {} await sleep(250); }
  await sleep(250);
}
async function ensure(opts) {
  if (proc && ws) return;
  if (!proc) await launch(opts.exe, opts.profile, opts.headless);
  let L = await pages(); if (!L.length) { await http("/json/new?about:blank", "PUT"); L = await pages(); }
  await connect(L[0]);
  if (opts.downloads) { fs.mkdirSync(opts.downloads, { recursive: true }); try { await send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: opts.downloads }); } catch {} }
}

// numbered interactive elements plus the page text
const SNAP = `(() => {
  document.querySelectorAll("[data-og-ref]").forEach((e) => e.removeAttribute("data-og-ref"));
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[contenteditable=""],[contenteditable=true],[onclick]';
  const out = []; let n = 0;
  for (const e of document.querySelectorAll(sel)) {
    const r = e.getBoundingClientRect(), st = getComputedStyle(e);
    if (r.width < 2 || r.height < 2 || st.visibility === "hidden" || st.display === "none" || st.opacity === "0") continue;
    if (n >= 200) break; e.setAttribute("data-og-ref", ++n);
    const tag = e.tagName.toLowerCase(), type = (e.getAttribute("type") || "").toLowerCase();
    const name = (e.getAttribute("aria-label") || e.innerText || (type === "password" ? "" : e.value) || e.getAttribute("placeholder") || e.getAttribute("title") || e.getAttribute("alt") || e.getAttribute("name") || "").trim().replace(/\\s+/g, " ").slice(0, 80);
    const extra = tag === "a" ? " -> " + (e.getAttribute("href") || "").slice(0, 90) : tag === "select" ? " options: " + [...e.options].slice(0, 12).map((o) => o.text.trim()).join(" | ") : (tag === "input" || tag === "textarea") && type !== "password" && e.value ? ' value="' + String(e.value).slice(0, 50) + '"' : "";
    const off = r.bottom < 0 || r.top > innerHeight ? " (off-screen)" : "";
    out.push("[" + n + "] " + tag + (type ? "[" + type + "]" : "") + (e.getAttribute("role") ? "[" + e.getAttribute("role") + "]" : "") + ' "' + name + '"' + extra + (e.disabled ? " (disabled)" : "") + (e.checked ? " (checked)" : "") + off);
  }
  return { title: document.title, url: location.href, text: (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n"), elements: out, y: Math.round(scrollY), h: document.documentElement.scrollHeight, vh: innerHeight };
})()`;
async function snapshot(textMax = 6000, offset = 0) {
  const s = await evaluate(SNAP); lastUrl = s.url;
  const pos = s.h > s.vh ? `Scrolled ${s.y} of ${s.h - s.vh} px.` : "The whole page fits on screen.";
  const text = s.text.slice(offset, offset + textMax);
  return `Page: ${s.title}\nURL: ${s.url}\n${pos}\n\nInteractive elements (use the [number] as ref):\n${s.elements.join("\n") || "(none)"}\n\nPage text${offset ? ` from character ${offset}` : ""}:\n${text}${s.text.length > offset + textMax ? `\n…[${s.text.length - offset - textMax} more characters: use read with offset ${offset + textMax}]` : ""}`;
}
// finds an element by ref, CSS selector or visible text; scrolls it into view; returns its centre and kind
const FIND = (q) => `(() => {
  const q = ${JSON.stringify(q)}; let e = null;
  if (q.ref) e = document.querySelector('[data-og-ref="' + Number(q.ref) + '"]');
  else if (q.selector) e = document.querySelector(q.selector);
  else if (q.text) { const t = q.text.toLowerCase(), all = [...document.querySelectorAll('a,button,input,select,textarea,label,summary,[role],[onclick],h1,h2,h3,li,span,div,p,td')].filter((x) => (x.innerText || x.value || x.getAttribute("aria-label") || "").toLowerCase().includes(t)); all.sort((a, b) => (a.innerText || "").length - (b.innerText || "").length); e = all[0] || null; }
  if (!e) return null;
  e.scrollIntoView({ block: "center", inline: "center" });
  const r = e.getBoundingClientRect(), tag = e.tagName.toLowerCase();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag, type: (e.getAttribute("type") || "").toLowerCase(), autocomplete: (e.getAttribute("autocomplete") || "").toLowerCase(), editable: e.isContentEditable };
})()`;
const KEYS = { enter: [13, "Enter", "\r"], tab: [9, "Tab"], escape: [27, "Escape"], esc: [27, "Escape"], backspace: [8, "Backspace"], delete: [46, "Delete"], space: [32, " ", " "], arrowup: [38, "ArrowUp"], arrowdown: [40, "ArrowDown"], arrowleft: [37, "ArrowLeft"], arrowright: [39, "ArrowRight"], up: [38, "ArrowUp"], down: [40, "ArrowDown"], left: [37, "ArrowLeft"], right: [39, "ArrowRight"], pageup: [33, "PageUp"], pagedown: [34, "PageDown"], home: [36, "Home"], end: [35, "End"] };
async function pressKey(combo) {
  const parts = String(combo).toLowerCase().split("+").map((s) => s.trim()), key = parts.pop(), mods = (parts.includes("alt") ? 1 : 0) | (parts.includes("ctrl") || parts.includes("control") ? 2 : 0) | (parts.includes("meta") ? 4 : 0) | (parts.includes("shift") ? 8 : 0);
  let k = KEYS[key];
  if (!k && key.length === 1) k = [key.toUpperCase().charCodeAt(0), key, mods & 2 ? undefined : key];
  if (!k) throw new Error("unknown key " + combo + " (use Enter, Tab, Escape, arrows, PageDown, a single character, with ctrl/shift/alt)");
  const [code, name, text] = k;
  await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", windowsVirtualKeyCode: code, key: name, modifiers: mods, ...(text ? { text } : {}) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: code, key: name, modifiers: mods });
}
async function mouseClick(x, y, double) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (let c = 1; c <= (double ? 2 : 1); c++) {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: c });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: c });
  }
}
const target = (i) => (i.ref ? { ref: i.ref } : i.selector ? { selector: String(i.selector) } : i.text ? { text: String(i.text) } : null);

// opts: { exe, profile, downloads, headless, checkUrl(url) -> throws if not allowed }
export async function browserAction(i, opts) {
  const a = String(i.action || "");
  if (a === "close") { if (proc) { try { proc.kill(); } catch {} } proc = null; ws = null; port = 0; return "Closed the browser."; }
  if (!opts.exe) throw new Error("Microsoft Edge or Google Chrome was not found. Install one (install_tool winget Microsoft.Edge) to use the browser tool.");
  await ensure(opts);
  const guard = async () => { // a click may lead somewhere that is not allowed
    const u = await evaluate("location.href");
    if (u === "about:blank" || /^https?:/i.test(u) && await opts.checkUrl(u).then(() => true, () => false)) return;
    await send("Page.navigate", { url: lastUrl && /^https?:/.test(lastUrl) ? lastUrl : "about:blank" }); await settle();
    throw new Error("that led to an address the browser tool may not visit (" + u.slice(0, 120) + "), so it went back");
  };
  switch (a) {
    case "open": {
      const u = new URL(String(i.url || "")); if (!/^https?:$/.test(u.protocol)) throw new Error("only http(s) addresses can be opened");
      await opts.checkUrl(u.href);
      if (i.new_tab) { const t = await http("/json/new?" + encodeURI(u.href), "PUT"); await connect(t); } else await send("Page.navigate", { url: u.href });
      await settle(); await guard(); return snapshot();
    }
    case "read": return snapshot(Math.min(Number(i.max_chars) || 20000, 60000), Math.max(0, Number(i.offset) || 0));
    case "screenshot": {
      const r = await send("Page.captureScreenshot", { format: "jpeg", quality: 70, ...(i.full_page ? { captureBeyondViewport: true } : {}) });
      const s = await evaluate("({t:document.title,u:location.href})");
      return { text: `Screenshot of ${s.t} (${s.u}).`, blocks: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: r.data } }] };
    }
    case "click": {
      const t = target(i); if (!t) throw new Error("give ref, selector or text");
      const e = await evaluate(FIND(t)); if (!e) throw new Error("element not found; use read to get fresh ref numbers");
      await sleep(150); const e2 = await evaluate(FIND(t)) || e;
      await mouseClick(e2.x, e2.y, !!i.double); await settle(); await guard(); return snapshot();
    }
    case "type": {
      const t = target(i); if (!t) throw new Error("give ref, selector or text");
      const e = await evaluate(FIND(t)); if (!e) throw new Error("element not found; use read to get fresh ref numbers");
      if (e.type === "password" || /password|cc-number|cc-csc/.test(e.autocomplete)) throw new Error("This is a password or card field. The browser tool never types those: ask the user (ask_user) to type it themselves in the browser window, then continue.");
      if (!["input", "textarea"].includes(e.tag) && !e.editable) throw new Error(`that element is a ${e.tag}, not a text field`);
      await mouseClick(e.x, e.y, false);
      if (i.clear !== false) { await pressKey("ctrl+a"); await pressKey("backspace"); }
      await send("Input.insertText", { text: String(i.value ?? i.input ?? "") });
      if (i.submit) { await pressKey("enter"); await settle(); await guard(); }
      return snapshot(3000);
    }
    case "select": {
      const t = target(i); if (!t) throw new Error("give ref or selector");
      const ok = await evaluate(`(() => { const e = ${t.ref ? `document.querySelector('[data-og-ref="${Number(t.ref)}"]')` : `document.querySelector(${JSON.stringify(t.selector || "")})`}; if (!e || e.tagName !== "SELECT") return false; const v = ${JSON.stringify(String(i.value ?? ""))}.toLowerCase(); const o = [...e.options].find((o) => o.value.toLowerCase() === v || o.text.trim().toLowerCase() === v) || [...e.options].find((o) => o.text.toLowerCase().includes(v)); if (!o) return null; e.value = o.value; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); return o.text; })()`);
      if (ok === false) throw new Error("that is not a dropdown list"); if (ok === null) throw new Error("no option matches " + i.value);
      await settle(5000); return `Selected "${ok}".\n\n` + await snapshot(3000);
    }
    case "press": await pressKey(i.key || "enter"); await settle(); await guard(); return snapshot(3000);
    case "scroll": {
      if (i.ref) await evaluate(FIND({ ref: i.ref }));
      else await evaluate(`scrollBy(0, ${i.direction === "up" ? -1 : 1} * innerHeight * 0.85 * ${Math.min(Math.max(Number(i.amount) || 1, 0.1), 20)})`);
      await sleep(400); return snapshot(4000);
    }
    case "back": case "forward": await evaluate(`history.${a}()`); await settle(); await guard(); return snapshot();
    case "wait": await sleep(Math.min(Math.max(Number(i.seconds) || 2, 0.5), 30) * 1000); return snapshot(3000);
    case "tabs": {
      const L = await pages();
      if (i.switch_to !== undefined) { const t = L[Number(i.switch_to)]; if (!t) throw new Error("no tab " + i.switch_to); await connect(t); try { await http("/json/activate/" + t.id); } catch {} return snapshot(); }
      return L.map((t, k) => `${k}: ${t.title || "(untitled)"} - ${t.url}${t.id === pageId ? "  (current)" : ""}`).join("\n") + "\nUse tabs with switch_to to change tab.";
    }
    default: throw new Error("unknown action " + a);
  }
}
export const browserOpen = () => !!proc;
