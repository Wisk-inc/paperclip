# Imagenery (IMY)

IMY is a strict, syntax-agnostic **blueprint compiler**. You invent your own syntax, variable
names and variable packs, and you code every mechanic yourself. IMY checks the blueprint
against hard rules, has an AI model compile it in the background, proves the output is clean,
and runs it. It never edits your `.imy` file and never invents behaviour you didn't write.

IMY is not a chat prompt. A line like `hello make me a calculator app` is rejected before any
AI call.

```text
# ("prints a greeting with the user's name and how many letters the name has")
name = "Ava"
letters = count(name)
show ("Hello, " + name + "!")
show ("Your name has " + letters + " letters.")
```

```console
$ imy run hello.imy
Hello, Ava!
Your name has 3 letters.
```

## Install

IMY is open source and runs wherever Python 3.11 or newer does: Linux, macOS, Windows, and a
phone (in Automa, or in Termux). Anyone can install it. Pick whichever line fits:

```console
pip install imagenery
pip install "git+https://github.com/Wisk-inc/paperclip@claude/automa-android-apk-uiimmy#subdirectory=imy-engine"
pip install imagenery-1.1.1-py3-none-any.whl
```

- The first is the usual way once the package is on PyPI. If pip answers that it finds no
  such package, it is not published yet: use the second line.
- The second installs straight from this repository and needs only `git`. The part after `@`
  is the branch IMY lives on until it is merged; after that, leave `@…` out.
- The third installs a wheel file you were given (one comes with every Automa release).

`pipx install` in place of `pip install` gives IMY its own environment and puts `imy` on your
PATH, which is the tidy way on a computer where Python belongs to the system.

Then choose who compiles for you:

```console
imy init                       # pick a provider, a model and your key
imy doctor                     # shows what IMY will use and which languages run here
```

You need one of: a key from Anthropic, OpenAI or Google; a server that speaks the OpenAI
protocol, such as a model running on your own machine with Ollama, which costs nothing
(`imy init --provider openai-compatible --base-url http://localhost:11434/v1 --model llama3.1`);
or Automa, which brings its free models.

**In Automa:** open **Terminals → IMY**. Automa installs IMY for you and connects it to
Automa's free models, so no key is needed. The tile has a menu for the model and one for the
language your code becomes. You can still switch to your own key with `imy init`.

## Quick start

```console
imy init                                   # provider, model, key; creates .imy/ here
imy examples                               # the ready programs that come with IMY
imy examples hello --copy                  # write hello.imy into this folder
imy check hello.imy                        # rules + AI validator, nothing runs
imy check hello.imy --static               # only the free deterministic rules
imy run hello.imy                          # validate, remember, compile, run
imy run hello.imy --to javascript          # compile to JavaScript and run it with node
imy run hello.imy --watch                  # run again each time you save the file
imy convert hello.imy --to rust -o hello.rs
imy console                                # type IMY line by line: each line is converted as you go
imy console --to ruby                      # the same, into Ruby (or any other language)
imy languages                              # every language IMY converts to, and which run here
imy import ./my-project                    # use an existing project's functions and variables by name
imy models --check                         # which models answer right now, and how fast
```

While a model works, IMY shows how long it has waited, and afterwards which model compiled
the program and in how many seconds. A second run of unchanged code comes from the cache at
once. Real sessions, with their output, are in [examples/README.md](examples/README.md).

## The rules

IMY validates in two stages: deterministic Python checks first (free and instant), then a
strict AI validator. Any error cuts everything off with a report that names the exact lines.
Nothing runs until the whole program is clean.

### 1. Header contract

Every file starts with `# ("...")`, which says what the code builds and how it works. Every
function block (`def`, `fn`, `func`, `function`, ...) needs its own header on the line above it.
A function block is a function word, a name and `(`, or a name followed by `:` or `{` alone:
`fn jump(height)`, `def area:`, `func start {`. A line such as `define speed = 5` or
`sub total = price - discount` is an ordinary line and needs no header.

```text
# ("adds two numbers and shows the sum")
def add(a, b):
    show (a + b)
```

The header only guides how IMY reads your code. IMY implements **only what the code lines
define**. A feature that appears only in the header is never added.

### 2. Code only, no prompting

