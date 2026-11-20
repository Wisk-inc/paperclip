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

Python 3.11 or newer:

```console
pip install imagenery          # or: pipx install imagenery
imy init                       # pick a provider, a model and your key (or free models)
```

**In Automa:** open **Terminals → IMY**. Automa installs IMY for you and connects it to
Automa's free models, so no key is needed. You can still switch to your own key with `imy init`.

## Quick start

```console
imy init                                   # provider, model, key; creates .imy/ here
imy check hello.imy                        # rules + AI validator, nothing runs
imy check hello.imy --static               # only the free deterministic rules
imy run hello.imy                          # validate, remember, compile, run
imy run hello.imy --to javascript          # compile to JavaScript and run it with node
imy convert hello.imy --to rust -o hello.rs
imy console                                # type IMY line by line, then :run
```

## The rules

IMY validates in two stages: deterministic Python checks first (free and instant), then a
strict AI validator. Any error cuts everything off with a report that names the exact lines.
Nothing runs until the whole program is clean.

### 1. Header contract

Every file starts with `# ("...")`, which says what the code builds and how it works. Every
function block (`def`, `fn`, `func`, `function`, ...) needs its own header on the line above it.

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

### 6. Ambiguity halts

If a line is still unclear after the header, the code and your saved memory are considered,
IMY doesn't guess. It halts with `CompilerError [AmbiguousIntent]` and asks you to sharpen the
code or the header.

### Custom syntax, variable packs, virtual paths and web resources

- Use any word as a variable, even `if`, `then` or `from`. IMY splits compound tokens into
  pieces and maps a meaning to each piece.
- `VelocityX = velocityY = velocityZ = name variablepack = "XYZ"` groups three variables into
  the pack `XYZ`. Pack names match without regard to case, so `"xyz"` works too.
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

Memory lives in `~/.imy/memory.json`. A project can keep its own with
`imy init --local-memory`, which creates `.imy/memory.json`; it overrides global entries and
receives new saves.

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

Example: `examples/session1.imy` defines `greet` and the pack `XYZ`. After
`imy run session1.imy`, `examples/session2.imy` can call `greet ("Bo")` without defining it,
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
  icons or logos unless your code defines them, and no visible words that aren't in your code.
  A page described as having a "cool logo" with no image file either fails with
  `MissingMechanics` or comes out as a bare white page showing your literal text.

## Targets

`--to` accepts any language name. These are built and run by `imy run`:

| Language | Needs | Language | Needs |
|---|---|---|---|
| python | python3 | rust | rustc |
| javascript | node | go | go |
| typescript | node 22+ or tsx | c / cpp | cc / c++ |
| lua | lua | java | java 17+ |
| ruby, php, perl, r, julia | the interpreter | kotlin | kotlinc + java |
| bash, powershell | bash, pwsh | csharp | dotnet |
| swift, dart, scala, sql | swift, dart, scala-cli, sqlite3 | html | nothing (`--serve` to preview) |

Every other name (for example `cobol` or `fortran`) works with `imy convert`. Programs run in
the folder that holds your `.imy` file, get `IMY_PROJECT_ROOT` and `IMY_VFS_ROOT`, and never
see `IMY_API_KEY`. A compiled program runs with your own permissions, like any script you
start. To read the code before it runs, use `imy run --show-code`, or `imy convert` and run
the file yourself. Use `--timeout 30` to stop a long-running program, and `--detach` to run it
in the background with a log in `.imy/build/`.

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
the file stays byte-for-byte the same, and the diff is printed. Accepted repositories:

- GitHub URLs, `git@github.com:` addresses and `owner/repo`
- `.git` URLs on other hosts, plus GitLab, Bitbucket and Codeberg
- local repositories

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
variables, then `.env`, then `~/.imy/config.json`, then the defaults.

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
`imy models` lists the models for a provider.

## The console

```console
$ imy console
  1 imy> # ("greets one person by name on the screen")
  2 imy> show ("Hi, Bo!")
  3 imy> :run
Hi, Bo!
exit code 0
```

| Command | What it does |
|---|---|
| `:run [args]` | validate, compile and run the code |
| `:check` | validate only |
| `:convert <lang> [file]` | convert to another language |
| `:show`, `:code` | list the code; show the last compiled code |
| `:undo`, `:del N`, `:edit N <text>`, `:insert N <text>` | edit lines |
| `:clear`, `:load <file>`, `:save <file>`, `:save! <file>` | manage the buffer (`:save!` overwrites) |
| `:target <lang>`, `:provider <name>`, `:model <id>`, `:models` | switch target, provider or model |
| `:memory`, `:help`, `:quit` | saved symbols, help, leave |
| `!<command>` | run a shell command |

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

## License

MIT
