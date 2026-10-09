# OmniGPT tool catalog

A **tool** is something the OmniGPT app runs on the user's PC when an agent asks for it with a structured call: a tool
name plus arguments (for example `view_images {"paths": ["D:\\Photos\\a.jpg"]}`). Every call goes through the same
pipeline: hard safety rules (`precheck` in `app/tools.mjs`), the safety reviewer and the approval mode, then the run,
the activity log and, for changes, the undo journal. Tools that only touch the app itself (questions, scheduled tasks,
memory, the checklist, helpers) run inside the page instead (`PAGE_TOOLS` in `app/app.js`). A call to a tool the agent
was not given (for example a read-only helper calling `write_file`) is refused before anything runs.

This catalog lists what an agent needs to do anything a user would ask Claude to do (Claude Code, the Claude apps,
Claude in Chrome, computer use, connectors), compared with what OmniGPT already has. Everything uses free software:
what ships with Windows (PowerShell, .NET, Edge, the Windows OCR engine), free programs installed on demand with
`install_tool` (ffmpeg, 7-Zip, qpdf, Git, GitHub CLI), and the user's own OmniRoute providers.

Tiers: **1** = built first, **2** = built second (what is still to come is under "Tier 2 (next)"), **3** = later or on
request.

## Already available

| Tool | What it does |
|---|---|
| `read_file`, `read_files`, `inspect_file` | Read text; read any format (Office, PDF, archives, images, audio, video, SQLite) |
| `list_dir`, `find_duplicates` | List folders; find identical files by content |
| `write_file`, `write_files`, `edit_file`, `make_dir` | Create and change files (backed up, undoable) |
| `copy_file`, `move_file`, `move_files`, `delete_file`, `delete_files` | Organize files; deletes go to the Recycle Bin |
| `run_command` | PowerShell in the working folder |
| `run_code` | Python or JavaScript in an isolated sandbox (no network, no user files) |
| `view_images` | The model sees pictures and video frames |
| `install_tool` | winget / pip / npm installs of missing programs |
| `web_search`, `web_open`, `download_file` | Search, read pages, download files |
| `list_project_chats`, `read_project_chat` | Other conversations in the same project |

## Tier 1 (built now)

### Talking to the user
| Tool | Arguments | How | Safety |
|---|---|---|---|
| `ask_user` | `question`, `options[]`, `multi` | Shows the question with buttons in the conversation and waits for the answer | Read-only. Stops the agent guessing before big changes |
| `notify` | `title`, `message` | Windows notification (toast) plus the in-app notice, for long or scheduled jobs | None |

### Finding things
| Tool | Arguments | How | Safety |
|---|---|---|---|
| `find_files` | `path`, `pattern` (`*.pdf`, `**/report*`), `min_size`, `max_size`, `modified_after`, `modified_before` | Walks the folder in Node | Read-only, allowed folders, protected folders skipped |
| `search_files` | `path`, `query` (text or regex), `glob`, `case_sensitive` | Searches inside text files (like grep), returns file:line matches | Read-only, skips binaries and files over 5 MB |
| `system_info` | none | Windows version, CPU, RAM, disks and free space, display, installed runtimes (Python, Node, Git, ffmpeg) | Read-only |

### Opening and packing
| Tool | Arguments | How | Safety |
|---|---|---|---|
| `open_path` | `path` or `url`, `reveal` | Opens a document, folder or web page in its default app, or shows it in File Explorer | Programs and scripts (.exe, .bat, .ps1, .msi, .lnk ...) are never opened; only http(s) URLs |
| `archive` | `action` (`zip`, `unzip`, `list`), `source`, `destination` | Built-in .NET zip; 7-Zip for .7z/.rar when installed | Unzip refuses entries that escape the destination; undoable |
| `clipboard` | `action` (`read`, `write`), `text` | PowerShell Get/Set-Clipboard | Reading always asks first (the clipboard often holds passwords) |

### Scheduling
| Tool | Arguments | How | Safety |
|---|---|---|---|
| `schedule_task` | `name`, `prompt`, `when` (`once` + time, `every` N minutes, `daily` HH:MM, `weekly` days + HH:MM), `pc_access` | Uses OmniGPT's scheduled tasks | Shown in Scheduled tasks; can be removed there |
| `list_tasks`, `cancel_task` | `id` | Same store | None |

### Pictures, media and documents
| Tool | Arguments | How | Safety |
|---|---|---|---|
| `edit_image` | `path`, `output`, `resize` (max side or WxH), `crop` (x,y,w,h), `rotate` (90/180/270), `flip`, `format` (jpg/png/bmp/gif), `quality` | .NET System.Drawing (built into Windows) | Never overwrites unless `output` equals the source; undoable |
| `convert_media` | `input`, `output`, `start`, `end`, `audio_only`, `max_width`, `quality` (high/medium/small), `fps` (for GIFs) | ffmpeg (installed on demand) | Never overwrites; undoable |
| `make_document` | `path` (.docx, .xlsx, .pptx, .pdf, .html, .md), `title`, `content` (Markdown) or `sheets` (rows) or `slides` (title + bullets) | Office files written directly (no Office needed); PDF printed by Microsoft Edge in the background | Never overwrites unless asked; undoable |
| `generate_image` | `prompt`, `path`, `size`, `model` | OmniRoute image generation with the user's providers (free ones first) | Saved as a new file; undoable |
| `transcribe_audio` | `path`, `language`, `model` | OmniRoute speech-to-text (for example Whisper on Groq); video audio extracted with ffmpeg | Read-only |
| `speak` | `text`, `path`, `voice`, `model` | OmniRoute text-to-speech, or the offline Windows voice | New file; undoable |

