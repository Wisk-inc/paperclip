# Automa

**A company run by AI agents, in an Android app.**
Made in Jamaica by Nathan Lyttle (Corx Labs).

Version **1.9.4** · Android 8.0 or newer · package `com.corxlabs.automa`

You create an organization with a goal, hire AI agents into an org chart, give
them work in plain words, and watch them plan it, do it, and check in when they
need you. Agents can run on paid models you bring a key for (Claude, GPT,
Gemini, Kimi, Grok, DeepSeek and more) or on **free models that need no key and
no account**. On top of that, Automa has **App Studio** (build, run and share
apps with a team of AI models), **Terminals** (real coding tools on the phone),
**App Inspector** (decode, read, edit and rebuild Android apps) and **Moan**
(a Jamaican model that talks Patois and knows the island).

---

## Contents

1. [What Automa is](#1-what-automa-is)
2. [What's new in 1.9.4](#2-whats-new-in-194)
3. [Install](#3-install)
4. [First run](#4-first-run)
5. [Core ideas](#5-core-ideas)
6. [Getting around the app](#6-getting-around-the-app)
7. [Home (Dashboard)](#7-home-dashboard)
8. [Chats](#8-chats)
9. [Free models](#9-free-models)
10. [Moan, the Jamaican model](#10-moan-the-jamaican-model)
11. [The Que engine](#11-the-que-engine)
12. [Tasks](#12-tasks)
13. [Inbox and approvals](#13-inbox-and-approvals)
14. [Agents and the org chart](#14-agents-and-the-org-chart)
15. [Projects, goals, routines, pipelines, cases and workspaces](#15-projects-goals-routines-pipelines-cases-and-workspaces)
16. [Artifacts and Files](#16-artifacts-and-files)
17. [Skills and connectors](#17-skills-and-connectors)
18. [App Studio](#18-app-studio)
19. [Terminals](#19-terminals)
20. [App Inspector](#20-app-inspector)
21. [Costs, budgets and usage limits](#21-costs-budgets-and-usage-limits)
22. [Search, activity, audit, timeline, status, conference room](#22-search-activity-audit-timeline-status-conference-room)
23. [Settings and your profile](#23-settings-and-your-profile)
24. [Running Automa on the phone (Termux)](#24-running-automa-on-the-phone-termux)
25. [Letting agents use the phone (ADB)](#25-letting-agents-use-the-phone-adb)
26. [Security and privacy](#26-security-and-privacy)
27. [Troubleshooting](#27-troubleshooting)
28. [For developers](#28-for-developers)
29. [Release history](#29-release-history)
30. [Credits and license](#30-credits-and-license)

---

## 1. What Automa is

Automa is a control plane for a company of AI agents, delivered as an Android
app.

- **Goals first.** Every task traces back to the organization's goal, so you
  can always see why something is being done.
- **One owner per task.** Every piece of work has a page, an assignee, a
  history and a cost. Nothing happens silently.
- **You stay in charge.** Governed actions (hiring, budgets, plans, anything an
  agent gets stuck on) wait for your yes in the Inbox.
- **Every token counted.** Agent runs, chats, App Studio and code suggestions
  all land on the Costs page, by agent, by task and by month. A hard budget
  stop pauses spending before it runs away.
- **Bring any model, or none.** Use your own API keys or subscriptions, or run
  agents on the free models with nothing to sign up for.

```
Phone (Automa app, UI inside the APK) ──/api──▶ Automa server ──▶ agents (Claude, Codex, free models, …)
        │  Files, share sheet, shared folder            │
        └──────── agents ask the phone for files ◀──────┘
```

The **server** can run on your computer, on a cloud VM, or **on the phone
itself** inside the free Termux app. The **app** carries the whole board UI,
so the phone layout is the same whatever server it talks to; the server
supplies the data.

---

## 2. What's new in 1.9.4

**App Studio teams you can watch**
- Every model on a job shows as its maker's logo. The logos "boot up" one by
  one as the lead puts them to work, each with a ring for working, done or
  failed, and the tokens it has used so far.
- Teammates talk to each other in a **team chat** you can read. They agree on
  file names, element ids, APIs and ports instead of guessing. Each teammate is
  told what you asked and who else is on the job, and the lead reads the whole
  conversation along with the reports.
- Every reply shows its total tokens and each model's share.
- A new **Stats** tab lists tokens per model for the chat and everything the
  team said.
- The App Studio page and Home show **App Studio AI, last 30 days**: every
  model's tokens and cost (Free on the free models).

**Web pages**
- Ask for anything to look at (a page, a game, a chart, a dashboard, a report)
  and the AI builds it as a web page and opens it in the preview, even in a
  console project. The reply that started it has an **Open the page** button.
- Pages that save data with `localStorage` now work inside the preview (they
  used to stop with an error).
- Previewed pages without a `<head>` keep their styles, and a `<header>` is no
  longer mistaken for the head.

**The task waiting notice ("Resumes in 14s · Attempt 2")**
- An **X** closes it (the banner at the top and the strip above the reply
  box) until that wait is over.
- During a retry its button is **Retry now**, and it works (the old "Check
  now" failed there with "Issue has no scheduled monitor").
- It says honestly that replies wait for the retry.
- It refreshes itself when the wait comes due, instead of sitting on
  "Overdue" after the agent already started.

---

## 3. Install

**You need:** Android 8.0 or newer, about 100 MB of storage, and internet for
the AI features.

1. Get the APK: `releases/android/Automa-1.9.4.apk` in this repository.
2. Copy it to the phone and open it. If Android asks, allow **Install unknown
   apps** for the app you opened it with.
3. Tap **Install** (or **Update**). Every release from 1.8.2 on is signed with
   the same key, so a new version installs over the old one and keeps your
   sign-in, settings and data.
4. Coming from 1.8.1 or older? Those used a different key: uninstall Automa
   first, then install. Your board data lives on the server and is kept.
5. If your server runs on the phone in Termux, run `automa update` in Termux
   after updating the app, so the server matches the app.

---

## 4. First run

1. **Connect to a server.** The connect screen takes an address such as
   `http://192.168.1.20:3100`.
   - On a computer, start the server with `npx paperclipai onboard --bind lan`
     (same Wi-Fi) or `--bind tailnet` (Tailscale) and use the address it prints.
   - If the server refuses the phone's address:
     `npx paperclipai allowed-hostname <address>`.
   - For access from anywhere, put the server behind HTTPS.
   - The address under *Developer options → Wireless debugging* is the
     phone's own adb address, not Automa's. The screen tells you if you enter it.
2. **Or run Automa on this phone.** Tap **Run Automa on this phone** (see
   [section 24](#24-running-automa-on-the-phone-termux)).
3. **Or link a computer over ADB** (USB cable or Wireless debugging, no
   firewall rule, LAN binding or HTTPS needed): start Automa on the computer,
   turn on USB or Wireless debugging on the phone (the app's **Link a computer
   with ADB** section opens it), and run `node mobile/adb/automa-adb.mjs` on
   the computer. The computer's Automa then answers on the phone at
   `127.0.0.1:3100`, and the helper keeps the link up.
4. **Create an organization** with a name and a goal.
5. **Hire the first agent.** New agent asks for a name, role, engine and model.
   The model step offers Anthropic, OpenAI, Gemini, Grok and Cursor with an API
   key, or **Skip for now: start on the free models** (no key needed). On a
   phone, a Claude agent needs only an Anthropic API key under Settings → API
   keys.
6. **Say what you want done** in Chats. The agent plans, creates tasks, and asks
   when it needs you.
7. **Take the tour.** One card per section (what it is, why it matters), with
   Skip at every step. Run it again any time from the account sheet.

**Continue with Google** and **push notifications** work when the server has
Firebase set up.

---

## 5. Core ideas

| Term | What it means |
|---|---|
| **Organization** | One company: a goal, agents, tasks, budget and settings. One server can host several; the switcher in the sidebar moves between them and every page is scoped to the current one. |
| **Agent** | An AI employee with a role, title, manager, engine and model, system prompt, instructions, budget, skills and tools. It works on a heartbeat or when you chat with it. |
| **Engine (adapter)** | How an agent runs. See the list below. |
| **Task** | A unit of work with one assignee, a parent and sub-tasks, blockers, comments, a plan document, attachments and work products, and a status that moves through review and approval. |
| **Chat** | A conversation with one agent. Under the hood it is a task in conversation mode, so it has the same history, attachments and cost tracking. |
| **Approval** | A governed action waiting on you: a hire, a budget, a plan, anything an agent got stuck on. Agents never spend or hire without a yes. |
| **Routine** | Work that runs on a schedule, such as a daily summary or a weekly review. |
| **Project / Goal** | Projects group tasks under one goal; goals are the "why" the task tree hangs from. |
| **Connector** | An app agents can reach (GitHub, Slack, Gmail, Notion and more), with per-agent access and per-action permissions. |
| **Skill** | Something agents know how to do, installed from the catalog or written in Skill Studio. |
| **Workspace** | A checkout or sandbox where an agent's run happens; it can expose live services such as a dev server. |
| **Artifact / work product** | A file an agent produced, attached to its task and downloadable. |

**Agent engines:** Claude Code · Anthropic API (no Claude Code) · Codex ·
Cursor (local and cloud) · Gemini CLI · Grok · Hermes (local and gateway) ·
Kimi · OpenCode · OpenClaw gateway · Pi · **Free models** (no key) · metered
API engines · a REST/webhook engine for an agent you host somewhere else.
Plugins can add more.

---

## 6. Getting around the app

**On a phone**
- **Bottom tab bar:** Home, Chats, **+** (create), Tasks, Files. It stays put
  while you scroll, and primary actions sit in the thumb zone.
- **☰ sidebar:** every section, the organization switcher, and Settings. On a
  wide screen it stays open.
- **Bell:** the Inbox badge. Tapping it clears the bell and opens what needs you.
- **Account sheet** (your avatar, top right): profile, your API balance, the
  tour, dark theme, feedback, sign out, and the organization sheet.
- **+ (create):** new task, new chat, and every other create action, one tap away.

**Sidebar sections, in order:** Search, Dashboard (Home), Status, Conference
Room, Tasks, Projects, Routines, Artifacts, Files, App Studio, Terminals, App
Inspector, Cases, Pipelines, Goals, Workspaces, Agents, Skills, Connectors,
Audit, Org, Timeline, Costs, Activity, Settings. Chats and Inbox are on the tab
bar and the bell.

**How it feels**
- Destructive actions come with **Undo** instead of "are you sure?" dialogs.
- Taps, sends, limits and successes use Android's own **haptics** (they follow
  your touch-feedback setting).
- Dialogs and menus always fit the screen. The mascot floats gently; agents'
  own characters stay animated and pause while the page moves.
- **Offline sheet:** when the phone loses the network or the server stops
  answering, a sheet says so and counts down to the next try. What you typed
  is kept.
- **Picks up where you left off:** the app reopens on the page you were on,
  signed in, on the same server.
- **Launcher shortcuts** (long-press the app icon): New chat, New task, App
  Studio, Change server, Files.
- **Every screen:** edge-to-edge on Android 15 and 16, safe around camera
  cutouts and the gesture bar, keyboard-aware, portrait and landscape, phones,
  tablets, foldables and Chromebooks.

---

## 7. Home (Dashboard)

Your day on one screen.
- **What needs you** (with the Inbox count), **who is working right now**, live
  run activity, and what the month has cost.
- **Free models card:** tokens and pictures used on the free models, $0.00
  charged, and what the same work would have cost at paid prices ("saved").
  **Reset** starts the count again.
- **App Studio AI card** (new): App Studio's models over the last 30 days, each
  with its logo, tokens in and out, a share bar, and Free or its cost, with a
  link to App Studio.
- A greeting card that tells you how many things need you and where to start.

---

## 8. Chats

Talk to an agent like a teammate.

**Replies**
- Replies **stream** token by token with a caret.
- The model's **thinking** streams into its own panel while it works and folds
  away when the answer starts. You can open and close it on every model.
- **Thinking depth:** Auto, Quick, Balanced, Deep, Deeper, Max, from the top of
  the model sheet or with `/think deep`.
- Tables wider than the screen scroll sideways and show fade edges when there
  is more to see.
- Source links show the site's **favicon**.
- When a reply fails, the chat says why in plain words (a model at its daily
  limit and when it is back, a busy model) instead of an error code.
- A failed reply never blocks the chat: switch to another model, send again,
  and it answers.
- **Retry** on any reply asks the question again.
- The chat **never switches models behind your back**: the model you picked is
  the one that answers.

**The model switcher** (in the chat header)
- Every provider with its key status: Claude, GPT, Gemini, DeepSeek, Llama,
  Qwen, Kimi, Grok and more, with each maker's logo.
- A **Free** filter and a "Free models · no key needed" section
  ([section 9](#9-free-models)).
- **What this agent can do** switches for free-model agents: Web search &
  reading, Files & commands, Teammates & tasks, Connected apps.
- **Paired image model:** bond an image model to a chat model so the agent can
  draw. A small "Bonded" mark shows the two makers' logos leaning into each
  other, on the chat header's model chip and on the org chart.

**Messages**
- Copy, delete and thumbs up/down sit on the **newest reply** only. They fade
  in when you hover (computer) or tap (phone) the reply and fade out when you
  tap elsewhere.
- **Press and hold** any other message for a little shake and the same menu.
- **Attachments:** tap + under the message box for photos, screenshots, PDFs
  or any file.
- **Drafts survive:** an unsent message stays in the box when you leave and
  come back.
- **Try asking** cards for a first message; ⋯ on a chat to pin, move or delete it.

**Pictures**
- On an image model (or a chat model with a paired image model), describe a
  picture to get one.
- Attach a photo and say what to change: the model reads it and **redraws** it
  with the change (a redraw, not a pixel edit).
- Pictures load with a shimmer. Tap one, then **Download**, to save it to the
  phone. A single picture shows full size.
- **Draw again:** the small refresh button on any generated picture asks for a
  fresh take with your whole original prompt.

**Slash commands** (type `/` for suggestions)

| Command | What it does |
|---|---|
| `/plan` | Plan mode: plan first; nothing runs until you say so |
| `/ask` | Ask mode: questions and answers only, no changes |
| `/auto` | Auto mode: work and act without asking first |
| `/model` | Switch the model this agent answers with |
| `/think` | How long it thinks first: quick, balanced, deep, max (`/think deep`) |
| `/context` | The model, the mode, and how much this chat has used |
| `/stop` | Interrupt the run in progress |
| `/clear` | Start a fresh session; the history stays visible |
| `/skills` | Browse the skills your agents can use |
| `/help` | Every slash command in one place |
| `/new` | Start over: the model begins a new session |

**Ask Claude** buttons elsewhere (App Inspector, a decoded project) open a chat
with the question already typed, after anything you had already written.

Agent Chat can be switched off under Settings → Experimental; the page says so
and links there.

---

## 9. Free models

No key, no account, no card. Pick a free model in the model switcher and the
agent runs on it. Your other runtimes and API models stay exactly where they
were.

**Chat models**

| Model | Context |
|---|---|
| Moan (Jamaican, on Nemotron 3 Ultra; [section 10](#10-moan-the-jamaican-model)) | 1M |
| Nemotron 3 Ultra 550B | 1M |
| Nemotron 3 Super 120B | 262k |
| Nemotron 3 Nano Omni 30B Reasoning | 256k |
| Nemotron 3.5 Lightning | 1M |
| Nemotron 3.5 Super VL | 1M |
| Nemotron 3.5 Content Safety (no tools) | 128k |
| DeepSeek V4.1 Flash | 1M |
| Gemma 4 31B | 262k |
| Gemma 4 26B A4B | 262k |
| Qwen 3.8 27B | 256k |
| Qwen 3.8 27B Abliterated Cyber | 256k |
| Inkling | 1M |
| Inkling Small | 1M |
| Flint v1.0 | 262k |
| North Mini Code | 256k |
| Atria Dawn Preview | 256k |
| Apodex 1.1 Mini | 262k |
| LFM 2.5 2.6B | 65k |
| Xing 4.0 29B A4B | 262k |
| Ternary Bonsai 27B | 262k |
| Free Router (routes each question to an available free model) | 200k |

**Image models:** SDXL Lightning (fast; the default pairing for every free chat
model) and SDXL Base 1.0.

**Every model stays listed** and says how it is doing: ready, busy, at today's
free limit (and when it is back), or closed by its provider. Broken models are
never hidden; they fail gracefully.

**What a free agent can do** (each group has its own switch)
- **Web search & reading:** search the web across many results (paged), read
  pages, read raw JavaScript and JSON, list a page's links and scripts, crawl a
  site a few hops deep, and download files into the workspace. Every step shows
  the site's favicon. The web tools never reach private or local addresses.
- **Files & commands:** read, write, edit, search (Grep, Glob) and run
  commands (Bash) in its workspace.
- **Office files:** make real **Excel spreadsheets** (with formulas),
  **PowerPoint decks** (with tables, charts, notes and drawn pictures) and
  **Word documents** (from Markdown), attached to the reply and kept in the
  workspace; and **read** spreadsheets, documents, decks, PDFs and CSVs you
  attach or point it at, so it can rework or recreate them. Oversized
  documents are refused instead of choking the agent.
- **Pictures:** draw with its paired image model when asked.
- **Teammates & tasks:** message other agents, hand off work, create and
  update tasks, and write plans through the Automa API.
- **Connected apps:** find and request the apps it needs from Connectors.

**It knows who it is.** A free agent is told its role and title, its teammates
(so it can message them and hand off tasks), your profile name, and that
Automa was made in Jamaica by Nathan Lyttle (Corx Labs).

**It keeps going.** It rides out a busy provider by retrying on the same model,
survives dropped connections, keeps its tools when a provider has an error,
runs only the tools you switched on, carries out tool calls a model writes as
plain text, and cuts short the same tool call repeated over and over.

**Counting:** the free-usage card counts tokens and pictures at $0.00 and shows
what they would have cost at paid prices. Usage limits on the Costs page show
the free models' monthly allowance and each model's daily limit with a
countdown ([section 21](#21-costs-budgets-and-usage-limits)).

**Switching:** an agent on an API key can switch to the free models from the
model switcher, and back.

---

## 10. Moan, the Jamaican model

Moan (`moan/moan-1:free`) is Automa's own free model: Nemotron 3 Ultra under a
Jamaican persona.

- **Patois first.** It talks Jamaican Patois by default and switches to
  Standard Jamaican English for formal, legal and submitted documents, and
  inside code.
- **A Jamaica primer:** the island's history, government, courts and statutes,
  economy, culture and language.
- **A living knowledge index.** While Moan is in use, Automa keeps reading
  Jamaican sources (the Gleaner, the Observer, JIS, the Office of the Prime
  Minister, Parliament, the Bank of Jamaica, the Laws of Jamaica and reference
  pages) into a local, searchable index. Every Moan reply gets the passages that
  match the question plus the newest news, with source, date and link, so its
  answers cite what is current.
- **Jamaica knowledge card:** in the model switcher, when an agent runs on Moan,
  with the index size, when it last refreshed, and a **Refresh** button.
- **Bounded on a phone:** news older than a year is dropped after each
  refresh, and past 80,000 entries the oldest news goes first.
- **Everywhere:** pick Moan first among the free models in chat, in App Studio,
  or in the Terminals free chat.
- The index holds only public pages, never company or user data.

---

## 11. The Que engine

Every free-model call (chat, App Studio, pictures) takes its turn in the Que
engine, so many questions at once all get answered instead of some failing.

- **Up to 10 calls at once**, and at most **2 at a time on any one model**
  (providers refuse bigger bursts to one model). The rest wait in order.
- **App-ID pool:** requests are spread across an auto-growing pool of 200+ app
  IDs, each resting 11 seconds after a rate limit; the pool grows by 50 on each
  burst of rate limits.
- **Retries** on busy answers, a **5-minute answer cache**, **conversations**,
  and **batches** of up to 20 questions.
- **Fair use:** 30 questions a minute per person, to protect the shared allowance.
- A status line under the free models in the model switcher shows the engine.

For developers, the same engine is an API (organization-scoped):
`POST /api/companies/:id/que/chat`, `POST …/que/batch`,
`GET|DELETE …/que/conversations`, `GET|POST|DELETE …/que/conversations/:id`, and
`GET …/que/stats` (queue, cache hits, live app-ID pool).

---

## 12. Tasks

Everything the agents are doing, each one a thread you can read, steer and
approve.

- **One assignee** (an agent or a person), a parent and sub-tasks, blockers,
  comments with @mentions, a **plan document**, attachments and **work
  products**, labels, priority, and a status: backlog, to do, in progress, in
  review, blocked, done, cancelled.
- **Filters** by status, assignee and project; **My tasks** and **What needs
  me** narrow the list to you.
- **Task detail:** the live run transcript (with the agent's thinking and
  tools), costs, and the full history.
- **Questions:** an agent can ask you a question with options right in the task
  (for example "What would you like to do?"); pick one and it carries on.
- **Held replies:** a reply that is waiting on a limit or a retry shows where
  the message belongs, with a **Retry** button.
- **The waiting notice:** when an agent is waiting on a monitor or a scheduled
  retry, a banner and a strip above the reply box count down ("Resumes in 14s ·
  Attempt 2").
  - **Check now** (monitor) or **Retry now** (retry) starts it early.
  - **X** closes the notice until that wait is over.
  - During a monitor, sending a reply wakes the agent at once; during a retry,
    replies wait for the retry, and the notice says which.
- **New files show up as they land:** when an agent produces a file, its panel
  opens; in a chat on a phone, the picture shows or the file is linked in the
  conversation instead.

---

## 13. Inbox and approvals

Decisions waiting on you: hires, budgets, plans, join requests, and anything an
agent got stuck on. Approve, decline or reassign from the phone. Agents never
spend or hire without your yes; this is where you give it. The bell shows the
count and clears when tapped.

---

## 14. Agents and the org chart

**Agents**
- Each agent has a role and title, an engine and model (with the maker's logo),
  a system prompt and instruction bundle, a budget, skills, tools and a manager.
- **Agent detail** shows live runs, logs, progress, its instructions and its
  tools tab.
- **Pause, change or offboard** an agent any time. Agents awaiting approval or
  offboarded are shown but can't be chatted with.
- **New agent** is a short wizard. The **Teams catalog** installs a whole team
  (a CEO with executives and engineers) in one go.
- **Claude on a phone:** Claude Code's desktop engine can't run in Termux, so on
  a phone a Claude agent answers through the Anthropic API with the agent's
  key, with Claude Code's own tools (Read, Write, Edit, Bash, Grep, Glob)
  running in Termux, plus the `termux-*` commands when Termux:API is installed.
  The same happens when an agent's engine is set to "Anthropic API (no Claude
  Code)" or when Claude Code can't start on a machine. Codex agents can't run
  on a phone and say so.

**Org chart**
- Who reports to whom, built for phones, with **drag-to-connect** reporting
  lines.
- Agents show their maker's logo, and a bonded pair of models shows both logos.
- The **organization sheet** edits the name, goal and budget.

---

## 15. Projects, goals, routines, pipelines, cases and workspaces

- **Projects** group tasks under one goal and keep their own workspace. Add a
  project from a phone too.
- **Goals** are the top of the task tree.
- **Routines** run work on a schedule; each run is a task you can read.
- **Pipelines** chain stages of work with their own settings.
- **Cases** collect related work into one file.
- **Workspaces** (project and execution) show where an agent's run happens, its
  setup status, live service ports (a preview or dev server), and a summary of
  activity and follow-ups.

---

## 16. Artifacts and Files

**Artifacts:** every file the agents produced, grouped by task, with a viewer
for text, images and code. Downloads go to `Downloads/Automa`.

**Files (device files):** share one folder on the phone with your agents.
- With **auto-send** on, a file an agent asks for from that folder is sent
  without asking; otherwise the request waits on the Files page for you to pick
  a file or decline.
- Agents can send files back to the phone.
- **Share to Automa** from any app's share sheet; the file waits on the Files
  page until you confirm.
- Requests meant for another device are marked as such.

---

## 17. Skills and connectors

- **Skills** are what agents know how to do. Install them from the catalog or
  build one in **Skill Studio**. A new skill is available from the agent's next run.
- **Connectors** are the apps agents can reach: GitHub, Slack, Gmail, Notion and
  more. Choose which agents get access, which accounts they use, and which
  actions they may take. Connecting an app stays inside Automa.

---

## 18. App Studio

Build, run and share apps from your phone with an AI pair, or a whole AI team,
that writes the code and fixes what breaks. Full screen on a phone. No key
needed: the free models work in the AI panel and for the editor's suggestions.

### Starting an app
- **69 languages in 11 groups:** Popular, Web & full stack, Servers & APIs,
  Mobile, Systems, JVM & .NET, Scripting & shells, Functional, Data & science,
  Classic, and Just for fun. Quick starts include a website (HTML, CSS and JS),
  Python, a full-stack app (Node.js and SQLite), React, Flask, JavaScript, Go,
  Rust, a mobile app (PWA) and TypeScript.
- **Describe your app** in plain words and the assistant builds it from the
  first message.
- **Clone from GitHub:** paste a repository link, then ask the assistant to set
  it up or fix it.
- **Join someone's project** with their invite link or join code.
- The App Studio page lists your apps (running, public link, shared, GitHub),
  with rename, **download as zip**, and delete (with Undo). The top of the page
  counts apps, running apps, shared apps and AI tokens over 30 days, above the
  **App Studio AI** card.

### The workspace
On a phone each part is a tab: **Files, Code, Console, Preview, AI, Stats,
Team**. On a wider screen the files, editor and a side panel sit together.
- **Files:** the project tree with each file's kind, size and age, plus an
  Assets view. Upload files.
- **Code:** an editor with **AI code suggestions** as you type (on the free
  models or your key). Edits save on their own, and everyone in the project sees
  them as they are typed.
- **Console:** what the app prints, live, and a line to type into it.
- **Preview:** the running app inside Automa, sandboxed so it can't act as you.
  A moving bar and the newest console line show while it installs and starts.
  **One tap opens a public link** (a Cloudflare tunnel to the app's own port, one
  at a time) that anyone can open.
- **Run / Stop** in the header. Missing toolchains install on this device with
  progress. Each project can have its own run command.

### The AI assistant
- **Providers:** Free models (no key), Anthropic (Claude), OpenAI (GPT),
  OpenRouter (any model, with a searchable catalog), Google (Gemini), Kimi
  (Moonshot), DeepSeek, xAI (Grok), Groq, Mistral, and any OpenAI-compatible
  endpoint. One sheet picks the provider (with its key status) and the model.
  Keys are encrypted on your server; the organization's key is used when none
  is saved in Studio.
- **Thinking depth** per model.
- **What it does on its own:** reads and searches the files, writes and edits
  code, deletes what is no longer needed, runs commands and tests, starts and
  stops the app, reads the console, searches the web and reads pages, and keeps
  going until the job is done (no step cap). It always finishes with a short
  reply.
- **Context:** it sees the project's state on every message, remembers the
  conversation even when you switch providers, and takes images and text files
  with your message.
- **Web pages:** ask for something to look at and it builds a web page and opens
  it in the preview (in a console project it serves the page itself). **Open
  the page** on the reply jumps to the Preview.
- **Live progress:** what it is doing right now, steps done and time elapsed,
  its thinking (tap to read), each step, and a token and cost line.

### AI teams
Pick teammates in the model sheet (any providers you have keys for, or the free
models) and the lead model can hand them work.
- **run_team:** several teammates work at the same time, each with a role
  ("backend: the API in server.py") and the files it owns. The lead waits for
  all of them, reviews their changes, runs the app and fixes what doesn't fit.
- **ask_teammate:** one quick task for one teammate.
- **Team chat:** teammates message each other, one teammate, or the lead while
  they work, and get the replies with their next step. You read it all in the
  **Team chat** tab: the lead's tasks, their talk, and their reports.
- **Logos that boot up:** every model on the job, with a working, done or failed
  ring and its live token count. The **Work** tab has each teammate's card
  (role, status, steps, tokens, task, its own steps and report).
- **Stats tab:** tokens per model for the whole chat, and everything each team
  said.
- Each teammate knows what you asked and who else is working. Up to six
  assignments per run, and teammates never nest.

### Undo and safety
- **Undo any change** the assistant made, step by step, with **Undo** beside the
  step.
- **Checkpoints:** saved before every AI message, before accepting a change,
  before going back, and whenever you save one. Going back to a checkpoint
  never deletes files.
- **Stop** is instant. Failed code suggestions pause for a while instead of
  retrying after every keystroke.
- Nothing is ever written outside the project folder.

### Working with friends
- **Invite people** with a join code or an invite link (public, or on this
  network), working for 1 hour, 1 day, 7 days, 30 days, or with no limit.
  **New code** stops the old one; **Revoke all** ends sharing and removes everyone.
- Guests see your code as you type, see who is here and which file they are
  in, **chat** and send files, and **suggest changes** you review as a diff,
  edit before accepting, then accept or deny. Guests can't save files or reach
  the rest of Automa.

### Costs
App Studio has its own row on the Costs page, stops at the organization's
budget like agents do, and shows its 30-day per-model usage on the Studio page
and Home.

---

## 19. Terminals

A real coding terminal on the device: **Claude Code, Codex, Gemini CLI,
OpenCode** and others in their full terminal UI, over a PTY relay, on a
proot-distro Debian layer the page sets up for you.
- Wire a terminal to an agent so it works with that agent's key, and **pick a
  model per tool**.
- A **Free models chat** with nothing to install.
- Terminals run where Automa runs (on the phone when Automa runs in Termux). If
  the server is older than the app, the page offers the update.

---

## 20. App Inspector

Pick an app on your phone to decode its manifest, resources and code, read the
code as Java, ask Claude to explain any file, edit, and rebuild a signed APK to
your Downloads. For apps you made or are allowed to analyze.

- **App picker:** the apps installed on the phone with names and icons, plus an
  **APK** button to upload any `.apk`.
- **App sheet:** Open (decompile), **Ask Claude about this app**, copy the
  package name, and the APK itself.
- **Decode options:** resources (apktool), smali, Java (jadx). Decoding runs
  apktool and jadx in parallel on every core.
- **Project explorer:** a Files view (AndroidManifest.xml, res/, smali/) and a
  Java view, search across the project, an app info panel (package, version,
  SDKs, launcher activity, permissions, components), the decode log, and an
  editor for text files.
- **Explain** a file with Claude. **Ask Claude** opens a chat that already knows
  where the project lives and how to launch, screenshot and drive the app over
  adb once `automa adb link` has been run.
- **Rebuild:** apktool rebuild, zipalign and apksigner with an inspector key,
  saved to `Downloads/Automa`.
- apktool and jadx must be installed where Automa runs; the Termux installer
  adds them.

---

## 21. Costs, budgets and usage limits

- **Every token counted:** agent runs, chats, App Studio replies and code
  suggestions land on Costs **by agent, by task and by month**, with refunds and
  offsets. App Studio has its own row.
- Refused, stopped and cut-off replies still count the tokens they used. Runs
  through Bedrock, Vertex, Foundry or a gateway count as paid usage.
- **Budgets:** the organization and each agent have one; a **hard stop pauses**
  spending at the limit. App Studio stops at the organization's budget too.
- **Usage limits card:** how much of the free models' monthly allowance is used
  and when it renews, each free model at its daily limit with a countdown to
  when it is back, and Claude's session and weekly limits when Claude Code is
  signed in.
- **Free models saved:** the same savings card as Home, with Reset.

---

## 22. Search, activity, audit, timeline, status, conference room

- **Search** across tasks, agents, projects, chats and artifacts.
- **Activity** and **Audit:** the log of everything that happened, who did it
  and when. **Timeline** is the same, scrollable.
- **Status:** the server's health page.
- **Conference Room:** a shared channel between you and the agents.

---

## 23. Settings and your profile

**Organization settings:** General (name, goal, budget, archive), Profile,
Members and Access (invites, roles, join requests), **API keys** (add, copy,
set default and remove the keys agents, chats and App Studio run on), Secrets,
Adapters (which engines are on, model overrides), Environments, Plugins,
Experimental (Agent Chat and other switches), and Export and Import (move an
organization between servers).

**Instance settings** (for the whole server): general options, access, and
experimental features.

**Profile and API balance** (account sheet): how much is **left on your keys**,
what you **spent this month**, and a **monthly spending limit**. Add a key once
and agents, chats and App Studio all use it; set a limit and nothing
overspends. A run that fails before its model session says so and links here.

---

## 24. Running Automa on the phone (Termux)

**Install**
1. Install **Termux** from F-Droid.
2. In Automa, tap **Run Automa on this phone → Send to Termux**, and paste the
   command Termux is given.
3. The installer sets up Node.js and PostgreSQL, the server, apktool and jadx,
   and an `automa` command, then starts Automa on `127.0.0.1:3100`, locked to
   the app. The first install downloads about 380 packages (10 to 45 minutes);
   updates are much faster. The connect screen shows each step with a progress
   bar and opens the board when the server answers.
4. Set Termux's battery use to **Unrestricted**. With **Termux:Boot**, Automa
   starts when the phone boots.

**The `automa` command**

| Command | What it does |
|---|---|
| `automa run` | Run in the foreground, restarting the server if it stops |
| `automa start` | Run in the background (log in `~/.automa/server.log`) |
| `automa stop` / `automa status` | Stop it / check it |
| `automa update` | Update the server (backs up the database first) |
| `automa backup` | Save a database backup now |
| `automa restore` | List backups and put the newest back (or `automa restore FILE`), keeping a copy of what it replaced |
| `automa link` | Print the app key again |
| `automa adb link` | Let agents drive the phone over adb ([section 25](#25-letting-agents-use-the-phone-adb)) |

**How it behaves**
- **The app starts it for you:** when Automa on the phone doesn't answer, the
  app starts it through Termux's RUN_COMMAND (Android asks once).
- **Locked to the app:** every app on a phone can reach `127.0.0.1`, so Automa
  answers only the Automa app, using a key the installer makes. A browser on the
  phone sees a notice instead of the board.
- **Works offline** with its own server when the internet drops (the AI
  features need internet).
- **Updating is safe:** a new APK doesn't update the server. When a page needs a
  newer server it shows **Update Automa on this phone**. The new server is built
  next to the running one and takes over only when complete; a stalled download
  is retried, and if it still fails nothing changes and Automa keeps running
  the version you had.
- **Backups:** a complete copy of the database every hour while Automa runs
  (in `~/.paperclip/instances/default/data/backups/`) and one before every
  update. A backup that fails says so.
- **Your data is never re-created:** if Termux upgraded PostgreSQL to a new
  major version, the installer stops and says how to move the old files aside
  and restore a backup. Restore never loses the database.
- Every Termux install survives Android clearing apt's download cache.

---

## 25. Letting agents use the phone (ADB)

Turn on *Developer options → Wireless debugging* and run `automa adb link` in
Termux (the wireless ADB wizard walks you through pairing). Agents then have the
phone's shell: `adb shell input` to tap and type, `screencap` for screenshots,
`pm` and `settings`, and `logcat`. App Inspector's Ask Claude prompt tells the
agent exactly these commands.

---

## 26. Security and privacy

**The app**
- Only your configured server and the bundled connect screen load in the app;
  other links open in the browser.
- Every native bridge method needs a page key the app gives only to its own
  pages, and checks the calling origin. File bytes never cross the bridge: the
  app serves them on tokenized URLs.
- Release builds are obfuscated (R8 full mode); signing keys, Firebase config
  and `keystore.properties` are never shipped or committed.

**The server**
- On the phone, the server asks for the app key on every request (an HttpOnly
  cookie), the database asks for a password even from loopback, and the app
  seals the key with the Android Keystore.
- Every organization's data is kept separate; agent keys are stored hashed and
  can't reach another organization.
- Keys you save in App Studio are encrypted on your server; Studio shows only
  their last four characters.
- The free models' access token lives only on the server, never in the app's
  web pages.

**Agents and App Studio**
- Free agents' web tools never reach private or local network addresses.
- App Studio previews run in a sandbox with no access to Automa or your
  sign-in; App Studio never writes outside the project folder.
- Governed actions wait for your approval, and budgets stop spending.

**Privacy:** your organizations, tasks, chats and files live on your own Automa
server (your computer, a VM, or your phone). The app talks to the server you
connect it to, and to Google only for Continue with Google and push
notifications when those are set up. Free-model requests go from your server to
the free AI service Automa uses. Moan's knowledge index holds only public
Jamaican web pages.

The full threat model is in `doc/AUTOMA-SECURITY.md`.

---

## 27. Troubleshooting

| You see | What it means | Do this |
|---|---|---|
| **Update Automa on this phone** on Terminals or App Inspector | The phone's server is older than the page. | Tap it, Send to Termux, paste the command (or `automa update`). |
| "App not installed" / "conflicts with an existing package" | The installed Automa was signed with a different key (1.8.1 or older). | Uninstall Automa, then install. Board data lives in Termux and is kept. |
| Termux "RunCommandService requires allow-external-apps" | Termux hasn't let the app run commands yet. | Use the app's one-tap fix, or run the installer again. |
| The connect screen keeps counting down | The server isn't up yet, or the address is wrong. | `automa status` in Termux, or check the address (not the Wireless debugging one). |
| "Automa needs Node.js 24 or newer" in Termux | Termux packages are old. | `pkg upgrade -y`, then run the install command again. |
| The board is empty after an update (onboarding again, chats gone) | The server isn't reading its old database (for example a PostgreSQL major upgrade); nothing was deleted. | `automa restore`. The message "Your Automa database was written by PostgreSQL N" gives the exact steps. |
| "Connect a model" with no key | A first agent needs a model. | **Skip for now: start on the free models**; add a key later in Settings. |
| Chat says Agent Chat is turned off | The experimental switch is off. | Settings → Experimental → Agent Chat. |
| A free model says it is at its daily limit | That model used today's free allowance. | Pick another free model; the list says when this one is back. |
| "Resumes in …" notice on a task | The agent is waiting for a retry or a monitor. | Wait, tap **Retry now** / **Check now**, or tap **X** to hide it. |
| A page saved in the App Studio preview forgets its data after a reload | The preview's sandbox keeps page storage in memory. | Open the app's public link for lasting storage, or ask the assistant to save data on the server. |
| "Organization not found" on device pages | Fixed in 1.8.1. | Update the app. |

---

## 28. For developers

**Run it locally**
```sh
pnpm install
pnpm dev            # API and board on http://localhost:3100, embedded database
```

**Check your work**
```sh
pnpm -r typecheck
pnpm test:run
pnpm build
pnpm check:token-gates   # UI design-token rules
```

**Build the Android app**
Needs JDK 17+, the Android SDK (platform 36, build-tools 36), Node and pnpm.
```sh
pnpm mobile:bundle-ui        # board UI → mobile/android/app/src/main/assets/ui
pnpm mobile:bundle-server    # server → assets/server/automa-server.tar.xz
cd mobile/android
echo "sdk.dir=$ANDROID_HOME" > local.properties
./gradlew assembleRelease    # needs keystore.properties (git-ignored)
```

**Release checklist:** bump `automa.versionCode` and `automa.versionName` in
`mobile/android/gradle.properties`, add the note to
`ui/src/lib/release-history.ts` (shown in the app) and to `AUTOMA.md`, build,
check the version and signature, and put the APK in `releases/android/`. Keep
the upload keystore safe: an APK signed with another key can't update the
installed app.

**What the APK carries:** the Kotlin shell (`MainActivity`, the `AutomaNative`
bridge, shared folder, incoming shares, downloads, server config, the bundled
UI, Google sign-in, push), the connect screen, the board UI, and the server
bundle Termux installs.

**Where things live**

| Path | What |
|---|---|
| `mobile/android/` | The Kotlin app |
| `mobile/termux/` | The on-phone installer, the `automa` command, the adb link wizard |
| `mobile/store/` | Store listing, privacy policy, terms, graphics |
| `server/` | The API server and agent orchestration |
| `ui/` | The board UI (React) |
| `packages/shared/` | Shared types, the free-model engine, the Que engine, Moan |
| `packages/db/` | Database schema and migrations |
| `packages/adapters/` | Agent engines |
| `server/src/adapters/free-models/` | Free-model agents: tools, web, office files, quotas |
| `server/src/services/moan/` | Moan's knowledge index |
| `server/src/services/studio/` | App Studio: assistant, teams, runner, preview, usage |
| `ui/src/pages/Studio*.tsx`, `ui/src/components/studio/` | App Studio screens |
| `ui/src/pages/AppInspector.tsx`, `server/src/services/app-inspector/` | App Inspector |
| `ui/src/pages/Terminals.tsx`, `server/src/services/terminals/` | Terminals |
| `ui/src/pages/DeviceFiles.tsx` | Files |
| `ui/src/lib/automa-native.ts` | The native bridge contract |
| `releases/android/` | The current signed APK |

More detail: `AUTOMA.md` (the complete guide), `mobile/README.md` (building,
Termux, Firebase), `doc/moan.md`, `doc/AUTOMA-SECURITY.md`.

---

## 29. Release history

| Version | Date | Highlights |
|---|---|---|
| 1.9.4 | 2026-10-30 | App Studio teams you can watch (booting logos with live tokens, a readable team chat, per-model shares, a Stats tab, 30-day per-model usage on the Studio page and Home); web pages built and opened in the preview, with `localStorage` working there; the task waiting notice gets an X, a working Retry now, honest wording and a self-refresh. |
| 1.9.3 | 2026-10-30 | An auto-growing pool of 200+ app IDs spreads free-model requests so many people asking at once all get answered; tables show fade edges; held-reply Retry placed where it belongs; recovery notices say Automa. |
| 1.9.2 | 2026-10-29 | Safe server updates on the phone: built next to the running server, switched over only when complete, and a failed update changes nothing. |
| 1.9.1 | 2026-10-28 | Usage limits on Costs; chat says why a reply failed; Draw again keeps the whole prompt; API-key agents can switch to free models; works offline with its own server; tougher free agents; Que limited to 30 questions a minute per person; safer App Studio; Moan updated and bounded; honest backups and safe restore; every AI knows Automa was made in Jamaica by Nathan Lyttle (Corx Labs). |
| 1.9.0 | 2026-10-28 | The Que engine under every free-model call; failed replies no longer block the chat; every free model kept with its status; Ternary Bonsai 27B and the Free Router; App Studio with no key, undo per step, web search, no step cap and parallel teammates with roles; the newest paid models; Termux installs survive apt's cache being cleared. |
| 1.8.8 | 2026-10-27 | Moan, the Jamaican model, with its self-refreshing index; free agents make and read spreadsheets, decks and documents; favicons on crawl and download steps. |
| 1.8.7 | 2026-10-27 | Free agents keep their model and recover in place; instant taps; Retry on replies; raw JS and JSON reading, crawling and downloads; App Studio free provider, OpenRouter catalog, model teams and memory across providers; a model per terminal tool and a free terminal chat; maker logos on agents; installer repairs; parallel decoding. |
| 1.8.6 | 2026-10-26 | Free chat agents paired with SDXL Lightning and drawing when asked; the model switcher scrolls to the end on phones. |
| 1.8.5 | 2026-10-26 | Skip for now hires the first agent on the free models; Anthropic and Cursor tiles; a backup before every server update, `automa backup` / `automa restore`, and a PostgreSQL version guard. |
| 1.8.4 | 2026-10-26 | Free models in chat (streaming, thinking, web, files, teammates, tasks, connected apps, paired image models); favicons on source links; collapsible thinking; message actions on the newest reply; savings on Home and Costs. |
| 1.8.3 | 2026-10-26 | Server updates take effect at once; Ask Claude waits for sign-in and keeps your draft. |
| 1.8.2 | 2026-10-26 | Outdated-server panel on Terminals and App Inspector; Ask Claude from any app; `automa update`. |
| 1.8.1 | 2026-10-24 | "Organization not found" fixed on device pages; one-tap fix when Termux blocks Automa. |
| 1.8.0 | 2026-10-24 | Terminals; App Inspector; your API balance in your profile. |
| 1.7.0 | 2026-10-24 | API agents with Claude Code's tools on phones, thinking modes, more models, start-up progress, balances and a spending limit. |
| 1.6.x | 2026-10-22 | Live replies with visible thinking, token and cost counts everywhere, a faster Studio. |
| 1.5.0 | 2026-10-21 | Slash commands, app shortcuts, the offline sheet, and resuming where you were. |
| 1.4.x | 2026-10-10 | App Studio; the app locked to its own Automa on the phone; the wireless ADB wizard; full-screen Studio; one API keys page; the tour. |
| 1.3.0 | 2026-09-29 | Profile and organization sheet, drag-to-connect org chart, run Automa on the phone. |
| 1.2.0 | 2026-09-28 | The org chart on phones and one model switch in chat. |
| 1.1.0 | 2026-09-28 | Continue with Google and push notifications. |
| 1.0.0 | 2026-09-27 | The first Automa for Android. |

---

## 30. Credits and license

Automa is made in Jamaica by **Nathan Lyttle (Corx Labs)**. It builds on an
MIT-licensed open-source control plane for AI agents; see `LICENSE`.
