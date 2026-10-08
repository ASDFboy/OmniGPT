# Builds OmniGPT-Setup.exe: runs the checks, builds the program, tests the code sandbox, and packs everything
# into one installer exe. Usage: powershell -ExecutionPolicy Bypass -File build-installer.ps1 [-Out <folder>]
param([string]$Out = "$PSScriptRoot\release", [string]$Node = "", [string]$Python = "")
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$node = if ($Node) { $Node } else { (Get-Command node).Source }

Write-Host "1/4 Checking the source..."
& $node "$here\tests\preflight.mjs"
if ($LASTEXITCODE -ne 0) { throw "Checks failed." }

Write-Host "2/4 Building the program..."
$stage = Join-Path $env:TEMP "OmniGPT-installer-stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
& "$here\build.ps1" -Out $stage -Node $node -Python $Python | Out-Null

Write-Host "3/4 Testing the code sandbox in the build..."
& $node "$here\tests\sandbox-test.mjs" $stage
if ($LASTEXITCODE -ne 0) { throw "The sandbox did not hold." }
Get-ChildItem $stage -Recurse -Force -Filter ".omnigpt-acl-*" | Remove-Item -Force # permission markers belong to this PC only

Write-Host "4/4 Packing the installer..."
New-Item -ItemType Directory -Force $Out | Out-Null
$zip = Join-Path $env:TEMP "omnigpt-payload.zip"
if (Test-Path $zip) { Remove-Item $zip }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$fw = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319"
& $csc /nologo /target:winexe /platform:x64 /optimize+ /out:"$Out\OmniGPT-Setup.exe" /win32icon:"$stage\icon.ico" `
  /resource:"$zip,payload.zip" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll `
  /reference:"$fw\System.IO.Compression.dll" /reference:"$fw\System.IO.Compression.FileSystem.dll" "$here\Setup.cs"
if ($LASTEXITCODE -ne 0) { throw "Installer compilation failed." }
Remove-Item $zip
$exe = Get-Item "$Out\OmniGPT-Setup.exe"
$hash = (Get-FileHash $exe -Algorithm SHA256).Hash
Set-Content "$Out\OmniGPT-Setup.exe.sha256" "$hash  OmniGPT-Setup.exe" -Encoding ascii
Write-Host ("Built {0} ({1:N1} MB)  SHA256 {2}" -f $exe.FullName, ($exe.Length / 1MB), $hash)
