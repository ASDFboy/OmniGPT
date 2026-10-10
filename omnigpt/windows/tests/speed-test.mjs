// Built with Claude (Anthropic) - see CREDITS.md
// Speed: the shared PowerShell worker (Windows, or anywhere with OMNIGPT_POWERSHELL pointing to pwsh) and the shared
// browser that draws chart PNGs and prints PDFs (every system with Edge or Chromium). Prints the timings.
// Run: node speed-test.mjs (exit 0 = all passed)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = ["app", "OmniGPT"].map((d) => path.resolve(here, "..", "..", d)).find((d) => fs.existsSync(path.join(d, "server.mjs")));
process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "omnigpt-speedtest-"));
process.env.OMNIGPT_PS_WORKER = "1"; // the worker is opt-in in the app; this test is what proves it before it can become the default
process.env.OMNIGPT_PS_IDLE_MS = "2500"; process.env.OMNIGPT_RENDER_IDLE_MS = "2500";
const win = process.platform === "win32";
const { findBrowser } = await import("./pagekit.mjs");
if (!process.env.OMNIGPT_BROWSER && !win) { const b = findBrowser(); if (b) process.env.OMNIGPT_BROWSER = b; }
const mod = (m) => import(pathToFileURL(path.join(src, m)).href);
const { ps, psq, psInfo, stopPs } = await mod("psworker.mjs"), { htmlToPng, renderInfo, stopRender } = await mod("render.mjs"), tools = await mod("tools.mjs");
const W = path.join(os.homedir(), "Documents", "OmniRoute Workspace", ".omnigpt-speed-test-" + process.pid);
let failed = 0; const timing = [];
const check = (name, ok, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "  " + extra : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timed = async (fn) => { const t0 = performance.now(); const r = await fn(); return [r, Math.round(performance.now() - t0)]; };
const zombie = (pid) => { try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop().startsWith("Z"); } catch { return false; } };
const alive = (pid) => { try { process.kill(pid, 0); return !zombie(pid); } catch (e) { return e.code === "EPERM"; } };
const goneWithin = async (pid, ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (!alive(pid)) return true; return !alive(pid); };
const pngSize = (b) => b.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" ? [b.readUInt32BE(16), b.readUInt32BE(20)].join("x") : "not a PNG";
const cfg = { ...tools.loadConfig(), cwd: W, roots: [path.dirname(W)], granted: [], approval: "ask" };
const f = (...p) => path.join(W, ...p);
fs.mkdirSync(W, { recursive: true });
try {
  // ---- the PowerShell worker
  if (win || process.env.OMNIGPT_POWERSHELL) {
    const cwd = os.tmpdir(), ms = 30000, lf = (s) => String(s || "").replace(/\r\n/g, "\n");
    const q = (s, env = {}, c = cwd, t = ms) => psq(s, env, c, t).then((r) => ({ ...r, out: lf(r.out), err: lf(r.err) })); // line ends as on Windows (CRLF) or here
    let fresh = 0, old = null;
    if (win) { [, fresh] = await timed(async () => { for (let k = 0; k < 10; k++) old = await ps("Write-Output hi", {}, cwd, ms); }); }
    const [first, cold] = await timed(() => psq("Write-Output hi", {}, cwd, ms));
    const [outs, warm] = await timed(async () => { const L = []; for (let k = 0; k < 10; k++) L.push(await psq("Write-Output hi", {}, cwd, ms)); return L; });
    timing.push(`PowerShell, 10 trivial calls: ${win ? `${fresh} ms with a new process each (ps), ` : ""}${warm} ms through the worker (psq); its first call, which starts it, ${cold} ms`);
    const same = old ? first.out === old.out && first.code === old.code : lf(first.out) === "hi\n" && first.code === 0;
    check("the worker answers exactly like ps()", same && outs.every((r) => r.code === first.code && r.out === first.out && !r.timedOut) && !psInfo().broken, JSON.stringify(first).slice(0, 120) + (old ? " ps(): " + JSON.stringify(old).slice(0, 120) : "") + " " + JSON.stringify(psInfo()).slice(0, 400));
    check("one worker serves all calls", psInfo().starts === 1 && psInfo().running, JSON.stringify(psInfo()));
    if (win) check("10 calls through the worker are faster than 10 new PowerShell processes", warm < fresh, `${warm} ms vs ${fresh} ms`);
    const pid = psInfo().pid;

    // environment and state never carry over to the next call
    let r = await q("$env:ORC_A; $x=5; function Leak { 1 }; $env:ORC_B='set'; Set-Location ..; $ErrorActionPreference='Stop'", { ORC_A: "one" });
    check("a call sees its own environment variables", r.out === "one\n", r.out);
    r = await q("if($env:ORC_A -or $env:ORC_B){'leak env'}; if($x){'leak var'}; if(Get-Command Leak -ErrorAction SilentlyContinue){'leak function'}; Get-Item ./does-not-exist-xyz -ErrorAction SilentlyContinue; [string]$ErrorActionPreference; (Get-Location).Path", {}, W);
    check("variables, functions, environment, preferences and folder of a call do not reach the next", r.out === `Continue\n${W}\n`, JSON.stringify(r.out));
    const len1 = (await q("$env:Path.Length")).out, len2 = (await q("$env:Path.Length")).out;
    check("the PATH refresh does not pile up from call to call", len1 && len1 === len2, `${len1.trim()} then ${len2.trim()}`);
    // exit codes as with ps(): the program's own code, 1 for a failed command or an error, exit N
    r = await q('& $env:ORC_NODE -e "process.exitCode=7"', { ORC_NODE: process.execPath });
    check("a program's exit code is passed through", r.code === 7, JSON.stringify(r));
    r = await q("Get-Item ./does-not-exist-xyz");
    check("a failed last command gives exit code 1 and its error", r.code === 1 && /does-not-exist-xyz/.test(r.out) && /does-not-exist-xyz/.test(r.err), JSON.stringify(r).slice(0, 200));
    r = await q("Get-Item ./does-not-exist-xyz; [IO.File]::ReadAllText('does-not-exist.txt'); 'after'");
    check("errors that only end one statement let the script go on", r.code === 0 && /after\n$/.test(r.out), JSON.stringify(r).slice(0, 200));
    r = await q("'before'; throw 'boom'; 'after'");
    check("a thrown error ends the script with code 1", r.code === 1 && /^before\r?\n/.test(r.out) && /boom/.test(r.err) && !/^after\r?$/m.test(r.out) /* PowerShell's error text quotes the source line, so "after" only counts as its own output line */, JSON.stringify(r).slice(0, 200));
    r = await q("'x'; exit 5; 'never'");
    check("exit 5 ends the call with code 5", r.code === 5 && r.out === "x\n", JSON.stringify(r));
    r = await q("function Stop-Here { exit 9 }; Stop-Here; 'never'");
    check("exit inside a function ends the call too", r.code === 9 && !r.out, JSON.stringify(r));
    r = await q("'still here'");
    check("exit and errors do not end the worker", r.out === "still here\n" && psInfo().pid === pid && psInfo().starts === 1, JSON.stringify(psInfo()));
    // output: unicode both ways, [Console]::Out, Write-Host, warnings, tables in one piece
    const uni = "héllo — 世界 ✓ ünï";
    r = await q("Write-Output $env:ORC_T; [Console]::Out.WriteLine('ü ✓ 日本'); [Console]::WriteLine('direct'); Write-Host 'host'; Write-Warning 'careful'; [pscustomobject]@{Name='first'}, [pscustomobject]@{Name='second'}", { ORC_T: uni });
    const want = [uni, "ü ✓ 日本", "direct", "host", "WARNING: careful"];
    check("output keeps unicode and includes [Console]::Out, Write-Host and warnings", want.every((s) => r.out.includes(s + "\n")) && r.out.split("Name").length === 2, JSON.stringify(r.out).slice(0, 300));
    // calls at the same time wait for each other, each with its own variables
    const [all, both] = await timed(() => Promise.all([1, 2, 3, 4, 5].map((n) => q("Start-Sleep -Milliseconds 200; 'n=' + $env:ORC_N", { ORC_N: String(n) }))));
    check("calls made at the same time queue and keep their own values", all.map((x) => x.out.trim()).join(",") === "n=1,n=2,n=3,n=4,n=5" && both >= 900, `${all.map((x) => x.out.trim()).join(",")} in ${both} ms`);
    // a call that runs too long stops the worker and what it started; the next call gets a new one
    const opt = win ? "; WindowStyle='Hidden'" : "";
    const [slow, took] = await timed(() => q(`$a=@{FilePath=$env:ORC_NODE; ArgumentList=@('-e','setTimeout(function(){},60000)'); PassThru=$true${opt}}; $p=Start-Process @a; 'PID|' + $p.Id; Start-Sleep 60`, { ORC_NODE: process.execPath }, cwd, 2500));
    const child = Number((/PID\|(\d+)/.exec(slow.out) || [])[1]);
    check("a call over its time limit is stopped with its output so far", slow.timedOut && child > 0 && took < 8000, JSON.stringify(slow).slice(0, 200) + ` ${took} ms`);
    check("stopping it also ends the program it started", child > 0 && (await goneWithin(child, 5000)), "process " + child);
    check("the old worker is gone", await goneWithin(pid, 5000));
    r = await q("'new worker'");
    check("the next call starts a fresh worker", r.out === "new worker\n" && psInfo().starts === 2 && psInfo().pid !== pid, JSON.stringify(psInfo()));
    // idle: the worker closes itself; the next call starts it again
    const p2 = psInfo().pid; await sleep(4000);
    check("the worker closes after the idle time", !psInfo().running && (await goneWithin(p2, 5000)), JSON.stringify(psInfo()));
    r = await q("'back'");
    check("a call after the idle close starts it again", r.out === "back\n" && psInfo().starts === 3);
    const p3 = psInfo().pid; stopPs();
    check("stopPs (the app closing) ends the worker", !psInfo().running && (await goneWithin(p3, 5000)));
  } else check("PowerShell worker (runs on Windows)", true);

  // a worker that cannot start: the call runs the old way, and so do later calls (any system)
  {
    const probe = path.join(W, "probe.mjs");
    fs.writeFileSync(probe, `const m = await import(${JSON.stringify(pathToFileURL(path.join(src, "psworker.mjs")).href)});
const a = await m.psq("Write-Output fallback", {}, ${JSON.stringify(os.tmpdir())}, 30000), b = await m.ps("Write-Output fallback", {}, ${JSON.stringify(os.tmpdir())}, 30000);
console.log(JSON.stringify({ a, b, info: m.psInfo() })); process.exit(0);`);
    const env = { ...process.env, OMNIGPT_POWERSHELL: process.execPath }; // node rejects PowerShell's switches and exits at once
    const out = spawnSync(process.execPath, [probe], { env, encoding: "utf8", timeout: 60000 }).stdout || "";
    let res = {}; try { res = JSON.parse(out.trim().split("\n").pop()); } catch {}
    check("if the worker cannot start, psq() runs the script as ps() does", res.a && res.b && res.a.code === res.b.code && res.a.out === res.b.out && res.info.broken, out.slice(0, 300));
  }

  // ---- the shared browser
  const exe = process.env.OMNIGPT_BROWSER || findBrowser();
  if (exe) {
    const l0 = renderInfo().launches, times = [], sizes = [];
    for (let k = 0; k < 5; k++) {
      const [, t] = await timed(() => tools.run("make_chart", { path: f(`chart${k}.png`), type: k % 2 ? "line" : "bar", title: "Chart " + k, labels: ["Jan", "Feb", "Mar", "Apr"], series: [{ name: "Sales", values: [3, 5, k + 1, 4] }], width: 800, height: 450 }, cfg));
      times.push(t); sizes.push(pngSize(fs.readFileSync(f(`chart${k}.png`))));
    }
    const pid = renderInfo().pid, warm = Math.round(times.slice(1).reduce((a, b) => a + b, 0) / 4);
    check("5 chart PNGs drawn at twice the size", sizes.every((s) => s === "1600x900"), sizes.join(" "));
    check("one browser draws them all", renderInfo().launches - l0 === 1 && renderInfo().running && pid > 0, JSON.stringify(renderInfo()));
    check("the next charts are faster than the first (which starts the browser)", warm < times[0], times.join(", ") + " ms");
    let mine = -1;
    if (process.platform === "linux") mine = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d)).filter((d) => { try { const st = fs.readFileSync(`/proc/${d}/stat`, "utf8").split(") ").pop().split(" "); return Number(st[1]) === process.pid && st[0] !== "Z" && fs.readFileSync(`/proc/${d}/cmdline`, "utf8").includes("--remote-debugging-pipe"); } catch { return false; } }).length;
    else if (win) mine = Number((await psq("@(Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $env:ORC_PID) | Where-Object { $_.CommandLine -like '*--remote-debugging-pipe*' }).Count", { ORC_PID: String(process.pid) }, os.tmpdir(), 30000)).out.trim());
    if (mine >= 0) check("exactly one browser process was started", mine === 1, mine + " browser processes");
    const [shots, together] = await timed(() => Promise.all([300, 301, 302].map((w) => htmlToPng(exe, `<body style="margin:0;background:#2a78d6">${w}</body>`, w, 120, 1))));
    check("pages drawn at the same time each get their own picture", shots.map(pngSize).join(" ") === "300x120 301x120 302x120" && renderInfo().launches - l0 === 1, shots.map(pngSize).join(" "));
    const content = "# Speed test\n\nFirst page, with a table:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<!-- pagebreak -->\n\n## Second page\n\nThe end.";
    const [, pdfMs] = await timed(() => tools.run("make_document", { path: f("doc.pdf"), title: "Speed", content }, cfg));
    const pdf = fs.readFileSync(f("doc.pdf")), qpdf = spawnSync("qpdf", ["--show-npages", f("doc.pdf")], { encoding: "utf8" });
    const pagesN = qpdf.status === 0 ? Number(qpdf.stdout.trim()) : (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
    check(`make_document PDF printed by the same browser (${qpdf.status === 0 ? "page count by qpdf" : "pages counted in the file"})`, pdf.toString("latin1", 0, 5) === "%PDF-" && pagesN === 2 && renderInfo().launches - l0 === 1, `${pagesN} pages, ${pdf.length} bytes`);
    timing.push(`Charts: first PNG ${times[0]} ms (starts the browser), next four ${times.slice(1).join(", ")} ms (average ${warm}); PDF ${pdfMs} ms; 3 pictures at once ${together} ms`);
    await sleep(4000);
    check("the browser closes after the idle time", !renderInfo().running && (await goneWithin(pid, 5000)), JSON.stringify(renderInfo()));
    const again = await htmlToPng(exe, "<body>again</body>", 200, 100, 1);
    check("a picture after the idle close starts the browser again", pngSize(again) === "200x100" && renderInfo().launches - l0 === 2);
    const p2 = renderInfo().pid; stopRender();
    check("stopRender (the app closing) ends the browser", await goneWithin(p2, 8000));
    // the browser also ends when the backend itself is killed
    const probe = path.join(W, "kill.mjs");
    fs.writeFileSync(probe, `const m = await import(${JSON.stringify(pathToFileURL(path.join(src, "render.mjs")).href)});
await m.htmlToPng(${JSON.stringify(exe)}, "<body>x</body>", 100, 100, 1); console.log("PID " + m.renderInfo().pid + " DIR " + m.renderInfo().dir); process.kill(process.pid, "SIGKILL");`);
    const k = spawnSync(process.execPath, [probe], { encoding: "utf8", timeout: 60000 }), [, bp, bdir] = /PID (\d+) DIR (.+)/.exec(k.stdout || "") || [];
    check("the browser ends when the backend is killed", bp > 0 && (await goneWithin(Number(bp), 10000)), "browser process " + (bp || "?") + " " + String(k.stderr || "").slice(0, 120));
    for (let n = 0; bdir && n < 20 && fs.existsSync(bdir.trim()); n++) { try { fs.rmSync(bdir.trim(), { recursive: true, force: true }); } catch { await sleep(250); } } // what the killed backend could not remove
  } else check("shared browser (skipped: no Edge or Chromium here)", true);
} catch (e) { check("speed test", false, String(e.stack || e)); }
stopPs(); stopRender();
for (const t of timing) console.log("TIMING  " + t);
fs.rmSync(W, { recursive: true, force: true }); try { fs.rmSync(process.env.LOCALAPPDATA, { recursive: true, force: true }); } catch {}
console.log(failed ? `${failed} check(s) failed.` : "All speed checks passed.");
process.exit(failed ? 1 : 0);
