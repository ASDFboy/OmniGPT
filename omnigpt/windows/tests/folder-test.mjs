// Built with Claude (Anthropic) - see CREDITS.md
// Checks the attached-folder rules. preflight.mjs runs this with LOCALAPPDATA pointed at a temporary folder,
// so the user's real configuration is never changed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
if (!/omnigpt-foldertest/i.test(process.env.LOCALAPPDATA || "")) { console.log("Refusing to run: LOCALAPPDATA must point at a temporary test folder."); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = ["app", "OmniGPT"].map((d) => path.resolve(here, "..", "..", d)).find((d) => fs.existsSync(path.join(d, "server.mjs"))); // repository layout or development layout
const T = await import(pathToFileURL(path.join(appDir, "tools.mjs")).href);
const ws = path.join(os.homedir(), "Documents", "OmniRoute Workspace"); fs.mkdirSync(ws, { recursive: true });
const proj = fs.mkdtempSync(path.join(ws, "omnigpt-foldertest-")); // not under Temp: Temp is inside AppData, which can never be attached
fs.mkdirSync(path.join(proj, "src"), { recursive: true }); fs.writeFileSync(path.join(proj, "src", "a.txt"), "x");
let failed = 0; const check = (n, ok) => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + n); };
const throws = (f) => { try { f(); return false; } catch { return true; } };

check("a folder that was never attached is refused", throws(() => T.folderConfig(T.loadConfig(), proj)));
const g = T.grantFolder(proj);
const cfg = T.folderConfig(T.loadConfig(), proj);
check("an attached folder becomes the working folder", cfg.cwd.toLowerCase() === g.toLowerCase());
check("file actions inside it are recognised", T.insideFolder("write_file", { path: "src/new.txt" }, cfg) === true && T.insideFolder("delete_files", { paths: [path.join(proj, "src", "a.txt")] }, cfg) === true);
check("moves inside it are recognised", T.insideFolder("move_files", { moves: [{ source: "src/a.txt", destination: "lib/a.txt" }] }, cfg) === true);
check("anything reaching outside it is not", T.insideFolder("write_file", { path: "..\\escape.txt" }, cfg) === false && T.insideFolder("copy_file", { source: "src/a.txt", destination: "C:\\Users\\Public\\x.txt" }, cfg) === false);
check("commands inside it are flagged for the reviewer", T.insideFolder("run_command", { command: "Get-ChildItem -Recurse src" }, cfg) === "command" && T.insideFolder("run_command", { command: `Copy-Item "${path.join(proj, "src", "a.txt")}" "${path.join(proj, "b.txt")}"` }, cfg) === "command");
check("commands naming anything outside it need normal approval", ["Copy-Item .\\README.md C:\\Users\\Public\\Desktop\\README.md", "Remove-Item ..\\other -Recurse", "Copy-Item a.txt $HOME\\x", "Get-Content $env:USERPROFILE\\x", "cd C:\\Windows; dir", "Copy-Item a.txt \\\\server\\share"].every((c) => T.insideFolder("run_command", { command: c }, cfg) === false));
let wrote = true; try { await T.precheck("write_file", { path: "src/new.txt", content: "y" }, cfg); } catch { wrote = false; }
check("tools accept paths inside it even though it is not an allowed folder", wrote);
check("the folder itself cannot be deleted", await T.precheck("delete_file", { path: proj }, cfg).then(() => false, () => true));
check("credential files inside it stay blocked", await T.precheck("read_file", { path: ".env" }, cfg).then(() => false, () => true));
check("a whole drive cannot be attached", throws(() => T.grantFolder("C:\\")));
check("the whole user folder cannot be attached", throws(() => T.grantFolder(os.homedir())));
check("Windows and app data cannot be attached", throws(() => T.grantFolder(process.env.SystemRoot || "C:\\Windows")) && throws(() => T.grantFolder(path.join(os.homedir(), "AppData", "Local"))));
check("a missing folder cannot be attached", throws(() => T.grantFolder(path.join(proj, "nope"))));
T.ungrantFolder(g);
check("removing it takes access away again", throws(() => T.folderConfig(T.loadConfig(), proj)));
check("saving settings keeps attached folders", (() => { T.grantFolder(proj); T.saveConfig({ approval: "ask", cwd: T.loadConfig().cwd, roots: T.loadConfig().roots }); return (T.loadConfig().granted || []).some((x) => x.toLowerCase() === proj.toLowerCase()); })());
T.ungrantFolder(proj);
fs.rmSync(proj, { recursive: true, force: true });
console.log(failed ? `${failed} folder check(s) FAILED` : "All folder checks passed.");
process.exit(failed ? 1 : 0);
