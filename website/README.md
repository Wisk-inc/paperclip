# Automa — your AI company, in your pocket

**Made in Jamaica by Nathan Lyttle (Corx Labs)** · Android 8.0 or newer · Version 1.9.15

Automa is an Android app that runs a whole company of AI agents for you. You hire
agents, give them roles, chat with them like teammates, hand them tasks, let them
build and run apps, draw pictures, search the web and work with your files — and
you approve anything that matters. It runs on **free AI models with no key, no
account and no card**, or on your own API keys and subscriptions (Claude, GPT,
Gemini, DeepSeek, Grok and more).

The agents work on an Automa server you control: your computer, a cloud machine,
or **the phone itself** (inside the free Termux app). Nothing sits in the middle.
No Automa cloud account, no ads, no tracking.

<p align="center">
  <img src="screenshots/00-connect-screen.png" width="230" alt="The connect screen">
  <img src="screenshots/01-home.png" width="230" alt="Home: what needs you, who is working, free-model savings">
  <img src="screenshots/03-chats.png" width="230" alt="Chats with your agents">
</p>
<p align="center"><em>Connect to a server (or run one on the phone) · Home · Chats</em></p>

> **Download:** the signed APK is in the release zip and in this repository under
> `releases/android/`. **Coming soon on APKPure** — the same signed build will be
> listed there so updates arrive on their own.

---

## Contents

