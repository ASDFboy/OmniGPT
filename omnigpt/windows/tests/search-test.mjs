// web_search uses the search providers set up in OmniRoute first, and the private-address rules hold for IPv6-written IPv4.
// Run: node search-test.mjs   (a stand-in OmniRoute on a local port; no real search is made)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-searchtest-"));
const here = path.dirname(fileURLToPath(import.meta.url));
const src = ["app", "OmniGPT"].map((d) => path.resolve(here, "..", "..", d)).find((d) => fs.existsSync(path.join(d, "server.mjs")));
const T = await import(pathToFileURL(path.join(src, "tools.mjs")).href);
let failed = 0; const check = (n, ok, x = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + n + (x ? "  " + x : "")); };

let seen = null;
const srv = http.createServer((q, r) => { let b = ""; q.on("data", (c) => (b += c)); q.on("end", () => {
  seen = { url: q.url, auth: q.headers.authorization, body: b };
  r.setHeader("content-type", "application/json");
  r.end(JSON.stringify({ provider: "stand-in", results: [{ title: "Node.js 24 LTS", url: "https://nodejs.org/en/blog/release", snippet: "Long-term support" }, { title: "bad", url: "javascript:alert(1)", snippet: "" }] }));
}); }).listen(0, "127.0.0.1");
await new Promise((r) => srv.on("listening", r));
T.setOmniRoute("http://127.0.0.1:" + srv.address().port, () => "test-key");
const cfg = T.loadConfig();
const out = await T.run("web_search", { query: "node lts" }, cfg);
check("web_search asks OmniRoute's /v1/search with the key", seen && seen.url === "/v1/search" && seen.auth === "Bearer test-key" && JSON.parse(seen.body).query === "node lts", JSON.stringify(seen).slice(0, 120));
check("its results are listed, unsafe links dropped", /1\. Node\.js 24 LTS\n\s+https:\/\/nodejs\.org/.test(out) && !/javascript:/.test(out), out.slice(0, 120));
srv.close();

const blocked = [];
for (const u of ["http://[::ffff:127.0.0.1]:20128/", "http://[::ffff:7f00:1]/", "http://[0:0:0:0:0:ffff:7f00:1]/", "http://[::ffff:a9fe:a9fe]/", "http://[::ffff:c0a8:101]/", "http://[64:ff9b::7f00:1]/", "http://[fe90::1]/"]) {
  try { await T.checkUrl(u); blocked.push("ALLOWED " + u); } catch {}
}
check("IPv4 written as IPv6 is checked as IPv4", !blocked.length, blocked.join(" "));
let pub = true; try { await T.checkUrl("http://[2606:4700:4700::1111]/"); } catch { pub = false; }
check("a public IPv6 address is still allowed", pub);

const H = os.homedir(), proj = path.join(H, "Documents", "OmniRoute Workspace", ".omnigpt-search-test-" + process.pid);
fs.mkdirSync(proj, { recursive: true });
const fc = { cwd: proj, roots: [proj], folder: proj, granted: [proj] };
const escapes = ["Set-Location ..; Remove-Item * -Recurse -Force", "Remove-Item .. -Recurse -Force", "cmd /c rd /s /q %USERPROFILE%\\Pictures", "Remove-Item ([Environment]::GetFolderPath('Desktop')) -Recurse", "Remove-Item D:old -Recurse"].filter((c) => T.insideFolder("run_command", { command: c }, fc) !== false);
check("commands that reach outside an attached folder are not treated as inside it", !escapes.length, escapes.join(" | "));
check("ordinary commands inside it still are", T.insideFolder("run_command", { command: "Get-ChildItem -Recurse src; python .\\build.py --out dist" }, fc) === "command");
const secrets = ["reg query HKCU\\Environment /v OMNIROUTE_API_KEY", 'Copy-Item "$HOME\\.omniroute\\storage.sqlite" .\\x.db'].filter((c) => { try { T.checkCommand(c, true); return true; } catch { return false; } });
check("the OmniRoute key and data folder stay blocked, even in bypass mode", !secrets.length, secrets.join(" | "));
fs.rmSync(proj, { recursive: true, force: true }); fs.rmSync(process.env.LOCALAPPDATA, { recursive: true, force: true });
console.log(failed ? `${failed} check(s) failed.` : "All search and address checks passed.");
process.exit(failed ? 1 : 0);