Everything under the header must be code: assignments, calls, operators, blocks and symbols.
English requests are rejected with `SyntaxError [PromptingDetected]`, and comment lines with
`SyntaxError [CommentInSource]`. Text inside strings is data, so `show ("make me a sandwich")`
is fine.

### 3. Shortcuts: at most one, at most 20 characters

Auto-helper shortcuts (`.autohook`, `.autodetect`, `.autotag`, any `.auto*`) are capped at
**one per file**. A second one fails with `CompilerError [ShortcutLimitExceeded]`. The single
shortcut may be at most **20 characters, dot included**: `.autohook` passes, while
`.autodetect_every_widget_on_screen` fails with `[ShortcutLengthExceeded]`. This keeps a whole
request from being smuggled into one command name.

### 4. No magic toggles

`DoubleJump = True` (that nothing reads) and `editor.spellcheck.on` (that nothing codes) fail
with `CompilerError [MissingMechanics]`. Code the real mechanics instead: instances, hooks,
state variables, math and velocity changes, key bindings, assets, animations and positions.

```text
# ("platformer physics for my own game: the player leaves the floor with an upward speed, gravity lowers the speed every tick, and each tick prints the tick number and the height until the player lands")
height = 0
speed = 0.5
gravity = 0.1
tick = 0
repeat until (height < 0)
  then tick = tick + 1
  then height = height + speed
  then speed = speed - gravity
  then show ("tick " + tick + ": height " + round(height, 2))
show ("landed after " + tick + " ticks")
```

### 5. Strict top-to-bottom order

Every hook, instance, variable and variable pack must be defined before a line uses it. IMY
**never reorders or fixes** your code. It halts with `CompilerError [ExecutionOrderViolation]`
and cites both lines:

```text
1  # ("collision helper for my own game: installs the physics hook, then detects walls in the scene")
2  walls = World.find("wall")
3  World.detect(walls)          ← ExecutionOrderViolation: runs before line 5 sets up the hook
4  bounce = ("0.5")
5  physics.autohook
```

Names saved in memory by an earlier file may be used without defining them again. A name
the file does define must be defined before its first use: memory never excuses the order
inside a file.

### 6. Ambiguity halts

If a line is still unclear after the header, the code and your saved memory are considered,
IMY doesn't guess. It halts with `CompilerError [AmbiguousIntent]` and asks you to sharpen the
code or the header.

### Custom syntax, variable packs, virtual paths and web resources

- Use any word as a variable, even `if`, `then` or `from`. IMY splits compound tokens into
  pieces and maps a meaning to each piece.
- `VelocityX = velocityY = velocityZ = name variablepack = "XYZ"` groups three variables into
  the pack `XYZ`. So does `pack "XYZ" = VelocityX, velocityY, velocityZ`. Pack names match
  without regard to case, so `"xyz"` works too.
- `ship ("/file:paths")` declares a made-up path. IMY maps it into `.imy/vfs/file/paths` and
  records the mapping in `.imy/manifest.json`.
- A URL in a string is a web resource. `ship ("https://…/data.json")` is downloaded into the
  virtual file system before the program runs (`--offline` skips the download,
  `--refresh-web` downloads it again). Any other URL can be fetched by the program at run time.

## Error codes

| Family | Code | Meaning |
|---|---|---|
| SyntaxError | `MissingHeader` | the file or a function block has no `# ("...")` header |
| SyntaxError | `MalformedHeader` | a `#` line that isn't a valid header (or a description under 3 words) |
| SyntaxError | `EmptyBody` | a header with no code under it |
| SyntaxError | `PromptingDetected` | an English request or sentence instead of code |
| SyntaxError | `CommentInSource` | IMY has no comments; the header is the only description |
| SyntaxError | `UnterminatedString` | a string that is never closed |
| CompilerError | `ShortcutLimitExceeded` | more than one `.auto*` shortcut in a file |
| CompilerError | `ShortcutLengthExceeded` | a shortcut longer than 20 characters |
| CompilerError | `ShortcutViolation` | a shortcut used to stand in for a whole feature |
| CompilerError | `MissingMechanics` | a magic toggle, or behaviour the code never defines |
| CompilerError | `ExecutionOrderViolation` | something used before the line that defines it |
| CompilerError | `HeaderMismatch` | code that contradicts its header |
| CompilerError | `AmbiguousIntent` | a line whose meaning can't be determined |
| CompilerError | `MemoryConflict` | a saved symbol would be overwritten (see `--update-memory`) |
| CompilerError | `CommentsInOutput` | the model put a comment in the compiled code |
| CompilerError | `InvalidOutput` | the compiled code doesn't parse, or isn't in the target language |
| CompilerError | `InventedStyling` / `InventedAsset` / `InventedContent` | a website got styling, images or text the code never defined |
| CompilerError | `MessageNotPreserved` | a string message from your code was changed |

