# Built with Claude (Anthropic) - see CREDITS.md
# Installs or updates OmniGPT as a normal program for the current user.
# Order matters: tests first, then close the running app, then build and replace. Nothing is touched if tests fail.
param([string]$Dest = "$env:LOCALAPPDATA\Programs\OmniGPT", [switch]$Launch, [switch]$NoShortcuts)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot

Write-Host "1/5 Checking the source..."
& "C:\Program Files\nodejs\node.exe" "$here\tests\preflight.mjs"
if ($LASTEXITCODE -ne 0) { Write-Host "Not installing: checks failed." -ForegroundColor Red; exit 1 }

Write-Host "2/5 Closing the running app (if any)..."
# any OmniGPT window, including a staging copy: a leftover copy would keep serving the old interface on the same port
foreach ($p in @(Get-Process OmniGPT -ErrorAction SilentlyContinue)) { [void]$p.CloseMainWindow(); if (-not $p.WaitForExit(8000)) { Stop-Process -Id $p.Id -Force } }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -like "$Dest*" -or $_.ExecutablePath -like "*OmniGPT-App\dist\runtime*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep 1

Write-Host "3/5 Building..."
$stage = Join-Path $env:TEMP "OmniGPT-stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
& "$here\build.ps1" -Out $stage | Out-Null
Write-Host "3b. Trying to break out of the code sandbox..."
& "C:\Program Files\nodejs\node.exe" "$here\tests\sandbox-test.mjs" $stage
if ($LASTEXITCODE -ne 0) { Write-Host "Not installing: the sandbox did not hold." -ForegroundColor Red; exit 1 }

Write-Host "4/5 Installing to $Dest ..."
New-Item -ItemType Directory -Force $Dest | Out-Null
# the sandbox's permission markers belong to the folder they were made in, so they must never be copied
robocopy $stage $Dest /MIR /XF ".omnigpt-acl-*" /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copy failed (robocopy code $LASTEXITCODE)" }
Get-ChildItem $Dest -Recurse -Force -Filter ".omnigpt-acl-*" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Write-Host "    Verifying the installed copy (this also grants the sandbox its folder permissions)..."
& "C:\Program Files\nodejs\node.exe" "$here\tests\sandbox-test.mjs" $Dest
if ($LASTEXITCODE -ne 0) { Write-Host "WARNING: the sandbox failed its checks in the installed copy." -ForegroundColor Red }
$un = @'
@echo off
rem Removes the OmniGPT program and its shortcuts. Your chats and settings (in %LOCALAPPDATA%\OmniRouteChat and %LOCALAPPDATA%\OmniGPT) are kept.
taskkill /im OmniGPT.exe /f >nul 2>&1
del "%USERPROFILE%\Desktop\OmniGPT.lnk" >nul 2>&1
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\OmniGPT.lnk" >nul 2>&1
start "" /min cmd /c "ping -n 3 127.0.0.1 >nul & rmdir /s /q ""%~dp0"""
echo OmniGPT removed.
'@
Set-Content "$Dest\Uninstall OmniGPT.cmd" $un -Encoding ascii

if (-not $NoShortcuts) {
  Write-Host "5/5 Creating shortcuts..."
  $sh = New-Object -ComObject WScript.Shell
  foreach ($lnk in @("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\OmniGPT.lnk", "$([Environment]::GetFolderPath('Desktop'))\OmniGPT.lnk")) {
    $s = $sh.CreateShortcut($lnk); $s.TargetPath = "$Dest\OmniGPT.exe"; $s.WorkingDirectory = $Dest; $s.IconLocation = "$Dest\OmniGPT.exe,0"; $s.Description = "OmniGPT"; $s.Save()
  }
}
Write-Host "Installed: $Dest" -ForegroundColor Green
if ($Launch) { Start-Process "$Dest\OmniGPT.exe" }
