# Automa — the complete guide

Made in Jamaica by Nathan Lyttle (Corx Labs).

Automa is a control plane for a company run by AI agents, delivered as an
Android app. You create an organization with a goal, hire agents (Claude,
Codex, Gemini, Kimi and others) into an org chart, give them work in plain
words, and watch them plan it, do it, and check in when they need you. Every
task traces back to the organization's goal, governed actions wait for your
approval, every token is counted against a budget, and a hard stop pauses
spending before it runs away.

This guide covers every screen and feature. `mobile/README.md` is the
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
- The server does the work, so apktool and jadx must be installed where Automa
  runs; the Termux installer adds them.

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
  `automa status`. With Termux:Boot installed, Automa starts when the phone
  boots. Set Termux's battery use to Unrestricted.
- **The app starts it for you**: when Automa on the phone doesn't answer, the
  app starts it through Termux's RUN_COMMAND (the installer turns on
  `allow-external-apps`; Android asks once), and the connect screen shows
  each step with a progress bar.
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
| The connect screen keeps counting down | The server isn't up yet or the address is wrong. | Check `automa status` in Termux, or the address (not the Wireless debugging one). |
| "Automa needs Node.js 24 or newer" in Termux | Termux packages are old. | `pkg upgrade -y`, then run the install command again. |
| The board is empty after an update: onboarding again, chats gone | The server is not reading the database it used to (a PostgreSQL major upgrade, or a database re-created elsewhere), not deleted data. | In Termux: `automa restore` lists the hourly backups and puts the newest back. "Your Automa database was written by PostgreSQL N" says the exact steps. |
| "Connect a model" with no key to give | A first agent needs a model. | Tap **Skip for now: start on the free models**; add a key or subscription under Settings later. |
| Chat says Agent Chat is turned off | The experimental switch is off. | Settings → Experimental → Agent Chat. |

---

## 10. Release history

| Version | Date | Highlights |
|---|---|---|
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
| `server/src/services/app-inspector/`, `server/src/routes/app-inspector.ts` | Decode, explain, rebuild |
| `server/src/services/terminals/`, `server/src/routes/terminals.ts` | PTY relay |
| `releases/android/` | The current signed APK |
