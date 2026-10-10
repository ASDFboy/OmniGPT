// Built with Claude (Anthropic) - see CREDITS.md
// The browser tool against a small local test site: open, follow links, fill a form, refuse password fields,
// screenshot, scroll, back, tabs, and refuse addresses it may not visit. Run: node browser-test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = ["app", "OmniGPT"].map((d) => path.resolve(here, "..", "..", d)).find((d) => fs.existsSync(path.join(d, "server.mjs")));
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-browsertest-"));
process.env.OMNIGPT_TEST_ALLOW_LOCAL = "1"; process.env.OMNIGPT_BROWSER_HEADLESS = "1";
for (const b of ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"]) if (!process.env.OMNIGPT_BROWSER && process.platform !== "win32" && fs.existsSync(b)) process.env.OMNIGPT_BROWSER = b;
const tools = await import(pathToFileURL(path.join(src, "tools.mjs")).href);
let failed = 0;
const check = (name, ok, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "  " + extra : "")); };
const W = path.join(os.homedir(), "Documents", "OmniRoute Workspace");
const cfg = { ...tools.loadConfig(), cwd: W, roots: [W], granted: [] };
const page = (t, b) => `<!doctype html><html><head><title>${t}</title></head><body style="font-family:sans-serif">${b}</body></html>`;
const site = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"); res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (u.pathname === "/") return res.end(page("Test shop", `<h1>Welcome to the test shop</h1><p>Opening hours 9 to 5.</p><a href="/form">Go to the order form</a> <button onclick="document.getElementById('msg').textContent='Button worked'">Show message</button><p id="msg"></p><div style="height:3000px"></div><p>Bottom of the page</p>`));
  if (u.pathname === "/form") return res.end(page("Order form", `<form action="/done"><label>Name <input name="name" placeholder="Your name"></label><label>Password <input type="password" name="pw"></label><select name="country"><option value="us">United States</option><option value="ca">Canada</option></select><button type="submit">Place order</button></form>`));
  if (u.pathname === "/done") return res.end(page("Done", `<p>Thanks ${String(u.searchParams.get("name")).replace(/</g, "")} from ${u.searchParams.get("country")}</p>`));
  res.end(page("404", "not found"));
});
await new Promise((ok) => site.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${site.address().port}`, B = (i) => tools.run("browser", i, cfg);
try {
  let r = await B({ action: "open", url: base + "/" });
  check("open shows the page, its text and numbered elements", /Page: Test shop/.test(r) && /Opening hours 9 to 5/.test(r) && /\[\d+\] a "Go to the order form"/.test(r), r.split("\n")[0]);
  const btn = /\[(\d+)\] button "Show message"/.exec(r)[1];
  r = await B({ action: "click", ref: Number(btn) });
  check("click by ref runs the page's button", /Button worked/.test(r));
  r = await B({ action: "click", text: "Go to the order form" });
  check("click by text follows a link", /Page: Order form/.test(r), r.split("\n")[1]);
  const name = /\[(\d+)\] input "Your name"/.exec(r)[1], pw = /\[(\d+)\] input\[password\]/.exec(r)[1], sel = /\[(\d+)\] select/.exec(r)[1];
  r = await B({ action: "type", ref: Number(name), value: "Ada" });
  check("type fills a text field", /value="Ada"/.test(r));
  let err = await B({ action: "type", ref: Number(pw), value: "hunter2" }).then(() => "", (e) => e.message);
  check("never types into a password field", /never types those/.test(err), err.slice(0, 60));
  r = await tools.run("browser", { action: "select", ref: Number(sel), value: "Canada" }, cfg);
  check("select chooses an option", /Selected "Canada"/.test(r));
  r = await B({ action: "click", text: "Place order" });
  check("submitting the form works", /Thanks Ada from ca/.test(r), r.split("\n").slice(0, 2).join(" | "));
  const shot = await B({ action: "screenshot" });
  check("screenshot returns a picture", shot.blocks?.[0]?.type === "image" && shot.blocks[0].source.data.length > 1000);
  r = await B({ action: "back" });
  check("back returns to the form", /Page: Order form/.test(r));
  await B({ action: "open", url: base + "/" });
  r = await B({ action: "scroll", direction: "down", amount: 3 });
  check("scroll moves down the page", /Scrolled [1-9]\d* of/.test(r), r.split("\n")[2]);
  r = await B({ action: "tabs" });
  check("tabs lists open tabs", /Test shop.*\(current\)/.test(r));
  const refused = async (u) => tools.precheck("browser", { action: "open", url: u }, cfg).then(() => false, () => true);
  check("refuses local files, browser pages and the home network", (await refused("file:///C:/Windows/win.ini")) && (await refused("edge://settings")) && (await refused("http://192.168.1.1/")) && (await refused("javascript:alert(1)")));
  check("reading a page is read-only; clicking needs the normal approval", (await tools.precheck("browser", { action: "read" }, cfg)).class === "read" && (await tools.precheck("browser", { action: "click", ref: 1 }, cfg)).class === "browser");
} catch (e) { check("browser test", false, String(e.stack || e)); }
try { await B({ action: "close" }); } catch {}
site.close();
setTimeout(() => { try { fs.rmSync(process.env.LOCALAPPDATA, { recursive: true, force: true }); } catch {} console.log(failed ? `${failed} check(s) failed.` : "All browser checks passed."); process.exit(failed ? 1 : 0); }, 800);
