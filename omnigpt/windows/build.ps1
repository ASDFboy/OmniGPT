# Built with Claude (Anthropic) - see CREDITS.md
# Builds the OmniGPT program into .\dist (does NOT touch the installed copy).
# Needs only what Windows already has (the .NET Framework C# compiler), Node.js, and optionally Python 3 for the code sandbox.
# The WebView2 libraries are taken from the NuGet cache, or downloaded once from nuget.org.
param([string]$Out = "$PSScriptRoot\dist", [string]$Node = "", [string]$Python = "", [string]$WebView2Sdk = "")
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$src = Join-Path (Split-Path $here) "app"
if (-not (Test-Path "$src\server.mjs")) { $src = Join-Path (Split-Path $here) "OmniGPT" } # development layout
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not $Node) { $cmd = Get-Command node -ErrorAction SilentlyContinue; $Node = if ($cmd) { $cmd.Source } else { "C:\Program Files\nodejs\node.exe" } }
if (-not $Python) { $Python = (Get-ChildItem "C:\Python3*", "$env:LOCALAPPDATA\Programs\Python\Python3*" -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1).FullName }
function Find-WebView2Sdk {
  if ($WebView2Sdk) { return $WebView2Sdk }
  $ver = "1.0.2903.40"
  $cache = Join-Path $env:LOCALAPPDATA "OmniGPT-build\webview2-$ver"
  foreach ($root in @((Get-ChildItem "$env:USERPROFILE\.nuget\packages\microsoft.web.webview2\*" -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | ForEach-Object { $_.FullName }) + $cache)) {
    if ($root -and (Test-Path "$root\lib\net462\Microsoft.Web.WebView2.Core.dll")) { return $root }
  }
  Write-Host "Downloading the WebView2 SDK $ver from nuget.org (one time)..."
  New-Item -ItemType Directory -Force $cache | Out-Null
  $zip = "$cache.zip"
  Invoke-WebRequest "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/$ver" -OutFile $zip -UseBasicParsing
  Expand-Archive $zip $cache -Force; Remove-Item $zip
  return $cache
}
$pkg = Find-WebView2Sdk
$sdkCore = "$pkg\lib\net462"; $sdkLoader = "$pkg\runtimes\win-x64\native"
if (-not (Test-Path "$sdkCore\Microsoft.Web.WebView2.Core.dll")) { $sdkCore = $pkg; $sdkLoader = $pkg } # a plain folder of DLLs passed with -WebView2Sdk
foreach ($p in @($csc, "$sdkCore\Microsoft.Web.WebView2.Core.dll", "$sdkCore\Microsoft.Web.WebView2.WinForms.dll", "$sdkLoader\WebView2Loader.dll", $Node, "$src\index.html", "$src\app.js", "$src\brain.js", "$src\style.css", "$src\server.mjs", "$src\tools.mjs", "$src\web.mjs", "$src\files.mjs", "$src\zip.mjs", "$src\docs.mjs", "$src\browser.mjs", "$src\jobs.mjs", "$src\console-theme.css")) {
  if (-not (Test-Path $p)) { throw "Missing required file: $p" }
}
New-Item -ItemType Directory -Force $Out, "$Out\app", "$Out\runtime" | Out-Null

