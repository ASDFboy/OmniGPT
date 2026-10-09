// PowerShell for the backend. ps() starts a new powershell.exe for every call: run_command, install_tool and speak use it.
// psq() sends the app's own short scripts (notifications, clipboard, Recycle Bin, pictures, OCR, DPAPI...) to one hidden
// PowerShell that stays open, because starting powershell.exe costs about half a second every time. Calls run one at a
// time, each in a new scope with its own environment variables, which are put back afterwards. The worker closes after
// 5 minutes without calls (OMNIGPT_PS_IDLE_MS); a call that runs too long stops it and everything it started, and the
// next call starts a fresh one.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { PASS_CODE } from "./jobs.mjs";

const win = process.platform === "win32";
const cap = (s, n = 12000) => (s.length > n ? s.slice(0, n / 2) + `\n…[${s.length - n} chars omitted]…\n` + s.slice(-n / 2) : s);
// the environment for programs the agents start: anything that looks like a secret is left out
export const cleanEnv = (env = {}) => Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([k]) => !/key|token|secret|passw|omniroute|api/i.test(k) || k in env));
export function ps(script, env, cwd, timeoutMs) {
  return new Promise((ok) => {
    const clean = cleanEnv(env);
    const refresh = "$env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')+';'+$env:Path\n"; // programs installed during this session are found
    const c = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8\n" + refresh + script + PASS_CODE], { cwd, env: clean, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", timedOut = false;
    c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => { timedOut = true; spawn("taskkill", ["/pid", String(c.pid), "/t", "/f"], { windowsHide: true }); }, timeoutMs);
    c.on("close", (code) => { clearTimeout(t); ok({ code, out: cap(out), timedOut }); });
    c.on("error", (e) => { clearTimeout(t); ok({ code: -1, out: String(e), timedOut: false }); });
  });
}

