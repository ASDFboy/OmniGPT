# OmniGPT

OmniGPT is a Windows desktop AI assistant that runs on top of [OmniRoute](README.omniroute.md), a local AI gateway that
connects to many AI providers (free and paid) through one endpoint. OmniGPT decides how hard each request is, picks
models for it, can split work between several agents running at the same time, checks code by actually running it,
reads and edits files on your PC (with a safety reviewer and your approval), searches the web, and can keep working
on its own in OMNI mode.

Beyond files and the web, agents can run long jobs in the background, call web APIs, draw charts, work with PDFs,
read scanned pages (OCR), analyze your data files in an isolated sandbox, find things by meaning, post to Discord or
Slack, read your calendar and use GitHub, and OmniGPT learns which models work best for which kind of task. The full
list is in the [tool catalog](omnigpt/TOOL-CATALOG.md); what changed in each version is in the
[release notes](omnigpt/RELEASE-NOTES.md).

This repository is a fork of OmniRoute with OmniGPT added in [`omnigpt/`](omnigpt). Everything runs on your own
computer. Your API keys stay on your PC and are never part of this repository.

> **Setting this up with an AI assistant (Claude Code, Codex, etc.)?** Point it at
> [`omnigpt/SETUP-FOR-AI-ASSISTANTS.md`](omnigpt/SETUP-FOR-AI-ASSISTANTS.md). It has an exact, checkable procedure.

---

## Contents

