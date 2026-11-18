# Automa — the complete guide

Made in Jamaica by Nathan Lyttle (Corx Labs).

Automa is a control plane for a company run by AI agents, delivered as an
Android app. You create an organization with a goal, hire agents (Claude,
Codex, Gemini, Kimi and others) into an org chart, give them work in plain
words, and watch them plan it, do it, and check in when they need you. Every
task traces back to the organization's goal, governed actions wait for your
approval, every token is counted against a budget, and a hard stop pauses
spending before it runs away.

This guide covers every screen and feature. `AUTOMA-README.md` is the
one-page overview of everything Automa does, and `mobile/README.md` is the
operational companion: building, Termux, Firebase, the threat model.

```
Phone (Automa app, UI inside the APK) ──/api──▶ Automa server ──▶ agents (Claude, Codex, …)
        │  Files, share sheet, shared folder            │
        └──────── agents ask the phone for files ◀──────┘
```

The server can run on your computer, on a cloud VM, or **on the phone itself**
inside the free Termux app. The app bundles the whole board UI, so the phone
layout is the same whatever server it talks to; the server supplies the data.

---

## 1. Concepts

| Term | Meaning |
|---|---|
| **Organization** | One company: a goal, agents, tasks, budget, settings. One server can host several. The sidebar's organization switcher moves between them; every page is scoped to the current one. |
| **Agent** | An employee. Has a role, a title, a manager, a model and adapter, a system prompt, a budget, and skills. Runs on a heartbeat or when you chat with it. |
| **Adapter** | How an agent runs: Claude Code, Codex, Gemini CLI, Grok, Hermes, Kimi, OpenCode, Pi, a metered API adapter, or a REST/webhook adapter for an agent you host elsewhere. Plugins can add more. |
| **Task** (issue) | A unit of work with one assignee, a parent, sub-tasks, blockers, comments, a plan document, attachments and work products, and a status that moves through review and approval. |
| **Chat** | A conversation with one agent. Technically a task in conversation mode, so it has the same history, attachments and cost tracking. |
| **Approval** | A governed action waiting on you: hiring, budgets, plans, anything an agent got stuck on. Agents never spend or hire without a yes. |
| **Routine** | Work that runs on a schedule (a daily summary, a weekly review). |
| **Project / Goal** | Projects group tasks under one goal; goals are the "why" the task tree hangs from. |
| **Connector** | An app agents can reach (GitHub, Slack, Gmail, Notion, …), with per-agent access and per-action permissions. |
| **Skill** | Something agents know how to do, installed from the catalog or written in Skill Studio. |
| **Workspace** | A checkout or sandbox where an agent's run happens; execution workspaces can expose live services such as a dev server. |
| **Artifact / work product** | A file an agent produced, attached to a task and downloadable from Artifacts. |

---

## 2. Getting started

1. **Install the APK** (`releases/android/Automa-<version>.apk`). Allow "install
   unknown apps" if asked. Automa's package is `com.corxlabs.automa`; every
   release from 1.8.2 on is signed with the same upload key, so newer builds
   install over older ones and keep your sign-in and settings.
2. **Connect to a server.** The connect screen takes an address such as
   `http://192.168.1.20:3100` (start the server with
   `npx paperclipai onboard --bind lan`) or an HTTPS address for access from
   anywhere. The address under *Developer options → Wireless debugging* is the
   phone's own adb address, not Automa's; the screen says so if you enter it.
3. **Or run Automa on this phone.** Install Termux from F-Droid, tap **Run
   Automa on this phone → Send to Termux**, and paste the command Termux is
   given. It installs Node.js and PostgreSQL, the server, and an `automa`
   command, then starts Automa on `127.0.0.1:3100` locked to the app. The
   first install downloads about 380 packages (10 to 45 minutes); updates are
   much faster. The connect screen shows each step and opens the board when
   the server answers.
4. **Create an organization** with a name and a goal, then **hire the first
   agent** (New agent asks for a name, role, adapter and model). On a phone a
   Claude agent needs only an Anthropic API key under Settings → API keys.
5. **Say what you want done** in Chats. The agent plans, creates tasks, and
   asks when it needs you. The two-minute **tour** (one card per section,
   skippable, repeatable from the account sheet) walks through everything
   below.

---

## 3. The interface

### Phone layout

- **Bottom tab bar**: Home, Chats, **+** (create), Tasks, Files. The bar stays
  put while you scroll; primary actions sit in the thumb zone.
- **☰ sidebar**: every section (below), the organization switcher, and
  Settings. On a wide screen it stays open; on a phone it slides in.
- **Bell**: the inbox badge. Tapping it clears the bell and opens what needs
  you.
- **Account sheet** (avatar, top right): profile, your API balance, the
  feature tour, dark theme, feedback, sign out, and the organization sheet.
- **+ (create)**: new task, new chat, and the other create actions, always one
  tap away.
- **Feel**: destructive actions have Undo; taps, sends, limits and successes
  use Android's own haptics; dialogs and menus always fit the screen; the
  mascot floats gently (agents' own characters stay animated and pause while
  the page moves).
- **Offline**: when the phone loses the network or the server stops answering,
  a sheet over the page says so and counts down to the next try. What you
  typed is kept.
- **Picks up where you left off**: the app reopens on the page you were on,
  signed in, with the same server.
- **Launcher shortcuts** (long-press the icon): New chat, New task, App
  Studio, Change server, Files.
- **Screens**: edge-to-edge on Android 15/16, safe around cutouts and the
  gesture bar, keyboard-aware, portrait and landscape, phones, tablets,
  foldables and Chromebooks.

### Sidebar sections

In the order they appear: Search, Dashboard (Home), Status, Conference Room,
Tasks, Projects, Routines, Artifacts, Files, App Studio, Terminals, App
Inspector, Cases, Pipelines, Goals, Workspaces, Agents, Skills, Connectors,
Audit, Org, Timeline, Costs, Activity, Settings. Chats and Inbox are reached
from the tab bar and the bell.

---

## 4. Screens, one by one

### Home (Dashboard)
Your day at a glance: what needs you, who is working right now, and what it
has cost this month, with live run activity. Open the app, read one screen,
and know whether anything is waiting on you.

### Chats
Talk to an agent like a teammate.

- **Streaming replies** appear token by token with a caret. The model's
  **thinking** shows in its own panel while it works and folds away when the
  answer starts.
- **Model switcher** in the chat header: Claude, GPT, Gemini, DeepSeek, Llama,
  Qwen and more, with each provider's key status. **Thinking depth**: Auto,
  Quick, Balanced, Deep, Deeper, Max (also `/think deep`).
- **Free models**: the model switcher has a **Free** filter and a "Free models
  · no key needed" section, each row tagged **Free**: 19 chat models (DeepSeek
  V4.1 Flash, Nemotron 3 Ultra 550B, Gemma 4, Qwen 3.8, North Mini Code and
  more) and two image models (SDXL Lightning, SDXL Base). Picking one switches
  the agent to Free models; no key or account is needed. Your other runtimes
  and API models (Claude, Gemini, GPT and the rest) stay exactly where they
  were. A free chat model streams its reply and works like an agent: **What
  this agent can do** in the switcher turns on Web search & reading, Files &
  commands, Teammates & tasks (message agents, create and update tasks, write
  plans) and Connected apps, and **Paired image model** bonds an image model so
  the agent can draw in its replies; a small "Bonded" mark shows the two
  makers' logos leaning into each other. Thinking depth (Quick, Balanced,
  Deep, Deeper) makes it think harder; the thinking streams into the
  collapsible reasoning panel, which you can open and close on every model.
  On an image model, describe a picture to get one, or attach a photo and say
  what to change; the model reads it and redraws it with the change (a redraw,
  not a pixel edit). Pictures load with a shimmer; tap one, then Download, to
  save it to the phone. Source links in replies show the site's favicon. The
  card at the top of the section counts the tokens and pictures used ($0.00
  charged), shows what the same work would have cost at paid prices, and
  **Reset** starts the count again; Home and Costs show the same as "saved".