## Cross-session memory

`imy run` saves what each file defines, so you can call it from later files:

- **variable packs** (such as `XYZ`), **functions** and **virtual paths**: one entry per name
- **custom syntax rules** (such as `extract.font123` or `web.structure.home`): the first saved
  meaning wins, so your personal syntax compiles the same way every time
- **variables**: one entry per file that defines them, so common names never collide

A later file gets a saved symbol only when it uses it without defining it: a variable used as a
value or named in the code, a pack named in a string or in the code, a function that is called,
a syntax rule whose words appear on a code line (several words match across any spacing), a
virtual path the file ships. A saved variable whose name is a grammar word (`if`, `then`,
`name`, `show`, …) is reused only where the file uses it as a value, so everyday words in a new
file never pull in old meanings.

Memory lives in `~/.imy/memory.json`. A project can keep its own with
`imy init --local-memory`, which creates `.imy/memory.json`; it overrides global entries and
receives new saves. (Working in your home folder, `~/.imy` is the one store: it is never
treated as a project's own.)

A saved symbol is never overwritten silently:

- If another file redefines a saved pack or function, IMY halts with `MemoryConflict` unless
  you pass `--update-memory`.
- If a file changes its own definition, IMY saves the change and says so
  (`memory: updated … (redefined in this file)`).

```console
imy memory list [--kind variable_pack] [--scope global|local]
imy memory show XYZ
imy memory delete greet [--file session1.imy] [--yes]
imy memory clear [--scope local] [--cache] --yes
```

Example: `session1.imy` (`imy examples session1 --copy`) defines `greet` and the pack `XYZ`.
After `imy run session1.imy`, `session2.imy` can call `greet ("Bo")` without defining it,
because IMY injects the saved definition.

### Deterministic cache

Each compile is cached under `.imy/cache/`. The cache key is the hash of the normalized source,
the target language, the memory the file uses (plus virtual paths and repository context) and
the compiler prompt version. Running an unchanged script again reuses the cached program with
no AI call. `--no-cache` forces a fresh compile.

## Output rules

- **Zero comments.** IMY scans the compiled code with a language-aware scanner that skips
  strings, raw strings, character literals and regex literals. Any `#`, `//`, `/* */`,
  `<!-- -->` or `--` comment, Python docstring or shebang is rejected. The model gets one repair
  round (`repair_attempts`), then the compile fails with `CommentsInOutput` and the output line.
- Markdown fences and chat prose around the code are stripped.
- **Exact messages and layout.** Every string message from your code must survive character
  for character, and the model is told to keep your order, block structure and names.
- **Strict websites** (`--to html`): no styling, classes, fonts, colours, animations, images,
  icons, logos or outside scripts unless your code defines them, and no visible words that
  aren't in your code.
  A page described as having a "cool logo" with no image file is either refused, with an
  error that says the code never defines the logo (`MissingMechanics`, `HeaderMismatch` or
  `AmbiguousIntent`, depending on how the model reads the line), or comes out as a bare
  white page showing your literal text. It never gets an invented logo.

## Targets

You write IMY once and choose the language it becomes: `--to <name>` on `imy run`,
`imy convert` and `imy console`, `:target <name>` inside the console, or `default_target` in
`imy init`. The same `.imy` file can become Python today and Rust tomorrow.

```console
$ imy languages
Ready on this machine (14): python, javascript, typescript, java, rust, go, c, cpp, ruby, php, bash, perl, asm, awk
Need a tool installed (28): kotlin, scala, csharp, swift, dart, lua, powershell, r, julia, …
Web pages: css, html (built; --serve shows them)
Convert only: vb, ada, erlang, objc
$ imy languages zig
✗ Zig needs `zig`. Install Zig from ziglang.org.
Converting works without it: imy convert file.imy --to zig
```

`imy run` builds and runs these, when the tool they need is installed:

| Kind | Languages | Needs |
|---|---|---|
| Scripting | python, javascript, typescript, ruby, php, perl, lua, r, julia, tcl, awk | python3, node (22.6+ or tsx for TypeScript), the interpreter |
| Shells | bash, powershell | bash, pwsh |
| Systems | c, cpp, rust, go, zig, d, nim, v, odin, crystal, swift | cc, c++, rustc, go, zig, a D compiler, nim, v, odin, crystal, swift |
| Assembly | asm | cc (written for this machine's processor and system, in GNU assembler syntax) |
| JVM and .NET | java, kotlin, scala, groovy, clojure, csharp, fsharp | java 17+, kotlinc, scala-cli, groovy, clojure, dotnet |
| Functional | haskell, ocaml, elixir, scheme, lisp | runghc, ocaml, elixir, guile, sbcl |
| Classic | fortran, pascal, cobol | gfortran, fpc, cobc |
| Other | dart, sql | dart, sqlite3 |
| Web pages | html, css | nothing (`--serve` to preview) |

`vb`, `ada`, `erlang` and `objc` are converted with their own rules but not run, and every
other language name (a new one, a rare one) works with `imy convert` too.

**When the program does not build.** A compiled language has its own judge: the C compiler,
`rustc`, `go`, `javac`, the assembler. When it refuses the program, IMY sends what it said
back to the model, gets a corrected version, checks it against the same output rules and
builds again, before anything runs:

```console
$ imy run tip.imy --to asm
cc refused the program: tip.s:23: Error: operand type mismatch for `cvtsi2sd'
corrected (nvidia/nemotron-3-ultra-550b-a55b:free, 1 min 00 s)
▶ tip.imy (asm, nvidia/nemotron-3-ultra-550b-a55b:free, 1 min 00 s)
Tip: 12.60
Each of 4 friends pays 24.15
```

Scripts get their language's own syntax check first when the code is new (`node --check`,
`ruby -c`, `php -l`, `perl -c`, `bash -n`, `luac -p`). How often a correction is asked for is
the `repair_attempts` setting (`IMY_REPAIR_ATTEMPTS`, 1 unless you change it; 0 turns it off).
A program that still does not build is not kept, so the next run starts afresh.

Programs run in
the folder that holds your `.imy` file, get `IMY_PROJECT_ROOT` and `IMY_VFS_ROOT`, and never
see `IMY_API_KEY`. A compiled program runs with your own permissions, like any script you
start. To read the code before it runs, use `imy run --show-code`, or `imy convert` and run
the file yourself. Use `--timeout 30` to stop a long-running program, and `--detach` to run it
in the background with a log in `.imy/build/`.

## Importing an existing project

You don't have to start from nothing. `imy import` brings a project you already have into the
workspace: every function, class and variable its files define at their top level is saved to
IMY's memory, with the project's own code as the definition. From then on a `.imy` file uses
them by name, and they come out in whatever language that file is compiled to.

```console
$ imy import shop
✓ cart.py Python  2 functions, 1 class, 1 variable
    left out main: it is the file's own entry point
✓ prices.py Python  2 functions, 3 variables
1 file in other languages than Python: automa/nvidia/nemotron-3-ultra-550b-a55b:free reads them (their text is sent to it).
✓ web/format.js JavaScript  2 functions, 1 variable  (nvidia/nemotron-3-ultra-550b-a55b:free, 8 s)
Saved to memory: 12 new
Use them by name in a .imy file, for example:
  show (cart_total(prices))
```

`cart_total` is Python and `money` is JavaScript. One IMY file uses both:

```text
# ("prints the price of three shop items with tax and shipping, as a money label in euros")
prices = [4.50, 3.25, 10.00]
total = cart_total(prices)
show ("To pay: " + money(total, "EUR"))
```

```console
$ imy run receipt.imy
To pay: €25.80
$ imy run receipt.imy --to javascript
To pay: €25.80
```

The compiled program holds `cart_total`, the two functions and two constants it leans on, and
`money` with its table of currency signs, all written in the target language with the same
behaviour. Nothing else of the project comes along.

How a file is read:

- **Python** is read by Python's own parser, on your machine: exact, instant, no model.
- **Every other language** (JavaScript, TypeScript, Ruby, Rust, Go, C, Java, …) is read by the
  model. Each thing it reports is checked against the file: the name must be in the file, and
  the definition saved is the file's own lines, never the model's words.
- **No project code is ever run**, and nothing in the project is changed.

`imy import <folder> --dry-run` lists the files that would be read and which of them the model
would see, and reads nothing. The source can be a folder, one file, or the address of a git
repository (`imy import https://github.com/owner/repo --subdir src`), which is cloned into
`.imy/repos/` first.

| Option | What it does |
|---|---|
| `--dry-run` | list what would be read; read and save nothing |
| `--max-files N` | read at most N files, the shallowest first (25 unless you say otherwise) |
| `--include-tests` | also read test files and test folders |
| `--update-memory` | replace a definition another file saved under the same name |
| `--local` | save into this project's own memory (`.imy/memory.json`) instead of the shared one |
| `--fresh` | read every file again, also the ones that have not changed |
| `--forget` | remove what an earlier import of this folder or file saved |
| `--name`, `--branch`, `--subdir` | the project's name in the saved meanings; for a repository, the branch and the folder inside it |

Folders that hold other people's code or build output (`node_modules`, `venv`, `dist`, …),
hidden folders, links, generated files and files over 40 KB are left alone, and the report
names what was left out and why. A file that has not changed since the last import is not
read again. A name another file already saved is not replaced unless you pass
`--update-memory`; everything else is saved all the same. A `.imy` file that defines a name
itself always uses its own. Names that IMY programs use as plain words (`show`, `count`,
`round`, `if`, `call`, …) are not imported, so an import never changes what your other
programs mean; the report lists the ones it left out. In the console: `:import <folder>`.

## Injecting into a repository

```console
imy inject https://github.com/huggingface/transformers \
  --target src/transformers/utils/logging.py \
  --anchor "def get_logger(" \
  --imy log_banner.imy \
  --run "python -c 'import transformers'"
```

IMY clones the repository into `.imy/repos/` (or `--dest`) and validates your `.imy` against
the code around the insertion point. It compiles a zero-comment snippet in the file's language
(`--to` overrides that) and indents it to fit:

- `--anchor TEXT` inserts after the matching line, which must be unique. Use `--before` to
  insert before it.
- `--line N` makes the snippet start at line N.
- With neither, the snippet goes at the end of the file.

For Python files, the spliced file must still parse, or nothing is written. Every other line of
the file stays byte-for-byte the same, and the diff is printed. Your `.imy` file is checked
against the rules before anything is cloned. Accepted repositories:

- GitHub URLs (a page inside the repository works too, such as `…/tree/main/src`),
  `git@github.com:` addresses and `owner/repo`; they all share one clone
- `.git` URLs and `git@host:group/repo.git` addresses on other hosts, plus GitLab, Bitbucket
  and Codeberg
- local repositories

An earlier clone is reused. `--fresh` clones again, and removes only a folder that is an
earlier clone of the same repository: it never deletes another folder you point `--dest` at.

## Providers and keys

| Provider | `--provider` | Key |
|---|---|---|
| Anthropic (Claude) | `anthropic` (default model `claude-opus-5-5`) | `ANTHROPIC_API_KEY` |
| OpenAI | `openai` | `OPENAI_API_KEY` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| Ollama, vLLM, LM Studio, OpenRouter, … | `openai-compatible` with `--base-url` | optional |
| Automa's free models | `automa` | none (inside Automa's IMY terminal) |

`imy init` asks which provider and model to use, and how to supply the key:

- paste it (hidden input, stored in `~/.imy/config.json`, readable only by you)
- or name an environment variable that holds it

IMY never prints a key. Scripts can pass a key with `imy init --api-key-stdin`. IMY also reads
a project `.env` file.

Settings resolve in this order: `--provider`/`--model` flags, then `IMY_*` environment
variables, then `.env`, then `~/.imy/config.json`, then the defaults. Choosing another provider
for one run (`--provider`, `IMY_PROVIDER`) leaves the saved provider's model, key and server URL
behind: each provider uses its own.

A `.env` file comes with a project, so it may hold keys and the provider, model and target, and
nothing that decides where a key is sent or what runs on your computer: `IMY_AUTOMA_BRIDGE`,
`IMY_PYTHON`, `IMY_HOME` and `IMY_API_KEY_ENV` are refused there, and `IMY_BASE_URL` only when
it points at this computer (`localhost`, `127.0.0.1`). Set those in your shell or with
`imy init`.

| Variable | Setting |
|---|---|
| `IMY_PROVIDER`, `IMY_MODEL`, `IMY_BASE_URL` | provider, model, server URL |
| `IMY_API_KEY` | a key for any provider (highest priority) |
| `IMY_API_KEY_ENV` | read the key from this variable |
| `IMY_TARGET` | default language for `run` and `check` |
| `IMY_TIMEOUT`, `IMY_MAX_TOKENS`, `IMY_EFFORT`, `IMY_REPAIR_ATTEMPTS` | model call limits |
| `IMY_AUTOMA_BRIDGE` | the free-models bridge command (Automa sets it) |
| `IMY_HOME` | where config and global memory live (default `~/.imy`) |
| `IMY_PYTHON` | the Python that runs compiled Python programs |

`imy doctor` shows what IMY will use, where the key comes from and which toolchains are
installed. `imy doctor --ping` sends one tiny request to test the key and model.

`imy models` lists the models for a provider. Free models come and go: a provider can take a
free version offline for a day or a month, and IMY never answers on a different model than
the one you picked. `imy models --check` asks every listed model for one word and shows which
answer now and how fast:

```console
$ imy models --check
Automa free models (no key)
  ✓ 1.3 s  nvidia/nemotron-3-ultra-550b-a55b:free
  ✗ not served now  deepseek/deepseek-v4.1-flash:free
  ✓ 0.8 s  recursive/flint-v1.0:free
  …
12 of 23 answer now. Fastest: nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free (0.7 s).
```

What the check found, and what each compile finds, is kept for a day (in
`~/.imy/model-checks.json`) and shown next to each model by `imy models`.

## The console

`imy console` is where you write a program line by line. It is kept the way an editor keeps
a file: the first line is the name of the program file your code becomes, every line stands
behind its number, and the code a line became stands under it. It says nothing you did not
ask for.

This session was typed on a terminal 55 columns wide, a phone's width, with one of Automa's
free models:

```console
$ imy console
main.py  IMY 1.1.1 · :help
  1 │ # ("greets one person by name and says how long
      the name is")
  2 │ person = "Bo"
    ┆ 1 person = "Bo"
  3 │ show ("Hi, " + person + "!")
    ┆ 2 print("Hi, " + person + "!")
  4 │ show ("Your name has " + count(person) + "
      letters.")
    ┆ 3 print("Your name has " + str(len(person)) + "
        letters.")
      :run
Hi, Bo!
Your name has 2 letters.
      :target ruby
main.rb
    ┆ 1 def count(str)
    ┆ 2   str.length
    ┆ 3 end
    ┆ 4
    ┆ 5 person = "Bo"
    ┆ 6 puts("Hi, " + person + "!")
    ┆ 7 puts("Your name has " + count(person).to_s + "
        letters.")
      :run
Hi, Bo!
Your name has 2 letters.
      :quit
```

- **The title** is the file the code becomes: `main.py` for Python, `main.rb` after
  `:target ruby`, `Main.java`, `main.go`. `imy console --to ruby` opens in Ruby. `:run`
  builds that file under `.imy/build/`.
- **A line of your code** is typed behind its number and a bar. When you press Enter it is
  set again in colour, and a line too long for the terminal continues between words under
  its own beginning.
- **Lines behind the broken bar `┆`** are the program file: what your lines became, each
  with its number in that file (see [Converted as you type](#converted-as-you-type)).
- **A command** starts with a colon and a letter (`:run`, `:show`; `:?` is the help) and
  keeps no number, so the numbered lines are your program. `!ls` runs a shell command.
  Every other line is code, also one that begins with a colon, such as `:: end`.
- **Nothing more is printed.** `:run` prints what your program prints, and its exit code
  only when that is not 0. While a model is waited for, one line counts the seconds and
  leaves nothing behind. `:help` lists the commands.

### Writing as in an editor

- A new line begins where the line before it began, so a block keeps its indentation.
  Backspace takes the indentation away.
- Tab indents to the next stop, in the step your code already uses (four spaces
  otherwise). After a command, Tab completes a file's name: `:load not<Tab>`.
- Several lines pasted at once become several numbered lines with the indentation they
  have, and a command among them is carried out in its place.
- Up and Down bring back earlier lines, also those of earlier sessions in the same folder.
- `:header greets one person by name` writes the `# ("...")` line from plain words, which
  is handy on a phone keyboard. `:example hello` loads a ready program to look at and run.
- `:edit N <text>`, `:insert N <text>`, `:del N` and `:undo` change lines already entered,
  and a changed line is shown as it now stands. `:load` lists a file that fits the screen.
  `:show` lists the code again, `:code` the program file.

The kept indentation and Tab need GNU readline, which Python has on Linux, in Termux and in
Automa's terminal. On macOS, Python often comes with editline instead, and the console
works without those two. When input is piped in, lines are taken as they come and nothing
is drawn again.

### Converted as you type

With Automa's free models the console converts while you write. Each line you enter is
checked against the rules at once, and the lines so far go to the model in the background.
When the answer is in, the lines of the program file that are new or changed appear under
the lines they came from, in the colours of that language.

Typing is never held up. One request runs at a time, and when you have entered more lines
meanwhile, the newest ones go next. A result is written while you are not typing, or the
moment you enter the line you are typing, never into it. When a newer result follows
directly, it takes the place of the older one, so a line of the program is shown once. A
line that breaks a rule is reported the moment you enter it, without asking the model.

The live result is a preview: it saves nothing to memory, and `:run` still does the full
strict compile. `:target ruby` switches the language and shows the program again in it, and
`:code` shows the whole of the last one.

`:live off` stops it and `:live on` starts it; `:live` says which it is. At start,
`imy console --live` or `--no-live` decides, or `IMY_LIVE=1` / `IMY_LIVE=0` in your shell.
With a key of your own, live conversion is off until you turn it on, because every line you
enter would be a paid request.

### Commands

| Command | What it does |
|---|---|
| `:run [args]` | validate, compile and run the code |
| `:check` | validate only |
| `:convert <lang> [file]` | show the code in another language, or write it to a file |
| `:header <words>` | write the `# ("...")` header line from plain words |
| `:examples`, `:example <name>` | list the ready programs; load one |
| `:show`, `:code` | list the code; show the program file it became |
| `:undo`, `:del N`, `:edit N <text>`, `:insert N <text>` | edit lines |
| `:clear`, `:load <file>`, `:save <file>`, `:save! <file>` | manage the buffer (`:save!` overwrites) |
| `:target <lang>`, `:languages` | switch the language the code becomes; list the languages and which run here |
| `:live on`, `:live off` | convert each line as you enter it, in the background |
| `:provider <name>`, `:model <id>` | switch provider or model |
| `:models`, `:models check` | list the models with what was last found; ask each if it answers now |
| `:import <folder>` | bring an existing project in: its functions and variables can be used by name |
| `:memory`, `:help`, `:quit` | saved symbols, help, leave |
| `!<command>` | run a shell command |

`:target`, `:model` and `:live` with nothing after them say what is set.

Ctrl+C stops the command that is running and returns to the line; `:quit`, or Ctrl+D on an
empty line, leaves. Closing the terminal leaves the same way, and the lines you typed stay
in the history (Up brings them back).
`:edit N` and `:insert N` take the rest of the line as code, exactly as typed: quotes need no
closing, and spaces after the first one indent the line.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success (`imy run` returns your program's own exit code once it starts) |
| 1 | the program broke a rule (nothing ran) |
| 2 | usage, file, config or memory problem |
| 3 | AI provider problem (key, network, timeout, refusal, unusable answer) |
| 4 | build or run problem (missing toolchain, failed compile) |
| 5 | repository injection problem |
| 124 | `--timeout` stopped the program |

## Development

```console
pip install -e ".[dev]"
pytest                      # mocked model, no network
pytest --live               # also calls your real provider (uses a temporary memory store)
```

Releases go to PyPI from `.github/workflows/publish-imagenery.yml` (Trusted Publishing, no
stored token):

1. Bump `__version__` in `src/imy/__init__.py`.
2. Rebuild the wheel that Automa's Terminals installer ships:
   `python -m build --wheel --outdir ../server/src/services/scripts/terminals/imy .`,
   removing the old wheel. `tests/test_bundled_wheel.py` checks it.
3. Push the tag `imagenery-v<version>`.

## License

MIT