1. [How it fits together](#1-how-it-fits-together)
2. [What you need](#2-what-you-need)
3. [Install Node.js](#3-install-nodejs)
4. [Install and start OmniRoute](#4-install-and-start-omniroute)
5. [Connect AI providers in OmniRoute](#5-connect-ai-providers-in-omniroute)
6. [Create an OmniRoute API key](#6-create-an-omniroute-api-key)
7. [Install OmniGPT](#7-install-omnigpt)
8. [Connect OmniGPT to OmniRoute](#8-connect-omnigpt-to-omniroute)
9. [Hook up your agents (models)](#9-hook-up-your-agents-models)
10. [Using OmniGPT](#10-using-omnigpt)
11. [Safety and approvals](#11-safety-and-approvals)
12. [Updates](#12-updates)
13. [Where your data lives, and uninstalling](#13-where-your-data-lives-and-uninstalling)
14. [Troubleshooting](#14-troubleshooting)
15. [Building from source](#15-building-from-source)

---

## 1. How it fits together

```
 OmniGPT (desktop app)  ──►  OmniRoute (local gateway, http://127.0.0.1:20128)  ──►  AI providers
   chat, agents, tools          your provider accounts and keys, fallbacks            Gemini, Groq, Claude,
   file access, safety          one API key for OmniGPT                               ChatGPT, DuckDuckGo, ...
```

* **OmniRoute** holds your provider accounts and keys. You manage it in its web dashboard (also available inside
  OmniGPT as the **OmniRoute console**).
* **OmniGPT** only needs one thing from OmniRoute: an **OmniRoute API key**. It starts OmniRoute for you in the
  background if it is not already running.
* Both listen only on `127.0.0.1` (your own computer). Nothing is exposed to your network.

## 2. What you need

| Requirement | Why | Notes |
|---|---|---|
| Windows 10 or 11, 64-bit | OmniGPT is a Windows app | |
| Microsoft Edge WebView2 Runtime | draws the OmniGPT window | Already installed on Windows 11 and most Windows 10 PCs. If missing: <https://developer.microsoft.com/microsoft-edge/webview2/> ("Evergreen Bootstrapper"). |
| Node.js 22 or 24 (LTS) | runs OmniRoute | <https://nodejs.org> |
| At least one AI provider | the actual models | Free options exist (Gemini, Groq, DuckDuckGo, UncloseAI). |
| Python 3 (optional) | lets agents convert and edit files (Excel, Word, images, PDF) | <https://www.python.org/downloads/> - tick "Add python.exe to PATH". |

About 1 GB of disk space is enough. No administrator rights are needed for OmniGPT itself.

## 3. Install Node.js

1. Go to <https://nodejs.org> and download the **LTS** installer for Windows (x64).
2. Run it and keep the default options.
3. Open **PowerShell** (Start menu, type `PowerShell`) and check:
   ```powershell
   node -v
   npm -v
   ```
   You should see a version like `v24.x.x` (OmniRoute needs Node 22.22+ or 24+).

## 4. Install and start OmniRoute

1. In PowerShell:
   ```powershell
   npm install -g omniroute
   ```
   This installs OmniRoute into `%APPDATA%\npm\node_modules\omniroute`, which is where OmniGPT looks for it.
2. Start it once by hand to set it up:
   ```powershell
   omniroute serve
   ```
   Leave that window open for now. (Later, OmniGPT starts OmniRoute automatically and hidden.)
3. Open <http://127.0.0.1:20128/dashboard> in your browser.
4. Sign in. The first password is shown on the sign-in page (`CHANGEME` unless you set `INITIAL_PASSWORD`).
   **Change it right away** in the dashboard settings.

> Want the version of OmniRoute from this fork (with the OmniGPT look) instead of the npm one? See
> [Building from source](#15-building-from-source). The npm version works fine; OmniGPT restyles its console either way.

## 5. Connect AI providers in OmniRoute

Open the **Providers** page in the OmniRoute dashboard and connect at least one provider. Good starting points:

| Provider | Cost | What you do |
|---|---|---|
| **Google Gemini** | free tier | Create a key at <https://aistudio.google.com/apikey> and paste it into the Gemini provider. |
| **Groq** | free tier | Create a key at <https://console.groq.com/keys> and paste it into the Groq provider. |
| **DuckDuckGo AI Chat** | free, no key | Enable it; no account needed. |
| **UncloseAI** | free, no key | Enable it; no account needed. |
| **Cloudflare AI Playground** | free, no key | Enable it; slower, and it blocks adult content. |
| **Claude** (Claude Code subscription) | paid subscription | Connect with the sign-in button (OAuth). Uses your Claude plan's limits. |
| **OpenAI Codex / ChatGPT** | paid subscription | Connect with the sign-in button (OAuth). Uses your ChatGPT plan's limits. |

After connecting, open the **Models** page (or **Playground**) and send a test message to one model to make sure it
answers. Free tiers have rate limits; when one is used up OmniGPT automatically moves on to the next model.

**Combos.** OmniRoute can group several models into one name with fallbacks (the **Combos** page). OmniGPT's Default
mode uses a combo called **`claude-first`** as its "strong" model. Create it on the Combos page with, for example,
Claude Sonnet first and a ChatGPT model second, using the *priority* strategy. If you do not have Claude or ChatGPT,
skip it: OmniGPT notices that it fails and uses the free models instead, or you can replace it in Settings, Models.

## 6. Create an OmniRoute API key

1. In the OmniRoute dashboard, open **API Manager** (the API keys page).
2. Create a new key (any name, for example `omnigpt`) and **copy it**. Treat it like a password.

## 7. Install OmniGPT

1. Open the [Releases page](https://github.com/ASDFboy/OmniGPT/releases) and download **`OmniGPT-Setup.exe`** from
   the newest release.
2. Run it. Windows SmartScreen may say "Windows protected your PC" because the installer is not code-signed: click
   **More info**, then **Run anyway**.
   *(Optional) check the download: in PowerShell, `Get-FileHash .\OmniGPT-Setup.exe` should match the SHA-256 shown on
   the release.*
3. Click **Install**. OmniGPT installs for your Windows account only, into
   `%LOCALAPPDATA%\Programs\OmniGPT`, and adds a Start menu entry (and a desktop shortcut if you leave it ticked).

To update later, run a newer installer the same way. Your chats and settings are kept.

## 8. Connect OmniGPT to OmniRoute

1. Close the `omniroute serve` window from step 4 if it is still open (or leave it; OmniGPT uses it if it is running).
2. Start **OmniGPT**.
3. Open **Settings** (bottom left), then **Connection**.
4. Paste your OmniRoute API key into **OmniRoute API key** and click **Save**. The status should change to
   **Connected**.

Alternatives for the key (use only one):

* Environment variable, for example in PowerShell:
  ```powershell
  [Environment]::SetEnvironmentVariable("OMNIROUTE_API_KEY", "paste-your-key-here", "User")
  ```
  then restart OmniGPT. An environment variable takes priority over the saved key.
* The key saved in Settings is stored in `%LOCALAPPDATA%\OmniRouteChat\omniroute-key.txt` for your Windows account.

**OmniRoute in a custom folder?** If you run OmniRoute with its own `DATA_DIR`, put that folder in Settings,
Connection, **OmniRoute data folder**, so OmniGPT starts OmniRoute with the same data (and protects it).

## 9. Hook up your agents (models)

OmniGPT uses five groups of models ("tiers"). Each is a list of OmniRoute model ids, tried in order:

| Tier | Job | Default |
|---|---|---|
| Router | sorts each request (how hard, needs tools, needs the web, can run in parallel) | `groq/openai/gpt-oss-120b`, `gemini/gemini-3.1-flash-lite` |
| Fast | does most of the work, answers, and workers | `groq/openai/gpt-oss-120b`, `gemini/gemini-3.1-flash-lite` |
| Strong | advisor on hard tasks and tie-breaker when answers disagree | `claude-first` (your combo) |
| Reviewers | consistency checks and the safety reviewer for PC actions | `gemini/gemini-3.1-flash-lite`, `groq/openai/gpt-oss-120b`, `groq/openai/gpt-oss-20b` |
| Vision | reads attached images | `gemini/gemini-3.1-flash-lite`, `claude-first` |

**Change them:** Settings, **Models**. Enter one model id per line. Empty lists use the defaults. Model ids are shown in
the OmniRoute dashboard (Models page) as `provider/model`, for example `gemini/gemini-3.8-flash`. Models that call tools
(file access, web search) must support tool calling; most current models do.

**Modes** (the menu at the right of the message box) pick a whole set of models at once:

| Mode | Uses | Needs |
|---|---|---|
| **Default** | the tiers above: free models first, the strong model only when needed | any providers |
| **Turbo** | paid models only (Claude Sonnet / Opus / Haiku 5.5, GPT-6) | Claude and/or Codex connected in OmniRoute |
| **Free** | free models only (Groq, Gemini, DuckDuckGo, UncloseAI); never anything paid | free providers |
| **Unfiltered** | models that allow adult content (DuckDuckGo Mistral/Gemma, UncloseAI, Gemini Flash Lite) | those providers |

Each conversation remembers its mode. Unfiltered still refuses sexual content involving minors, real people, weapons,
malware, violence and self-harm: a safety check runs before any model sees the request.

**How the agents work together:** a refiner turns your message into a precise brief; the router sorts it; easy
questions get one answer; moderate and hard questions get three independent answers that are compared, and the strong
model only steps in when they disagree; hard tasks get a short plan and acceptance criteria from the strong model first;
work that splits cleanly runs as parallel workers; code is run in an isolated sandbox to check it. The **agent graph**
on the right shows which models are talking.

## 10. Using OmniGPT

* **Chat:** type and press Enter (Shift+Enter for a new line). Ctrl+K starts a new chat, Ctrl+B hides the sidebar,
  Esc stops.
* **PC access** (top right): lets agents read, create and change files and run commands in your allowed folders.
* **Attach files** (paperclip): any file type. Built-in readers for Word, Excel, PowerPoint, PDF, OpenDocument,
  EPUB, text and code, archives, images, audio, video and SQLite. For other formats the agents look up a tool and
  install it with `pip`.
* **Attach a folder** (folder icon): the agents may do anything inside that folder and its subfolders without asking.
* **Files in answers:** file names in answers open File Explorer; created files appear as cards with previews.
* **Web:** with **Search the web first** (Settings, Agents and safety; on by default) agents look facts up online
  instead of answering from memory, and list their sources.
* **Pictures and videos:** agents look at images themselves (**view images**; videos need ffmpeg, which they install
  when needed) and sort or describe them by what they show, never by file name.
* **Missing tools:** when a job needs a program OmniGPT does not have, the agent searches for a free one and installs it
  with winget, pip or npm (**install tool**), then uses it.
* **Background jobs:** agents can start programs that keep running, such as a development server, a long build or a
  watcher (**start process**). While one runs, the top bar shows "1 background job": click it to see each job's
  command and latest output, and **Stop** it. At most 8 run at once, environment variables that look like keys or
  passwords are left out of them, and they all stop when you close OmniGPT.
* **Charts:** agents draw bar, line, pie and scatter charts as PNG or SVG files, from numbers or a CSV file
  (**make chart**). Charts that would mislead (more than 8 series, a pie with negative values) are refused with a
  reason; a pie with more than 8 slices groups the smallest into "Other".
* **PDF tools:** merge PDFs, copy out or rotate pages, split a PDF into smaller files, or show its page count
  (**pdf tools**). The originals are never changed; the results are new files that **Undo** removes. This uses qpdf, a
  free program: the first time, the agent installs it with winget, which goes through approval like any other install.
* **Text from pictures and scans (OCR):** agents read the text in photos, screenshots and scanned PDF pages with the
  OCR engine built into Windows, offline (**ocr**). It needs an OCR language in Windows: **Settings > Time & language >
  Language & region**, add a language with "Optical character recognition". OCR can misread characters, so check
  numbers that matter.
* **Data analysis:** agents work out totals, averages and tables from your spreadsheets and data files by running
  Python (or JavaScript) in the isolated sandbox (**analyze data**). The sandbox gets copies of up to 20 files from your
  allowed folders (each Excel sheet also as a CSV file), never the originals. It has no network, can run for at most
  60 seconds, and has only Python's standard library (no pandas or matplotlib; charts are drawn with **make chart**).
  The files it produces are saved to a new folder under **Analysis results** in the working folder, and **Undo**
  removes them.
* **Web APIs:** agents can call public web APIs and read their answers (**http request**). Local and private network
  addresses are refused. Keys are never typed into the chat: a request that carries a key, password or cookie in its
  headers is refused. Sending data to an API (anything other than reading) goes through approval like a change.
* **Accounts (Settings, Accounts):** connect free accounts once; the links and keys you paste are encrypted for your
  Windows user and never shown to the AI (Settings only shows names, addresses and a masked hint). Each account has
  **Test** (it never sends a message) and **Remove**.
  * **Discord or Slack channel:** paste an incoming-webhook link (Discord: channel settings, Integrations, Webhooks,
    Copy Webhook URL; Slack: an Incoming Webhook for a channel). Agents post with **send message**, which always asks
    you first, in every approval mode, and shows the exact text. Mentions such as @everyone never ping anyone.
  * **Calendar:** paste an ICS link (Google Calendar: Settings, your calendar, Integrate calendar, Secret address in
    iCal format; Outlook: Settings, Calendar, Shared calendars, Publish a calendar, ICS link). Agents read events with
    **calendar events** (today and the next 14 days unless asked otherwise, repeats and time zones worked out). It is
    read-only: agents cannot add events this way.
  * **Web API key:** an https address, the header name (for example Authorization or X-API-Key) and the key. Agents
    use it by name with **http request**; it is only ever sent to that address, never to another site after a
    redirect, and hidden if the API echoes it back.
  * **GitHub:** uses the free GitHub CLI (agents install it with your approval: winget GitHub.cli). **Connect** opens a
    window where you sign in with your browser; OmniGPT stores nothing. Agents can list and read repositories, issues,
    pull requests, workflow runs and releases (**github**); creating, commenting, closing, merging and reviewing always
    ask first. Sign-in, secrets, keys and settings commands are never run.
* **Checklist:** on long jobs the agent keeps a checklist in the conversation, under the reasoning line
  ("Checklist · 2 of 5 done"), and ticks items off as it works.
* **Helpers:** the agent can hand a self-contained part of the job to a helper agent. Each helper has its own lane in
  the reasoning and in the brain graph, works only from the instructions it was given, cannot ask you anything, and
  goes through the same safety checks. At most 6 helpers per request.
* **Memory:** ask OmniGPT to remember or forget something and the agent does it (**remember**, **recall**,
  **forget**). Passwords, keys and tokens are never saved. Forgetting needs a specific memory: a request that matches
  more than 5 memories removes nothing. Everything remembered is listed in Settings, **Memory**, where you can delete
  entries or turn memory off.
* **OMNI mode:** click the OmniGPT name at the top. Give it a goal and it keeps working on its own; send messages to
  steer it, press Stop to finish. "Run indefinitely" keeps improving the result with free models until you stop it.
* **OmniRoute console** (bottom left): the OmniRoute dashboard inside the app. "Back to OmniGPT" returns.
* **Projects and folders** in the sidebar organise chats; right-click a chat to rename, move, delete it, or
  **Export as Markdown**. The **Search chats** box finds chats by title or anything said in them.
* **Undo:** when an answer changed files on your PC, an **Undo N changes** button appears under it (click twice).
  It restores overwritten files, moves files back, removes files and folders the agent created (to the Recycle Bin)
  and brings deleted files back from the Recycle Bin. Commands the agent ran cannot be undone and are listed.
* **Usage:** the top bar shows this conversation's model calls, tokens and, when OmniRoute shares its prices, the cost.
* **Activity:** Settings, **Activity** lists every action agents took on your PC, newest first, with a link to the chat.
* **Brain graph** (right side): the models, memories, skills, tools and files taking part in the conversation.
* **Settings:** theme, accent color, text size, memory, skills, models, approvals, steps per task, token budget,
  attached folders, data export.

### Smarter and faster

* **Quicker start:** OmniGPT works out what kind of request it is while it clarifies it, and the agent gets only the
  tools the request needs (it can ask for more with **more tools**). In long chats, older messages are replaced by a
  short summary instead of being dropped.
* **Long jobs:** long tool results are shortened once the agent has seen them (it can read them again with **read
  output**), reading actions in one step run at the same time, the safety reviewer checks a whole step at once, and in
  "Ask before changes" mode the approval button appears right away. For bigger jobs that changed something, the agent
  checks its work once before answering ("Self-check" in the reasoning).
* **Search by meaning (Settings, Search by meaning):** with an embedding model from OmniRoute (Automatic picks one on
  this PC first, then free ones), memories, skills and earlier answers are found by what they mean. **Search my
  documents by meaning** (off by default) lets agents find passages in your allowed folders with **search meaning**;
  to build its index, the text of your documents is sent to the embedding provider chosen in OmniRoute (a provider on
  this PC, such as Ollama, keeps it here). The index is stored in `%LOCALAPPDATA%\OmniRouteChat\index`, updates only
  when it is used, and **Clear index** deletes it.
* **Learning (Settings, Models and Skills):** OmniGPT learns which models work best for each kind of task (files, web,
  writing, code, chat): answers that worked raise a model; corrections, Undo, failed actions and empty replies lower
  it. When every action in a request worked, the steps are kept as a **recipe** (tool names only, never contents or
  paths) and suggested for similar requests; recipes that later fail are dropped.
* **Light when idle:** the brain graph draws only while something changes. Notifications, clipboard, Recycle Bin,
  undo, pictures, OCR and saved-account encryption reuse one hidden PowerShell (closed after 5 idle minutes), and
  charts and PDFs reuse one hidden Edge (closed after 3 idle minutes). Each chat is saved in its own file, so saving
  stays fast with hundreds of chats; the sidebar search looks inside every chat.
* **Benchmark:** `node omnigpt\windows\tests\bench.mjs` runs about 30 everyday tasks against your OmniRoute in
  temporary folders and prints a score table (`--list`, `--only=name,name`).

## 11. Safety and approvals

Settings, **Agents and safety**, **Approval**:

| Option | Behaviour |
|---|---|
| Ask before changes | every change on your PC waits for your click (the safest) |
| Auto-run low-risk actions | the reviewer model approves low-risk actions; deletes still ask |
| Only stop high-risk actions | only actions rated high risk stop; the agent is asked to find a safer way first |
| Bypass all checks | no reviewer and no prompts. Only protection of secrets and drive-level damage remains |

Always active, whatever the setting: agents can only touch your **allowed folders**; they cannot read credential files,
environment variables or OmniRoute's data folder; deletes go to the Recycle Bin; code checks run in an isolated
sandbox with no network and no access to your files (data analysis gets copies of the files it was given, never the
originals); drives, your user folder and its main personal folders (Documents, Desktop, Downloads, Pictures, Music,
Videos, OneDrive) can never be deleted.

Even with **Bypass all checks**, once an agent has read a web page, called a web API or downloaded something in a
request, deletes, moves or writes of more than 10 files, destructive commands (also as background jobs) and sending
data to a web API ask first (a web page can try to trick the agent).

Limits, under **Agents and safety**: **Steps per task** (Auto = 40 actions, no limit when bypassing) and **Token budget
per request** (off by default). An agent that repeats the same action or keeps failing is warned and then stopped.

## 12. Updates

When a newer version is published on the Releases page, OmniGPT shows a small notice in the bottom-right corner.
**Install now** downloads the installer, checks it against the release's SHA-256, installs it and reopens OmniGPT.
Turn it off in Settings, General, **Update notifications**. Settings, About, **Check for updates** checks by hand.

## 13. Where your data lives, and uninstalling

| What | Where |
|---|---|
| The program | `%LOCALAPPDATA%\Programs\OmniGPT` |
| Chats, settings, memories, skills, saved key, undo journal, activity log | `%LOCALAPPDATA%\OmniRouteChat` |
| Connected accounts (links and keys encrypted for your Windows user) | `%LOCALAPPDATA%\OmniRouteChat\connections.json` |
| Chats (one file each) and the backup of the old single file | `%LOCALAPPDATA%\OmniRouteChat\kv\chats`, `kv\orc.chats.json.migrated-backup` |
| Search-by-meaning index and embedding cache | `%LOCALAPPDATA%\OmniRouteChat\index`, `embed-cache.json` |
| Backups of files agents overwrote | `%LOCALAPPDATA%\OmniRouteChat\backups` |
| Logs, sandbox runs, window data | `%LOCALAPPDATA%\OmniGPT` |
| Attached files | `Documents\OmniRoute Workspace\Attachments` |
| Data analysis results | `Analysis results` in the working folder (by default `Documents\OmniRoute Workspace\Analysis results`) |
| OmniRoute's data (provider keys) | `%USERPROFILE%\.omniroute` (or your `DATA_DIR`) |

Uninstall from **Settings, Apps** in Windows (OmniGPT), or run `Uninstall OmniGPT.cmd` in the program folder. Your chats
and settings are kept; delete the folders above to remove them too. Remove OmniRoute with `npm uninstall -g omniroute`.

## 14. Troubleshooting

| Problem | Fix |
|---|---|
| "No OmniRoute API key yet" | Settings, Connection: paste the key from step 6. |
| "OmniRoute is not responding" / Offline | Check that `npm install -g omniroute` worked. Run `omniroute serve` in PowerShell to see its error. Port 20128 must be free. |
| Answers fail with 401 | The API key is wrong or was deleted in OmniRoute. Create a new one. |
| A model fails with 429 | That provider's free limit is used up. OmniGPT moves to the next model; add more providers for headroom. |
| Turbo mode fails | Claude and/or Codex are not connected in OmniRoute. Use Default or Free. |
| Window stays blank or says WebView2 | Install the WebView2 Runtime (link in section 2). |
| "OmniGPT could not start" | Read `%LOCALAPPDATA%\OmniGPT\server.log`. |
| My providers disappeared after starting OmniGPT | OmniGPT started OmniRoute with its default folder. Set your custom folder in Settings, Connection, OmniRoute data folder, and restart OmniGPT. |
| File conversions fail | Install Python 3 and tick "Add python.exe to PATH". |
| OCR says Windows has no OCR language installed | Windows **Settings > Time & language > Language & region**: add a language with "Optical character recognition", then try again. |
| PDF tools say qpdf is not installed | Let the agent install it, or run `winget install --id QPDF.QPDF -e` in PowerShell. |
| A background job keeps running | Click "N background jobs" in the top bar and press **Stop**. Closing OmniGPT stops every job. |

## 15. Building from source

Requirements: Windows, Node.js 22+, optionally Python 3 (for the code sandbox). The C# compiler that ships with
Windows (.NET Framework 4) is used; the WebView2 SDK is downloaded once from nuget.org.

```powershell
git clone https://github.com/ASDFboy/OmniGPT.git
cd OmniGPT\omnigpt\windows
powershell -ExecutionPolicy Bypass -File .\build-installer.ps1
```

This runs the checks (`tests\preflight.mjs`: the syntax of every backend module, safety rules, file readers, folder
rules, the tool tests, and more), builds the program (it ships every backend module, `app\*.mjs`), tries to break out
of the code sandbox (`tests\sandbox-test.mjs`, which also runs data analysis end to end), and writes
`release\OmniGPT-Setup.exe`.
`install.ps1` builds and installs directly without making an installer.

Layout:

```
omnigpt/
  app/        the OmniGPT web app (index.html, style.css, brain.js, app.js) and its local backend (Node):
              server.mjs, tools.mjs (PC tools, safety rules, undo journal), jobs.mjs (background jobs),
              charts.mjs, pdfocr.mjs (OCR and PDF tools), render.mjs, browser.mjs, docs.mjs, web.mjs, files.mjs,
              zip.mjs
  windows/    the Windows host (OmniGPT.cs), code sandbox (Sandbox.cs), installer (Setup.cs), build scripts, tests
```

To run the OmniRoute dashboard from this fork (with the OmniGPT look built in), follow
[README.omniroute.md](README.omniroute.md) (`npm install`, `npm run build`, `npm start`).

**Automatic builds:** every change under `omnigpt/` runs the checks and builds the installer on GitHub
(`.github/workflows/omnigpt.yml`). Open the run under **Actions** and download the `OmniGPT-Setup` artifact.

**Publishing a release (maintainers):** set the new version in `omnigpt/app/server.mjs` (`VERSION`) and
`omnigpt/windows/Setup.cs` (`Version`), build the installer (locally or from the Actions artifact), then
`gh release create omnigpt-vX.Y.Z omnigpt/windows/release/OmniGPT-Setup.exe omnigpt/windows/release/OmniGPT-Setup.exe.sha256`
(the `.sha256` file is needed for **Install now**). The update check only looks at tags named
`omnigpt-vX.Y.Z`. Write the release's notes in [`omnigpt/RELEASE-NOTES.md`](omnigpt/RELEASE-NOTES.md) first and use
them as the release text.

---

OmniRoute is by [diegosouzapw](https://github.com/diegosouzapw/OmniRoute); its original README is
[README.omniroute.md](README.omniroute.md). MIT License (see [LICENSE](LICENSE)).