# 1. icon (monochrome mark), generated here so there is nothing to download
Add-Type -AssemblyName System.Drawing
function New-IconPng([int]$n) {
  $b = New-Object Drawing.Bitmap $n, $n
  $g = [Drawing.Graphics]::FromImage($b); $g.SmoothingMode = "AntiAlias"; $g.Clear([Drawing.Color]::Transparent)
  $r = [int]($n * 0.2); $d = $r * 2
  $path = New-Object Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $d, $d, 180, 90); $path.AddArc($n - $d - 1, 0, $d, $d, 270, 90); $path.AddArc($n - $d - 1, $n - $d - 1, $d, $d, 0, 90); $path.AddArc(0, $n - $d - 1, $d, $d, 90, 90); $path.CloseFigure()
  $g.FillPath((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(38, 38, 38))), $path)
  $pen = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(236, 236, 234)), ([single]($n * 0.085))
  $m = $n * 0.27; $g.DrawEllipse($pen, [single]$m, [single]$m, [single]($n - 2 * $m), [single]($n - 2 * $m))
  $dot = $n * 0.12; $g.FillEllipse((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(236, 236, 234))), [single]($n * 0.5 - $dot / 2), [single]($n * 0.5 - $dot / 2), [single]$dot, [single]$dot)
  $ms = New-Object IO.MemoryStream; $b.Save($ms, [Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $b.Dispose(); ,$ms.ToArray()
}
$sizes = 16, 32, 48, 256; $pngs = $sizes | ForEach-Object { , (New-IconPng $_) }
$ico = New-Object IO.MemoryStream; $w = New-Object IO.BinaryWriter $ico
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $w.Write([byte]($(if ($s -ge 256) { 0 } else { $s }))); $w.Write([byte]($(if ($s -ge 256) { 0 } else { $s }))); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$pngs[$i].Length); $w.Write([uint32]$offset); $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $w.Write($p) }
[IO.File]::WriteAllBytes("$Out\icon.ico", $ico.ToArray())

# 2. the program
Copy-Item "$sdkCore\Microsoft.Web.WebView2.Core.dll", "$sdkCore\Microsoft.Web.WebView2.WinForms.dll", "$sdkLoader\WebView2Loader.dll" $Out -Force
& $csc /nologo /target:winexe /platform:x64 /optimize+ /out:"$Out\OmniGPT.exe" /win32icon:"$Out\icon.ico" `
  /reference:"$Out\Microsoft.Web.WebView2.Core.dll" /reference:"$Out\Microsoft.Web.WebView2.WinForms.dll" `
  /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "$here\OmniGPT.cs"
if ($LASTEXITCODE -ne 0) { throw "Compilation failed" }

# 3. the web app and the Node runtime it runs on
# every backend module (*.mjs) is shipped, so a new module can never be left out of the installer
Copy-Item (@("$src\index.html", "$src\app.js", "$src\brain.js", "$src\style.css", "$src\console-theme.css") + @(Get-ChildItem "$src\*.mjs" | ForEach-Object { $_.FullName })) "$Out\app" -Force
if (-not (Test-Path "$Out\runtime\node.exe") -or (Get-Item "$Out\runtime\node.exe").Length -ne (Get-Item $Node).Length) {
  Copy-Item $Node "$Out\runtime\node.exe" -Force
}
# 4. the code sandbox: an AppContainer helper plus a trimmed Python (standard library only, no tests/IDLE/tkinter/pip)
& $csc /nologo /target:exe /platform:x64 /optimize+ /out:"$Out\OmniGPT.Sandbox.exe" "$here\Sandbox.cs"
if ($LASTEXITCODE -ne 0) { throw "Sandbox helper compilation failed" }
$py = $Python
if ($py -and (Test-Path "$py\python.exe")) {
  $pyName = (Get-ChildItem "$py\python3??.dll" | Select-Object -First 1).Name
  New-Item -ItemType Directory -Force "$Out\sandbox\python" | Out-Null
  robocopy $py "$Out\sandbox\python" python.exe python3.dll $pyName vcruntime140.dll vcruntime140_1.dll LICENSE.txt /NFL /NDL /NJH /NJS /NP | Out-Null
  robocopy "$py\DLLs" "$Out\sandbox\python\DLLs" /MIR /XF tcl*.dll tk*.dll _tkinter.pyd /NFL /NDL /NJH /NJS /NP | Out-Null
  robocopy "$py\Lib" "$Out\sandbox\python\Lib" /MIR /XD test tests idlelib tkinter turtledemo ensurepip site-packages __pycache__ lib2to3 /NFL /NDL /NJH /NJS /NP | Out-Null
  New-Item -ItemType Directory -Force "$Out\sandbox\python\Lib\site-packages" | Out-Null
} else { Write-Warning "Python 3 was not found; the Python sandbox will be unavailable. Pass -Python <folder> to use one." }
"Built $Out"
