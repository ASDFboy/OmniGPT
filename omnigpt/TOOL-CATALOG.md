# OmniGPT tool catalog

A **tool** is something the OmniGPT app runs on the user's PC when an agent asks for it with a structured call: a tool
name plus arguments (for example `view_images {"paths": ["D:\\Photos\\a.jpg"]}`). Every call goes through the same
pipeline: hard safety rules (`precheck` in `app/tools.mjs`), the safety reviewer and the approval mode, then the run,
the activity log and, for changes, the undo journal.

This catalog lists what an agent needs to do anything a user would ask Claude to do (Claude Code, the Claude apps,
Claude in Chrome, computer use, connectors), compared with what OmniGPT already has. Everything uses free software:
what ships with Windows (PowerShell, .NET, Edge, the Windows OCR engine), free programs installed on demand with
`install_tool` (ffmpeg, 7-Zip, Git, GitHub CLI), and the user's own OmniRoute providers.

Tiers: **1** = built now, **2** = next, **3** = later or on request.

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

## Tier 2 (next)

| Tool | What and how | Safety |
|---|---|---|
| `connect_account` + account tools | Sign in once with free official methods: GitHub through the GitHub CLI (`gh auth login`), Google (Gmail, Calendar, Drive) and Microsoft (Outlook, OneDrive, Calendar) through their OAuth device sign-in, Discord and Slack through webhooks the user creates. Then tools such as `email_search`, `email_read`, `email_draft`, `calendar_list`, `calendar_add`, `github` | Tokens stored for the Windows user only, never shown to the model; sending email or posting always asks |
| `http_request` | Call public JSON APIs (GET/POST with headers and body) | Same public-address rules as downloads; secrets only from saved connections |
| `start_process`, `read_process`, `stop_process` | Long-running jobs (dev servers, builds, watchers) in the background, with their output readable later | Listed in the UI; stopped when OmniGPT closes |
| `ocr` | Text from images and scanned PDFs with the Windows OCR engine (offline, built in) | Read-only |
| `pdf_tools` | Merge, split, rotate, extract pages, images and text (qpdf / pdfcpu installed on demand) | New files; undoable |
| `analyze_data` | Run Python in the sandbox with copies of chosen files (CSV, Excel, JSON, SQLite) as input and charts or tables as output | The sandbox still has no network and sees only the copies |
| `make_chart` | Bar, line, pie and scatter charts from data as PNG/SVG (drawn in the browser engine) | New files |
| `remember`, `forget`, `recall` | Explicit control over long-term memory | Shown in Settings, Memory |
| `todo` | A visible task checklist the agent keeps updated during long jobs | None |
| `delegate` | Hand a self-contained sub-task to a worker agent and get its report | Workers keep their lane limits |

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
