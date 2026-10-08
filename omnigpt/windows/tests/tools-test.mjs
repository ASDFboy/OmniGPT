// Everyday tools: find_files, search_files, system_info, open_path, archive, clipboard, notify.
// Run: node tools-test.mjs (exit 0 = all passed)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = ["app", "OmniGPT"].map((d) => path.resolve(here, "..", "..", d)).find((d) => fs.existsSync(path.join(d, "server.mjs")));
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-toolstest-"));
const tools = await import(pathToFileURL(path.join(src, "tools.mjs")).href);
const { zipBuild } = await import(pathToFileURL(path.join(src, "zip.mjs")).href);
const W = path.join(os.homedir(), "Documents", "OmniRoute Workspace", ".omnigpt-tools-test-" + process.pid);
let failed = 0;
const check = (name, ok, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "  " + extra : "")); };
const cfg = { ...tools.loadConfig(), cwd: W, roots: [path.dirname(W)], granted: [] };
const f = (...p) => path.join(W, ...p);
const refused = (name, input) => tools.precheck(name, input, cfg).then(() => false, () => true);
try {
  fs.mkdirSync(f("docs", "2024"), { recursive: true }); fs.mkdirSync(f("code"), { recursive: true });
  fs.writeFileSync(f("docs", "report.pdf"), Buffer.alloc(5000)); fs.writeFileSync(f("docs", "2024", "report-final.pdf"), Buffer.alloc(200));
  fs.writeFileSync(f("docs", "notes.txt"), "Budget meeting on Friday\nTODO: send invoice\nnothing here");
  fs.writeFileSync(f("code", "app.py"), "def main():\n    # TODO refactor\n    print('hi')\n"); fs.writeFileSync(f("code", "data.bin"), Buffer.from([0, 1, 2, 84, 79, 68, 79]));
  const old = new Date("2020-01-01"); fs.utimesSync(f("docs", "report.pdf"), old, old);

  let r = await tools.run("find_files", { path: W, pattern: "*.pdf" }, cfg);
  check("find_files by name, in subfolders", /Found 2 matches/.test(r) && /docs\/2024\/report-final\.pdf/.test(r), r.split("\n")[0]);
  r = await tools.run("find_files", { path: W, pattern: "**/2024/*" }, cfg);
  check("find_files with a path pattern", /Found 1 matches/.test(r), r.split("\n")[0]);
  r = await tools.run("find_files", { path: W, pattern: "*.pdf", min_size: 1000 }, cfg);
  check("find_files by size", /Found 1 matches/.test(r) && /report\.pdf/.test(r));
  r = await tools.run("find_files", { path: W, pattern: "*", modified_before: "2021-01-01" }, cfg);
  check("find_files by date", /Found 1 matches/.test(r) && /report\.pdf/.test(r));
  r = await tools.run("find_files", { path: W, pattern: "*", type: "folder" }, cfg);
  check("find_files for folders", /Found 3 folders/.test(r), r.split("\n")[0]);

  r = await tools.run("search_files", { path: W, query: "todo" }, cfg);
  check("search_files finds text in files, case-insensitive, skips binaries", /2 matching lines in 2 files/.test(r) && /notes\.txt:2:/.test(r) && /app\.py:2:/.test(r) && !/data\.bin/.test(r), r.split("\n")[0]);
  r = await tools.run("search_files", { path: W, query: "TODO", case_sensitive: true, glob: "*.py" }, cfg);
  check("search_files with a file filter", /1 matching lines in 1 files/.test(r) && /app\.py/.test(r));
  r = await tools.run("search_files", { path: W, query: "^def \\w+", regex: true }, cfg);
  check("search_files with a regular expression", /app\.py:1: def main/.test(r));
  check("a broken regular expression is refused", await refused("search_files", { path: W, query: "(", regex: true }));

  r = await tools.run("system_info", {}, cfg);
  check("system_info reports memory and installed tools", /Memory: /.test(r) && /(Installed|Not installed): node/.test(r));

  check("open_path refuses programs and scripts", await refused("open_path", { path: f("code", "app.py") }) && await refused("open_path", { path: "C:\\Windows\\System32\\cmd.exe" }));
  check("open_path refuses non-web addresses", await refused("open_path", { url: "file:///C:/x" }) && await refused("open_path", { url: "javascript:alert(1)" }));
  check("open_path allows documents, folders and web pages", !(await refused("open_path", { path: f("docs", "notes.txt") })) && !(await refused("open_path", { url: "https://example.com" })) && !(await refused("open_path", { path: f("code", "app.py"), reveal: true })));

  const meta = { turn: "t-tools-" + process.pid };
  r = await tools.run("archive", { action: "zip", source: [f("docs"), f("code", "app.py")], destination: f("pack.zip") }, cfg, null, meta);
  check("archive zips folders and files", /Packed 4 files/.test(r) && fs.existsSync(f("pack.zip")), r);
  r = await tools.run("archive", { action: "list", source: f("pack.zip") }, cfg);
  check("archive lists contents", /docs\/2024\/report-final\.pdf/.test(r) && /app\.py/.test(r));
  r = await tools.run("archive", { action: "unzip", source: f("pack.zip") }, cfg, null, meta);
  check("archive unzips into a new folder", /Extracted 4 files/.test(r) && fs.readFileSync(f("pack", "docs", "notes.txt"), "utf8").startsWith("Budget"), r);
  fs.writeFileSync(f("evil.zip"), zipBuild([{ name: "../escaped.txt", data: "x" }, { name: "ok/fine.txt", data: "y" }, { name: "C:/abs.txt", data: "z" }]));
  r = await tools.run("archive", { action: "unzip", source: f("evil.zip"), destination: f("evil") }, cfg, null, meta);
  check("unzip never writes outside the destination", !fs.existsSync(path.join(path.dirname(W), "escaped.txt")) && fs.existsSync(f("evil", "ok", "fine.txt")) && /Skipped 2/.test(r), r.replace(/\n/g, " | "));
  const u = await tools.undoTurn(meta.turn, cfg);
  check("undo removes what the archive tool made", u.ok && !fs.existsSync(f("pack.zip")) || process.platform !== "win32", process.platform === "win32" ? u.report : "(Recycle Bin part runs on Windows)");

  const pre = await tools.precheck("clipboard", { action: "read" }, cfg);
  check("reading the clipboard always asks", pre.confirm === true);
  check("notify works", /Notification/.test(await tools.run("notify", { title: "Done", message: "Sorted 40 files" }, cfg)));
} catch (e) { check("tools test", false, String(e.stack || e)); }
fs.rmSync(W, { recursive: true, force: true }); fs.rmSync(process.env.LOCALAPPDATA, { recursive: true, force: true });
console.log(failed ? `${failed} check(s) failed.` : "All tool checks passed.");
process.exit(failed ? 1 : 0);