// The worker reads one call per line (id, folder, script, then name/value pairs, all base64) and answers with lines that
// start with the RS character: "start", output pieces "o" and "e" (error stream), then "end <exit code>", or "fail" when
// the call could not be started (it then runs with ps()). The script runs in a runspace of the worker's own, as a nested
// pipeline in a child scope: variables, functions and preferences of one call never reach the next, errors behave as in
// powershell -Command, and exit N ends only the script (with code N). Output of programs that write straight to the
// console arrives without the RS mark and counts as output of the running call.
const HOST = `$ErrorActionPreference='Stop'
$u8=New-Object Text.UTF8Encoding $false; $nl=[Environment]::NewLine; $mk=[string][char]30+'ORC '
$rd=New-Object IO.StreamReader([Console]::OpenStandardInput(),$u8)
$wr=New-Object IO.StreamWriter([Console]::OpenStandardOutput(),$u8); $wr.AutoFlush=$true; $wr.NewLine=[string][char]10
$o0=[Console]::Out; $e0=[Console]::Error; $here=[Environment]::CurrentDirectory
$cmp=[StringComparer]::OrdinalIgnoreCase; if($IsWindows -eq $false){ $cmp=[StringComparer]::Ordinal }; $base=New-Object 'Collections.Generic.Dictionary[string,string]' $cmp
foreach($e in [Environment]::GetEnvironmentVariables().GetEnumerator()){ $base[[string]$e.Key]=[string]$e.Value }
function D($s){ $u8.GetString([Convert]::FromBase64String($s)) }
function Say($id,$k,$s){ $wr.WriteLine($mk+$id+' '+$k+' '+$s) }
function Put($id,$k,$s){ if($s){ Say $id $k ([Convert]::ToBase64String($u8.GetBytes([string]$s))) } }
function Reset(){
  foreach($k in @([Environment]::GetEnvironmentVariables().Keys)){ if(-not $base.ContainsKey([string]$k)){ try{ [Environment]::SetEnvironmentVariable([string]$k,$null) }catch{} } }
  foreach($k in @($base.Keys)){ if([Environment]::GetEnvironmentVariable($k) -cne $base[$k]){ try{ [Environment]::SetEnvironmentVariable($k,$base[$k]) }catch{} } }
  try{ [Environment]::CurrentDirectory=$here }catch{}
}
function Fmt($x){
  if($x -is [string]){ return [string]$x+$nl }
  if($x -is [Management.Automation.ErrorRecord]){ return ($x | Out-String -Width 4096) }
  if($x -is [Management.Automation.WarningRecord]){ return 'WARNING: '+$x.Message+$nl }
  if($x -is [Management.Automation.VerboseRecord]){ return 'VERBOSE: '+$x.Message+$nl }
  if($x -is [Management.Automation.DebugRecord]){ return 'DEBUG: '+$x.Message+$nl }
  $m=$x.MessageData; if($m -is [Management.Automation.HostInformationMessage]){ if($m.NoNewLine){ return [string]$m.Message }; return [string]$m.Message+$nl }; return [string]$m+$nl
}
function Drain($id){
  $run=New-Object Collections.ArrayList
  foreach($x in $out.ReadAll()){
    if(-not ($x -is [string] -or $x -is [Management.Automation.ErrorRecord] -or $x -is [Management.Automation.InformationalRecord] -or $x -is [Management.Automation.InformationRecord])){ [void]$run.Add($x); continue }
    if($run.Count){ Put $id 'o' ($run | Out-String -Width 4096); $run.Clear() }
    $k='o'; if($x -is [Management.Automation.ErrorRecord]){ $k='e' }; Put $id $k (Fmt $x)
  }
  if($run.Count){ Put $id 'o' ($run | Out-String -Width 4096) }
  [Threading.Monitor]::Enter($sw); try{ $b=$sw0.GetStringBuilder(); $s=$b.ToString($script:got,$b.Length-$script:got); $script:got=$b.Length }finally{ [Threading.Monitor]::Exit($sw) }
  Put $id 'o' $s
}
$wrap='$__orcP=[powershell]::Create([Management.Automation.RunspaceMode]::CurrentRunspace); [void]$__orcP.AddScript($__orcScript,$true); try{ $__orcP.Commands.Commands[0].MergeMyResults(''All'',''Output'') }catch{ $__orcP.Commands.Commands[0].MergeMyResults(''Error'',''Output'') }; $__orcP.Invoke($__orcIn,$__orcOut,$null); $__orcP.Dispose()'
$rs=[runspacefactory]::CreateRunspace([Management.Automation.Runspaces.InitialSessionState]::CreateDefault())
if($IsWindows -ne $false){ $rs.ApartmentState='STA' }; $rs.ThreadOptions='UseNewThread'; $rs.Open(); $v=$rs.SessionStateProxy
$in=New-Object 'Management.Automation.PSDataCollection[psobject]'; $in.Complete(); $out=New-Object 'Management.Automation.PSDataCollection[psobject]'
$v.SetVariable('__orcScript','Write-Error orc-e -ErrorAction Continue; ''OK''; exit 3'); $v.SetVariable('__orcIn',$in); $v.SetVariable('__orcOut',$out)
$p=[powershell]::Create(); $p.Runspace=$rs; [void]$p.AddScript($wrap,$true); [void]$p.Invoke(); $t=@($out.ReadAll())
if($t.Count -ne 2 -or -not ($t[0] -is [Management.Automation.ErrorRecord]) -or [string]$t[1] -ne 'OK' -or $v.GetVariable('LASTEXITCODE') -ne 3 -or $p.Streams.Error.Count){ [Console]::Error.WriteLine('The PowerShell helper failed its self-test.'); exit 1 }
$p.Dispose(); $v.SetVariable('LASTEXITCODE',$null)
while($true){
  $line=$rd.ReadLine(); if($null -eq $line){ break }
  $f=$line.Split([char]9); if($f.Count -lt 3){ continue }; $id=$f[0]; Say $id 'start' 1
  $code=0; $p=$null; $ran=$false; $why=$null
  try{
    for($i=3; $i+1 -lt $f.Count; $i+=2){ [Environment]::SetEnvironmentVariable((D $f[$i]),(D $f[$i+1])) }
    $env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')+';'+$env:Path
    try{ [Console]::OutputEncoding=[Text.Encoding]::UTF8 }catch{}
    $cwd=D $f[1]; if(-not $cwd){ $cwd=$here }
    [Environment]::CurrentDirectory=$cwd; [void]$v.Path.SetLocation([Management.Automation.WildcardPattern]::Escape($cwd))
    foreach($n in 'LASTEXITCODE','__orcOk','__orcEnd'){ $v.SetVariable($n,$null) }; try{ $v.GetVariable('Error').Clear() }catch{}
    $in=New-Object 'Management.Automation.PSDataCollection[psobject]'; $in.Complete(); $out=New-Object 'Management.Automation.PSDataCollection[psobject]'
    $v.SetVariable('__orcScript',(D $f[2])+$nl+'$global:__orcOk=$?; $global:__orcEnd=1'); $v.SetVariable('__orcIn',$in); $v.SetVariable('__orcOut',$out)
    $p=[powershell]::Create(); $p.Runspace=$rs; [void]$p.AddScript($wrap,$true)
    $sw0=New-Object IO.StringWriter; $sw=[IO.TextWriter]::Synchronized($sw0); $script:got=0
    [Console]::SetOut($sw); [Console]::SetError($sw)
    $h=$p.BeginInvoke(); $ran=$true
    do{ $fin=$h.AsyncWaitHandle.WaitOne(25); Drain $id }until($fin)
    try{ [void]$p.EndInvoke($h) }catch{}
    Drain $id
    $st=$p.InvocationStateInfo; $bad=$null
    if([string]$st.State -eq 'Failed'){ $bad=$st.Reason }elseif($p.Streams.Error.Count){ $bad=$p.Streams.Error[$p.Streams.Error.Count-1].Exception }
    if($bad){ $code=1; if($bad -is [Management.Automation.MethodInvocationException] -and $bad.InnerException){ $bad=$bad.InnerException }; if($bad.ErrorRecord){ Put $id 'e' ($bad.ErrorRecord | Out-String -Width 4096) }else{ Put $id 'e' ([string]$bad.Message+$nl) } }
    else{ $lec=$v.GetVariable('LASTEXITCODE'); if($lec){ $code=$lec }elseif($v.GetVariable('__orcEnd') -and -not $v.GetVariable('__orcOk')){ $code=1 } }
  }catch{ if($ran){ $code=1; Put $id 'e' ([string]$_+$nl) }else{ $why=[string]$_ } }
  finally{ [Console]::SetOut($o0); [Console]::SetError($e0); if($p){ try{ $p.Dispose() }catch{} }; foreach($n in '__orcScript','__orcIn','__orcOut'){ try{ $v.SetVariable($n,$null) }catch{} } }
  if($ran){ Say $id 'end' $code }else{ Put $id 'fail' $why; if(-not $why){ Say $id 'fail' '' } }
  Reset
}`;

