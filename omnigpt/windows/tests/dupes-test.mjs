// find_duplicates: identical content is found whatever the names; same size with different content is not a duplicate.
// Run: node dupes-test.mjs (exit 0 = all passed)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = ["app", "OmniGPT"].map((d) => path.resolve(here, "..", "..", d)).find((d) => fs.existsSync(path.join(d, "server.mjs")));
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-dupetest-"));
const tools = await import(pathToFileURL(path.join(src, "tools.mjs")).href);
const W = path.join(os.homedir(), "Documents", "OmniRoute Workspace", ".omnigpt-dupe-test-" + process.pid);
let failed = 0;
const check = (name, ok, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "  " + extra : "")); };
const cfg = { ...tools.loadConfig(), cwd: W, roots: [path.dirname(W)], granted: [] };
try {
  fs.mkdirSync(path.join(W, "sub"), { recursive: true });
  const big = Buffer.alloc(300000, 7);
  fs.writeFileSync(path.join(W, "photo.jpg"), big); fs.writeFileSync(path.join(W, "sub", "photo (1).jpg"), big); fs.writeFileSync(path.join(W, "copy.bin"), big);
  fs.writeFileSync(path.join(W, "a.txt"), "same size A"); fs.writeFileSync(path.join(W, "b.txt"), "same size B"); // same size, different content
  fs.writeFileSync(path.join(W, "note.txt"), "hello"); fs.writeFileSync(path.join(W, "sub", "note-copy.txt"), "hello");
  const pre = await tools.precheck("find_duplicates", { path: W }, cfg);
  check("read-only (no approval needed)", pre.class === "read", pre.summary);
  const out = await tools.run("find_duplicates", { path: W }, cfg);
  check("finds both groups", /Found 2 groups of identical files: 3 extra copies/.test(out), out.split("\n").slice(0, 2).join(" | "));
  check("the 3 identical photos are one group, largest first", /Group 1: 3 identical files[\s\S]*photo \(1\)\.jpg/.test(out.split("Group 2")[0]));
  check("same size but different content is not a duplicate", !/a\.txt|b\.txt/.test(out));
  const flat = await tools.run("find_duplicates", { path: W, recursive: false }, cfg);
  check("recursive:false stays in the top folder", /Found 1 groups/.test(flat) && !/sub/.test(flat.split("\n\n").slice(1).join("")));
  check("nothing was changed", fs.readdirSync(W).length === 6 && fs.readdirSync(path.join(W, "sub")).length === 2);
} catch (e) { check("duplicates test", false, String(e.stack || e)); }
fs.rmSync(W, { recursive: true, force: true }); fs.rmSync(process.env.LOCALAPPDATA, { recursive: true, force: true });
console.log(failed ? `${failed} check(s) failed.` : "All duplicate checks passed.");
process.exit(failed ? 1 : 0);
