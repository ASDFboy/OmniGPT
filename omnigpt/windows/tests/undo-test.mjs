// Built with Claude (Anthropic) - see CREDITS.md
// Undo: changes an agent makes through the real tools are recorded per answer and reversed by undoTurn().
// Works in a throwaway folder inside the workspace and a throwaway settings folder. On Windows it also checks that
// deleted files come back from the Recycle Bin and new files go there. Run: node undo-test.mjs (exit 0 = all passed)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = ["app", "OmniGPT"].map((d) => path.resolve(here, "..", "..", d)).find((d) => fs.existsSync(path.join(d, "server.mjs")));
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-undotest-")); // journal and activity log go here
const tools = await import(pathToFileURL(path.join(src, "tools.mjs")).href);
const W = path.join(os.homedir(), "Documents", "OmniRoute Workspace", ".omnigpt-undo-test-" + process.pid);
const win = process.platform === "win32";
let failed = 0;
const check = (name, ok, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "  " + extra : "")); };
const cfg = { ...tools.loadConfig(), approval: "bypass", cwd: W, roots: [path.dirname(W)], granted: [] };
const f = (n) => path.join(W, n), read = (n) => fs.readFileSync(f(n), "utf8"), exists = (n) => fs.existsSync(f(n));
const meta = { turn: "t-undo-" + process.pid, chat: "c1" };

try {
  fs.mkdirSync(W, { recursive: true });
  fs.writeFileSync(f("keep.txt"), "original"); fs.writeFileSync(f("move-me.txt"), "m"); fs.writeFileSync(f("delete-me.txt"), "d");
  await tools.run("write_file", { path: f("keep.txt"), content: "changed" }, cfg, null, meta);
  await tools.run("edit_file", { path: f("keep.txt"), old_string: "changed", new_string: "changed twice" }, cfg, null, meta);
  await tools.run("make_dir", { path: f("newdir") }, cfg, null, meta);
  await tools.run("move_files", { moves: [{ source: f("move-me.txt"), destination: f("newdir/moved.txt") }] }, cfg, null, meta);
  if (win) {
    await tools.run("write_file", { path: f("brand-new.txt"), content: "new" }, cfg, null, meta);
    await tools.run("delete_file", { path: f("delete-me.txt") }, cfg, null, meta);
  }
  const info = tools.undoInfo(meta.turn);
  check("changes are recorded per answer", info.changes === (win ? 6 : 4), JSON.stringify(info));
  check("activity log lists them", tools.readActivity(50).filter((a) => a.turn === meta.turn).length >= 4);
  check("before undo: file changed, moved, deleted", read("keep.txt") === "changed twice" && !exists("move-me.txt") && (!win || !exists("delete-me.txt")));
  const r = await tools.undoTurn(meta.turn, cfg);
  check("undo ran", r.ok && r.skipped === 0, r.report || r.error);
  check("overwritten file is back to the original", read("keep.txt") === "original");
  check("moved file is back", exists("move-me.txt") && !exists("newdir/moved.txt"));
  check("folder the agent made is gone", !exists("newdir"));
  if (win) {
    check("deleted file is restored from the Recycle Bin", exists("delete-me.txt") && read("delete-me.txt") === "d");
    check("new file went to the Recycle Bin", !exists("brand-new.txt"));
  }
  check("undo cannot run twice", (await tools.undoTurn(meta.turn, cfg)).ok === false);
} catch (e) { check("undo test", false, String(e.stack || e)); }
fs.rmSync(W, { recursive: true, force: true }); fs.rmSync(process.env.LOCALAPPDATA, { recursive: true, force: true });
console.log(failed ? `${failed} check(s) failed.` : "All undo checks passed.");
process.exit(failed ? 1 : 0);