let W = null, broken = false, worked = false, fails = 0, nextId = 1, queue = Promise.resolve(), idleT = null;
const stat = { starts: 0 };
const idleMs = () => Math.max(Number(process.env.OMNIGPT_PS_IDLE_MS) || 300000, 500);
const b64 = (s) => Buffer.from(String(s), "utf8").toString("base64");
// for tests: whether the worker runs, its process id, how often one was started, and why one could not take a call
export const psInfo = () => ({ running: !!W, pid: W ? W.c.pid : null, starts: stat.starts, broken, why: stat.why || "" });
const hold = (w, on) => { for (const h of [w.c, w.c.stdin, w.c.stdout, w.c.stderr]) { try { on ? h.ref() : h.unref(); } catch {} } }; // an idle worker never keeps the backend from exiting
const kill = (w) => { try { if (win) spawn("taskkill", ["/pid", String(w.c.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }); else process.kill(-w.c.pid, "SIGKILL"); } catch { try { w.c.kill("SIGKILL"); } catch {} } };
function start() {
  // -InputFormat None: otherwise powershell.exe reads all of stdin before it runs anything
  const c = spawn(process.env.OMNIGPT_POWERSHELL || "powershell.exe", ["-NoProfile", "-NonInteractive", "-InputFormat", "None", "-Command", HOST], { env: cleanEnv(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: !win });
  const w = { c, cur: null, rest: "", dead: false }; stat.starts++;
  c.stdout.setEncoding("utf8"); c.stderr.setEncoding("utf8");
  c.stdout.on("data", (d) => read(w, d));
  c.stderr.on("data", (d) => { if (w.cur) { w.cur.out += d; w.cur.err += d; } });
  c.stdin.on("error", () => {});
  c.on("error", (e) => { if (w.cur) w.cur.out += String(e); gone(w, -1); });
  c.on("close", (code) => gone(w, code));
  return w;
}
function read(w, d) {
  const L = (w.rest + d).split("\n"); w.rest = L.pop();
  for (const line of L) {
    const k = line.indexOf("\x1eORC "), cur = w.cur;
    if (k < 0) { if (cur) cur.out += line + "\n"; continue; } // a program writing straight to the console
    if (k > 0 && cur) cur.out += line.slice(0, k);
    const [id, kind, data = ""] = line.slice(k + 5).replace(/\r$/, "").split(" ");
    if (!cur || String(cur.id) !== id) continue;
    if (kind === "start") cur.started = true;
    else if (kind === "o" || kind === "e") { const t = Buffer.from(data, "base64").toString("utf8"); cur.out += t; if (kind === "e") cur.err += t; }
    else if (kind === "end") { worked = true; fails = 0; done(w, { code: Number(data) || 0, out: cap(cur.out), timedOut: false, err: cur.err }); }
    else if (kind === "fail") { done(w, null); cur.fallback(); } // nothing ran: the call gets its own process instead
  }
}
function done(w, r) {
  const cur = w.cur; if (!cur) return;
  clearTimeout(cur.t); clearTimeout(cur.boot); w.cur = null; hold(w, false);
  clearTimeout(idleT); idleT = setTimeout(stopPs, idleMs()); idleT.unref();
  if (r) cur.ok(r);
}
function gone(w, code) {
  if (w.dead) return; w.dead = true; if (W === w) W = null;
  const cur = w.cur; if (!cur) return;
  done(w, null);
  if (!cur.started) { stat.why = cur.out.trim().slice(-400) || "exit code " + code; if (!worked || ++fails >= 2) broken = true; return cur.fallback(); } // the worker could not start or failed its self-test: the call runs the old way (and all later ones if it happens again)
  cur.ok({ code: code ?? -1, out: cap(cur.out), timedOut: cur.timedOut, err: cur.err });
}
function call(script, env, cwd, timeoutMs) {
  return new Promise((ok) => {
    clearTimeout(idleT);
    if (cwd && !fs.existsSync(cwd)) return ok({ code: -1, out: "The folder " + cwd + " does not exist.", timedOut: false, err: "" });
    const w = W && !W.dead ? W : (W = start());
    const cur = { id: nextId++, since: Date.now(), out: "", err: "", started: false, timedOut: false, ok, fallback: () => ps(script, env, cwd, timeoutMs).then((r) => ok({ ...r, err: "" })) };
    w.cur = cur; hold(w, true);
    cur.t = setTimeout(() => { cur.timedOut = true; kill(w); }, timeoutMs);
    cur.boot = setTimeout(() => { if (!cur.started) kill(w); }, 20000); // a worker that does not even take the call is replaced by ps()
    const pairs = Object.entries(env || {}).filter(([, v]) => v !== undefined).flatMap(([k, v]) => [b64(k), b64(v)]);
    w.c.stdin.write([cur.id, b64(cwd || ""), b64(script), ...pairs].join("\t") + "\n");
  });
}
// psq: same arguments and result as ps() ({ code, out, timedOut }, plus err: the error-stream text alone). While the
// worker is busy with a long call (OCR of many pages), a new call gets its own process instead of waiting behind it.
// Programs a psq script starts share the worker's input, so they must not wait for typed input (use ps() for those).
// On Windows the shared worker is opt-in (OMNIGPT_PS_WORKER=1) until it has been proven on real PCs; elsewhere it only runs in tests (OMNIGPT_POWERSHELL)
const workerOn = () => win ? process.env.OMNIGPT_PS_WORKER === "1" : !!process.env.OMNIGPT_POWERSHELL;
export function psq(script, env = {}, cwd, timeoutMs = 60000) {
  if (broken || !workerOn() || (W && W.cur && Date.now() - W.cur.since > 1500)) return ps(script, env, cwd, timeoutMs);
  const job = queue.then(() => call(String(script), env, cwd, timeoutMs));
  queue = job.catch(() => {}); return job;
}
// stops the worker (the app closing, or idle): it ends by itself when its input closes; a running call is stopped
export function stopPs() {
  clearTimeout(idleT); const w = W; if (!w) return; W = null;
  if (w.cur) return kill(w);
  try { w.c.stdin.end(); } catch {}
  const t = setTimeout(() => { if (!w.dead) kill(w); }, 3000); t.unref();
}
process.on("exit", () => { if (W) { try { W.c.kill(); } catch {} } });
