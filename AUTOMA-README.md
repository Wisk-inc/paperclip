# Automa

**A company run by AI agents, in an Android app.**
Made in Jamaica by Nathan Lyttle (Corx Labs).

Version **1.9.17** · Android 8.0 or newer · package `com.corxlabs.automa`

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
2. [What's new in 1.9.17](#2-whats-new-in-1917)
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

## 2. What's new in 1.9.17

App Studio reads like a code editor, its AI is easier to talk to, and App
Inspector has a chat. Open **Terminals** too: the IMY tile says **Tap to
update** (IMY 1.1.2).

**App Studio's code screen**
- **Open files are tabs** above the editor, each with its file's icon and a
  close button. Tap a tab to go back to that file; a dot marks edits that are
  not saved yet. The tabs are remembered for each app.
- **A line under the editor** shows the line and column of the cursor, the
  language and the indent, with the AI suggestions switch and whether the file
  is saved.
- **On a phone, a row of keys** above that line: Undo, Redo, Tab, brackets,
  quotes and the other symbols a phone keyboard hides.
- On a wide screen, the side panel's tabs (Console, Preview, AI, Stats, Team)
  no longer run into each other.

**Talking to the AI in App Studio**
- When a free model is busy or at its daily limit, the reply now shows what
  went wrong in a box with two buttons: **Try again**, and **Ask** another
  model **instead**, which switches to a free model that is answering and
  sends your message again in one tap. Automa still never answers with a
  different model than the one shown: the switch is your tap.
- A new chat starts on a free model that is answering right now, and says so
  when that is not the usual first choice.

**A chat in App Inspector**
- Open a decoded app and tap the chat button to ask about the whole app, or
  open a file and tap it there to ask about that file. The model is given the
  app's summary (package, version, permissions, screens and services) and the
  file you have open, or the files your question names.
- It works with the free models and no key. With an Anthropic key saved,
  Claude is in the model menu too. The conversation is kept with the project.
- A busy model gets the same two buttons as in App Studio.
- **Ask an agent instead** is still there for the things only an agent can do
  (read every file, drive the app over adb).
- **Decode again** (on the Info tab, and wherever an app shows no files or no
  Java) reads the project's APK once more with its resources, its code and the
  Java view. Use it on a project that was opened from an APK file before this
  version: those were decoded with everything switched off. It replaces the
  project's decoded files, with any edits you made to them.

**Fixed**

*App Studio: your work is kept*
- Opening a second app showed the first app's file and saved into it. Each app now opens on its own files.
- Your own autosave could come back as a change "from somewhere else". Saves go out one at a time, each on the version the one before returned.
- A save that failed was never tried again, and leaving right after typing could lose the last edit. A failed save is tried again by itself (at once when the connection is back), and the last edit is saved as you leave the page.
- After the connection dropped and came back, the open file, the files list and the AI chat stayed as they were. They are read again, and unsaved edits get the keep-mine or load-theirs choice.
- Two saves made from the same version at the same moment were both accepted. One is now refused as a conflict.
- Going back to a checkpoint deleted a file that had grown past what a checkpoint can hold. It is left as it is, and Automa says which files stayed.
- A file deleted and made again under the same name stayed hidden in the list.

*App Studio: running and previewing*
- Tapping Run twice started the app twice, and an app that could not start still showed as running.
- The preview changed addresses with encoded characters (a space as `%20`), so some pages and files did not load.
- A file removed just as it was opened, or a line typed into an app that had closed its input, could stop Automa's server.
- Stop could hang while a visitor's download from the preview was open, and an abandoned download or file view left the file open.
- Downloading a project held whole files in memory.
- The console did not follow output printed while another tab was showing.

*App Studio: the AI*
- The AI said nothing while it tried a busy free model again. It now says each try ("Trying again, 2 of 4").
- The organization's budget stop was checked only before a reply started. It is now checked at each model call of the reply. (It still cannot count what the reply itself is spending until the reply ends.)
- A code suggestion that failed showed the service's raw reply. It now says why in plain words.
- A message with four full-size pictures was refused as too large.
- The AI's delete of a path that was not there reported success.
- A new chat no longer treats a conversation that is still loading as a new one.

*App Studio: messages, sharing and layout*
- Failures that said nothing now say what failed and why: deleting a file, deleting an app, saving the settings, an upload over the size limit.
- The invite link was gone when the page was opened again (only the code showed). It is read again, and **Get the public link** asks for the public one without changing the code.
- On a guest's page nothing was read again after a reconnect, and New folder did nothing.
- The New app sheet cut its error message and long language names off; the Checkpoints sheet kept an old error and an armed "Tap again" after it was closed.
- After a sheet or dialog closes, focus goes back to the button that opened it.
- A phone turned sideways, and tablets up to 1180 px wide, got three columns with an editor a few pixels wide. They now get one pane at a time, like a phone.
- The Find panel took half the screen on a phone and left no code visible with the keyboard up. It is two rows now, and its close button is finger-sized.
- The close button of every sheet and dialog, Copy invite link, and the asset cards' buttons are finger-sized on touch screens (they were 16 to 24 px).
- A long link in the Team chat pushed its bubble off the screen; a model's name in the usage card and asset names were cut off; the public-link card covered half the preview on a sideways phone.
- Cloning a project whose `package.json` is not strict JSON failed.

*Free models*
- A model at its provider's daily limit was read as "busy": Automa tried it four times over about half a minute and then failed. It is now recognised however the provider words it, fails at once with the time it is back, and shows as at its limit in the model menu.
- For a model with a second route (Gemma over Google's route), each route is tracked on its own, so a route that is out is skipped and the other one is asked.
- A refusal sent inside an "OK" reply was read as an empty answer.
- Moan runs on Nemotron 3 Ultra, and is now marked busy or at its limit when that model is.
- A busy model is asked four times in all and a provider that sends nothing once more; the extra try that used to follow is gone.
- The connection test for the free models says "pick another model" when the first model is at its limit, instead of failing as if the free service were down.
- The note under a model's name (busy, at its limit) was too faint to read in the light theme.
- The messages say "model menu" where three still said "switcher".

*App Inspector*
- An app opened from an APK file was decoded with everything switched off: no resources, no code, no Java. It is decoded in full now, and **Decode again** repairs a project opened before.
- Text that is not UTF-8 (Latin-1, GBK) would have had its letters changed by a save. Such a file is read-only and says why.
- Clearing the chat while an answer was being written kept that answer.
- Search could run past its time limit inside one large folder without saying that results were left out, and kept running after you typed something else.
- When the phone stopped jadx (usually for lack of memory), the Java view showed as ready and empty. It now says it failed.
- A decode that failed showed as decoded after Automa restarted.
- "Opens with" named the wrong screen when a screen without content came before the real one; the Activities list counted aliases as screens; permissions asked only on Android 6 and newer were left out.
- After an edit, the "Built and signed" banner of the older build stayed.
- A link inside the decoded files could lead to a file outside the project. Reading, saving, the chat and the manifest reader now stay inside the project.
- A reply that was only the model's reasoning showed as empty, and the chat offered Moan, which it could not ask.
- Saving a file, deleting a project and decoding again are in the activity log.
- The project screen says so when a project cannot be loaded or a search fails, and Info no longer shows loading rows forever after a failed decode.

**Smaller changes**
- App Inspector's text search also reads `.toml` and `.tsv` files.
- IMY 1.1.2: `imy import` leaves out `bazel-out` and `zig-out`, the folders
  Bazel and Zig build into.
- A few waits are a little longer for slow phones and networks: the app
  waiting for the phone's Automa to answer, downloads, reading the web, Moan's
  sources, App Studio's preview and Terminals.

### From 1.9.16

IMY's console now reads like the file you are writing, and says nothing you
did not ask for. Open **Terminals**: the IMY tile says **Tap to update**
(IMY 1.1.1).

**IMY's console looks like a code file**
- It opens with one line: the name of the program file your code becomes
  (`main.py`, or `main.rb` when you picked Ruby, `Main.java`, `main.go`) and
  IMY's version. The lines on how to begin are gone, and so is `imy>` before
  every line.
- Each line is typed behind its number and a bar, like the margin of an
  editor. When you press Enter the line is set again in colour, and a line too
  long for the screen continues between words under its own beginning.
- The code a line became stands under it. With the free models, the lines of
  the program file that are new or changed appear under the lines they came
  from, each behind a broken bar and its own number in that file, in the
  colours of the language. `:code` and `:convert ruby` show the whole program
  the same way, under the file's name.
- A new line begins where the line before it began, so a block keeps its
  indentation; Backspace takes it away. Tab indents, and after a command it
  completes a file's name.
- A command keeps no number, so the numbered lines are your program.

**It says only what you asked for**
- `:run` prints what your program prints. The "compiled to …" line, the note
  about memory and "exit code 0" are gone; an exit code is shown only when it
  is not 0. The seconds still count while a model works, and leave no line
  behind.
- A command answers in a word or two, or not at all: `:target ruby` answers
  with the new file's name, `:live off` with "live off". The hints that
  followed a command are gone. `:help` lists every command, as before.

**Fixes in the console**
- Several lines pasted at once became one numbered line, and every number
  after them was wrong. Each pasted line is now a line of its own.
- A line that begins with a colon and no letter, such as `:: end` in the
  countdown example, was refused as an unknown command. It is code now.
- On a phone's narrow screen a converted result could land in the line you
  were typing, and a command entered at that moment could vanish from the
  screen. A result is now written only while nothing is being typed, or when
  you press Enter.
- When two results came in one after the other, a line of the program could
  be shown twice. The newer result now takes the place of the older one.
- Keys pressed while a compile counted its seconds landed in that line and
  left it on the screen. They are now taken as typed once the compile is done.
- Closing the terminal ends IMY cleanly, and the lines you typed are kept for
  the next time (the Up key brings them back).

### From 1.9.15

IMY comes to Terminals: a strict compiler for code you write your own way. It
converts while you type, turns your code into the programming language you
pick, can take in a project you already have, and works with the free models
from the first tap.

**IMY (Imagenery) in Terminals**
- IMY reads a program written in whatever syntax you invent. The first line is
  a header, `# ("what this builds and how it works")`; under it you code every
  step yourself. IMY checks the program against its rules, turns it into
  another programming language in the background, and runs it. Your `.imy`
  file is never changed.
- It is strict on purpose, and names the exact lines when it stops:
  an English request in place of code (`PromptingDetected`), more than one
  `.auto…` shortcut in a file or one longer than 20 characters, a switch that
  turns a feature on by name when the code never builds it
  (`MissingMechanics`), anything used before the line that defines it
  (`ExecutionOrderViolation`; IMY never reorders your code), and a line it
  cannot be sure about (`AmbiguousIntent`; it does not guess). Nothing runs
  until the whole program is clean.
- **Converted as you type.** In IMY's console each line you enter is checked
  at once, and the lines so far are converted in the background. The lines of
  the program that are new or changed appear under the lines they came from,
  so you see your code become Python (or Ruby, or Rust) line by line. Typing
  is never held up. `:live off` stops it.
- **Pick the language your code becomes.** The IMY tile has a second menu:
  Python, JavaScript, TypeScript, Bash, Lua, Ruby, PHP, Perl, C, C++, Rust, Go,
  Zig, Assembly, Java, Kotlin, C#, Swift, SQL or HTML. Inside the console,
  `:target ruby` switches at any time and `:languages` lists all 48 that IMY
  knows, with the ones that can run on your device. IMY builds and runs 42 of
  them when the language's own tool is installed, down to assembly for your
  device's processor; every language converts even when it cannot run there.
- **Bring a project you already have.** `:import my-folder` (or
  `imy import my-folder`) reads an existing project and saves every function,
  class and variable it defines. From then on your IMY code uses them by name,
  and they come out in whatever language you compile to, each with the helpers
  it needs. Python files are read on the device, with no model; other
  languages are read by the model and every answer is checked against the
  file. None of the project's code is run, and `--dry-run` shows beforehand
  which files the model would see.
- **A program that does not build is corrected.** When the language's own tool
  refuses the result (the C compiler, the assembler, `node --check`…), IMY
  hands what the tool said back to the model, gets a corrected version and
  builds again, before anything runs.
- What a file defines is remembered: functions, variable packs, your own
  syntax and made-up file paths are saved, so a later file can use them
  without defining them again. Running unchanged code again is instant.
- The output has no comments and keeps your messages letter for letter. A
  website gets no styling, images or words your code did not define.
- **To use it:** open **Terminals** and tap **IMY**. The first tap installs it
  (inside the Linux layer on a phone; it needs Python 3.11 or newer on a
  computer). The next tap opens IMY's console. `:header prints a greeting by
  name` writes the header line for you, `:example hello` loads one of nine
  ready programs, `:run` runs your code, and `:help` lists the rest. While a
  model works, the console counts the seconds.
- **Models:** IMY works with Automa's free models with no key. The menu on the
  IMY tile lists them; the one you pick is the one used, and if it is not
  being served that day IMY says so instead of quietly using another.
  `:models check` asks every free model for one word and shows which answer
  now and how fast. Left on "IMY's own setting", IMY uses the free models
  until you run `imy init`, where you can choose your own Anthropic, OpenAI or
  Gemini key, or a server such as Ollama. A compile on the free models takes
  about half a minute to a minute and a half.
- **Updates:** IMY comes with Automa. When a new Automa brings a newer IMY the
  tile says **Tap to update**; if the update cannot finish (no connection),
  the next tap opens the IMY you have.
- **Anyone can install IMY**, also without Automa: it is an open Python
  package of its own (`imagenery`, in the repository's `imy-engine/` folder).
  `pip install "git+https://github.com/Wisk-inc/paperclip@claude/automa-android-apk-uiimmy#subdirectory=imy-engine"`
  installs it on any computer with Python 3.11 or newer, and the wheel file is
  in this release's zip. Real sessions, with their output, are in
  `imy-engine/examples/README.md`.

**Which free models answer right now**
- Free models come and go at their providers, and Automa never answers on
  another model than the one you picked. The Terminals page and the chat's
  model picker now have a **Check** button that asks every free model for one
  word. The lists then mark the ones closed at their provider, so you can pick
  one that answers without trying each. A model that was only busy or at its
  limit is not marked, since it may answer the next time, and the check counts
  those apart ("Marked in the lists: 11. Only busy or at a limit, may answer
  later: 2.").
- A model that did not answer when it was last asked says so in the picker
  ("Did not answer when last asked (3 h ago)"), and is asked again when you
  pick it.
- One more free model: **LFM3 1.7B**, small and fast.

**Terminals page**
- A terminal now starts at the width your screen really shows. It used to
  start 80 columns wide whatever the screen, so on a phone (about 55 columns)
  a tool's first lines broke in the middle of words.
- The tools' names and descriptions are now translated with the rest of the
  board; they used to stay in English in every language.
- **Running now** lists only the terminals whose program is still running.
  One whose program had ended (IMY after `:quit`, an install that finished)
  stayed listed there for a minute, with its Stop button. A tool that finishes
  installing while you are looking at the list now turns **Ready** by itself.
- The installer's own lines (what it is doing, what went wrong) are folded
  between words on a narrow screen, and a failed IMY install no longer ends
  with pip's advice to update pip.

### From 1.9.14

Automa speaks your language: the board, your agents, the connect screen and the
app's own screens.

**Pick your language, or let Auto pick it**
- Your account sheet has a new **Language** row. It offers **Auto** and 40
  languages, each under its own name (Español, العربية, 日本語, हिन्दी…), and
  the list searches by that name, the English name or the name in the language
  you are reading, with or without accents.
- **Auto** follows your phone's or browser's language and shows the country it
  found ("Follows this device: Español (México)"). It understands the old
  language codes some phones still send, Chinese script and region (Hong Kong,
  Macau and Taiwan read Traditional Chinese) and the countries that write
  European Portuguese, and it takes your country from the device's time zone.
  Nothing is looked up online.
- The choice applies at once, stays on the device and is saved to your account,
  so every phone and browser you sign in on uses it. A choice made while signed
  out or offline reaches your account later.
- Dates, numbers and times such as "5 min ago" follow your language and
  country on every screen, even when the phone itself is set to another
  language. Digits are the Western ones (0-9) in every language, so a screen
  never mixes two kinds; month names, separators and calendars are your
  language's own.

**The whole board in your language**
- The main screens (navigation, your account, sign-in, chats and the model
  switcher, the reconnecting notices and the common buttons) are built into
  Automa in all 40 languages, so they show at once, even offline.
- Everything else is translated the first time a screen opens, by Automa's free
  models, and kept on the device and on your server for everyone on it, so each
  screen is translated once per server. Only Automa's own wording is sent: the
  server accepts nothing but the board's own English text, never your chats,
  tasks, names or files. A phrase shows in English until its translation
  arrives.
- Your own words stay as they are: chats, agents' replies, notes, terminals and
  run output are never translated. Messages Automa's server writes into a task,
  such as why a free model did not answer, are still in English.
- Arabic, Persian, Hebrew and Urdu read right to left: the page is mirrored,
  arrows point the other way, a sheet's close button moves to the other side,
  and a name or a piece of code inside a sentence keeps its own order.

**Agents write to you in your language**
- When an agent works on something for you (your comment, or a task that is
  yours), it is told your language and country and writes to you in it. Write
  to it in another language and it answers in that one. Code, commands, names
  and quotes stay as they are. Free agents, every coding-tool agent and Moan do
  this; Moan keeps Patois for English readers.

**The app follows your choice**
- The connect screen opens in your language, right to left where it should be,
  and so does everything it shows while it connects or starts Automa: every
  setup step for Termux and for a computer over ADB, which step Automa is on
  while it starts and how long it has waited, the troubleshooter's notes, and
  the app's own messages, such as why an address did not answer. Commands,
  addresses and Termux's own button names (Paste, Open directory) stay as they
  are, so they match what you see in Termux.
- The board shows the app's own messages in your language too, such as a
  share or download that did not work.
- On Android 13 and newer the app's own screens use your choice too: the
  "No connection" and "Automa is starting" sheets, messages such as "Saved to
  Downloads", the launcher shortcuts and the notification channel. **Auto**
  uses the phone's language. Android also lists Automa in its own per-app
  language setting (Settings → Apps → Automa → Language); a language picked
  there changes the app's own screens until you pick another one in Automa.
  On Android 12 and older the app's own screens follow the phone's language.

### From 1.9.13

Model lists that update themselves as new models come out, with Claude Fable
5.2 and Gemini 4 added; tighter security for accounts, sign-in and the free
models' key; fewer processes on the phone; new free models; and fixes from a
review of everything 1.9.12 added (the repository's checks, its full build and
every page of the board opened again).

**Troubleshoot and Safe start always show their own answer**
- The app asks Termux to start Automa, to start it in safe mode, or to run the
  troubleshooter, and Termux answers each request. All the requests listened
  for those answers in one place, so when two were waiting at once (Automa
  being started while you tapped Troubleshoot, for example), the first answer
  went to both: Troubleshoot could show what `automa start` said as its
  report, and its own report then reached nothing. Each request now has its
  own answer.
- On the connect screen, Troubleshoot now waits while a Safe start runs (Safe
  start already waited for Troubleshoot). Together, Troubleshoot's own start
  could start Automa normally while Safe start was stopping it to start it in
  safe mode.

**The safe mode banner sees a slow return**
- After Restart normally, the banner checks on Automa every 2 seconds and, after
  3 minutes, says Automa hasn't come back yet. It then stopped checking, and
  nothing else in the phone's board asks for that information: an Automa that
  came back later (a first start after an update can take that long) left the
  banner saying it hadn't, until the app was reopened or Refresh was tapped. It
  now keeps checking every 10 seconds, goes away when Automa is back normally,
  and says so when Automa came back in safe mode again.

**Security**
- The key Automa uses for the free models is stored scrambled. Up to 1.9.12 the
  phone server kept it as eleven short readable pieces, which anyone who opened
  the APK could put back together. Every build now checks the board, the phone
  server and the whole APK, and refuses to ship the key in any readable form:
  whole, in pieces or base64-encoded. On a phone you control, someone determined
  can still recover it, since the server has to unscramble it to use it; this
  stops the quick ways.
- The database password and the app key on your phone are locked to Termux
  alone every time Automa installs or updates, including ones an older
  installer left readable.
- Sign-in on a server you share: every caller gets three password tries every
  ten seconds. A caller could get around that by making up a new network
  address for each try (a header anyone can set), and requests without one all
  shared a single limit that anyone could use up. Automa now counts the address
  the connection really comes from, or what a proxy you trust says, and a new
  session records that real address too.
- Only the board itself can show the board's page inside a frame, so another
  website cannot load it hidden and trick you into clicking. API answers tell
  the browser not to guess what they contain, and the server no longer
  announces what software it runs.

**Fewer processes on the phone**
- With PostgreSQL 18, Termux's current version, the database runs three fewer
  processes: its three I/O helpers are off (4 helpers instead of 7, measured).
  Android counts every process against Termux. A database started by 1.9.12
  is restarted with this setting the next time Automa starts. Older PostgreSQL
  keeps its settings, since it would refuse this one.
- The server no longer runs `git` three times every few seconds (on every health
  check, and every 30 seconds) on a phone, where there is no git checkout to
  read.

**Free models**
- New: Ling 3.2 Flash, ERNIE 5.5 Flash Preview and Particle 1, each with a 1M
  context and tools, each checked live before release.
- A free agent with no model picked now runs on Nemotron 3 Ultra, as intended.
  It was trying DeepSeek V4.1 Flash, whose free version its provider has taken
  offline, so it could not answer at all.
- Ten free versions are offline at their providers today, DeepSeek V4.1 Flash
  among them (see [section 9](#9-free-models)). They stay listed, say so in the
  chat, and answer again as soon as the free version is back. Automa never
  answers on a different model than the one you picked.

**Model lists update themselves**
- Every model list follows a public model catalog (every major maker's models,
  with their release dates), so a model that comes out after this version
  shows up without an Automa update: an agent's model choice (Gemini CLI and
  Grok, and Claude Code and Codex when no key reaches the maker's own list),
  App Studio's Anthropic, OpenAI, OpenRouter, Google, Kimi and xAI lists, the
  Terminals model menus (Claude Code, Codex, Gemini CLI), and the chat's model
  switcher, whose **Newest models** section is now the catalog's newest.
- Automa fetches a fresh catalog at most twice a day, in the background, and
  keeps a copy, so the lists stay complete offline and after a restart. Lists
  read newest first: a model out tomorrow lands on top, an older one Automa
  didn't list goes among the models of its time, and App Studio marks the last
  30 days' models **New**. Only models that can use tools are added, since
  every one of these lists works through tools.
- Added now: **Claude Fable 5.2**, **Gemini 4 Carbon** and **Gemini 4
  Hydrogen** (Gemini CLI, App Studio, Terminals), and on OpenRouter Claude
  Fable 5.2, Gemini 4 Carbon and **Qwen 4 Max**. Default models are unchanged.

### From 1.9.12

Automa keeps running on the phone, and gets back up by itself when it can't.

**Termux no longer closes under you (as often), and says why when it does**
- Termux closing while you use it ("[Process completed (signal 9) - press
  Enter]") is Android: version 12 and newer end the background processes of
  apps once all apps together run more than 32, and every Android ends apps
  when memory runs low. Automa now runs lighter: its database starts fewer
  processes (no parallel query workers, one autovacuum worker) and uses less
  memory, and the server keeps 6 database connections at most (it was 10).
  A database started before this update gets the lighter settings the next
  time Automa starts.
- **`automa keep-alive`** lifts Android's process limit for good: it uses
  Wireless debugging once (it walks you through linking it, like
  `automa adb link`), turns the limit off (`settings_enable_monitor_phantom_procs`
  on Android 12L and newer, `max_phantom_processes` on Android 12), takes Termux
  off battery optimisation, reads both back and remembers it. The settings stay
  after the phone restarts. On Android 14 and newer you can also do it by hand:
  Settings → Developer options → Disable child process restrictions.
- When the server stops, Termux says why: Android ended it (signal 9), it
  crashed for want of memory, or the error just above. A launcher that Android
  ended without warning is noticed at the next start. `automa logs` shows the
  end of the log and the record of starts and stops (`~/.automa/events.log`);
  `automa status` shows the last one. `automa start` keeps the previous start's
  log as `server.log.1`.

**Safe start**
- When Automa stops three times in a row within minutes of starting, the
  launcher starts it in **safe mode**: the database, the API and your board,
  with agents, schedules, plugins, runtime services, the Moan index and
  message deliveries off (nothing is deleted or changed). A banner across the
  top of the board says why, with **Restart normally** (Automa restarts at
  once without safe mode, and the banner goes when it is back) and
  **Troubleshoot**. Only when safe mode itself keeps stopping does it wait a
  minute between tries.
- On purpose: **Safe start** on the app's connect screen, `automa start --safe`,
  `automa run --safe` or `automa restart --safe`.

**Troubleshoot**
- `automa troubleshoot` (also `automa fix`) checks Termux, Node.js and
  PostgreSQL, storage and memory, Automa's server files, the database, Automa
  itself, the recent starts and stops, what the last logs say went wrong, and
  Android's process limit. It fixes what it safely can: a database lock left
  when Android ended Termux, an update that stopped between two steps, a
  database that isn't running, and (when storage is nearly full) leftovers of
  updates, the previous log and npm's download cache. It never touches your
  board's data or its backups, and says what to do about the rest.
  `--start` starts Automa afterwards, in safe mode when it kept stopping.
- In the app: **Troubleshoot** on the connect screen (when Automa on the phone
  won't start), on the safe mode banner, and in your account sheet runs it in
  Termux and shows its report in the app.

**Refresh**
- A **Refresh** button in the board's header loads everything on the page
  again and reconnects live updates (a connection can look open after the
  phone slept and bring nothing). What you typed stays.
- Your account sheet adds **Reload app** (the whole board again) and
  **Troubleshoot**. The connect screen adds **Refresh** (ask Automa now), and
  the sheet shown when Automa can't be reached adds **Reload page**.
- `automa restart` stops Automa and starts it again in the background.

**What this release does not do**
- It does not keep a copy of the previous server to fall back to: an update
  removes the old one once the new one is in place, and the database is moved
  forward by the update, so an older server could not open it. The fallbacks
  are safe mode, the troubleshooter's repairs, and the backup Automa saves
  before every update (`automa restore`).

### From 1.9.11

Fixes from another wide scan of the whole app: every page was opened and
watched for errors, every test group was run on its own, the full build and
every repository check were run, and the code changed in 1.9.10 was reviewed
again.

**No more "Failed to fetch" in two more places**
- Saving your name or photo while the connection drops now says "Can't reach
  Automa right now. Check your connection (on a phone, that Automa is running
  in Termux), then try again." instead of the browser's "Failed to fetch". The
  change is not sent twice.
- The App Studio page an invited collaborator uses says "Can't reach this App
  Studio session right now. Check your connection, then try again." instead of
  "Failed to fetch".

**Loads by itself when the connection is back**
- An agent's settings page: the extra settings some AI connections add (Codex,
  Gemini and others) stayed missing for the rest of the session if the page was
  first opened while the connection was down, until the app was reopened. They
  now load by themselves the moment Automa answers, and at once when the
  phone's network returns.
- After the connection comes back, pages you had already left no longer keep
  the board asking the server every 10 seconds; they load fresh when you open
  them again.

**Under the hood**
- The command-line tool (`paperclipai company import <folder>`) packs a company
  folder with Node's own zip checksum: on a 64 MB package that step alone took
  several seconds (longer on a phone), and now takes milliseconds.
- Tests that failed only on a busy machine now wait for what they check, for
  as long as it really takes: the environment settings tests, the command-line
  import/export test that starts the whole server from source, a GitHub
  launcher test that runs about twenty separate launcher processes, a 64 MB zip
  test, the chat channels suite's waits for background deliveries, and five
  route test files that pay a one-time compile of a very large module. A test
  that left its server running after every run now stops it. No app behaviour
  changed with them.
- Four broken links in the developer docs are fixed.

### From 1.9.10

Two fixes from the field: the wait while Automa on the phone starts, and
"Failed to fetch" when the connection drops.

**Opening the app while Automa starts**
- The connect screen used to sit on "Automa finishes starting up" with a bar
  creeping along, saying nothing about what Automa was doing, while Termux
  already looked finished. Automa now reports which step of its start it is
  on, and the screen shows it: "Automa is starting up: checking assigned
  tasks…", how long it has waited, and "step 13 of 23"; the bar follows the
  steps. The sheet over the board while Automa restarts shows the same.
- A step that runs five minutes or more is called out, with what to do.
- A start that stopped (Android closed Termux, or Automa hit an error) is no
  longer shown as "still starting": after about ten seconds without an
  answer the screen says Automa stopped answering, offers Open Termux, and
  asks Termux once to start it again.
- The wait no longer gives up after five minutes while Automa still answers
  that it is starting; it stops only after five minutes with no answer at
  all, and says what to do.
- When `automa run` (or `automa link`) in Termux asks the app to connect while
  the screen is already waiting, the wait carries on instead of starting over
  from the top.
- A key check that got no answer (Automa busy starting) no longer reads as
  "this app's key was not accepted", and the key from Termux is kept.

**Automa on the phone gets to "ready" sooner, and starts more reliably**
- Checking connected apps over the network and tidying every inbox now happen
  right after Automa is ready, not before: on a phone with a slow connection
  they held the start (and the app) for minutes.
- One startup step that fails is written to the log and the start goes on;
  it used to end the whole start, and Automa then restarted over and over.
- The terminal shows each step's time, and says when one is still running
  after 30 seconds.

**In Termux**
- `automa run` while Automa already runs in the background (the app starts it
  with `automa start`) follows that start step by step until it is ready, then
  opens the app on the board. It used to print "Automa is already running" and
  end while the app kept waiting.
- `automa status` says which step a starting Automa is on.
- A pid file or PostgreSQL lock file left behind when Android ended Termux no
  longer stops Automa from starting, and its old process number is never sent
  a stop signal when another program has it now.
- An Automa that keeps stopping while it starts waits a minute between tries
  (instead of every 3 seconds) and says where the error is; `automa stop` ends
  that wait at once.

**No more "Failed to fetch"**
- When the Wi-Fi drops or the server restarts, the board keeps what it shows,
  with a short "Can't reach Automa right now" note. It checks every few
  seconds, and the moment the connection or the server is back it loads again
  by itself: no reopening the app, nothing typed lost. The app tells the board
  as soon as the phone's network returns.
- The whole board is no longer replaced by one red line ("Failed to fetch")
  that stayed until the app was reopened.
- A dropped connection no longer sends you to the sign-in page.
- When there is nothing to show yet, "Reconnecting to Automa…" says so, with
  **Try now**.

### From 1.9.9

Fixes from a scan of the whole app: every page was opened and watched for
errors, every test group was run on its own, and a live agent was put through
a chat with a web search and a task with a review.

**When the free AI service says "slow down"**
- The free AI service limits how fast one phone, network or the shared free
  allowance may send requests, across all models, and answers "Too many AI
  requests ... Try again in a minute" when the limit is reached. Automa used
  to treat that like a busy model: it asked again four times within 25
  seconds, all inside that minute, then failed the reply saying the model
  "is busy at its provider" and suggesting another model, which could not
  help. The automatic retry then started the whole reply over, web search
  and all.
- Automa now waits the time the service asks for and carries on with the same
  reply. One refusal holds every other call too (another agent, a teammate in
  App Studio, the model's second route), so nothing is sent just to be
  refused. The transcript says so while it waits: "The free AI service asked
  Automa to slow down ... Waiting about 60 seconds, then carrying on."
- If the limit still stands after the waits, the message says what it is and
  that another model will not answer sooner. The model is no longer marked
  busy in the switcher for it.

**Home and deleted chats**
- Home's agent cards no longer show "Task unavailable" over a dead link for
  chats and tasks you deleted. The list of recent runs used to name the task
  of every run, deleted or not, and the page asked the server for each one.
  Past runs of a deleted task are now left out, and a live one is shown
  without a task.
- Deleting a chat or task also cancels the runs still waiting for it: a retry
  scheduled for later (hours away when a model's daily limit has to reset)
  or a queued follow-up. They used to keep the agent "still working", which
  blocked removing the agent until the retry's turn came.

**Connections**
- The bring-your-own page (`/apps/byo`) and the Vercel connect page were
  taken for the detail page of a connection named "byo": they opened with
  the wrong sidebar and asked the server for a connection that does not
  exist. Both layouts now share one list of the Apps pages that are not
  connections, checked against the router by a test.

**Small things**
- A web search called with no query (some models do that) tells the model to
  give one, instead of "No results."
- In a phone browser, a haptic that plays as a screen appears no longer asks
  the browser to vibrate before the first touch (the browser refused and
  logged an error). The app's own haptics are unchanged.
- Android lint is clean.

### From 1.9.8

Fixes under the hood, found by running every check in the repository and by
chasing two failures seen while making the website screenshots. Nothing on
the screen changes; the phone's Automa and the agents' tools get sturdier.

**Automa on the phone starts even with a poisoned queue**
- A queued run whose wake receipt could not be verified (a queue left behind
  by an older version, or a receipt that no longer matches the run) used to
  throw inside startup recovery, and the whole server failed to start with
  "Paperclip server failed to start". The run is now cancelled with the
  reason on it, the agent's other queued runs start, and the task behind the
  cancelled run is woken afresh.
- Any other failure while claiming one queued run is logged and skipped for
  that cycle instead of stopping the agent's other runs or the startup.
- Cancelling a queued run from inside the scheduler (agent gone, budget
  reached, task on hold, unverifiable receipt) no longer stalls the agent's
  scheduler for 30 seconds: the release of the run's task asked to start the
  agent's next run while the scheduler already held that agent's start lock,
  and waited for the lock to be declared stale. The request is now served
  right after the lock is released.

**Web search with a second source**
- When DuckDuckGo refuses a network with its bot check (a 202 "anomaly" page)
  or answers an error, the search falls back to Bing's results feed, so an
  agent's web tools keep working on networks DuckDuckGo blocks. DuckDuckGo
  stays first.
- A search that fails on every source says what each source answered, for
  example "DuckDuckGo answered with a bot check; Bing answered 403", instead
  of a bare status code.

**Free-model agents on tasks (from the website work, not in 1.9.7's APK)**
- After answering a task, a free-model agent hands the task back for your
  review (it goes to In review with an approval in the Inbox) instead of
  leaving it for the recovery sweep to mark blocked.
- A tool that fails three times in a row is dropped for the rest of the run
  and the agent is told to answer with what it knows, instead of calling it
  until the turn limit and burning the whole budget.

**Privacy policy**
- Rewritten for the build on APKPure: no cloud account, telemetry off on the
  phone, Google sign-in and push only in Firebase builds, exactly what goes
  to a model, web tools (now naming Bing as the fallback), Moan's index,
  connected apps, App Studio, the phone shell, and what the app keeps. The
  same text is on the website, in the app's connect screen and behind the
  account sheet's Privacy link.

**Android**
- Two version checks that could never be false (the app needs Android 8.0)
  are gone, as lint asked.

### From 1.9.7

Two fixes from the field, both on the phone.

**Coming back to the app stays on your page**
- Switching to another app (Termux, say) and back no longer sends you to the
  connect screen with "Waiting for Automa…". The app used to give up on your
  phone's Automa after a single unanswered check (Android pausing Termux for a
  moment, or Automa restarting after an update), go to the connect screen and
  ask Termux to start an Automa that was already running. It now checks a few
  times before it concludes Automa is gone.
- While Automa says it is still starting (its database, or the recovery after
  a restart), a sheet says **Automa is starting** over your page and checks
  every few seconds; the page comes back by itself when Automa is ready.
- When Termux starts Automa (`automa run`) it opens the app with a connect
  request. With the board already open on that server, the page now stays
  instead of reloading and landing on the connect screen.
- Coming back after Android ended the app in the background (low memory): the
  app proves your phone's Automa still holds the app key, then opens the page
  you were on. It no longer re-runs the launch that started the app (Change
  server showed the connect screen over a board that was fine), and the
  restored page can reach the phone straight away (its page key was missing
  until the next full load).
- The connect screen's wait tries to connect once before asking Termux to
  start Automa.

**Deleting a chat while the AI is replying**
- The reply is stopped at once. A free model used to keep writing to the end
  and then fail on a chat that was gone, which also marked the agent as
  failed. Stop and pausing the agent stop it the same way now.
- The chat page leaves the deleted chat before anything refreshes, instead of
  flashing "not found" or an empty new chat for a moment.
- Deleting never waits more than ten seconds for a reply that is slow to
  stop (a tool call that ignores the stop); the chat goes and the reply ends
  on its own.
- A chat that has not started yet is never sent to the server for deletion
  under its placeholder id.

### From 1.9.6

1.9.6 is a fixes release: a full check of the app, area by area, with every
problem found fixed and tested. What changes for you:

**Safer on your phone**
- The app proves that the Automa on your phone really holds the app key
  before it sends the key, and never sends it to another program on the phone
  (another port on 127.0.0.1). Automa refuses to start on another port when
  3100 is taken, instead of moving somewhere the app would follow.
- Agents and terminals no longer see the server's database password or its
  sign-in secret.
- An invite can't give more than the person who made it has, and Google
  sign-in no longer joins an existing unverified account with the same email.
- Deleting an organization takes its owner, and only when deletion is turned
  on for the server.

**Signing in, out and joining**
- Sign out sticks (it used to sign straight back in with Google).
- Invite-only servers let invited people in, including with Google, and an
  invite page you open while signed in no longer accepts it by itself.
- Admins can reach the Invites tab.

**Connectors (Notion, GitHub and more)**
- Signing in to a connector in the Android app works: the provider's page
  opens inside Automa with a bar naming the site and a **Cancel** button, and
  comes back to Automa when you are done. (Providers that refuse in-app
  browsers, such as Google sign-in, still can't be used from the app.)
- A reconnect that fails or that you cancel says so on the app's page, with
  GitHub's install link when that is what is missing. Unfinished connectors
  say **Setup incomplete**, and a custom connector's **Connect** no longer
  sends you round in a loop.

**Agents, keys and costs**
- A key or sign-in added while hiring becomes your default, so the agent uses
  it; if that step fails you see why, and trying again doesn't save the key
  twice. **Connect another account** in an agent's settings does the same.
- Hiring a Claude agent on the Anthropic API finishes (its test never passed
  before). Free-model agents keep the thinking level you picked.
- An agent's settings offer only the shared accounts it may use.
- Each key's spend line says it is the provider's spend across all keys, with
  the reason when there is no balance to show.
- Agent budgets can be set on **Costs > Budgets** and are enforced (a built-in
  agent's monthly budget never was). Budget warnings no longer look like
  stops, and a paused organization says it stays paused and offers
  **Resume**. "This month" follows the budget's month everywhere.

**Chats**
- Removing an agent deletes its chats and their files (they used to become
  tasks everyone could see). Hires waiting for approval aren't offered as
  chats, renaming an agent keeps its chat links working, and a failed
  settings check says so instead of "Agent Chat is off".

**App Studio sharing**
- Stopping sharing (or removing someone, or an expired link) changes the
  preview link. Guests no longer see your AI chat. Accepting a guest's change
  never overwrites your newer edits without asking.

**Your phone**
- One Automa per phone: a second server can't start on another port.
- Pushes go to the right phone and the right server; a forgotten server's
  pushes are dropped.
- Shared files and folders stay tied to the server they belong to, and
  restore and backups are safer.

**Terminals and App Inspector**
- Claude Code and Codex show as installed on a phone (they always said Tap to
  install). A missing Python is explained with the command that fixes it, and
  the page no longer crashes when it opens.
- Deleting an App Inspector project while it decompiles stops the whole job.
  On a computer without jadx, the Java option says so up front.

Not done yet: opening an invite web link straight into the Android app (open
it in the app by pasting it on the no-access page).

**Fixed earlier in 1.9.6: connecting and signing in**
- While Automa is starting up, the connect screen says it is still starting
  (it used to say "not an Automa server" or "Nothing answers on this phone"),
  and for Automa on this phone it waits with its progress steps.
- Automa on this phone that is locked to the app, when the app has no key yet:
  the screen says so before anything else and opens **Paste the app key**,
  instead of saying Connected and then bouncing back.
- When a server has its own accounts, the success screen says you sign in
  next.
- The sign-in page shows **Continue with Google** on servers that accept it
  (it never appeared before), says passwords need at least 8 characters, and
  says when a password is too short (it used to say fields were missing).
  Invite-only servers no longer offer **Create one**.

### From 1.9.5

**Notifications when AI work finishes while you are away**
- When an agent replies to something you sent, or an App Studio job finishes,
  while you are outside the app, you get a notification with the first lines
  of the reply. **Tap it to jump straight to that chat, task or App Studio
  project.**
- On the phone they are Android notifications. In a browser they are system
  notifications (Automa asks once, the first time you send something to an AI),
  and clicking one brings the board forward on that screen.
- Only replies to what you asked (or the task you had open) notify you, never
  the agents' routine background work. A newer reply on the same chat replaces
  the older notification instead of piling up.
- When your server has a Firebase service account set up, it also sends the
  same notification as a push, so it still arrives after Android has put the
  app to sleep. The phone shows one notification, not two, and none while you
  are looking at Automa.

**App Studio's Stats tab is live**
- While the AI works, a **Working now** panel shows a running clock, what it is
  doing this second, steps and files changed, and every model at work with its
  status (Working, Done, Failed), what it is doing and its tokens as they count.
- **Latest moves:** the newest steps across the team, each with who took it and
  how long ago.
- Six totals for the chat: Models, Tokens, Cost, **Would cost**, Steps and Files.

**Costs show what free work would have cost**
- Free-model work is priced at the paid versions' list prices: each reply says
  "Free · worth $0.42", each model's line on the Stats tab and on the 30-day
  App Studio card says what it would have cost, and the card adds it all up.
- A team that mixed free and paid models shows both, for example
  "$0.12 · worth $0.40".

**The AI sees the page the way you do (`view_app`)**
- After building or changing a page, the AI opens it in your App Studio at a
  phone (390×844) or desktop (1280×800) size, out of sight, with its scripts
  running, and reads what is on the screen top to bottom: headings, text,
  buttons, inputs and images with their sizes and positions.
- It also gets the page's console errors, files that failed to load, and layout
  trouble: sideways scrolling, buttons too small to tap, cut-off text and
  hard-to-read colors. It fixes them and looks again.
- When App Studio is closed, it reads the page's HTML instead.

**Bigger teams and a live preview**
- Up to **8 teammates** (was 4) and **10 assignments** at once (was 6).
- The preview **reloads by itself** a moment after files change, so it always
  shows the latest page. The ⚡ button beside reload turns that off and on.

### Also new in 1.9.4

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

**Notifications**
- When an AI reply or an App Studio job finishes while you are outside the app,
  a notification says so; tap it to open that chat, task or project.
- Automa asks for permission once, the first time you send something to an AI.
  Turn them off in Android's app settings (or your browser's site settings).
- You are notified about replies to what you sent and the task you had open,
  not the agents' routine background work.

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
- **Newest models** at the top: the major makers' newest models, which update
  by themselves as new ones come out.
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
| Ling 3.2 Flash (new in 1.9.13) | 1M |
| ERNIE 5.5 Flash Preview (new in 1.9.13) | 1M |
| Particle 1 (new in 1.9.13) | 1M |
| LFM3 1.7B (new in 1.9.15) | 262k |
| Free Router (routes each question to an available free model) | 200k |

A free agent with no model chosen runs on Nemotron 3 Ultra 550B.

**Image models:** SDXL Lightning (fast; the default pairing for every free chat
model) and SDXL Base 1.0.

**Every model stays listed** and says how it is doing: ready, busy, at today's
free limit (and when it is back), or closed by its provider. Broken models are
never hidden; they fail gracefully, and Automa never answers on a different
model than the one you picked.

As of 17 November 2026 the providers of ten of these have taken their free
versions offline: Nemotron 3 Super 120B, Nemotron 3.5 Content Safety, DeepSeek
V4.1 Flash, Qwen 3.8 27B Abliterated Cyber, Inkling, Inkling Small, Atria Dawn
Preview, Apodex 1.1 Mini, LFM 2.5 2.6B and Xing 4.0 29B A4B (only paid versions
remain). Each says so in the chat, Automa checks again every few minutes, and
it answers again as soon as the free version is back.

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
waits the minute out when the free AI service asks Automa to slow down,
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
- **Slow-down:** when the free AI service says too many requests reached it
  in a short time (from this phone, its network or the shared allowance),
  every call waits the time it asks for, a minute usually, and then they go
  out one after another instead of all at once.
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
  models or your key). Open files are tabs above it; a line under it shows the
  cursor's line and column, the language and whether the file is saved; on a
  phone a row of keys adds Tab, brackets and other symbols. Edits save on their
  own, and everyone in the project sees them as they are typed.
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
  is saved in Studio. The Anthropic, OpenAI, OpenRouter, Google, Kimi and xAI
  model lists add new models by themselves, newest first, marked **New** for
  their first 30 days.
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
- **Sees the page like you do (`view_app`):** it opens the running page in your
  App Studio at a phone or desktop size, out of sight, and reads what is on the
  screen (text, buttons, inputs, images, sizes and positions), the console
  errors and failed loads, and layout trouble (sideways scrolling, small tap
  targets, cut-off text, hard-to-read colors), then fixes what it found and
  looks again. With App Studio closed it reads the page's HTML.
- **Live preview:** the preview reloads by itself a moment after files change;
  the ⚡ button beside reload turns that off.
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
- **Stats tab, live:** while the AI works, a running clock, what it is doing,
  steps and files changed so far, and every model at work with its status and
  live tokens; then the totals (models, tokens, cost, what it would have cost,
  steps, files), tokens per model, the latest moves with how long ago, and
  everything each team said.
- Each teammate knows what you asked and who else is working. Up to eight
  teammates and ten assignments per run, and teammates never nest.

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
and Home. Free models cost nothing; each reply, the Stats tab and the 30-day
card also say what the same tokens would have cost on the paid versions
("Free · worth $0.42").

---

## 19. Terminals

A real coding terminal on the device: **Claude Code, Codex, Gemini CLI,
OpenCode** and others in their full terminal UI, over a PTY relay, on a
proot-distro Debian layer the page sets up for you.
- Wire a terminal to an agent so it works with that agent's key, and **pick a
  model per tool** (Claude Code's, Codex's and Gemini CLI's menus add new models
  by themselves).
- A **Free models chat** with nothing to install.
- **IMY** (Imagenery), the strict blueprint compiler from `imy-engine/`.
  Install it from the page; on a phone it goes into the Debian layer. Then
  open it, type IMY code line by line under a `# ("...")` header, and `:run`
  it. The console reads like the file you are writing: its first line is the
  name of the program file your code becomes, each line stands behind its
  number, and the code it became appears under it.
  - Two menus on the tile: the **model** (the free models, no key; or IMY's
    own setting, which is your own key once you run `imy init`) and the
    **language** your code becomes (Python, JavaScript, Ruby, Rust, C, Go,
    Assembly and thirteen more; `:target` switches inside the console, and
    `:languages` lists all 48).
  - `:import my-folder` takes in a project you already have, so your IMY code
    can use its functions and variables by name.
  - A program its own build tool refuses is handed back to the model and
    corrected before it runs.
  - Outside Automa, anyone can install it on a computer with Python 3.11 or
    newer:
    `pip install "git+https://github.com/Wisk-inc/paperclip@claude/automa-android-apk-uiimmy#subdirectory=imy-engine"`.
- A **Check** button asks every free model for one word and marks, in the
  Free models and IMY menus, the ones closed at their provider. A model that
  was only busy or at its limit is counted apart and left unmarked.
- Terminals run where Automa runs (on the phone when Automa runs in Termux). If
  the server is older than the app, the page offers the update.

---

## 20. App Inspector

Pick an app on your phone to decode its manifest, resources and code, read the
code as Java, chat with an AI about the app or any file, edit, and rebuild a
signed APK to your Downloads. For apps you made or are allowed to analyze.

- **App picker:** the apps installed on the phone with names and icons, plus an
  **APK** button to upload any `.apk`.
- **App sheet:** Open (decompile), **Ask an agent about this app**, copy the
  package name, and the APK itself.
- **Decode options:** resources (apktool), smali, Java (jadx). Decoding runs
  apktool and jadx in parallel on every core.
- **Project explorer:** a Files view (AndroidManifest.xml, res/, smali/) and a
  Java view, search across the project, an app info panel (package, version,
  SDKs, launcher activity, permissions, components), the decode log, and an
  editor for text files.
- **Chat** about the app or the open file, right in the inspector: on the free
  models with no key, or on Claude with your Anthropic key. The model is given
  the app's summary and the open file, or the files your question names; the
  conversation is kept with the project. **Ask an agent instead** opens a chat
  with one of your agents that already knows where the project lives and how to
  launch, screenshot and drive the app over adb once `automa adb link` has been
  run.
- **Rebuild:** apktool rebuild, zipalign and apksigner with an inspector key,
  saved to `Downloads/Automa`.
- apktool, apksigner and jadx must be installed where Automa runs. On a phone
  the App Inspector installs them the first time it decodes (through Termux
  packages, or apktool's own release jar when the package won't install).

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
- **What free work would have cost:** App Studio's replies, Stats tab and 30-day
  card price free-model tokens at the paid versions' list prices.

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

**Language** (account sheet): **Auto** (your phone's or browser's language, with
the country it found) or one of 40 languages. It is saved to your account and
used by the board, by your agents when they write to you, by the connect screen
and, on Android 13 and newer, by the app's own screens. See
[section 2](#2-whats-new-in-1914).

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
3. The installer sets up Node.js and PostgreSQL (plus git, Python and
   proot-distro for tasks and Terminals), the server, and an `automa` command,
   then starts Automa on `127.0.0.1:3100`, locked to
   the app. The first install downloads about 380 packages (10 to 45 minutes);
   updates are much faster. The connect screen shows each step with a progress
   bar and opens the board when the server answers.
4. Set Termux's battery use to **Unrestricted**. With **Termux:Boot**, Automa
   starts when the phone boots.

**The `automa` command**

| Command | What it does |
|---|---|
| `automa run` | Run in the foreground, restarting the server if it stops (with one already running in the background, it follows that start until it is ready) |
| `automa start` | Run in the background (log in `~/.automa/server.log`, the previous one in `server.log.1`) |
| `automa run --safe` / `automa start --safe` | The same in safe mode: the board opens with agents, schedules and plugins off (Automa also starts this way by itself after stopping three times in a row while starting) |
| `automa restart` | Stop it and start it again in the background (`--safe`: in safe mode) |
| `automa stop` / `automa status` | Stop it / check it (a starting Automa says which step it is on; also the last start or stop) |
| `automa logs` | The end of the log, and when and why Automa last started and stopped |
| `automa troubleshoot` | Check Termux, storage, memory, the server files, the database and Automa; fix what it safely can; say what to do about the rest (also `automa fix`; `--start` starts Automa afterwards) |
| `automa keep-alive` | Stop Android 12 and newer from ending Termux in the background (uses Wireless debugging once; `--check` says whether it was done) |
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
  web pages, and is stored scrambled; every build checks the app, the board
  and the phone server for it in any readable form and refuses to ship it.
  The server has to unscramble it to use it, so someone with your phone and
  time can still recover it; this stops the quick ways.
- On the phone, the database password and the app key are readable by Termux
  alone, checked again on every install and update.
- Sign-in tries are limited per caller (three every ten seconds). The caller is
  the address the connection really comes from, or what a proxy you trust
  says; a made-up address in a header changes nothing.
- Only the board itself can show the board's page in a frame, so another
  website can't load it hidden to steer your clicks.
- Translating the board sends only the board's own English wording to the free
  models: the server refuses any other text, so names, chats and tasks are never
  sent. Translations are checked (same placeholders, no links or markup the
  English lacks) and each person can have at most 2,000 new phrases translated
  an hour.
- Your language choice is yours alone: only you can read or change it, and an
  agent is told only your language and country.

**Agents and App Studio**
- Free agents' web tools never reach private or local network addresses.
- App Studio previews run in a sandbox with no access to Automa or your
  sign-in; App Studio never writes outside the project folder.
- When the AI looks at a page (`view_app`), only your own App Studio renders it
  (never a guest's), the page answers only the App Studio around it, and the
  preview link's secret is left out of every address it reports.

**Notifications**
- A notification shows the first lines of an AI reply, so they can appear on
  the lock screen; Android's lock-screen setting decides.
- Without a Firebase service account on your server, notifications come from
  the app itself and nothing leaves your server for them.
- Governed actions wait for your approval, and budgets stop spending.

**Privacy:** your organizations, tasks, chats and files live on your own Automa
server (your computer, a VM, or your phone). The app talks to the server you
connect it to, and to Google only for Continue with Google and push
notifications when those are set up. Free-model requests go from your server to
the free AI service Automa uses. The model lists' catalog is a public list your
server downloads (nothing about you is sent). Translations of the board are
made from Automa's own wording and shared by everyone on your server. Moan's
knowledge index holds only public Jamaican web pages.

The full threat model is in `doc/AUTOMA-SECURITY.md`.

---

## 27. Troubleshooting

| You see | What it means | Do this |
|---|---|---|
| **Update Automa on this phone** on Terminals or App Inspector | The phone's server is older than the page. | Tap it, Send to Termux, paste the command (or `automa update`). |
| "App not installed" / "conflicts with an existing package" | The installed Automa was signed with a different key (1.8.1 or older). | Uninstall Automa, then install. Board data lives in Termux and is kept. |
| Termux "RunCommandService requires allow-external-apps" | Termux hasn't let the app run commands yet. | Use the app's one-tap fix, or run the installer again. |
| The connect screen keeps waiting | Automa is still starting (the screen shows its current step and time), it stopped (the screen says so), or the address is wrong. | `automa status` in Termux shows the step; `automa run` follows the start; check the address (not the Wireless debugging one). |
| "Automa needs Node.js 24 or newer" in Termux | Termux packages are old. | `pkg upgrade -y`, then run the install command again. |
| Termux shows "[Process completed (signal 9)]", or Automa stops while you use it | Android ended Termux's processes: Android 12 and newer limit how many processes apps run in the background, and every Android ends apps when memory runs low. | `automa keep-alive` (once); set Termux's battery use to Unrestricted; close apps you aren't using. `automa logs` shows when it happened. |
| A **Safe mode** banner across the top of the board | Automa kept stopping while it started, so it started without agents, schedules and plugins (or you asked for a safe start). | **Troubleshoot** on the banner (or `automa troubleshoot`), fix what it says, then **Restart normally**. |
| The board looks stuck or out of date | A page or the live updates missed something. | **Refresh** in the header; **Reload app** in your account sheet reloads everything. |
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
| 1.9.17 | 2026-11-22 | App Studio's code screen: open files as tabs, a status line (line and column, language, saved), a key row on phones. A busy free model offers Try again and Ask another model instead (your tap switches; never a silent swap); a new chat starts on a model that is answering. App Inspector: a chat about the app or the open file, on the free models with no key or Claude with your key; an APK opened from a file is decoded in full, and **Decode again** repairs older projects. 49 fixes across App Studio, App Inspector and the free models. The ones you would have noticed: a free model at its daily limit is recognised at once instead of being retried as busy for half a minute; saves are retried and never reported as someone else's change; switching apps no longer shows the first app's file; a sideways phone gets one pane at a time; and files that are not UTF-8 are read-only in App Inspector instead of being damaged by a save. App Inspector search reads `.toml` and `.tsv`. IMY 1.1.2: `imy import` skips `bazel-out` and `zig-out`. A few waits are longer for slow phones and networks. |
| 1.9.16 | 2026-11-22 | IMY 1.1.1: its console reads like the file being written. It opens with one line, the name of the program file the code becomes (`main.py`, `main.rb`…); each line is typed behind its number and a bar and set again in colour once entered; the code a line became appears under it with its own number in the program file (`:code` and `:convert` show the whole file the same way); a block keeps its indentation and Tab indents; `:run` prints only what the program prints (no "compiled to", no "exit code 0"), commands answer in a word and the hints are gone. Fixes: lines pasted at once are numbered one by one; `:: end` is code, not an unknown command; a result is no longer written into a line being typed; a newer result replaces the older instead of showing a program line twice; keys pressed during a compile no longer land in the line that counts the seconds; closing the terminal keeps the lines typed |
| 1.9.15 | 2026-11-22 | IMY (Imagenery) in Terminals: a strict compiler for code written in your own syntax under a `# ("...")` header; it refuses English requests, more than one `.auto…` shortcut, switches for features the code never builds, and anything used before its definition, naming the lines; each line is converted as you type it, and the result shows above the line being typed; a language menu on the tile (20 languages) and `:target` in the console choose what the code becomes, with 48 languages known and 42 built and run, down to assembly for the device's processor; `:import` takes in an existing project so its functions and variables can be used by name, in any target language; a program its own build tool refuses is corrected by the model before it runs; nine ready examples, `:header`, seconds shown while a model works; what a file defines is remembered for later files; free models with no key (the model you pick is the one used) or your own key after `imy init`; installs from the page (in the Linux layer on a phone), says Tap to update when a new Automa brings a newer IMY, and installs anywhere with pip. A Check button on Terminals and in the chat's model picker asks every free model for one word and marks the ones not answering; a model that did not answer when last asked says so; one more free model (LFM3 1.7B); a terminal starts at the width the screen really shows, so a tool's first lines no longer break mid-word on a phone; the Terminals tools' names and descriptions are translated; the check counts models that were only busy apart from the ones it marks; Running now lists only terminals still running, and a tool that finishes installing in the background turns Ready by itself; the installer's own messages fold between words on a narrow screen |
| 1.9.14 | 2026-11-18 | Languages: Auto (the device's language, with its country) or one of 40, saved to your account; the main screens built in, the rest translated by the free models on first sight and kept for everyone on the server (only Automa's own wording is sent); right to left for Arabic, Persian, Hebrew and Urdu; dates and numbers follow language and country; agents write to each person in their language; the connect screen and, on Android 13+, the app's own screens, shortcuts and notification channel follow the choice |
| 1.9.13 | 2026-11-17 | Model lists update themselves (agents, App Studio, Terminals, the chat's Newest models), newest first; Claude Fable 5.2, Gemini 4 Carbon and Hydrogen, Qwen 4 Max; security: the free models' key stored scrambled and checked out of every build, phone secrets locked to Termux, sign-in limits per real caller, no framing of the board; PostgreSQL 18 runs three fewer processes and the server stops running git every few seconds; free models Ling 3.2 Flash, ERNIE 5.5 Flash Preview and Particle 1, and no-model agents on Nemotron 3 Ultra; review fixes: Troubleshoot, Safe start and Start each get their own answer from Termux, Troubleshoot waits during a Safe start, the safe mode banner sees a slow return |
| 1.9.12 | 2026-11-17 | Keeps running: a lighter database and fewer connections, `automa keep-alive` lifts Android's background process limit, Termux says why Automa stopped (`automa logs`); safe start (by itself after three quick stops, or on purpose) with a banner offering Restart normally and Troubleshoot; `automa troubleshoot` checks and repairs, also from the app with its report shown there; Refresh in the header, Reload app, Refresh and Reload page on the connection screens; `automa restart` |
| 1.9.11 | 2026-11-16 | Wide-scan fixes: saving your name or photo and the App Studio guest page say "Can't reach…" instead of "Failed to fetch"; an agent's settings page loads its extra AI-connection settings by itself once Automa answers (they used to stay missing until the app was reopened); pages you left stop asking the server after a reconnect; company folders pack with Node's own zip checksum (seconds to milliseconds for 64 MB); load-sensitive tests made reliable; four doc links fixed |
| 1.9.10 | 2026-11-12 | The wait while Automa on the phone starts shows the step Automa is on, its time and "step x of y", tells a stopped start from a slow one (and asks Termux once to start it again), and no longer gives up while Automa still answers; Automa reaches "ready" sooner (network checks and inbox tidying after ready) and one failing startup step no longer ends the start; `automa run` follows a background start until ready, `automa status` shows the step, stale pid and PostgreSQL lock files no longer block a start; no more "Failed to fetch": the board keeps its page during an outage and reloads by itself when Wi-Fi or the server is back, and a dropped connection no longer signs you out. |
| 1.9.9 | 2026-11-09 | Scan fixes: Automa waits out the free AI service's own rate limit (once, for all agents) instead of four quick retries and a failed reply that blamed the model; Home shows no "Task unavailable" cards for deleted chats and tasks; deleting a chat or task cancels the retries still waiting for it, so its agent can be removed; the bring-your-own and Vercel connect pages no longer open as a connection named "byo"; a web search without a query asks for one. |
| 1.9.8 | 2026-11-08 | Fixes under the hood: Automa on the phone starts even when an old queued run is poisoned (the run is cancelled, the others start), cancelling a queued run no longer stalls the scheduler for 30 seconds, web search falls back to Bing when DuckDuckGo refuses, a failed search names what each source answered, free-model agents hand tasks back for review and drop a tool that keeps failing, and the privacy policy is rewritten for the APKPure build. |
| 1.9.7 | 2026-11-03 | Coming back to the app stays on your page: your phone's Automa is checked a few times before the connect screen, "Automa is starting" shows over the page while it starts, a connect request from Termux keeps the open board, and the page you were on comes back after Android ended the app in the background. Deleting a chat while the AI is replying stops the reply at once, leaves the chat before refreshing and never waits more than ten seconds. |
| 1.9.6 | 2026-11-02 | A full check of the app with every problem found fixed: the app proves your phone's Automa holds its key before sending it; agents and terminals no longer see server secrets; invites can't give more than their maker has; sign-out sticks; connectors sign in inside the Android app; keys added while hiring become your default; agent budgets can be set and are enforced; removing an agent deletes its chats; App Studio sharing is safer; one Automa per phone; Terminals show Claude Code and Codex as installed on phones. Plus the connect and sign-in fixes: "still starting" instead of "not an Automa server", a locked phone server without its key says so up front, Continue with Google shows where it works. |
| 1.9.5 | 2026-10-30 | Notifications when an AI reply or App Studio job finishes while you are away, with a tap that opens that chat, task or project (Android and browser; also server push with Firebase); a live App Studio Stats tab (running clock, each model's status and tokens, latest moves, steps and files); costs say what free work would have cost; the AI sees the page like you do (`view_app`: phone and desktop sizes, console errors, layout trouble); teams of up to 8; the preview reloads itself when files change. |
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
