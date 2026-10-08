# Setting up OmniGPT: procedure for AI coding assistants

You are an AI assistant (Claude Code, Codex, or similar) helping a user install OmniGPT on **their own Windows PC**.
Follow these steps in order. Each step has a check; do not continue until it passes. The human-readable guide with
more explanation is the repository [README](../README.md).

## Rules

* **Never read, print, log, or commit API keys, passwords, OAuth tokens or session cookies.** When a step needs one, tell
  the user exactly where to paste it themselves (an OmniRoute dashboard field, or the OmniGPT Settings field). Do not
  ask the user to paste secrets into the chat. If they do anyway, do not repeat them back and suggest they rotate them.
* Do not enable paid billing, overage, auto top-up or subscriptions for the user. Free tiers are enough to start.
* Keep OmniRoute bound to `127.0.0.1` (its default). Do not expose it to the network.
* Do not change the user's system or security settings. Everything here installs per-user, without administrator rights.
* Report real results. "The installer exited 0" is not "OmniGPT works"; the final check is a real answer in the app.

## Step 1. Check the PC

```powershell
[Environment]::OSVersion.Version          # Windows 10 (10.0.19041+) or 11 (10.0.22000+)
[Environment]::Is64BitOperatingSystem     # must be True
node -v                                   # v22.22+ or v24+; if missing, Step 2
Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue | Select-Object pv
```

The last command prints the WebView2 Runtime version. If it prints nothing, also check the same key under `HKCU:\Software\Microsoft\EdgeUpdate\Clients\...`;
if both are empty, ask the user to install the WebView2 Evergreen Runtime from
<https://developer.microsoft.com/microsoft-edge/webview2/>.

## Step 2. Node.js (only if Step 1 found none or an old version)

Ask the user to install the LTS version from <https://nodejs.org> (default options), or, if `winget` is available and
the user agrees: `winget install OpenJS.NodeJS.LTS`. Open a new terminal afterwards. **Check:** `node -v`.

## Step 3. OmniRoute

```powershell
npm install -g omniroute
Test-Path "$env:APPDATA\npm\node_modules\omniroute\bin\omniroute.mjs"   # must be True (OmniGPT looks here)
```

Start it in the background for setup:

```powershell
Start-Process omniroute -ArgumentList "serve" -WindowStyle Minimized
```

**Check** (may take up to a minute on first start):

```powershell
(Invoke-WebRequest http://127.0.0.1:20128/api/settings/require-login -UseBasicParsing).StatusCode   # 200
```

If the user already runs OmniRoute with a custom `DATA_DIR`, note that folder; it is needed in Step 7.

## Step 4. The user signs in and connects providers (the user does this)

Tell the user:

1. Open <http://127.0.0.1:20128/dashboard>. Sign in with the password shown on the sign-in page (`CHANGEME` by default)
   and change it in the dashboard settings.
2. On **Providers**, connect at least one provider. Free and easy:
   * Google Gemini: key from <https://aistudio.google.com/apikey>
   * Groq: key from <https://console.groq.com/keys>
   * DuckDuckGo AI Chat and UncloseAI: no key, just enable
   * Optional, paid plans: Claude (Claude Code subscription) and OpenAI Codex, both by OAuth sign-in
3. On **API Manager**, create an API key named `omnigpt` and keep it ready (do not paste it into this chat).

**Check** (after the user has the key, without seeing it): ask the user to confirm that a test message to a model
answers on the dashboard's Models or Playground page.

## Step 5. Install OmniGPT

Download the newest installer and run it silently:

```powershell
$rel = Invoke-RestMethod "https://api.github.com/repos/ASDFboy/OmniGPT/releases?per_page=20" -Headers @{ "User-Agent" = "setup" }
$r = $rel | Where-Object { $_.tag_name -like "omnigpt-v*" -and -not $_.draft -and -not $_.prerelease } | Select-Object -First 1
$asset = $r.assets | Where-Object name -eq "OmniGPT-Setup.exe"
$exe = Join-Path $env:TEMP "OmniGPT-Setup.exe"
Invoke-WebRequest $asset.browser_download_url -OutFile $exe -UseBasicParsing
(Get-FileHash $exe -Algorithm SHA256).Hash    # compare with the SHA-256 in the release notes
Start-Process $exe -ArgumentList "/S" -Wait
```

**Check:**

```powershell
Test-Path "$env:LOCALAPPDATA\Programs\OmniGPT\OmniGPT.exe"                                    # True
Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\OmniGPT" | Select-Object DisplayVersion
```

If the silent install fails, the reason is in `$env:TEMP\OmniGPT-Setup.log`.

Alternative (no download): build from this repository with
`powershell -ExecutionPolicy Bypass -File omnigpt\windows\install.ps1`.

## Step 6. Give OmniGPT the API key (the user does this)

Start OmniGPT (`Start-Process "$env:LOCALAPPDATA\Programs\OmniGPT\OmniGPT.exe"`), then tell the user: **Settings
(bottom left), Connection, OmniRoute API key: paste the key, Save.** The status should say **Connected**.

(If the user prefers an environment variable, they can run this themselves, with their own key, and restart OmniGPT:
`[Environment]::SetEnvironmentVariable("OMNIROUTE_API_KEY", "<key>", "User")`.)

## Step 7. Point OmniGPT at the right models

1. If OmniRoute uses a custom data folder (Step 3), the user enters it in Settings, Connection, **OmniRoute data
   folder**, then restarts OmniGPT.
2. List the model ids that actually answer, using the user's key from the environment without printing it, for example:
   ```powershell
   $h = @{ Authorization = "Bearer $env:OMNIROUTE_API_KEY" }   # only if the user set the environment variable
   (Invoke-RestMethod http://127.0.0.1:20128/v1/models -Headers $h).data.id
   ```
   If the key is only saved in Settings, ask the user to look at the Models page in the dashboard instead.
3. The defaults expect Groq (`groq/openai/gpt-oss-120b`), Gemini (`gemini/gemini-3.1-flash-lite`) and a combo named
   `claude-first`. If the user connected different providers, have them open Settings, **Models**, and enter working
   ids, one per line, for Router, Fast, Strong, Reviewers and Vision. If they have Claude or ChatGPT, they can create the
   `claude-first` combo on the dashboard's Combos page (priority strategy, strong model first).
4. Modes: **Free** needs Gemini/Groq/DuckDuckGo/UncloseAI; **Turbo** needs Claude (`cc/...`) and/or Codex (`cx/...`).

## Step 8. Final check

Ask the user to send `What is 17 * 23?` in a new OmniGPT chat. **Pass:** an answer of 391 appears. Then ask them to
open **OmniRoute console** (bottom left) and confirm the dashboard opens inside the window and "Back to OmniGPT" works.

Report what passed and what did not, with the exact error text for anything that failed. Logs:
`%LOCALAPPDATA%\OmniGPT\server.log`.

## Troubleshooting map

| Symptom | Cause | Fix |
|---|---|---|
| Status "No API key" | key not saved | Step 6 |
| 401 errors | wrong or deleted key | new key on API Manager, Step 6 |
| 429 errors | free limit used up | add another provider; OmniGPT falls back automatically |
| Status "Offline" | OmniRoute not running or not installed | Step 3 check; run `omniroute serve` to see errors |
| Providers missing after OmniGPT starts | OmniGPT started OmniRoute with the default data folder | Step 7.1 |
| Blank window | WebView2 Runtime missing | Step 1 |