1. [What Automa does, in one minute](#what-automa-does-in-one-minute)
2. [Get started](#get-started)
3. [Chats with your agents](#chats-with-your-agents)
4. [Free models, Moan and the Que engine](#free-models-moan-and-the-que-engine)
5. [Tasks, approvals and the Inbox](#tasks-approvals-and-the-inbox)
6. [Agents and the org chart](#agents-and-the-org-chart)
7. [Projects, goals and routines](#projects-goals-and-routines)
8. [Artifacts and your phone's files](#artifacts-and-your-phones-files)
9. [Skills and connectors](#skills-and-connectors)
10. [App Studio: build apps from your phone](#app-studio-build-apps-from-your-phone)
11. [Terminals and App Inspector](#terminals-and-app-inspector)
12. [Costs, budgets and usage limits](#costs-budgets-and-usage-limits)
13. [Search, audit and the timeline](#search-audit-and-the-timeline)
14. [Settings, your profile and the tour](#settings-your-profile-and-the-tour)
15. [Running Automa on the phone (Termux)](#running-automa-on-the-phone-termux)
16. [Security and privacy](#security-and-privacy)
17. [Download and install](#download-and-install)
18. [What's new](#whats-new)
19. [Questions people ask](#questions-people-ask)
20. [Credits](#credits)

---

## What Automa does, in one minute

- **Hire AI agents** with a role, a title, a manager and a model. A whole team in
  one tap from the teams catalog, or one agent at a time.
- **Chat with them** like teammates: replies stream in, their thinking shows in a
  panel, they search the web and cite sources, read your attachments, draw
  pictures, and make real Excel, PowerPoint and Word files.
- **Give them tasks.** Every task has one owner, a plan, a history and a cost.
  Agents ask you questions right in the task when they need a decision.
- **Approve what matters.** Hires, budgets, plans and anything an agent gets
  stuck on wait for your yes in the Inbox. Agents never spend or hire on their own.
- **Build apps on the phone.** App Studio writes, runs, previews and shares apps
  in 69 languages, with an AI pair or an AI team, and undo for every change.
- **Use free models.** Twenty-plus chat models and two image models that need no
  key, including **Moan**, Automa's own Jamaican model that talks Patois and knows
  Jamaica's news, law and government.
- **Bring your own models** too: Claude, GPT, Gemini, DeepSeek, Grok, Kimi,
  Cursor, Codex, Gemini CLI, OpenCode and any OpenAI-compatible endpoint.
- **Run coding terminals** (Claude Code, Codex, Gemini CLI) on the device, and
  **take apps apart** with App Inspector.
- **Count every token.** Costs by agent, by task and by month, hard budget stops,
  and what free work would have cost at paid prices.
- **Use it in your language.** Auto (your phone's language) or one of 40
  languages, right to left where it should be; agents write to you in it too.
- **Keep it yours.** Your organizations, chats and files live on your own server,
  which can be the phone in your hand.

---

## Get started

1. **Install the APK** (see [Download and install](#download-and-install)).
2. **Connect.** The connect screen takes a server address such as
   `http://192.168.1.20:3100`, or you tap **Run Automa on this phone** and the
   app sets up a server inside Termux for you, with a progress bar for each step.
   A computer can also be linked over a USB cable or Wireless debugging.
3. **Create an organization** with a name and a goal.
4. **Hire your first agent.** Pick a name, a role and a model, or tap
   **Skip for now: start on the free models**.
5. **Say what you want done** in Chats. The agent plans, creates tasks and asks
   when it needs you.
6. **Take the tour.** One card per section, with Skip at every step; run it again
   any time from your profile.

<p align="center">
  <img src="screenshots/16-new-agent.png" width="230" alt="Meet your next agent: the hiring wizard">
  <img src="screenshots/51-organizations.png" width="230" alt="Your organizations">
  <img src="screenshots/54-feature-tour.png" width="230" alt="The feature tour">
</p>
<p align="center"><em>Hiring an agent · More than one organization on a server · The tour</em></p>

**Getting around:** a bottom tab bar (Home, Chats, +, Tasks, Files) that stays in
thumb reach, a sidebar with every section and the organization switcher, a bell
for the Inbox, and your avatar for the account sheet. Long-press the app icon for
shortcuts: New chat, New task, App Studio, Change server, Files. Every screen is
edge-to-edge, keyboard-aware, and works in portrait and landscape on phones,
tablets, foldables and Chromebooks. Destructive actions come with **Undo**, not
"are you sure?" dialogs.

---

## Chats with your agents

Talk to an agent like a teammate. Replies **stream** token by token; the model's
**thinking** streams into its own panel and folds away when the answer starts.
Tables wider than the screen scroll sideways. Source links show the site's
favicon. When a reply fails, the chat says why in plain words, and you can switch
model and send again.

<p align="center">
  <img src="screenshots/04-chat-web-search.png" width="230" alt="An agent searches the web and answers with a table">
  <img src="screenshots/05-chat-sources-table.png" width="230" alt="The sources table scrolls sideways">
  <img src="screenshots/06-moan-patois.png" width="230" alt="Moan answering in Jamaican Patois">
</p>
<p align="center"><em>Web search with sources · Wide tables scroll · Moan answers in Patois</em></p>

**Pictures.** Ask any free chat model for a picture and its paired image model
draws it. Attach a photo and say what to change, and the model redraws it. Tap a
picture to view it full size or **Download** it to the phone; **Draw again** asks
for a fresh take.

<p align="center">
  <img src="screenshots/07-image-generated.png" width="230" alt="A logo drawn by the paired image model">
  <img src="screenshots/08-model-switcher.png" width="230" alt="The model switcher with the agent's tool switches">
  <img src="screenshots/09-model-switcher-free-models.png" width="230" alt="The free models list with each model's status">
</p>
<p align="center"><em>A drawn logo · The model switcher and tool switches · Free models with live status</em></p>

**The model switcher** (in the chat header) lists every provider with its key
status and the maker's logo, the **newest models** (they update by themselves as
new ones come out), a **Free** filter, **thinking depth** (Auto, Quick,
Balanced, Deep, Deeper, Max), and switches for what a free agent may do: **Web
search & reading, Files & commands, Teammates & tasks, Connected apps**. A
**paired image model** gives a chat model the power to draw; a small "Bonded"
mark shows the two makers' logos together.

**Messages.** Copy, retry, delete and thumbs up/down on the newest reply; press
and hold any other message for the same menu. Attach photos, screenshots, PDFs or
any file with **+**. Unsent drafts survive leaving the chat. ⋯ on a chat pins,
moves or deletes it.

**Slash commands:** `/plan` (plan first, nothing runs until you say so), `/ask`
(answers only, no changes), `/auto`, `/model`, `/think deep`, `/context`,
`/stop`, `/clear`, `/skills`, `/help`, `/new`.

**Notifications.** When an agent finishes a reply, or an App Studio job ends,
while you are outside the app, a notification says so. Tap it to jump straight
to that chat, task or project.

---

## Free models, Moan and the Que engine

No key, no account, no card. Pick a free model in the switcher and the agent runs
on it; your other models stay where they are.

**Chat models:** Moan (Jamaican, on Nemotron 3 Ultra) · Nemotron 3 Ultra 550B ·
Nemotron 3 Super 120B · Nemotron 3 Nano Omni 30B Reasoning · Nemotron 3.5
Lightning · Nemotron 3.5 Super VL · Nemotron 3.5 Content Safety · DeepSeek V4.1
Flash · Gemma 4 31B · Gemma 4 26B A4B · Qwen 3.8 27B · Qwen 3.8 27B Abliterated
Cyber · Inkling · Inkling Small · Flint v1.0 · North Mini Code · Atria Dawn
Preview · Apodex 1.1 Mini · LFM 2.5 2.6B · Xing 4.0 29B A4B · Ternary Bonsai 27B
· Ling 3.2 Flash · ERNIE 5.5 Flash Preview · Particle 1 · LFM3 1.7B · Free Router (sends each
question to an available free model). A free agent with no model chosen runs on
Nemotron 3 Ultra.

**Image models:** SDXL Lightning (fast, the default pairing) and SDXL Base 1.0.

Every model stays listed and says how it is doing: ready, busy, at today's free
limit (and when it is back), or closed by its provider. Nothing is hidden, and a
reply never comes from a different model than the one picked. As of 17 November
2026, ten providers have taken their free versions offline (among them DeepSeek
V4.1 Flash); those models say so and answer again when the free version is back.

**What a free agent can do:** search the web across many results, read pages,
crawl a site, download files; read, write, edit and search files and run commands
in its workspace; make real **Excel spreadsheets** (with formulas), **PowerPoint
decks** (with charts and pictures) and **Word documents**, and read the
spreadsheets, documents, decks, PDFs and CSVs you attach; draw with its paired
image model; message teammates, hand off work, create and update tasks; and
request the connected apps it needs. It knows its role, its teammates and your
name, and it keeps going through busy providers and dropped connections without
ever switching models behind your back.

**Moan, the Jamaican model.** Patois first, Standard Jamaican English for formal
documents and code. It carries a Jamaica primer (history, government, courts,
statutes, economy, culture) and a **living knowledge index**: while Moan is in
use, Automa keeps reading Jamaican sources (the Gleaner, the Observer, JIS, the
Office of the Prime Minister, Parliament, the Bank of Jamaica, the Laws of
Jamaica) into a local, searchable index, and every reply gets the passages that
match the question plus the newest news, with source, date and link.

**The Que engine** sits under every free-model call: up to ten calls at once, at
most two at a time on any one model, a pool of app IDs that grows on rate limits,
retries on busy answers, a five-minute answer cache, conversations and batches.
Many questions at once all get answered instead of some failing. When the
free AI service asks Automa to slow down, every call waits the minute it asks
for and then carries on, rather than asking again at once and failing.

---

## Tasks, approvals and the Inbox

Everything the agents are doing, each one a thread you can read, steer and
approve. A task has **one assignee**, a parent and sub-tasks, blockers, comments
with @mentions, a **plan document**, attachments and work products, labels, a
priority and a status (backlog, to do, in progress, in review, blocked, done).
The task page shows the live run transcript with the agent's thinking and tools,
its cost and its full history. An agent can ask you a question with options right
in the task; pick one and it carries on. When an agent finishes a task it asks
you to **approve the result** from the Inbox: approve to mark the task done, or
send it back with what to change and the agent picks it up again.

<p align="center">
  <img src="screenshots/10-tasks.png" width="230" alt="The task list with status counts and filters">
  <img src="screenshots/11-task-detail.png" width="230" alt="A task page with the brief and the agent's work">
  <img src="screenshots/11b-task-reply.png" width="230" alt="The agent's finished reply on the task">
</p>
<p align="center"><em>Tasks · A task's thread · The agent's finished work</em></p>

**Inbox and approvals.** Decisions waiting on you: hires, budgets, plans, join
requests, failed runs and anything an agent got stuck on. Approve, decline or
retry from the phone. The bell shows the count and clears when tapped. The
**Decisions** page keeps the record of every automated and governed decision.

<p align="center">
  <img src="screenshots/13-inbox.png" width="230" alt="The Inbox">
  <img src="screenshots/47-decisions.png" width="230" alt="The Decisions record">
  <img src="screenshots/12-new-task.png" width="230" alt="Creating a task">
</p>
<p align="center"><em>Inbox · Decisions · New task</em></p>

---

## Agents and the org chart

Each agent has a role and title, an engine and model (with the maker's logo), a
system prompt and instructions, a budget, skills, tools and a manager. The agent
page shows its live runs, logs, progress, instructions and tools. Pause, change or
offboard an agent any time. **New agent** is a short wizard; the **Teams catalog**
installs a whole team (a CEO with executives and engineers) in one go.

<p align="center">
  <img src="screenshots/14-agents.png" width="230" alt="The agent list">
  <img src="screenshots/15-agent-detail.png" width="230" alt="An agent's page">
  <img src="screenshots/17-org-chart.png" width="230" alt="The org chart">
</p>
<p align="center"><em>Agents · An agent's page · The org chart with drag-to-connect reporting lines</em></p>

**Engines:** Claude Code · Anthropic API · Codex · Cursor (local and cloud) ·
Gemini CLI · Grok · Hermes · Kimi · OpenCode · OpenClaw gateway · Pi · **Free
models** · metered API engines · a REST/webhook engine for an agent you host
elsewhere. On a phone, a Claude agent answers through the Anthropic API with
Claude Code's own tools running in Termux.

---

## Projects, goals and routines

**Projects** group tasks under one goal and keep their own workspace. **Goals** are
the top of the task tree, the "why" every task hangs from. **Routines** run work
on a schedule (a daily summary, a weekly review); each run is a task you can
read. Pipelines chain stages of work, cases collect related work into one file,
and workspaces show where an agent's run happens with its live service ports.

<p align="center">
  <img src="screenshots/18-projects.png" width="230" alt="Projects">
  <img src="screenshots/19-project-detail.png" width="230" alt="A project's tasks">
  <img src="screenshots/21-routines.png" width="230" alt="Routines">
</p>
<p align="center"><em>Projects · A project · Routines</em></p>

---

## Artifacts and your phone's files

**Artifacts** are every file the agents produced, grouped by task, with a viewer
for text, images and code. Downloads go to `Downloads/Automa`.

**Files** shares one folder on the phone with your agents. With **auto-send** on,
a file an agent asks for is sent without asking; otherwise the request waits for
you to pick a file or decline. Agents can send files back. **Share to Automa**
from any app's share sheet and the file waits on the Files page until you
confirm.

<p align="center">
  <img src="screenshots/25-artifacts.png" width="230" alt="Artifacts">
  <img src="screenshots/26-files.png" width="230" alt="Files: requests from agents">
  <img src="screenshots/20-goals.png" width="230" alt="Goals">
</p>
<p align="center"><em>Artifacts · Files · Goals</em></p>

---

## Skills and connectors

**Skills** are what agents know how to do. Install them from the catalog or build
one in Skill Studio; a new skill is available from the agent's next run.
**Connectors** are the apps agents can reach: GitHub, Slack, Gmail, Notion and
more. Choose which agents get access, which accounts they use and which actions
they may take. Connecting an app stays inside Automa.

<p align="center">
  <img src="screenshots/27-skills.png" width="230" alt="Skills">
  <img src="screenshots/28-connectors.png" width="230" alt="Connectors">
</p>
<p align="center"><em>Skills · Connectors</em></p>

---

## App Studio: build apps from your phone

Build, run and share apps with an AI pair, or a whole AI team, that writes the
code and fixes what breaks. No key needed: the free models work in the AI panel
and for the editor's code suggestions.

- **69 languages in 11 groups**, with quick starts for a website, Python, a
  full-stack app, React, Flask, Go, Rust, a mobile app and TypeScript.
- **Describe your app** in plain words and the assistant builds it from the first
  message. **Clone from GitHub** by pasting a link.
- On a phone each part is a tab: **Files, Code, Console, Preview, AI, Stats,
  Team**. The editor saves on its own and suggests code as you type.
- **Preview** runs the app inside Automa, sandboxed. One tap opens a **public
  link** anyone can open. Missing toolchains install on the device with progress.

<p align="center">
  <img src="screenshots/30-app-studio.png" width="230" alt="App Studio">
  <img src="screenshots/31-studio-files.png" width="230" alt="A project's files">
  <img src="screenshots/32-studio-code.png" width="230" alt="The code editor">
</p>
<p align="center"><em>App Studio · Project files · The editor with AI suggestions</em></p>

**The AI assistant** reads and searches the files, writes and edits code, runs
commands and tests, starts and stops the app, reads the console, searches the
web, and keeps going until the job is done. It **sees the page like you do**: it
opens the running page at phone or desktop size, reads what is on screen, the
console errors and the layout trouble, fixes what it found and looks again. The
preview reloads by itself when files change.

**AI teams.** Pick teammates in the model sheet and the lead model hands them
work: several teammates at once, each with a role and the files it owns, talking
to each other while they work. The **Stats** tab shows a running clock, steps,
files changed and every model at work with live tokens, then the totals and what
the free work would have cost.

<p align="center">
  <img src="screenshots/34-studio-ai.png" width="230" alt="The AI assistant">
  <img src="screenshots/35-studio-stats-live.png" width="230" alt="Stats while the AI works">
  <img src="screenshots/35b-studio-stats-totals.png" width="230" alt="Stats totals">
</p>
<p align="center"><em>The AI panel · Stats while a team works · Totals and what it would have cost</em></p>

**Undo and safety.** Undo any change the assistant made, step by step.
Checkpoints are saved before every AI message. Stop is instant. Nothing is ever
written outside the project folder.

**Working with friends.** Invite people with a join code or link (for an hour, a
day, a week, a month or no limit). Guests see your code as you type, chat, send
files and suggest changes you review as a diff; they can't save files or reach
the rest of Automa.

<p align="center">
  <img src="screenshots/33-studio-preview.png" width="230" alt="The preview">
  <img src="screenshots/36-studio-team.png" width="230" alt="Build together: invite people">
</p>
<p align="center"><em>Preview · Build together</em></p>

---

## Terminals and App Inspector

**Terminals** give you a real coding terminal on the device: Claude Code, Codex,
Gemini CLI, OpenCode and others in their full terminal UI, on a Debian layer the
page sets up for you. Wire a terminal to an agent so it works with that agent's
key, pick a model per tool (new models appear in the menus by themselves), or
open the **free models chat** with nothing to install.

**IMY** (Imagenery) is in Terminals too: a strict compiler for code you write in
your own syntax. You say what you are building in a `# ("...")` header, code
every step, and IMY checks it, compiles it and runs it, with the free models or
your own key. It converts each line as you type it, into the language you pick
on its tile (Python, JavaScript, Ruby, Rust, C, Go, Assembly and more), and
`:import` lets your code use the functions of a project you already have. It
refuses English requests in place of code and anything your code does not
actually build, and tells you the exact line. A **Check** button on the page
shows which free models are answering right now.

**App Inspector** takes an app on your phone (or any APK) apart: it decodes the
manifest, resources and code, shows the code as Java, lets you search, edit and
ask Claude to explain any file, and rebuilds a signed APK to your Downloads. For
apps you made or are allowed to analyze.

<p align="center">
  <img src="screenshots/37-terminals.png" width="230" alt="Terminals">
  <img src="screenshots/38-app-inspector.png" width="230" alt="App Inspector">
</p>
<p align="center"><em>Terminals · App Inspector</em></p>

---

## Costs, budgets and usage limits

Every token is counted: agent runs, chats, App Studio replies and code suggestions
land on Costs **by agent, by task and by month**. The organization and each agent
have a **budget**, and a hard stop pauses spending at the limit. The **usage
limits** card shows how much of the free models' monthly allowance is used and
when it renews, each free model's daily limit with a countdown, and Claude's
session and weekly limits when Claude Code is signed in. The **free models card**
on Home and Costs shows what the free work would have cost at paid prices.

<p align="center">
  <img src="screenshots/39-costs.png" width="230" alt="Costs">
  <img src="screenshots/40-costs-usage-limits.png" width="230" alt="Usage limits">
</p>
<p align="center"><em>Costs · Usage limits and free-model savings</em></p>

---

## Search, audit and the timeline

**Search** finds tasks, comments, plan documents, artifacts, agents and projects
in one place. **Audit** holds the log of everything that happened, who did it and
when, with the runs, costs and budgets behind it. The **Work Timeline** shows every
agent's runs side by side.

<p align="center">
  <img src="screenshots/41-search.png" width="230" alt="Search">
  <img src="screenshots/43-audit.png" width="230" alt="Audit">
  <img src="screenshots/44-timeline.png" width="230" alt="The work timeline">
</p>
<p align="center"><em>Search · Audit · Timeline</em></p>

---

## Settings, your profile and the tour

**Organization settings:** general (name, goal, logo, budget), members and
access (invites, roles, join requests), **API keys** (one place for the keys
agents, chats and App Studio run on, with a monthly spending limit), secrets,
adapters, environments, plugins and **Experimental** switches. **Instance
settings** cover the whole server. The **account sheet** shows your profile, your
API balance, your **language** (Auto or one of 40), the tour, the dark theme
and sign-out, and **About Automa** keeps the full version history.

<p align="center">
  <img src="screenshots/48-settings.png" width="230" alt="Organization settings">
  <img src="screenshots/49-settings-api-keys.png" width="230" alt="API keys">
  <img src="screenshots/50-settings-experimental.png" width="230" alt="Experimental features">
</p>
<p align="center"><em>Settings · API keys · Experimental</em></p>

<p align="center">
  <img src="screenshots/52-account-sheet.png" width="230" alt="The account sheet">
  <img src="screenshots/53-about-automa.png" width="230" alt="About Automa with the version history">
</p>
<p align="center"><em>Your profile and organization · About Automa</em></p>

---

## Running Automa on the phone (Termux)

No computer needed. Install **Termux** from F-Droid, tap **Run Automa on this
phone** in the app, and paste the command Termux is given. The installer sets up
Node.js and PostgreSQL, the server and an `automa` command, then starts Automa on
`127.0.0.1:3100`, locked to the app. The first install downloads a few hundred
packages (10 to 45 minutes); updates are much faster. The connect screen shows
each step with a progress bar and opens the board when the server answers.

| Command | What it does |
|---|---|
| `automa run` | Run in the foreground, restarting the server if it stops |
| `automa start` / `automa stop` / `automa status` | Run in the background, stop it, check it |
| `automa restart` | Stop it and start it again in the background |
| `automa start --safe` | Safe mode: the board opens with agents, schedules and plugins off |
| `automa troubleshoot` | Check the phone, the database and Automa, fix what it safely can, say what to do about the rest |
| `automa keep-alive` | Stop Android 12 and newer from ending Termux in the background |
| `automa logs` | The end of the log, and when and why Automa last stopped |
| `automa update` | Update the server (it backs up the database first) |
| `automa backup` / `automa restore` | Save a database backup now / put one back |
| `automa link` | Hand the app key to the Automa app again |
| `automa adb link` | Let agents drive the phone over adb (tap, type, screenshot) |

The app starts Automa for you when it isn't running, waits for it with a progress
screen, and shows **Automa is starting** over your page while the server comes up
after an update. Backups are made every hour while Automa runs and before every
update, and a restore never loses the database. Set Termux's battery use to
**Unrestricted**; with Termux:Boot, Automa starts when the phone boots.

---

## Security and privacy

- **Your data stays with you.** Organizations, tasks, chats and files live on your
  own Automa server. The app talks to the server you connect it to, and to Google
  only for sign-in and push notifications when those are set up. Free-model
  requests go from your server to the free AI service Automa uses.
- **Locked to the app.** On a phone, Automa answers only the Automa app, with a
  key the installer makes; the app proves the server holds that key before ever
  sending it, and never sends it to another program on the phone.
- **Agents see only what they should.** Agents and terminals never see the
  server's database password or sign-in secret. Every organization's data is kept
  separate. Keys saved in App Studio are encrypted on your server.
- **Sandboxed previews.** App Studio previews can't act as you or reach the rest
  of Automa. Free agents' web tools never reach private or local addresses.
- **Governed by you.** Hires, budgets and plans wait for your approval; budgets
  stop spending. Invites can't give more than the person who made them has.
- **Privacy policy.** What leaves the phone and what never does, in plain words:
  [PRIVACY.md](PRIVACY.md) (hostable page: `privacy.html`).
- The full threat model is in `doc/AUTOMA-SECURITY.md`.

---

## Download and install

**You need:** Android 8.0 or newer, about 100 MB of storage, and internet for the
AI features.

1. Get the APK from the release zip, or from `releases/android/Automa-1.9.15.apk`
   in this repository.
2. Copy it to the phone and open it. If Android asks, allow **Install unknown
   apps** for the app you opened it with.
3. Tap **Install** (or **Update**). Every release from 1.8.2 on is signed with the
   same key, so a new version installs over the old one and keeps your sign-in,
   settings and data.
4. If your server runs on the phone, run `automa update` in Termux after
   updating the app so the server matches it.

**Coming soon on APKPure.** Automa will be listed on APKPure with the same signed
build, so updates can arrive on their own. Until then the release zip is the
download. There is no Automa cloud account to create, ever.

---

## What's new

**1.9.15** (22 November 2026) — IMY comes to Terminals. IMY (Imagenery) is a
strict compiler for code you write your own way: the first line says what you
are building, in a header like `# ("adds two numbers and shows the sum")`, and
under it you code every step in whatever syntax you invent. IMY checks it,
turns it into another programming language in the background and runs it,
without changing your file.

- **It converts while you type.** Each line you enter is checked at once, and
  the result appears above the line you are typing.
- **You pick the language.** A menu on the IMY tile offers 20 (Python,
  JavaScript, Ruby, Rust, C, Go, Assembly…); `:target` switches inside the
  console, and IMY knows 48 in all and builds and runs 42 of them.
- **It takes in a project you already have.** `:import my-folder` saves the
  project's functions and variables, and your IMY code uses them by name, in
  whatever language you compile to.
- **It corrects a program that does not build**, by handing the build tool's
  own words back to the model, before anything runs.
- It stops, naming the exact lines, at an English request in place of code, at
  more than one `.auto…` shortcut, at a switch for a feature the code never
  builds, at anything used before the line that defines it, and at a line it
  cannot be sure about. What a file defines is remembered for later files.

Tap **IMY** in Terminals: the first tap installs it (in the Linux layer on a
phone), the next opens its console. It works with the free models with no key
(the model you pick is the one used), or with your own key after `imy init`.
When a new Automa brings a newer IMY the tile says **Tap to update**, and anyone
can install IMY on a computer with pip. Also new: a **Check** button on
Terminals and in the chat's model picker asks every free model for one word and
marks the ones closed at their provider (a model that was only busy is counted
apart and left unmarked); one more free model (LFM3 1.7B); a
terminal starts at the width your screen really shows, so a tool's first lines
no longer break mid-word on a phone; the Terminals tools' names and
descriptions are translated with the rest of the board; **Running now** lists
only the terminals still running, and a tool that finishes installing in the
background turns **Ready** by itself; and the installer's own messages fold
between words on a narrow screen.

**1.9.14** (18 November 2026) — Automa in your language. **Account → Language**
offers **Auto** and 40 languages: Auto follows your phone's or browser's
language and shows the country it found, and dates, numbers and times follow
your language and country. The main screens are built in for every language;
the rest of the board is translated by Automa's free models the first time a
screen opens and kept on your server for everyone on it. Only Automa's own
wording is sent for that, never your chats, tasks, names or files, and your own
words are never translated. Arabic, Persian, Hebrew and Urdu read right to
left. Agents write to you in your language, and answer in another one if you
write in it; Moan keeps Patois for English. The app follows your choice too:
the whole connect screen in every language (every setup step, which step
Automa is on while it starts, and the app's own messages, with commands and
Termux's own button names kept as they are), and on Android 13 and newer the
app's own notices, messages, launcher shortcuts and notification channel. The
choice is saved to your account, so every phone and browser you sign in on
uses it.

**1.9.13** (17 November 2026) — Model lists update themselves: an agent's
model choice, App Studio's providers, the Terminals menus and the chat's
**Newest models** follow a public catalog of every major maker's models, so a
model released after this version shows up without an update, newest first
(App Studio marks the last 30 days' **New**). Added now: Claude Fable 5.2,
Gemini 4 Carbon and Gemini 4 Hydrogen, and Qwen 4 Max on OpenRouter. Fixes from
a review of 1.9.12: Troubleshoot and Safe start in the app always show their
own answer: when two requests to Termux
were waiting at once, the first answer went to both, so Troubleshoot could show
what starting Automa said instead of its report. On the connect screen,
Troubleshoot waits while a Safe start runs. After Restart normally, the safe
mode banner keeps checking past its 3-minute wait, so it sees Automa come back
after a long start instead of saying it hasn't. Security: the free models' key
is stored scrambled and every build refuses to ship it readable; the phone's
database password and app key are locked to Termux on every install; sign-in
tries are counted per real caller (a made-up address no longer gets around the
limit); and other websites can no longer show the board inside a frame. On the
phone, PostgreSQL 18 runs three fewer processes and the server stops running
git every few seconds. New free models: Ling 3.2 Flash, ERNIE 5.5 Flash Preview
and Particle 1; a free agent with no model picked runs on Nemotron 3 Ultra.

**1.9.12** (17 November 2026) — Automa keeps running, and gets back up when it
can't. Termux closing while you use it is Android ending apps that run too
many processes or when memory runs low: Automa's database now runs lighter,
the server keeps fewer connections, and `automa keep-alive` lifts Android's
process limit for good. When Automa stops, Termux says why and keeps a record
(`automa logs`). When it keeps stopping while it starts, it starts in safe
mode by itself (your board opens with agents, schedules and plugins off) and a
banner offers Restart normally and Troubleshoot. `automa troubleshoot` (or
Troubleshoot in the app, which shows the report) checks the phone, the
database and Automa and fixes what it safely can. A Refresh button in the
header loads the page again and reconnects live updates; Reload app, Refresh
on the connect screen and Reload page on the connection sheet are there for
when something looks stuck.

**1.9.11** (16 November 2026) — Fixes from another scan of every page, every
test group, the build and every check. Saving your name or photo, and the App
Studio page an invited collaborator uses, now say "Can't reach…" in plain
words instead of "Failed to fetch" when the connection drops. An agent's
settings page loads the extra settings of its AI connection by itself once
Automa answers again; they used to stay missing until the app was reopened.
After a reconnect, pages you had already left stop asking the server every few
seconds. Company folders pack for import with Node's own zip checksum, so a big
package no longer spends seconds on it.

**1.9.10** (12 November 2026) — Opening the app while Automa on the phone
starts now shows what Automa is doing ("checking assigned tasks", step 13 of
23) and for how long, instead of spinning on "Automa finishes starting up". A
start that stopped is told apart from a slow one, and Termux is asked once to
start it again. Automa reaches "ready" sooner, and one failing startup step no
longer ends the start. In Termux, `automa run` follows a start that is already
going until it is ready, and `automa status` shows the step. No more "Failed to
fetch": when the Wi-Fi drops or the server restarts, the board keeps its page
and loads again by itself the moment the connection is back, with no need to
reopen the app.

**1.9.9** (9 November 2026) — Fixes from a scan of every page and a live run
of the app. When the free AI service asks Automa to slow down, Automa now
waits the minute it asks for, once for all agents, and carries on, instead of
asking four times in 25 seconds, failing the reply and blaming the model. Home
no longer shows "Task unavailable" cards for chats and tasks you deleted.
Deleting a chat or task also cancels the retries still waiting for it, so its
agent can be removed. The bring-your-own and Vercel connect pages no longer
open as a connection that does not exist.

**1.9.8** (8 November 2026) — Fixes under the hood. Automa on the phone starts
even when an old queued run is poisoned: the run is cancelled and the others
start, where the whole server used to fail to start. Cancelling a queued run no
longer stalls the scheduler for 30 seconds. Web search falls back to Bing when
DuckDuckGo refuses with a bot check or an error, and a failed search names what
each source answered. Free-model agents hand a task back for your review after
answering, and drop a tool that fails three times in a row instead of looping
to the turn limit. The privacy policy is rewritten for the APKPure build.

**1.9.7** (3 November 2026) — Coming back to the app stays on your page: your
phone's Automa is checked a few times before the connect screen, "Automa is
starting" shows over the page while it starts, a connect request from Termux
keeps the open board, and the page you were on comes back after Android ended
the app in the background. Deleting a chat while the AI is replying stops the
reply at once, leaves the chat before refreshing and never waits more than ten
seconds.

**1.9.6** — A full check of the app with every problem found fixed: the app
proves your phone's Automa holds its key before sending it, agents and terminals
no longer see server secrets, sign-out sticks, connectors sign in inside the app,
keys added while hiring become your default, agent budgets can be set and are
enforced, removing an agent deletes its chats, one Automa per phone, Terminals
show Claude Code and Codex as installed on phones.

**1.9.5** — Notifications when an AI reply or App Studio job finishes while you
are away, a live Stats tab in App Studio, what free work would have cost, and
agents that look at the page like you do.

The full history, release by release, is in **About Automa** inside the app and in
`AUTOMA-README.md`.

---

## Questions people ask

**Do I need an API key?** No. Pick a free model and start. Add keys later in
Settings → API keys if you want Claude, GPT, Gemini or another paid model.

**Do I need a computer?** No. Tap **Run Automa on this phone** and the server runs
inside Termux on the phone. A computer, a VM or a cloud machine works too.

**Is there an account?** Only on your own server, and only when you turn sign-in
on. There is no Automa cloud account.

**What happens offline?** With the server on the phone, Automa itself keeps
working; the AI features need internet.

**Can other people use my organization?** Yes. Invite members with roles; invites
can't give more than you have. App Studio projects can be shared with friends by
code or link.

**Where do downloads go?** `Downloads/Automa` on the phone.

**Can I use Automa in my language?** Yes. Account → Language: Auto follows your
phone, or pick one of 40 languages (Arabic, Persian, Hebrew and Urdu read right
to left). Your agents write to you in it, and the app's own screens follow it
on Android 13 and newer.

---

## Credits

Automa is made in Jamaica by **Nathan Lyttle (Corx Labs)**. It builds on an
MIT-licensed open-source control plane for AI agents; see `LICENSE`.
