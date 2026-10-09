# OmniGPT release notes

## 1.0.2

Many new abilities for agents, a faster start and much less waiting on long jobs. Run the new installer over 1.0.1:
your settings, memories and chats are kept (chats are moved to a new storage format on first start, and the old file
is kept as a backup).

**New things agents can do**
- Run long jobs in the background (dev servers, builds) and watch or stop them from the header.
- Call public web APIs, draw bar, line, pie and scatter charts (PNG or SVG), merge, split, rotate and extract PDF pages,
  and read scanned pages and pictures with the OCR built into Windows.
- Analyze data files (CSV, Excel, JSON, SQLite) in the isolated sandbox: it works on copies and saves results to an
  "Analysis results" folder.
- Settings, Accounts: post to Discord or Slack (always asks first), read a calendar link, use a saved web API key (the
  AI never sees it), and work with GitHub through the free GitHub CLI.
- A visible checklist on long jobs, helper agents for sub-tasks, and tools to remember, recall and forget.
- Find memories, skills and, if you turn it on, documents by meaning (Settings, Search by meaning).

**Faster and smarter**
- Requests start about twice as fast, agents get only the tools a request needs, and old messages are summarized
  instead of dropped.
- Long jobs send about 70% less text; reading actions run at the same time; the safety reviewer checks a whole step at
  once; the approval button appears immediately; bigger jobs check their own work before the answer.
- OmniGPT learns which models work best for each kind of task and saves the steps of jobs that worked as recipes.
- Charts and PDFs are about three times faster after the first one.

**Lighter**
- The brain graph uses no processor while nothing changes.
- Every chat is saved in its own file, so saving stays fast with hundreds of chats, and the sidebar search looks
  inside chats.

**Fixes**
- Tools an agent was not given can no longer be run.
- Forgetting a memory by a vague word no longer deletes many memories at once.
- Slack messages cannot ping @channel or @here.

Not included yet: controlling the screen, and email. Windows SmartScreen may warn because the installer is not
code-signed: choose *More info*, then *Run anyway*. OmniGPT needs OmniRoute (`npm install -g omniroute`) and an
OmniRoute API key: follow the [setup guide](https://github.com/ASDFboy/OmniGPT#readme).

## 1.0.1

Fixes settings and chats sometimes not being saved, and protects main personal folders from deletion.

## 1.0.0

First release: automatic model routing, parallel agents, code checked in a sandbox, file access with a safety reviewer,
readers for 40+ file types, web research, OMNI autonomous mode, memories and skills.