- **Message actions**: copy, delete and thumbs up/down belong to the newest
  reply only, and even there they stay out of the way: they fade in when you
  hover the reply (on a computer) or tap it (on the phone), and fade out when
  you tap anywhere else. Press and hold any other message (yours or the
  agent's) for a little shake and the same menu; tap elsewhere to close it.
- **Draw again**: every picture an agent drew has a small refresh button in
  its corner; tap it to ask for the same picture again and get a fresh take.
- **The agent knows who it is**: a free-model agent is told its role and
  title, its teammates (so it can message them and hand off tasks through
  the Automa API), and your profile name, so it can address you properly.
  The bonded pair's logos also show on the chat header's model chip and on
  the org chart.
- **Attachments**: tap + under the message box for photos, screenshots, PDFs
  or any file. The picker offers every type the page accepts.
- **Slash commands**: type `/` for `/plan`, `/ask`, `/auto`, `/model`,
  `/think`, `/context`, `/stop`, `/clear`, `/skills`, `/help` and `/new`,
  with suggestions as you type.
- **Try asking** cards for a first message, and ⋯ on a chat to pin, move or
  delete it.
- **Drafts survive**: an unsent message stays in the composer when you leave
  and come back.
- **Ask Claude** entry points elsewhere in the app (App Inspector, a decoded
  project) open a chat with the question already typed, after anything you
  had already typed there.
- Agent Chat can be turned off under Settings → Experimental; the page says
  so and links there.

### Tasks
Everything the agents are doing, each one a thread you can read, steer and
approve. A task has one assignee (agent or person), a parent and sub-tasks,
blockers, comments with mentions, a plan document, attachments and work
products, labels, priority, and a status that moves through in progress,
review and done. The list filters by status, assignee and project; **My
tasks** and **What needs me** narrow it to you. Task detail shows the run
transcript, costs and the full history. Nothing happens silently: every piece
of work has a page, an owner and a history.

### Inbox and Approvals
Decisions waiting on you: hires, budgets, plans, join requests, and anything
an agent got stuck on. Approve, decline or reassign from the phone. Agents
never spend or hire without a yes from you; this is where you say it.

### Agents
Your team. Each agent has a role, a model and adapter, a system prompt,
instructions, a budget, skills, tools, and a manager. Agent detail shows live
runs, logs, progress, its instruction bundle, and its tools tab. Pause,
change or offboard an agent any time. **New agent** is a short wizard; the
**Teams catalog** installs a whole team (a CEO with executives and
engineers) in one go. Agents awaiting approval or offboarded agents are shown
but can't be chatted with.

### Org
The org chart on phones: who reports to whom, with drag-to-connect reporting
lines. The organization sheet edits the name, goal and budget.

### Projects, Goals, Routines, Pipelines, Cases
- **Projects** group tasks under one goal and keep their own workspace.
- **Goals** are the top of the task tree.
- **Routines** run work on a schedule; each run is a task you can read.
- **Pipelines** chain stages of work with their own settings.
- **Cases** collect related work into one file.

### Workspaces
Project and execution workspaces: where an agent's run happens, its
provisioning status, live service ports (a preview or dev server), and a
summary of activity and follow-ups.

### Artifacts
Every file agents produced, grouped by task, with a viewer for text, images
and code, and downloads to `Downloads/Automa`.

### Skills and Connectors
- **Skills** are what agents know how to do: install from the catalog or build
  one in **Skill Studio**. Added skills are available from the next run.
- **Connectors** are the apps agents can reach (GitHub, Slack, Gmail, Notion
  and more). Choose which agents get access, which accounts they use, and
  which actions they may take.

### App Studio
Build, run and share apps from your phone with an AI pair that writes the
code and fixes what breaks. Full screen on a phone. Pick a language or
describe the app; one sheet picks the provider (with key status) and the
model; a sent message stays on screen while the reply streams with its
thinking, steps, and a token and cost line. The AI panel takes images and
text files with a message and uses the organization's API key when none is
saved in Studio. The file tree shows each file's kind, size and age.
Checkpoints, sharing by invite link or join code, and guest access are built
in. Studio has its own row on the Costs page and stops at the organization's
budget like agents do.

### Files (Device Files)
Share one folder on the phone with your agents. With **auto-send** on, a file
an agent requests from that folder is sent without asking; otherwise the
request waits here for you to pick a file or decline. Agents can send files
back to the phone. **Share to Automa** from any app's share sheet lands here
until you confirm. Requests addressed to another device are marked as such.
Downloads save to `Downloads/Automa`.

### Terminals
A real coding terminal on the device: Claude Code, Codex, Gemini CLI,
OpenCode and others in their full terminal UI, over a PTY relay with a
proot-distro Debian layer the page sets up for you. Wire a terminal to an
agent so it works with that agent's key. Runs only where Automa runs (on the
phone when Automa runs in Termux).

### App Inspector
Pick an app on your phone to decode its manifest, resources and code, read
the code as Java, ask Claude to explain any file, edit, and rebuild a signed
APK to your Downloads. For apps you made or are authorized to analyze.

- **App picker**: a grid of the apps installed on the phone, with names and
  icons, plus an **APK** button to upload any `.apk`.
- **App sheet**: tap an app for Open (decompile), **Ask Claude about this
  app**, copy package name, and the APK itself.
- **Decode options**: resources (apktool), smali sources, Java (jadx).
- **Project explorer**: a **Files** view (AndroidManifest.xml, res/, smali/)
  and a **Java** view (jadx output), search across the project, an app info
  panel (package, version, SDKs, launcher activity, permissions, components),
  the decode log, and an editor for text files.
- **Explain**: Claude explains the open file. **Ask Claude** opens a chat that
  already knows where the project lives on the device and how to launch,
  screenshot and drive the app over adb once `automa adb link` has been run.
- **Rebuild**: apktool rebuild, zipalign and apksigner with an inspector key,
  saved to `Downloads/Automa`.
- The server does the work, so apktool, apksigner and jadx must be installed
  where Automa runs; on a phone the App Inspector installs them the first time
  it decodes.

### Costs, Usage, Audit, Activity, Timeline
Every token counted: agent runs, chats, App Studio replies and code
suggestions all land on Costs, by agent, by task and by month, with refunds
and offsets. Audit and Activity are the log of everything that happened, who
did it and when; Timeline is the same, scrollable. Runs through Bedrock,
Vertex, Foundry or a gateway count as paid usage; refused, stopped and
cut-off replies still count the tokens they used.

### Status and Conference Room
Status is the instance's health page. Conference Room (board chat) is a
shared channel between you and the agents.

### Search
Searches tasks, agents, projects, chats and artifacts across the
organization.

### Settings
Organization settings: **General** (name, goal, budget, archive), **Profile**,
**Members** and **Access** (invites, roles, join requests), **API keys**,
**Secrets**, **Adapters** (which runtimes are on, model overrides),
**Environments**, **Plugins**, **Experimental** (Agent Chat and other
switches), **Export** and **Import** (move an organization between servers).
Instance settings (for the whole server) cover general options, access and
experimental features.

### Language
The account sheet's **Language** row: **Auto** (the device's language, with the
country found from its time zone) or one of 40 languages, searchable by native,
English or local name. Saved on the device and to the account. The board, the
agents (when they write to you), the connect screen and, on Android 13+, the
app's own screens follow it; Arabic, Persian, Hebrew and Urdu are right to left.

### Profile and API balance
The account sheet shows your API keys card: **left on your keys**, **spent
this month**, and a **monthly spending limit**. Add a key once and agents,
chats and App Studio all use it; set a limit and nothing overspends. A run
that fails before its model session says so and links here.

---

## 5. Agents on a phone

Claude Code's desktop engine can't run inside Termux, so on a phone a Claude
agent answers straight through the Anthropic API with the agent's
`ANTHROPIC_API_KEY`, with Claude Code's own tools (Read, Write, Edit, Bash,
Grep, Glob) running in Termux, plus the `termux-*` commands when Termux:API is
installed. The same happens when an agent's engine is set to "Anthropic API
(no Claude Code)" or when Claude Code can't start on a machine. Codex agents
can't run on a phone and say so; other runtimes must be installed in Termux.

**Letting agents control the phone.** Turn on *Developer options → Wireless
debugging* and run `automa adb link` in Termux. Agents then have the phone's
shell: `adb shell input` to tap and type, `screencap` for screenshots, `pm`
and `settings`, and `logcat`. The App Inspector's Ask Claude prompt tells the
agent exactly these commands.

---

## 6. Running Automa on the phone (Termux)

- **Start**: `automa run` (foreground, restarts the server if it stops) or
  `automa start` (background, log in `~/.automa/server.log`). `automa stop`,
  `automa status` (a starting Automa says which step it is on). `automa run`
  with one already running in the background follows its start until it is
  ready, then opens the app. With Termux:Boot installed, Automa starts when the
  phone boots. Set Termux's battery use to Unrestricted.
- **The app starts it for you**: when Automa on the phone doesn't answer, the
  app starts it through Termux's RUN_COMMAND (the installer turns on
  `allow-external-apps`; Android asks once), and the connect screen shows
  each step with a progress bar.
- **Staying up** (1.9.12): Android 12 and newer end the background processes
  of apps once all apps together run more than 32 (Termux then shows
  "[Process completed (signal 9)]"), and every Android ends apps when memory
  runs low. The launcher starts PostgreSQL with settings for a phone (no
  parallel query workers or logical replication launcher, one autovacuum
  worker, `max_connections=30`, `shared_buffers=32MB`; with PostgreSQL's own
  settings if it refuses them) and the server with `DATABASE_POOL_MAX=6`.
  `automa keep-alive` lifts the process limit over Wireless debugging (once;
  it stays after restarts) and takes Termux off battery optimisation. When
  the server stops, Termux says why (signal 9: Android; signal 6: most often
  memory) and `~/.automa/events.log` records it (`automa logs`, `automa
  status`).