### Browser (Claude in Chrome equivalent)
| Tool | Arguments | How | Safety |
|---|---|---|---|
| `browser` | `action`: `open` url, `read`, `screenshot`, `click` (text or CSS selector), `type` (selector + text), `press` key, `scroll`, `back`, `tabs`, `close` | A separate Microsoft Edge window with its own profile, driven through the DevTools protocol | Own profile: never the user's main browser, cookies or passwords. Only http(s). Typing into password fields asks first. The window is visible so the user can watch |

### Screen control (computer use)
| Tool | Arguments | How | Safety |
|---|---|---|---|
| `screen` | `action`: `screenshot`, `click` x,y (left/right/double), `type` text, `key` combo (ctrl+s, alt+tab), `scroll`, `move` | Windows input APIs (SendInput) through PowerShell; screenshots scaled down for the model | Every request that uses it asks once ("Allow screen control for this request?") in every approval mode, including bypass. A visible banner shows while it is allowed; Stop ends it. Coordinates are in screenshot pixels |
| `windows` | `action`: `list`, `focus` title, `launch` app name, `minimize`, `close` title | PowerShell window and process APIs; `launch` uses Start-menu app names, never paths | Same permission as `screen`; `close` asks first |

## Tier 2 (built now)

### Background jobs
| Tool | Arguments | How | Safety |
|---|---|---|---|
| `start_process` | `command`, `name`, `cwd`, `wait` (seconds to wait for the first output, default 3), `until` (text or pattern to wait for, e.g. `listening on`) | Runs a PowerShell command in the background (`app/jobs.mjs`) and returns a job id with its first output | Same command rules and approval as `run_command`. Not for parallel workers. Secrets are left out of its environment. At most 8 jobs run at once. Recorded in the undo journal as a command (it cannot be undone) and in the activity log |
| `read_process` | `id` (none: list all jobs), `all`, `wait` (up to 60 s), `until` | Returns what the job printed since the last read (the most recent 400,000 characters per job are kept; at most 12,000 shown per read), its state and the program's own exit code | Read-only |
| `stop_process` | `id` | Ends the job and the programs it started | Only jobs OmniGPT started |

While a job runs, the header shows "N background jobs"; clicking it opens the job list with each job's command, recent
output and a **Stop** button. Every job stops when OmniGPT closes.

### Web APIs
| Tool | Arguments | How | Safety |
|---|---|---|---|
| `http_request` | `method` (GET, POST, PUT, PATCH, DELETE, HEAD), `url`, `headers`, `body` (an object is sent as JSON; up to 1 MB; none for GET and HEAD), `timeout_sec` (default 30, at most 120) | Node `fetch`. Returns the status, key headers (content type, rate limits, retry-after) and the body: JSON formatted, cut after 20,000 characters, at most 2 MB read; binary content is only described (`download_file` saves it) | Public addresses only, same rules as `download_file`; every redirect is checked again (at most 5). Headers that carry a secret (Authorization, cookies, tokens, API keys, passwords, sessions) are refused, so keys are never typed into the chat. GET and HEAD count as reading the web; sending data is a network action that goes through approval and, once web content was read in the request, asks even with every check bypassed. The response counts as web content |

