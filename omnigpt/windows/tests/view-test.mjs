// view_images returns real pictures the model can see (videos: 3 frames when ffmpeg exists), and install_tool only
// accepts plain package names. Run: node view-test.mjs (exit 0 = all passed)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = ["app", "OmniGPT"].map((d) => path.resolve(here, "..", "..", d)).find((d) => fs.existsSync(path.join(d, "server.mjs")));
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-viewtest-"));
const tools = await import(pathToFileURL(path.join(src, "tools.mjs")).href);
const W = path.join(os.homedir(), "Documents", "OmniRoute Workspace", ".omnigpt-view-test-" + process.pid);
let failed = 0;
const check = (name, ok, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "  " + extra : "")); };
const cfg = { ...tools.loadConfig(), cwd: W, roots: [path.dirname(W)], granted: [] };
// a 4x4 red PNG and a 1x1 GIF
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC", "base64");
const GIF = Buffer.from("R0lGODlhAQABAIAAAP8AAP///yH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");
const ffmpeg = spawnSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"]).status === 0;
try {
  fs.mkdirSync(W, { recursive: true });
  fs.writeFileSync(path.join(W, "red.png"), PNG); fs.writeFileSync(path.join(W, "anim.gif"), GIF); fs.writeFileSync(path.join(W, "notes.txt"), "hello");
  if (ffmpeg) spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=10", path.join(W, "clip.mp4")]);
  const files = ["red.png", "anim.gif", "notes.txt", "missing.jpg", ...(ffmpeg ? ["clip.mp4"] : [])].map((f) => path.join(W, f));
  const pre = await tools.precheck("view_images", { paths: files }, cfg);
  check("view_images is read-only", pre.class === "read");
  const r = await tools.run("view_images", { paths: files }, cfg);
  const imgs = r.blocks.filter((b) => b.type === "image"), labels = r.blocks.filter((b) => b.type === "text").map((b) => b.text);
  check("returns picture blocks the model can see", imgs.length >= 2 && imgs.every((b) => b.source.type === "base64" && /^image\//.test(b.source.media_type) && b.source.data.length > 20), `${imgs.length} pictures`);
  check("every file is labelled with its path, in order", labels.length === files.length && labels.every((t, n) => t.startsWith(`Image ${n + 1}: ${files[n]}`)));
  check("non-images and missing files are reported, not shown", /not an image/.test(labels[2]) && /not found/.test(labels[3]));
  if (ffmpeg) check("a video gives 3 frames", /3 frames/.test(labels[4]) && imgs.length === 5, labels[4]);
  else check("without ffmpeg a video says how to install it (skipped: no ffmpeg here)", true);
  check("too many files at once is refused", await tools.precheck("view_images", { paths: Array(9).fill(files[0]) }, cfg).then(() => false, () => true));
  check("files outside the allowed folders are refused", await tools.precheck("view_images", { paths: [path.join(os.homedir(), ".ssh", "id_rsa")] }, cfg).then(() => false, () => true));
  // install_tool: package names only
  const ok = async (m, p, scope) => tools.precheck("install_tool", { manager: m, package: p }, cfg, scope).then(() => true, () => false);
  check("valid package names are accepted", (await ok("winget", "Gyan.FFmpeg")) && (await ok("pip", "Pillow")) && (await ok("pip", "opencv-python==4.10.0.84")) && (await ok("npm", "@scope/pkg@1.2.3")));
  const bad = [["winget", "Gyan.FFmpeg; Remove-Item C:\\ -Recurse"], ["winget", "--source evil x"], ["pip", "http://evil/x.whl"], ["pip", "../x"], ["npm", "x && calc"], ["choco", "ffmpeg"], ["pip", ""]];
  const res = await Promise.all(bad.map(([m, p]) => ok(m, p)));
  check("anything that is not a plain package name is refused", res.every((x) => !x), bad.filter((_, i) => res[i]).map((b) => b.join(" ")).join(", "));
  check("parallel workers cannot install", !(await ok("winget", "Gyan.FFmpeg", { writes: [] })));
} catch (e) { check("view test", false, String(e.stack || e)); }
fs.rmSync(W, { recursive: true, force: true }); fs.rmSync(process.env.LOCALAPPDATA, { recursive: true, force: true });
console.log(failed ? `${failed} check(s) failed.` : "All view and install checks passed.");
process.exit(failed ? 1 : 0);