- **Safe start**: after three stops in a row within five minutes of starting,
  the launcher starts the server with `PAPERCLIP_SAFE_MODE=1`: the board and
  the API only, with the heartbeat scheduler (agents, schedules, startup
  recovery), plugins, runtime services, the Moan index and message deliveries
  off. The board shows a banner with **Restart normally** (the server exits
  with code 75 and the launcher starts it again at once, normally) and
  **Troubleshoot**. `automa run --safe`, `automa start --safe`, `automa
  restart --safe` and the connect screen's **Safe start** start it this way
  on purpose.
- **Troubleshooting**: `automa troubleshoot` (or `automa fix`; `--start`
  starts Automa afterwards) checks Termux, storage, memory, the server files,
  the database, Automa, the recent stops, the logs and Android's process
  limit, and repairs what Automa itself left behind (a stale database lock, an
  update stopped between its two moves, a stopped database, leftovers when
  space runs out). It never changes the database's contents or the backups.
  The app runs it from the connect screen, the safe mode banner and the
  account sheet, and shows its report. **Refresh** in the board's header
  loads the page's data again and reconnects live updates; **Reload app** in
  the account sheet reloads the board.
- **Locked to the app**: on a phone every app can reach `127.0.0.1`, so
  Automa only answers the Automa app, using a key the installer makes and the
  launcher hands to the app. `automa link` prints it again. A browser on the
  phone sees a notice instead of the board.