### Data, charts and PDFs
| Tool | Arguments | How | Safety |
|---|---|---|---|
| `analyze_data` | `files[]` (up to 20, 200 MB together), `code`, `language` (`python`, the default, or `javascript`), `output` (folder), `name` (for the results folder), `timeout_sec` (default 30, at most 60) | The code sandbox (`windows/Sandbox.cs`) with copies of the files in `input/` (each sheet of an .xlsx file also as `input/<file>.<sheet>.csv`). Files the code writes to `output/` are saved to a new folder under `Analysis results` in the working folder | The code sees only the copies; no network; Python has its standard library only (no pandas or matplotlib); 1 GB memory. Links in `output/` are never followed; at most 50 result files, 200 MB and 4 folder levels come out. The results folder must be new or empty. Goes through approval like any change; undoable |
| `make_chart` | `path` (.png or .svg), `type` (`bar`, `line`, `pie`, `scatter`), `title`, `subtitle`, `labels`, `series` (`[{name, values}]`; scatter: `[{name, points: [[x,y],...]}]`) or `csv` (first column = labels, other columns = series) with `columns`, `x_label`, `y_label`, `stacked`, `width`, `height`, `overwrite` | Drawn as SVG in Node (`app/charts.mjs`); PNGs are rendered at twice the size by Edge in the background through the DevTools protocol (`app/render.mjs`) | Charts that would mislead are refused with a reason: more than 8 series, more than 3 scatter series, a pie with several series, negative values or a single slice. Pies with more than 8 slices combine the smallest into Other. At most 500 values per series (20,000 scatter points). One fixed colour-blind-checked colour order. Never replaces a file unless `overwrite` (backed up); undoable |
| `pdf_tools` | `action`: `info` path; `merge` paths (2 to 50) + output; `extract` path + pages (`1-3,7`, `5-z`, z = last page) + output; `rotate` path + angle (90/180/270) + pages + output; `split` path + every (pages per file, default 1) + output folder; `overwrite` | qpdf, run directly without a shell (`app/pdfocr.mjs`); installed on demand with `install_tool winget QPDF.QPDF` | Results are new files; the originals are never changed and the output cannot be one of the inputs. An existing output is only replaced with `overwrite` (backed up); `split` needs a new or empty folder. Password-protected PDFs cannot be changed. Undoable. PDF text is read with `inspect_file`, scanned pages with `ocr` |
| `ocr` | `path` (png, jpg, bmp, gif, tiff, webp, heic, ico or PDF), `pages` (`1-3,5`; default the first 30; at most 50 per call), `language` (e.g. `en-US`; default the user's Windows languages), `output` (also save the text), `overwrite` | The OCR engine built into Windows (`Windows.Media.Ocr`) through PowerShell, offline; PDF pages are drawn with `Windows.Data.Pdf` first | Read-only unless `output` is given (then a new, undoable file). Needs an OCR language installed in Windows (Settings > Time & language > Language & region). Stopped after 5 minutes |

### Memory, checklist and helpers (run inside the app)
| Tool | Arguments | How | Safety |
|---|---|---|---|
| `remember` | `text` (up to 300 characters), `kind` (`user`, `preference`, `fact`) | Saves to long-term memory; saying the same thing again updates the existing memory instead of adding a copy | Secrets (passwords, keys, tokens) are refused. Saves nothing when Memory is turned off. Every memory is shown, and can be deleted, in Settings, Memory |
| `recall` | `query` (none: everything) | Searches the memories and returns them with their ids | Read-only |
| `forget` | `id` (from `recall`) or `query` (at least 3 characters) | Removes the matching memories | A text that matches more than 5 memories removes nothing and lists their ids instead |
| `todo` | `items[]` (`text` + `status`: `pending`, `doing`, `done`; up to 40) | One checklist card per request, in the conversation under the reasoning line (not hidden inside it), updated in place: "Checklist · 2 of 5 done" | None |
| `delegate` | `title`, `instructions`, `tools` (`all`; `web` = web search and open only; `read` = reading files and the web, no changes) | A helper agent does a self-contained sub-task in its own lane in the reasoning ("Helper 1 · title") and in the brain graph, then reports back | The helper sees only its instructions, not the conversation. It cannot ask the user, delegate, schedule tasks, use the clipboard or change memory, and its actions go through the same safety checks. At most 6 helpers per request |

Parallel workers do not get `remember`, `forget`, `todo` or `delegate`. In OMNI (autonomous) mode each cycle gets its
own helper count and checklist.

## Tier 2 (next)

| Tool | What and how | Safety |
|---|---|---|
| `connect_account` + account tools | Sign in once with free official methods: GitHub through the GitHub CLI (`gh auth login`), Google (Gmail, Calendar, Drive) and Microsoft (Outlook, OneDrive, Calendar) through their OAuth device sign-in, Discord and Slack through webhooks the user creates. Then tools such as `email_search`, `email_read`, `email_draft`, `calendar_list`, `calendar_add`, `github` | Tokens stored for the Windows user only, never shown to the model; sending email or posting always asks |

## Tier 3 (later or on request)

| Tool | What |
|---|---|
| `git` helpers | Status, diff, commit, branch, push, pull requests (Git and GitHub CLI) |
| `database` | Query SQLite, PostgreSQL, MySQL with saved connections |
| `translate_document` | Translate Office and PDF files keeping their layout |
| `video_edit` | Cut lists, subtitles burned in, concatenation, thumbnails (ffmpeg) |
| `printer` | Print a document to a chosen printer |
| `settings_changes` | Wi-Fi, display, sound and similar Windows settings (each change asks) |
| `mcp` | Use any MCP server the user adds (OmniRoute already hosts an MCP server) |
| `phone_bridge` | Notifications to the user's phone through a free push service |

## Rules every new tool follows

1. Arguments are validated in `precheck`; paths go through the allowed-folder and protected-location rules.
2. Changes are recorded in the undo journal and the activity log.
3. Output shown to the model is labelled untrusted data.
4. Nothing paid is used or enabled; missing free programs are installed with `install_tool`.
5. Each tool has a test in `windows/tests/` that the installer build runs.