- **Updating**: a new APK does not update the server. When a page needs a
  newer server, it shows **Update Automa on this phone**: tap it, tap **Send
  to Termux**, paste the command the setup screen shows (the same as the
  first install). From a 1.8.2 or newer server, `automa update` does the same.
  The installer backs up the database first, stops the running server,
  installs the new one in place (reusing npm's cache), and starts it again.
- **Backups**: Automa saves a complete copy of its database every hour while
  it runs, in `~/.paperclip/instances/default/data/backups/`, and the
  installer saves one before every update. `automa backup` saves one now;
  `automa restore` lists them and puts the newest back (or
  `automa restore FILE`), keeping a copy of what it replaced. The installer
  never deletes or re-creates the database: if Termux upgraded PostgreSQL to
  a new major version, it stops and says how to move the old files aside and
  restore a backup.

---

## 7. Security in short

- Only the configured server origin and the bundled connect screen load in
  the app; other links open in the browser.
- Every native bridge method takes a page key the app hands only to its own
  pages, and checks the calling origin. File bytes never cross the bridge:
  the app serves them on tokenized URLs.
- The Termux server asks for its app key on every request (an HttpOnly
  cookie), the database asks for a password even from loopback, and the app
  seals the key with the Android Keystore.
- Signing keys, Firebase config and `keystore.properties` are git-ignored
  and never shipped in the APK.
- Release builds are obfuscated with R8 full mode: classes, methods and fields
  are renamed to short names, the package tree is flattened, logging is
  stripped, and source-file names are removed, so the shipped APK is hard to
  reverse engineer. The repo source stays readable; only the compiled DEX is
  obfuscated. The de-obfuscation map (`mapping.txt`) is a build output, kept
  private, never committed.

`doc/AUTOMA-SECURITY.md` has the full threat model.

---

## 8. Build and release

Requirements: JDK 17+, Android SDK (platform 36, build-tools 36), Node and pnpm.

```sh
pnpm install
pnpm mobile:bundle-ui        # board UI → mobile/android/app/src/main/assets/ui
pnpm mobile:bundle-server    # server bundle → assets/server/automa-server.tar.xz
cd mobile/android
echo "sdk.dir=$ANDROID_HOME" > local.properties
./gradlew assembleRelease    # needs keystore.properties (git-ignored)
```

Bump `automa.versionCode` and `automa.versionName` in
`mobile/android/gradle.properties` for every release, add the release note to
`ui/src/lib/release-history.ts` (shown in the app), and keep the upload
keystore safe: an APK signed with a different key cannot update the
installed app.

What the APK carries: the Kotlin shell (`MainActivity`, the `AutomaNative`
bridge, SharedFolder, IncomingShares, Downloads, ServerConfig, BundledUi,
GoogleSignIn, Push), the connect screen, the bundled UI, and the server
bundle Termux installs.

---

## 9. Troubleshooting

| You see | What it means | Do this |
|---|---|---|
| **Update Automa on this phone** on Terminals or App Inspector | The phone's server predates the page. | Tap it, Send to Termux, paste the command in Termux. |
| "App not installed" / "conflicts with an existing package" | The installed Automa was signed with a different key (1.8.1 or older). | Uninstall Automa, install the APK. Board data lives in Termux and is kept. |
| Termux "RunCommandService requires allow-external-apps" | Termux hasn't allowed the app to run commands yet. | The app offers a one-tap fix; or run the installer again. |
| "Organization not found / No organization matches prefix" | A page was opened without an organization in the URL (fixed in 1.8.1). | Update the app. |
| The connect screen keeps waiting | Automa is still starting (the screen shows its current step), it stopped (the screen says so), or the address is wrong. | `automa status` in Termux shows the step; `automa run` follows the start; check the address (not the Wireless debugging one). |
| "Automa needs Node.js 24 or newer" in Termux | Termux packages are old. | `pkg upgrade -y`, then run the install command again. |
| "[Process completed (signal 9)]" in Termux, or Automa stops while in use | Android ended Termux's processes (the Android 12+ process limit, or low memory). | `automa keep-alive` once; Termux's battery use Unrestricted; `automa logs` shows when. |
| A **Safe mode** banner on the board | Automa kept stopping while it started (or a safe start was asked for). | **Troubleshoot**, fix what it says, then **Restart normally**. |
| The board is empty after an update: onboarding again, chats gone | The server is not reading the database it used to (a PostgreSQL major upgrade, or a database re-created elsewhere), not deleted data. | In Termux: `automa restore` lists the hourly backups and puts the newest back. "Your Automa database was written by PostgreSQL N" says the exact steps. |
| "Connect a model" with no key to give | A first agent needs a model. | Tap **Skip for now: start on the free models**; add a key or subscription under Settings later. |
| Chat says Agent Chat is turned off | The experimental switch is off. | Settings → Experimental → Agent Chat. |

---

## 10. Release history

| Version | Date | Highlights |
|---|---|---|
| 1.9.14 | 2026-11-18 | Languages. **Choice** (`packages/shared/src/app-languages.ts`): 40 codes (`APP_LANGUAGE_CODES`, English and native names; right to left for ar, fa, he, ur); Auto (`detectAppLanguage`) takes the first of `navigator.languages` Automa has, reads old codes (iw, in, tl, no, nn), Chinese script and region (Hant or TW/HK/MO is zh-TW) and European Portuguese regions (PT, AO, MZ, CV, GW, ST, TL, GQ, LU, CH), and the country from the time zone (`time-zone-countries.ts`, 542 zones from tzdata 2026e, `scripts/generate-time-zone-countries.mjs`), else the locale's region; nothing online. `formattingLocale` writes dates and numbers the device's way when it uses the chosen language, else in that language for the person's country. `user_language_preferences` (migration 0291; an `AGENTS.md` exception, instance-wide per person): `auto` or a code plus what Auto found (language, locale, country, time zone); `GET`/`PUT /api/language-preferences/me` (board users, strict validation, OpenAPI). Board: `LanguageProvider` (`ui/src/context/LanguageContext.tsx`) keeps `automa:language` on the device and pushes it to the account (a choice made signed out or offline is marked `automa:language:unsynced` and sent later; the latest tap wins), sets `html` `lang`/`dir`, i18next and the format locale; Account, Language (`LanguageSheet`). **Agents**: the heartbeat finds the person a run answers (the waking comment's author, else who the task is for) and adds a Language section to the task brief (full and compact) and `context.paperclipReplyLanguage`: write to them in their language, answer in another if they write in one, keep code, commands, names and quotes; the free-models engine puts it in its system prompt; Moan keeps Patois for English readers. **Board translations**: 210 core strings (`BUILTIN_CORE_STRINGS`, the account sheet's credit line `AutomaCredit` among them) built in for 39 languages (`ui/src/i18n/builtin/<lang>.json`, loaded per language through `import.meta.glob`); everything else through `LiveTranslator` (a MutationObserver over text and `placeholder`/`title`/`aria-label`/`alt`, matching exact strings and `{n}` templates from `UI_STRINGS`, 13,722 entries in `packages/shared/src/ui-strings.generated.ts`, made by `ui/scripts/extract-ui-strings.mjs`: `pnpm i18n:extract`, `i18n:check` in CI; adjacent text nodes are matched in stretches of up to 12, longest first, and a template matches a stretch only when each value starts and ends where nodes meet, so "{0} changed {1}" is never read across two of the board's own texts side by side) and `UiTranslationStore` (built in, then the device cache `automa:ui-translations:v1:<lang>`, then the server; missing strings asked in batches of 60, again after 2 min; a 404 is a server without the route). Server: `GET /api/ui-translations/:language`, `POST /api/ui-translations` (board users; only `UI_STRINGS`; `PUTER_DEFAULT_MODEL` in batches of 30; `acceptUiTranslation`: same placeholders, no HTML or link the English lacks, at most 4x its length or 80; 2,000 new strings per person per hour; saved to `data/ui-translations/<lang>.json` in the instance folder, an `AGENTS.md` exception). People's words are `translate="no"` (MarkdownBody, TerminalView, the environments terminal, thinking, run transcripts). The app's own messages that reach the board through the bridge (`NATIVE_ERRORS` in `ui/src/lib/automa-native.ts`, 21) are on `UI_STRINGS` too, so a failed share, download or sign-in reads in the language. **Dates and numbers** all go through `formatLocale()` (`ui/src/i18n/format-locale.ts`): 99 calls in 68 files used the phone's own locale, so a board in Spanish on an English phone wrote some dates in English (a test now scans the board for any call that does); it asks for Western digits where the language's default differs (Arabic in Egypt, Persian, Bengali, Marathi, Urdu in India: `-u-nu-latn`), since the board writes counts, sizes and times as they are and one card mixed both, keeping the language's separators, month names and calendar; 23 formats stay US English on purpose (run-log times, US dollar amounts, chart axes, the cron preview). The home screen's greeting and count are whole sentences (`Good morning, {0}`, `{0} things need you. Start at the top.`): written as a greeting glued to a name, and as a count, a word and a phrase, the translator could not find the first and translated the second in pieces. **Right to left**: unlayered rules in `ui/src/index.css` (direction icons `scale: -1 1`, `.text-left`/`.text-right` swapped, `[data-own-words]` `unicode-bidi: plaintext`, `pre`/`code`/`kbd`/`samp` left to right), sheet and dialog close buttons at `end-4`, and FSI/PDI isolates around template values and text not translated yet. **App**: `AppLanguage.kt` keeps the choice (SharedPreferences `automa`/`language`, `normalize`: `auto` or the 40 codes) and on API 33+ sets `LocaleManager.applicationLocales` (empty for Auto); only a change is applied, since the board repeats its choice on every load and re-applying would undo a language set in Android's per-app settings (`android:localeConfig`, `res/xml/locales_config.xml`). `AutomaBridge.setLanguage` (server pages), `getLanguage` (the app's own pages). `AutomaApplication.onConfigurationChanged` renames the shortcuts and the notification channel when the locale changes. Connect screen: `assets/connect/i18n.js` (the saved choice, else Auto with the board's rules; exact matches and templates with any number of `{n}`, the most specific first (a value that is itself a listed sentence is translated too, such as the port hint inside a connection error; a sentence with links, buttons or code inside is matched whole and those elements are moved, never copied, into the translation's word order), attributes, later text through a MutationObserver, isolates for right to left; the page stays hidden until its dictionary is in, at most 1 s) with `assets/connect/i18n/<lang>.json`; Japanese headings `word-break: auto-phrase`. Found while translating it: the "on this step" help cleared only when its English wording matched (`stuckHelp` now); the troubleshooter's card keeps its note (translated, `#troubleshoot-note`) apart from the command output (as Termux printed it); waiting times use the language's units (`Intl.NumberFormat` unit style, Latin digits); on right-to-left screens `code`, `kbd` and `pre` stay left to right and bold names are isolated; Termux's own labels (Paste, Open directory) and the archive's name are `translate="no"`, as Termux shows them in English. **App translations**: `mobile/android/i18n/<lang>.json` for 39 languages (the connect screen's 223 strings, listed in `connect-strings.json`: every heading, setup step, status and error on the page, in `connect.js` and in the app's own messages to it, 213 of them in the language's file and 10 from the board's built-in set; 47 Android strings; the 18 startup step names in `startup-steps.json`, as `runStartupStep`/`recoverStep` in `server/src/index.ts` name them, written to read inside a sentence); `mobile/android/scripts/sync-translations.mjs` (`pnpm i18n:android`; `i18n:android:check` in CI) writes the connect dictionaries, `res/values-<q>/strings.xml` and `res/values-<q>/startup_steps.xml` (the starting sheet names the step Automa is on in the language: `StartupSteps.name`) (he `values-iw`, id `values-in`, pt-BR `values-pt` and `values-pt-rBR`, pt-PT `values-pt-rPT`, zh `values-zh-rCN`/`values-zh-rTW`); a right-to-left line that starts with a Latin word or a `%n$s` gets U+200F, since Android lays a paragraph out by its first strong letter. Tests: shared languages 9; preferences against Postgres 7; heartbeat 3; free engine 2; `ui-translations` 9; extractor 9 (node); built-in translations (every language: same strings and placeholders, the language's script, sentences translated, Automa's name kept); live translator 17; string index 10; translation store 10; `LanguageContext` 12; `LanguageSheet` 6; `sync-translations.test.mjs` 49 (node: the four language lists equal, connect strings on the page, every word on the page, in `connect.js` and in each message the app sends (read with a Kotlin string reader) on a list, the startup steps the ones the server names, each language complete with placeholders, script and brand, Android escaping, the right-to-left mark, written files up to date, the connect screen's choice); `android-connect-translation.test.ts` 6 (the page in Spanish and Arabic: its setup steps whole with Termux's labels and commands kept, the step and waiting time, the stuck help clearing, errors with the port hint inside them, right to left); `AutomaCredit` 4; `AppLanguageTest` 3 (JVM; applying only a change fails on the code before it); `StartupStepsTest` 2 (JVM); `format-locale` 6 (Western digits; the language's own words, separators and calendar; release dates; no call follows the phone's locale; listeners told only of a real change; every memoized component that can show a date redrawn); `NeedsYouList` 1 (the greeting and the count whole, in Spanish); `App.format-locale` 1; `AttentionQueueRow` +1; `StudioWorkspace` +2; `FreeModelsSavingsCard` 3 (English, Spanish through the real translator, Arabic with the date isolated); `ModelPickerSheet` +1; `StudioUsageCard` +1. Seen in Chromium: the board in Auto (es-MX), Arabic (right to left), Chinese and Hindi; the connect screen in all 39 languages and in Auto (es-MX, zh-HK): lang and dir right, nothing translatable left in English on any of its screens, shown or not yet shown, no errors (the check fails when a translation is taken out); and its setup steps, a connection error and the starting step in Arabic, Japanese, Hindi, Chinese, Korean, Thai, Spanish and German. Scan before release: every test file in the repo (Vitest group by group, and the `node --test` scripts), `pnpm -r typecheck`, `pnpm build`, the token gates, both translation checks, the 60 shell scripts (`bash -n`), the Android unit tests and lint, and every company page of the board in English and in Arabic in Chromium (144 each: lang and dir, uncaught errors, error screens, blank pages, failed requests compared page by page). Fixed: App Studio left two unhandled rejections for a project that is gone or a dropped connection (`studioApi.console`, and reloading the open file after another window saved it; that one now says so in a toast and keeps the open copy); dates and numbers already on screen kept the old format after a language switch until a reload: `useFormatLocale()` in `ui/src/i18n/format-locale.ts` (a `useSyncExternalStore` subscription, told only of a real change) makes `App` draw every page again without remounting it, so typing is kept, and the 12 memoized components that can show a date do the same, a test keeping any new one subscribed (all of these tests fail on the code before); Android lint reported Hebrew and Indonesian as missing from `locales_config.xml` (their folders are `values-iw` and `values-in`, the list says `he` and `id`, which Android maps): `app/lint.xml` lets only those two through, and a stray `values-sq` is still reported; the free models card on Home, the free usage in the chat's model switcher and App Studio's usage card glued their phrases into one line, so "2 images", "since <date>", "model", the amounts and "at paid prices" stayed in English and an Arabic date came apart where the line wrapped: each phrase is now whole in its own element with its value as a piece of its own (`{0} tokens`, `1 image`, `{0} images`, `$0.00 charged`, `since {0}`, `Would have cost {0} at paid prices`, `1 model`, `{0} on the free models`, `{0} spent`, `worth {0} at paid prices`), which the translator also needs for a template under six letters; the board's string list after these (13,722); two server tests no longer fitted 1.9.13's changes: the free-model usage route test stubbed a two-model catalog, which the model catalog now refuses (under 50 models), so it priced App Studio's free usage from whatever catalog the machine had and failed on every machine (it now gives the catalog a fresh snapshot of its own and checks nothing is downloaded), and the leak guard that keeps the free-model token out of the built web app read the token's pieces from a list that masking the token removed, so it scanned `ui/dist` and the app's web assets with nothing to look for (it now uses the release check's own finder, `scripts/check-free-model-token.mjs`, with types in `check-free-model-token.d.mts`, and a 10-character run of the signature planted in a build file is caught); the board's Vitest project collected the string extractor's `node --test` file and failed with "No test suite found", which fails `pnpm test:run`: `ui/vitest.config.ts` leaves `scripts/` out, and `scripts/__tests__/vitest-skips-node-test-files.test.mjs` (in the PR workflow) asks Vitest which `node --test` files any project would collect, beside an ordinary test of the same project, and checks the workflow runs each one with `node --test`. Inherited from the base and fixed: a Storybook story still used the old viewport key (`mobile-entity-pickers.stories.tsx`, now `globals.viewport`), and the runner's capability test expected 155 rows where its inventory has 156 (`generate-capability-contract.mjs --check` confirms the inventory matches its sources). Inherited and left as they are: the runner package's standalone-boundary checks (`check-forbidden-imports`, `check-tracked-imports`: imports of `@paperclipai/paperclip-eval-kernel` and `packages/shared` and an undeclared `./evals` subpath, a policy for that package's owners), the telemetry proposal extractor (`scripts/extract-proposed-events.mjs` uses the TypeScript 5/6 compiler API and the repo is on TypeScript 7), and `scripts/smoke/chat-webhook-ingress.test.mjs`, which fails on this container's Node 22 only (Node prints an "experimental" warning for `NODE_USE_ENV_PROXY`) and passes on Node 24.22.3, the version the repo requires. |
| 1.9.13 | 2026-11-17 | Self-updating model lists, security, fewer phone processes, free models, and review fixes. **Model catalog.** `server/src/services/model-catalog.ts` keeps OpenRouter's public `/api/v1/models` (no credentials): a read never waits; a catalog over 12 h old (`MODEL_CATALOG_FRESH_MS`) is answered at once and a new one downloads in the background (single flight, not again within 10 min of a failure, refused under 50 models), saved atomically to `data/model-catalog.json` in the instance folder; before the first download the built-in `packages/shared/src/model-catalog-snapshot.ts` stands in (470 models, refreshed by `pnpm models:update` = `scripts/update-model-catalog.mjs`, which refuses under 50), and a saved copy older than it is skipped. The free-model price estimates (`paidPrices`) and OpenCode's OpenRouter list read it too (they downloaded the same catalog separately before). `GET /api/model-catalog` (any signed-in caller; instance-level public data): the major makers' (`CATALOG_TOP_MAKERS`) chat models. Rules in `packages/shared/src/model-catalog.ts`: a list gains a model released in the last 180 days that takes tools (each list works through tool calls), is a chat model (`isCatalogChatModel`: no `:variant`, text output, not image/audio/video/search/embedding/guard models) and is not on it yet, at most 12, in the list's own id form (`catalogNativeId`: Anthropic dots to dashes; OpenAI `gpt-N`/`oN` without gpt-oss; Gemini; Grok; Kimi; OpenRouter for the top makers); `placeCatalogModels` puts each just above the first listed model released before it or undated (`catalogReleaseDates`), older than every dated one at the end, after a kept first entry. Lists: Gemini CLI (after Auto), Grok (after the default), Claude and Codex when no key reaches the provider's own list (`listClaudeModelsWithSource`: Anthropic's own list and Bedrock ids untouched); a model refresh downloads the catalog first. Board (`ui/src/lib/model-catalog.ts`, `useModelCatalog`, 1 h stale time): App Studio's Anthropic, OpenAI, OpenRouter, Google, Moonshot and xAI lists (New tag for the last 30 days) and Terminals' Claude Code, Codex and Gemini CLI menus; the chat picker's Newest models is `newestCatalogModelIds` (released within 60 days of the catalog's download, at most 16), falling back to `NEWEST_MODEL_IDS` on a server without the route. Added to the built-in lists: Claude Fable 5.2 (`claude-fable-5-2`; $8/$40 per Mtok, cache read $0.20; the `fable` alias prices as 5.2), Gemini 4 Carbon and Hydrogen, OpenRouter `anthropic/claude-fable-5.2`, `google/gemini-4-carbon`, `qwen/qwen4-max`; defaults unchanged; Gemini Omni 1.1/1.2 Flash left out (no tools). Names: `VL`, `FlashX`. **Security.** Free-model token: XOR-masked with a random 24-byte mask, both halves base64, in `packages/shared/src/puter-ai.ts` (1.9.12 shipped it as eleven readable strings in the server bundle's `dist/puter-ai.js`); `scripts/check-free-model-token.mjs` reads it as the service receives it (fetch stubbed, Authorization header) and fails on a file holding it whole, its payload or signature, any 10-character run of the signature, or its base64 at any alignment in either alphabet (prints paths and counts only); `build-mobile-server-bundle.mjs` runs it before packing, `bundle-mobile-ui.mjs` after copying (a hit removes the UI), and the release check over the unpacked APK. Recoverable on a device (the server unmasks it); old APKs and git history hold it readable until it is rotated. Termux: `chmod 600` on `db-password` and `app-secret` on every install (an existing file kept an older installer's mode). Sign-in rate limit: Better Auth keyed it on `X-Forwarded-For` (a made-up value per guess escaped it; header-less callers shared `no-trusted-ip`); `stampAuthClientIp` sets `x-paperclip-auth-client-ip` from `req.ip` (`TRUST_PROXY` policy) after deleting a caller's copy, and `advanced.ipAddress.ipAddressHeaders` reads only that; live: six guesses with new addresses answered 401, 401, 401, 429, 429, 429. Headers (`middleware/security-headers.ts`): no `X-Powered-By`; `nosniff` on `/api`; `X-Frame-Options: SAMEORIGIN` and `frame-ancestors 'self'` on the board page (index, SPA fallback, Vite dev). **Phone processes.** PostgreSQL 18 gets `io_method=sync` in `pg_phone_opts` (`pg_major` >= 18; 17 and older refuse it): 4 helper processes instead of 7, measured; `start_db tune` asks `max_parallel_workers` and `coalesce(current_setting('io_method', true), '')` in one query and restarts a database started without it. The native controller identity (every 30 s) reads `getServerProcessStartedAt()` instead of the full server snapshot, and without a git checkout `getServerInfoSnapshot` caches 10 min (`NO_CHECKOUT_CACHE_TTL_MS`; 3 s with one): on the phone three failing `git` runs per health check and every 30 s are gone. **Free models.** New: Ling 3.2 Flash (`inclusionai/ling-3.2-flash:free`), ERNIE 5.5 Flash Preview (`baidu/ernie-5.5-flash-preview:free`), Particle 1 (`particle-ai/particle-1:free`), 1M context each, each answering and calling a tool live; Inkling 2 Small (provider auth refused) and LFM 3 1.7B (429) failed that twice and are left out. A `free_models` agent with no model runs `PUTER_DEFAULT_MODEL` (Nemotron 3 Ultra), not DeepSeek V4.1 Flash, whose free version is withdrawn ("Model not found"); ten listed models are withdrawn today and stay listed with that message. Tests for these: shared catalog rules 14, catalog service 7, route 2, adapter lists 6, prices 3, OpenCode list 2, board catalog helpers 9, App Studio sheet 1, Terminals 1, chat picker 2, display names (VL, FlashX), `update-model-catalog.test.mjs` 3 and `check-free-model-token.test.mjs` 12 (node --test, both in the PR policy job), `puter-ai.test.ts` 3, `better-auth-rate-limit.integration.test.ts` 4 (failed three ways before), `better-auth.test.ts` 4, `security-headers.test.ts` 4, `native-controller-identity.test.ts` 3, server-info 3, Termux suite 3 (secrets 0600, PostgreSQL 18 and 17), free-models execute 1; each fix's test fails on the code before it. **Review fixes** (a review of the 1.9.12 diff, `pnpm -r typecheck`, `pnpm build`, the token gates and a Playwright walk of the board's routes). App: Termux's RUN_COMMAND answers came back on one broadcast action (`<package>.TERMUX_RESULT`) for every request, and each in-flight request registered a receiver for it, so with two in flight (the connect screen's own `automa start` and Troubleshoot, say) the first answer finished both (Troubleshoot took `automa start`'s output as its report, `problems` from its exit code) and the second reached no receiver; `TermuxReplies.newRequest` now gives each request its own action (`<package>.TERMUX_RESULT.<n>`, from a process-wide counter that also makes the PendingIntent request code, so a request after the activity is recreated never reuses one). Connect screen: Troubleshoot is disabled while Safe start runs, as Safe start already was while Troubleshoot ran (`automa troubleshoot --start` could start Automa normally while `automa restart --safe` was stopping it, which then found it running). Board: after Restart normally the safe mode banner polled health every 2 s and stopped at its 3 minute patience; `health` is not refetched on live-update reconnects (`STATIC_QUERY_ROOTS`) and the layout polls it only for the dev server, so a later return left "hasn't come back yet" up; it now keeps polling every 10 s (`SAFE_MODE_SLOW_POLL_MS`) and tells a new safe start (`serverInfo.processStartedAt`) from the old one in that phase too. Tests: `TermuxRepliesTest` (2, the app's first JVM unit tests: `testImplementation("junit:junit:4.13.2")`, `./gradlew testDebugUnitTest`), connect screen 1 (Troubleshoot off during a Safe start; fails on 1.9.12's script), safe mode banner 2 (keeps asking after the patience and reports a later safe start; the first fails on 1.9.12). The whole UI project (721 files, 7,130 tests) failed one test once: `HoneycombRunLink` waited a fixed five event-loop turns for a `crypto.subtle` hash that Node finishes on another thread, so a busy machine missed it (alone it passes); with the digest delayed 50 ms it failed every time, and it now waits for the link (`vi.waitFor`). The walk (102 routes of the test instance's company) found only what 1.9.11's did: the plan document's expected 404 on chats and tasks, the free-models adapter's absent config schema (404), and alias routes that redirect. |
| 1.9.12 | 2026-11-17 | Keep-alive, safe start, troubleshooting, refresh. Launcher (`mobile/termux/install.sh`): PostgreSQL starts with `pg_phone_opts` through `pg_ctl -o` (`max_connections=30`, `shared_buffers=32MB`, `max_worker_processes=2`, no parallel workers, `max_logical_replication_workers=0`, `autovacuum_max_workers=1`) and with its own settings when it refuses them; `automa run` restarts a database started without them (`start_db tune`, checked with `show max_parallel_workers`) before the server starts; the server gets `DATABASE_POOL_MAX=6` (`DATABASE_IDLE_TIMEOUT_SECONDS=60`); `--safe` on run/start/restart is the launcher's (removed from the server's argv); `automa restart` (waits up to a minute, then `KILL`), `automa logs`; `~/.automa/events.log` (starts, stops with exit code and run time, fallbacks; last 200 lines); exit reasons by code (137 signal 9: Android; 134 abort: memory; 139; 143); `automa.running` (the supervisor's pid, removed by its `finish`) tells a launcher ended without warning from one that was stopped, and `/proc/uptime` a phone restart; after three stops in a row under 300 s the server starts with `PAPERCLIP_SAFE_MODE=1 AUTOMA_SAFE_REASON=crashes`, and only when safe mode also stops three times does it wait 60 s; exit 75 restarts at once without safe mode; `AUTOMA_LAUNCHER=1` always; `automa start` keeps the previous log as `server.log.1`; `AUTOMA_RESTART_WAIT` for tests. Server: `safe-mode.ts` (`safeModeFromEnv`, `safeModeReasonFromEnv` returns only `crashes`/`asked`, `NORMAL_RESTART_EXIT_CODE = 75`, `restartOnce`); in safe mode `heartbeatSchedulerEnabled` is false, the background sweeps start stopped, and runtime-service reconciliation, the Moan index, the deliveries startup step and bundled plugin loading are skipped; `/api/health` carries `safeMode`, `safeModeReason` and `safeModeRestartAvailable` on every answer (the redacted one too, since a fixed word reveals nothing); `POST /api/health/safe-mode/restart` (board instance admin; 409 `not_in_safe_mode` or `not_started_by_automa`; 202, then `shutdown("SIGTERM", true, 75)` once the answer has finished). New `automa-troubleshoot.sh` (Termux tools, storage with safe clean-up of update leftovers, the previous log and npm's cache, memory, interrupted update repair by `.next`/`.prev`, PostgreSQL version, stale lock, start, password and database checks, health, port, `events.log`, a log scan read before any clean-up, Android's process limit; `--start`, `--no-follow`; plain text off a terminal; never touches the database's contents or backups) and `automa-keep-alive.sh` (adb to the phone itself, linking it with `automa-adb-link` when there is a terminal; API 32+: `settings put global settings_enable_monitor_phantom_procs false`, read back, falling back to device_config; API 31: `device_config set_sync_disabled_for_tests persistent` and `max_phantom_processes 2147483647`; `deviceidle whitelist +com.termux`, `appops RUN_ANY_IN_BACKGROUND allow`; `~/.automa/keep-alive`; `--check`); both bundled by `build-mobile-server-bundle.mjs`; `automa-follow-start.mjs` says when Automa is in safe mode. App: `MainActivity.TermuxTask` (`START`, `SAFE_START` = `restart --safe`, `TROUBLESHOOT` = `troubleshoot --start --no-follow` with its report returned and `problems` from the exit code; per-task reply timeouts; `old_server` when a launcher hands the command to the server's CLI, "unknown command"); bridge `safeStartAutomaInTermux`, `runTroubleshooter` and `canTroubleshoot` (the connect screen, or the board of a loopback server); the connect screen shows Safe start and Troubleshoot (report in the app; its Open Termux copies `automa keep-alive` when the report asks for it) whenever its help says something is wrong and after it gives up on this phone, never for another computer, plus Refresh; the native sheet adds Reload page (`reloadServerPage`). Board: `SafeModeBanner` in both layouts (Restart normally polls health every 2 s, tells a new fallback by `serverInfo.processStartedAt`, gives up waiting after 3 minutes), `TroubleshootDialog` (one run per opening; a late reply is dropped), `RefreshButton` in the header (`refreshBoard`: refetch active queries, invalidate the rest, `automa:refresh` makes `LiveUpdatesProvider` replace its socket), account sheet Troubleshoot and Reload app (`reload-app.ts`). Verified live: a server started in safe mode under a launcher-like loop showed the banner, Refresh re-asked 34 requests, Restart normally exited 75 and came back normally in 14 s; the connect screen's tools and report were checked with Playwright. Tests: 61 more (`safe-mode.test.ts` 12; `termux-pkg-script.test.ts` 29 → 48 with a fake phone: the safe-mode fallback, exit 75, `--safe`, signal 9 records, the unclean-end marker, phone settings and their fallback, `automa restart`, the troubleshooter's repairs and log reading, keep-alive on API 31/33/34 and without a terminal; `android-connect-screen.test.ts` 8 → 16; `RefreshButton` 3, `SafeModeBanner` 9, `TroubleshootDialog` 5, `AccountSheet` 3, live-updates refresh 1, header placement 1). Full Vitest run, 176 groups one after another: 1,974 files, 28,099 tests, 3 failures, each below and passing after its fix. The OpenAPI document lacked `POST /api/health/safe-mode/restart` (now listed: board only, 202, 403, 409). `native-codex-runner.integration.test.ts` builds the Rust runner itself, and the test machine's Cargo 1.75 cannot read the version 4 `Cargo.lock`; with Rust 1.97.1 it passed. `heartbeat-process-recovery.test.ts` (no 1.9.12 change) ran past its 20 minute limit: one Stop test failed early (its run was already cancelled when its controller lease was checked at dispatch, a timing race that three more runs, two of them with every core busy, did not repeat), and because the file's cleanup re-set `terminateLocalService` without resetting it, that test's one-shot Stop, which waits for the test to release it, stayed queued; every later Stop ran it and each test waited out its 30 s limit. The cleanup now resets that mock and restores `vi.spyOn` spies, and the Stop tests release their gates when they finish (`onTestFinished`). With one Stop test made to fail on purpose, the old file failed 13 tests in 311 s and the fixed one only that test, in 60 s; the whole file passes (301 tests, 238 s alone, 356 s with every core busy). |
| 1.9.11 | 2026-11-16 | Wide-scan release (112 routes walked with Playwright: no exceptions, error screens or blank pages, only the known `documents/plan` and `free_models/config-schema` 404s; every Vitest group run on its own, 176 groups: 1,959 files, 28,210 tests, 10 failures, all below and all passing after their fix; a live free-model chat with a web search; the App Studio guest page and the profile save checked offline in Chromium; `pnpm -r typecheck`, `pnpm build` and every `check:*` script clean; the 1.9.10 code reviewed again). Board: `authPatch` (`api/auth.ts`, profile name and photo) turns a network failure into `AuthApiError(NETWORK_ERROR_MESSAGE, 0, null, "network_error")` like `authPost`, never retried; the App Studio guest client (`api/studio.ts` `guestRequest`) throws `ApiError(GUEST_NETWORK_ERROR_MESSAGE, 0)` instead of the raw `TypeError`, aborts pass through; `ConnectionRecovery` counts a failed query as waiting on the server only while it has observers or is not yet invalidated (`waitsOnServer`), so after a recovery the pages you left (invalidated, fetched when shown) stop the 10 s health checks; `useConfigSchema` (`adapters/schema-config-fields.tsx`) no longer remembers a request that got no answer or a 502/503/504 as "no schema" (`unreachableSchemaTypes`): it asks again at 2/4/8/10 s while the form is open and at once on `online` or `automa:server-back`; a 404 or 500 (the adapter's own error, logged server-side) is still remembered. CLI: the company-package zip writer (`commands/client/zip.ts`) and the feedback bundle writer use `zlib.crc32` instead of a bit-at-a-time loop (5.2 s vs 26 ms for 64 MB measured here, identical checksums). Docs: four broken relative links (`doc/SPEC.md`, `doc/plans/2026-02-18-agent-authentication.md`, `doc/AGENTCOMPANIES_SPEC_INVENTORY.md`, `packages/plugins/sdk/README.md`). Tests: profile save offline and refused (2), guest page offline/401/abort (3), recovery after leaving a failed page (1), adapter settings after a dropped connection (6), the zip writer's CRC-32 check value `0xCBF43926` in local and central headers (1). Test infrastructure (no product change): `CompanySettings.test.tsx` waits by time (5 s) for the state it checks (the environment form shows before its capabilities and saved values arrive; 2 tests failed under load); the CLI dense-zip test computes its CRC with `zlib.crc32` (the loop alone took 5.2 s of its 5 s limit); `company-import-export-e2e` gives the from-source `paperclipai run` 120 s to answer (was 30 s), sets `PAPERCLIP_UPDATE_CHECK=0`, and spawns it detached so `afterAll` stops the whole process group (SIGTERM, then SIGKILL after 5 s): signalling only `pnpm` left `tsx` and the server (about 800 MB) running after every run, and that server ignores SIGTERM once its database is gone; `github-launcher.test.ts`'s identity test has a 30 s limit (about twenty launcher processes, 4.5 s on a quiet machine); `chat-channels.integration` routes its 79 default-time waits through `waitForDrain` (10 s, was `vi.waitFor`'s 1 s; two more drain tests had failed that way), and the attachment-only Telegram test waits for its provider effect to be marked processed after the post, not only for the post; server `hookTimeout` 30 s -> 120 s (route suites load their very large route modules in a hook on purpose, and on a busy 4-core machine that one-time transform measured 26-30 s for `routes/issues.ts` and `routes/agents.ts`: `external-object-routes` and `agent-skills-routes` failed in their hooks), `testTimeout` stays 30 s, and `agent-remove-chats-route` loads the agents route module in `beforeAll` instead of in its first test, as `invite-rate-limit-route` and `invite-test-resolution-route` now do for the access route module (their first tests have their own 20 s limit and failed while compiling it). |
| 1.9.10 | 2026-11-12 | Startup progress and reconnect. Server: `startup-recovery-state.ts` tracks the step in progress (`beginStartupStep`, `runStartupStep`: logs each step's ms, warns every 30 s while one runs, by one-shot timers) and its place in `STARTUP_STEP_ORDER` (a test keeps it equal to the order `index.ts` runs them); `/api/health` carries `startup: { phase, seconds, step: { id, label, seconds, number, total } }` on every answer (redacted ones too: fixed labels only) until ready. Startup: every recovery step after native-run recovery goes through `recoverStep` (logged with `retriedBy`, start continues; native recovery still fails closed); the delivery sweep no longer throws out of the start; `sweepConnectionHealth` (network) and the retention sweep (every company's whole inbox) run in `afterReady`, each single-flight against the scheduler tick. Android: `HealthResult.startup` (`ServerConfig.startupOf`), connect replies carry `starting`/`step`/`seconds`/`stepSeconds`/`stepNumber`/`stepTotal` or `silent`; `ServerConfig.verifyKey` tells `UNREACHABLE` from `REJECTED`, so a key check without an answer keeps the pending key and waits (connect and `recoverAppKey`); a CONNECT intent while the connect page is open calls `window.__automaConnectRequested` instead of reloading it; the STARTING sheet shows "Now: <step> · <time> so far"; `serverAway` + `automa:server-back` event when the server answers again (network back, `onResume`). Connect page (`connect.js`): steps from the server, elapsed time and "step x of y", answered-then-silent detection (3 tries) with help and one quiet `automa start`, no 100-try limit while starting, 5 min give-up for silence only, one try in flight. Launcher (`install.sh`): `running_pid` checks `/proc/PID/cmdline`, `clear_stale_pg_lock` before every database start, `automa run` follows a running start with `automa-follow-start.mjs` then `link_app`, `automa status` uses it `--once`, quick-stop backoff (3 stops within 5 min -> 60 s, interruptible), `finish` no longer exits early under `set -e`. Board: `fetchApi` (client.ts) turns network failures into the status-0 `ApiError` for health, session, profile, announcements, audit export and trace download; `CloudAccessGate` retries reachability errors (1 s doubling to 10 s), shows "Reconnecting to Automa…" only with nothing to show, keeps the board during an outage, never redirects to sign-in on a dropped connection; `ConnectionRecovery` (`lib/connection-recovery.ts`) refetches queries that failed for want of the server when it answers (health checks 2/4/8/10 s), on `online`, `focus`, `pageshow`, visible, and `automa:server-back`; live updates reconnect at once on `online`/`automa:server-back`. Tests: startup progress (12), connect screen in jsdom (8; 7 fail on 1.9.9's page), launcher (5 new), connection recovery (10), gate (5 new). |
| 1.9.9 | 2026-11-09 | Scan release (112 routes walked with Playwright, every Vitest group run on its own, live E2E). Free-model client (`packages/shared/src/puter-ai.ts`): the service's own 429 (`too_many_requests`, "Too many AI requests from this account, network or device. Try again in a minute.") is `kind: "busy"` with `slowDown: true` and `retryAfterMs` parsed from its text; `refusedBy()` records it in `slowDownUntil` and `waitOutSlowDown()` holds every `driverCall` and stream `open` until it passes (90 s at most per call, abortable); a slow-down never marks the model busy, never switches it to its backup route and does not rotate app ids; `describePuterError` names the service, not the model. Engine (`execute.ts`): the retry pauses `slowDownPauseMs(retryAfterMs)` and logs the wait, logs a held call (`freeServiceSlowDownMs()`), and sets `retryNotBefore`; App Studio's assistant logs the wait as a step. `GET /companies/:id/live-runs`: `issueId` is null unless the issue still exists in the company (uuid-guarded `exists`), and padding skips finished runs of deleted issues. `DELETE /issues/:id` cancels the issue's `queued` and `scheduled_retry` runs (`issue_deleted`) after the row is removed. UI: `ui/src/lib/apps-routes.ts` holds `RESERVED_APP_SUBPATHS` (adds `byo`, `vercel-connect` for the production layout) for both layouts; `haptic()` skips `navigator.vibrate` before `userActivation.hasBeenActive`. Tools: `WebSearch` without a query is an error result. Android: `@SuppressLint("ViewConstructor")` on the two code-built views. Tests: slow-down (6 client, 2 engine), live-runs with deleted issues (2, embedded Postgres), waiting runs of a deleted chat (1), apps routes (2 + layout case), haptics (5), empty search query (1). Test infrastructure (no product change): server `testTimeout` 15 s -> 30 s (the first test of a route suite pays a 12-16 s one-time transform of the route modules on a 4-core container), `routines-e2e` compiles its route modules in `beforeAll`, four heavy `acpx-engine/execute.test.ts` tests carry an explicit 15 s limit, and two chat ordering tests wait 10 s instead of 1 s for their drains. |
| 1.9.8 | 2026-11-08 | Robustness. Server: `claimQueuedRun` cancels a queued run whose `explicitOperatorRunIdentity` check throws 403 ("wake authority could not be verified") instead of letting the error escape `resumeQueuedRuns` and fail the start; the claim loop in `startNextQueuedRunForAgent` logs and skips a run whose claim throws; the start cycle is tracked in an `AsyncLocalStorage` so a nested start request (a cancel's issue release → `run_queued` post-commit effect → `startNextQueuedRunForAgent`) is served after the lock is released instead of waiting 30 s for the agent start lock to go stale. Free-models web tools: `webSearch` tries DuckDuckGo then Bing's RSS feed (`parseBingRss`, click-tracker links decoded), treats the DuckDuckGo anomaly page as a refusal (`isSearchChallenge`), and names every source's answer when all fail. Privacy policy regenerated from `website/PRIVACY.md` into the website page, the connect-screen page and `ui/public/legal`. Android: `ObsoleteSdkInt` lint fixes. Tests: web search sources (6), startup recovery with an unverifiable receipt (1). |
| 1.9.7 | 2026-11-03 | Field fixes. Android: a health check of the phone's own Automa that fails is checked again (3 silent checks over a few seconds, `LOOPBACK_CHECKS_BEFORE_WAIT`) before `serverWentAway()` and the waiting connect screen; a `503`/`starting` health answer shows the new `ConnectionOverlay.Reason.STARTING` sheet over the page with a check every 4 s and reloads the page when Automa answers; a failed main-frame load on loopback is confirmed by health first; an unreachable key proof is retried twice before the wait screen; a repeated connect request from Termux (`automa run` sends one at each start) keeps the open board and checks the server instead of reloading; after process death the app re-installs the page key, proves the key again before restoring, and never re-runs the launch intent when the WebView state can't be restored. The connect page's wait tries to connect once before asking Termux to start Automa. Server: the free-models engine opts into Stop (`onCancellationReady`) and returns an acknowledged `cancelled` result when its signal is aborted, so deleting a chat, Stop and agent pause abort the stream instead of letting it run to the end and fail on the deleted chat; `DELETE /issues/:id` waits at most 10 s (`PAPERCLIP_ISSUE_DELETE_STOP_WAIT_MS`) for the run to stop. UI: Delete chat leaves the chat first, drops the deleted chat's queries and refreshes lists without them; a draft chat's placeholder id is never sent to the server. |
| 1.9.6 | 2026-11-02 | Audit release (16 areas, every confirmed finding fixed with tests). Security: the app proves a loopback server holds the app key before any send (`x-automa-proof-nonce` → `x-automa-proof` = HMAC-SHA256(secret, `automa-local-secret-proof:v1:<port>:<nonce>`), proven origins remembered), refuses requests to other services on the server's host, and the server refuses to move off its port when `PAPERCLIP_LOCAL_TRUSTED_SECRET` is set; agent, terminal and workspace environments drop `DATABASE_URL`, `PGPASSWORD`, `BETTER_AUTH_SECRET` and `PAPERCLIP_*` secrets; invite roles and grants are capped at the inviter's; Firebase sign-in won't link an unverified password account; company delete needs the owner and `PAPERCLIP_ENABLE_COMPANY_DELETION`; approval comments check access; task parents are company-scoped and acyclic; chats are owner-only. Connectors: OAuth runs inside the Android WebView when the authorization URL's `redirect_uri` is this server (site bar + Cancel, 15-minute window; app-key cookie `SameSite=Lax`); dialog hosts skip popups in the app; failed/denied reconnects show a notice on the app page; custom connectors without a reconnect target go to `/apps/byo`. AI connections: setup keys become the default (errors shown, no duplicate on retry); the agent field's new account is installed for all agents; `GET ai-connections?agentId` hides shared accounts not installed for the agent; API-key Claude tests accept `claude_api_key_ok`; free-model hires keep `effort`. Costs: built-in agent budgets upsert policies; agent budget form; soft vs hard incidents; paused limit Resume; UTC months; free usage by finish time. Terminals: Debian probe via `execFile` (no outer shell); `relayReady`; hooks fixed; App Inspector jobs run in their own process group and are stopped as a group. Termux: one server per phone, safer restore/backups, wake lock kept. Earlier in 1.9.6, connect and sign-in fixes: a 503 from Automa's own health check (database not ready) reads as "still starting", not "not an Automa server" (and not "nothing answers" for this phone, which now waits for it); a locked phone server without the app's key is refused up front with the `automa link` steps instead of a false Connected; the success screen says when the server's sign-in comes next. The signed-out health reply now carries `features.firebaseSignIn` and `features.signUpEnabled`, so the sign-in page shows Continue with Google where it works and hides Create one on invite-only servers; the page states the 8-character password rule and says when a password is too short. |
| 1.9.5 | 2026-10-30 | Notifications for finished AI work while you are away (an agent's reply to what you sent, an App Studio job): Android notifications posted by the page through the app (`AutomaNative.notify`), browser notifications through the service worker, and with a Firebase service account an away-only data push from the server; one per tag, none while the app is on screen; tapping opens that chat, task or project. While the board is hidden, a quiet connection listens for run outcomes on watched tasks. Live App Studio Stats tab (running clock, per-model status and tokens, latest moves with times, steps and files). Would-have-cost (`equivalentUsd`) on replies, the Stats tab and the 30-day card. `view_app`: the owner's App Studio renders the page at phone or desktop size and reports outline, console errors, failed loads and layout warnings; a static HTML fallback when App Studio is closed. Teams of up to 8 and 10 assignments; the preview reloads when files change. |
| 1.9.4 | 2026-10-30 | App Studio teams: logos that boot up per model with live tokens, a readable team chat where teammates agree on names and APIs (`message_team`), the person's request and the crew in every teammate's prompt, per-model token shares on each reply, a Stats tab, and App Studio's 30-day per-model AI usage on the Studio page and Home. Web pages: built and opened in the preview (also from console projects) with an Open the page button; localStorage works in the sandboxed preview; preview pages keep standards mode. Task waiting notice: an X closes it until the wait ends; Retry now (not the monitor check) during a retry; honest reply hint; refreshes when due. |
| 1.9.3 | 2026-10-30 | Auto-growing app-ID pool (200 IDs, +50 on each rate-limit burst, 11 s per-ID cooldown) distributes free-model requests so many people asking at once all get through; scrollable tables show fade edges; retry placement and recovery wording fixes; Que stats report the live pool. |
| 1.9.2 | 2026-10-29 | Server updates on the phone are built next to the running server and switch over only when complete; stalled downloads are retried, and a failed update changes nothing and leaves Automa running (a timed-out download used to leave it stopped). |
| 1.9.1 | 2026-10-28 | Usage limits on Costs (the free models' monthly allowance, daily limits with countdowns, Claude's session and weekly limits); chat shows why a reply failed; Draw again keeps the whole prompt; agents on API keys switch to the free models; the phone app works offline with its own server; free agents survive dropped connections, keep their tools, obey their tool switches and never reach private addresses; Que limited to 30 questions a minute per person; App Studio checkpoints never delete files, instant Stop, one public link; Moan facts brought up to date and its index bounded; honest backups and safe restore; every AI knows Automa was made in Jamaica by Nathan Lyttle (Corx Labs); no upstream links. |
| 1.9.0 | 2026-10-28 | The Que engine under every free-model call (10 at once, 2 per model, a status line in the model switcher); a failed reply no longer blocks the next message on another model; every free model kept with its status (daily limit and when it is back, busy, closed), Ternary Bonsai 27B and the Free Router, Gemma over Google's route, tool calls written as text carried out; App Studio with no key (free models in the AI tab and the editor's suggestions), undo per step, web search, no step cap, parallel teammates with roles; the newest paid models; Connections stay on the device; Termux installs survive apt's cache being cleared. |
| 1.8.8 | 2026-10-27 | Moan, the Jamaican model (Nemotron 3 Ultra, Patois-first, a Jamaica primer and a self-refreshing index of Jamaican sources with a status card); free agents make spreadsheets, presentations and documents and read them back; favicons on crawl and download summaries. |
| 1.8.7 | 2026-10-27 | Free agents keep their model and recover in place; instant taps and a fresh header; Retry on replies; raw JS/JSON reading, crawling and downloads with favicons; App Studio free provider, OpenRouter catalog search, model teams, memory across providers; terminal model choice and a Free models chat; maker logos on agents; proot-distro, apt-cache and Claude Code installer repairs; parallel decoding. |
| 1.8.6 | 2026-10-26 | Free chat agents are paired with SDXL Lightning by default and draw when asked; the model switcher scrolls to the end on phones (one scroll column, search stays on top). |
| 1.8.5 | 2026-10-26 | Skip for now on the model step hires the first agent on the free models; Anthropic and Cursor tiles with an API key; a database backup before every server update, `automa backup` / `automa restore`, and a guard that never re-creates a database written by another PostgreSQL version. |
| 1.8.4 | 2026-10-26 | Free models in chat (19 chat, 2 image) that stream, think at a chosen depth, search and read the web, work with files, teammates, tasks and connected apps, and draw with a paired image model; favicons on source links; collapsible thinking on every model; message actions on the newest reply with press-and-hold menus; free-model savings on Home and Costs. |
| 1.8.3 | 2026-10-26 | Server update takes effect at once; Ask Claude waits for sign-in, keeps your draft, skips offboarded agents; outdated-server check is specific. |
| 1.8.2 | 2026-10-26 | Outdated-server panel on Terminals and App Inspector; Ask Claude from any app or decoded project; `automa update`. |
| 1.8.1 | 2026-10-24 | "Organization not found" on device pages fixed; one-tap fix when Termux blocks Automa. |
| 1.8.0 | 2026-10-24 | Terminals; App Inspector; API balance in the profile. |
| 1.7.0 | 2026-10-24 | API agents with Claude Code's tools on phones, thinking modes, more models, start-up progress, balances and a spending limit. |
| 1.6.x | 2026-10-22 | Live replies with visible thinking, token and cost counts everywhere, faster Studio; bug fixes. |
| 1.5.0 | 2026-10-21 | Slash commands, app shortcuts, offline sheet, resume where you were. |
| 1.4.x | 2026-10-10 | App Studio; the app locked to its own Automa; wireless ADB wizard; full-screen Studio; API keys page; tour. |
| 1.3.0 | 2026-09-29 | Profile and organization sheet, drag-to-connect org chart, run Automa on the phone. |
| 1.2.0 | 2026-09-28 | Org chart on phones, one model switch in chat. |
| 1.1.0 | 2026-09-28 | Continue with Google, push notifications. |
| 1.0.0 | 2026-09-27 | The first Automa for Android. |

---

## 11. Where the Automa code lives

| Path | What |
|---|---|
| `mobile/android/` | The Kotlin app |
| `mobile/termux/` | The on-phone installer, `automa` launcher, adb link wizard |
| `mobile/store/` | Play listing, privacy, terms, graphics |
| `ui/src/pages/AppInspector.tsx`, `ui/src/components/app-inspector/` | App Inspector |
| `ui/src/pages/Terminals.tsx`, `ui/src/components/terminals/` | Terminals |
| `ui/src/pages/DeviceFiles.tsx` | Files |
| `ui/src/components/device/` | Phone-only UI such as the outdated-server panel |
| `ui/src/lib/automa-native.ts` | The native bridge contract |
| `ui/src/lib/release-history.ts` | The in-app release notes |
| `packages/shared/src/app-languages.ts`, `ui/src/i18n/`, `ui/src/context/LanguageContext.tsx` | Languages: the 40, Auto, built-in and live translation |
| `server/src/services/ui-translations.ts`, `server/src/services/language-preferences.ts` | Board translations and each person's language |
| `mobile/android/i18n/`, `mobile/android/scripts/sync-translations.mjs` | The app's and connect screen's translations |
| `server/src/services/app-inspector/`, `server/src/routes/app-inspector.ts` | Decode, explain, rebuild |
| `server/src/services/terminals/`, `server/src/routes/terminals.ts` | PTY relay |
| `releases/android/` | The current signed APK |
