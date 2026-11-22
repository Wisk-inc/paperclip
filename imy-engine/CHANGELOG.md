# Changelog

## 1.1.0

### New

- **Examples built in.** `imy examples` lists nine ready programs, `imy examples hello`
  prints one and `--copy` writes it into the folder. In the console, `:examples` and
  `:example hello` load one to look at and run.
- **`:header <words>`** in the console writes the `# ("...")` line from plain words, and
  the console opens with three lines that say how to start.
- **Seconds while you wait.** The compile line counts the seconds, says after a while that
  free models often take a minute, and the result names the model and the time it took.
- **`imy models --check`** asks every listed model for one word and shows which answer now
  and how fast. What it found, and what each compile finds, is shown by `imy models` and
  `:models` for a day. A model that is not being served points at the check.
- **`imy run --watch`** runs the file again each time it is saved, until Ctrl+C. A broken
  rule is shown and the next save is waited for.
- `imy inject` and `imy doctor` take `--free-model` like the other commands.
- **Converted as you type.** In the console, each line you enter is checked against the
  rules at once and the lines so far are converted in the background. The result appears
  above the line you are typing and shows only what is new or changed. Typing is never held
  up, the preview saves nothing to memory, and `:run` still does the strict compile.
  On with Automa's free models, off with a key of your own (every line would be a paid
  request); `:live on|off`, `imy console --live/--no-live` and `IMY_LIVE` decide.
- **Many more languages.** `imy run` now also builds and runs assembly (for this machine's
  processor, through `cc`), D, Fortran, Pascal, COBOL, Clojure, Scheme, Common Lisp, Tcl,
  AWK, V and Odin, 42 languages in all; Ada, Erlang, Objective-C and Visual Basic convert
  with their own rules. `imy languages` lists them all with which run on this machine, and
  `imy languages <name>` says what a language needs. In the console: `:languages`.
- `imy console --to <language>` opens the console in a language, and the opening lines name
  it and how to switch (`:target rust`).
- **A program that does not build is corrected.** When the language's own build tool
  refuses the compiled program (the C compiler, rustc, go, javac, the assembler, …), what
  the tool said goes back to the model for a corrected version, as often as
  `repair_attempts` allows, and only then does anything run. Scripts get their language's
  own syntax check first when the code is new (`node --check`, `ruby -c`, `php -l`,
  `perl -c`, `bash -n`, `luac -p`). A program that still does not build leaves the cache, so
  the next run starts afresh. Go and Java are now built before they run, so their compile
  errors are caught the same way.
- **Assembly that works.** The model is given the exact calling rules of the processor IMY
  runs on (x86-64 or 64-bit ARM: stack alignment, how data is addressed in a
  position-independent program, where arguments go, what `printf` needs). The program is
  linked with the C and math libraries, and code that addresses its data absolutely is
  linked as a fixed-position program instead of being refused.

### Fixes

From a full review of every module. Each has a test.

#### Rules

- A function block is a function word, a name and `(`, or a name followed by `:` or `{`
  alone. `define speed = 5` and `sub total = price - discount` are ordinary lines again and
  no longer ask for a header of their own.
- A plain call before the file's one `.auto*` shortcut (`show ("starting")`) is no longer
  reported as running before the hook. Only dotted calls on an object are actions.
- A name saved in memory no longer hides a real order mistake: a name the file defines must
  be defined before the file uses it.
- A toggle on a feature the file codes itself (`editor.spellcheck.on` after
  `editor.spellcheck = …`) is accepted.
- Both pack shapes are read: `A = B = C = name variablepack = "XYZ"` and
  `pack "XYZ" = a, b, c`.

#### Memory

- An everyday operator (`+`, `==`, `&&`, …) is never saved as a custom syntax rule, and
  one an earlier version saved is no longer applied. Saved from one file as "joins text",
  `+` was then forced on every other file and broke programs that add numbers. Marks you
  invent (`<-`, `|>`, `say >>`) are still remembered.
- Working in your home folder, `~/.imy` is the one memory store. It was also read as the
  project's own, so every save counted twice.
- `~/.imy` is never taken for a project's workspace, also when `IMY_HOME` points elsewhere.
- A saved variable named with an everyday word (`if`, `then`, `name`, `show`, …) is reused
  only where a later file uses it as a value, so those words no longer pull old meanings
  into every new file.
- Custom syntax rules of several words (`menu.home page.structure`) are found again in
  later files, across any spacing.

#### Output checks

- Text blocks (`"""…"""`) in Java, Kotlin, Scala, C#, Groovy, Swift, Dart, Julia, Elixir and
  Nim are read as strings: a `//` or `#` inside one is not a comment.
- A strict website with an outside `<script src="…">` the code never named is rejected.
- A message with an apostrophe or quote that the target language escapes
  (`'It\'s done'`, `&quot;`, `"\u00e9"`) counts as preserved.
- The model's reply is read more tolerantly: an error code written in another letter case,
  a symbol kind under a common synonym, a missing line number.

#### Providers and settings

- Switching provider for one run (`--provider`, `IMY_PROVIDER`) no longer carries the saved
  provider's model, key and server URL to the new one.
- A project `.env` can no longer name the bridge command, the Python that runs programs,
  IMY's home or the variable the key is read from, and may set `IMY_BASE_URL` only to this
  computer. A downloaded project could otherwise run a command or send your key elsewhere.
- A model that takes longer than `IMY_TIMEOUT` is reported once instead of being asked
  three more times. A connection that fails to open is still retried.
- Anthropic models that refuse adaptive thinking, the effort setting or structured output
  are asked again without it instead of failing.

#### Running and injecting

- The `tip` example's header says what its code does (rounds to two decimal places). It
  promised "two decimals" in print, which `round` does not give, and the validator
  sometimes refused the example for it.
- `imy inject` takes GitHub page URLs (`…/tree/main/src`) and `git@host:group/repo.git`
  addresses on any host. Every way of naming a GitHub repository shares one clone.
- `--fresh` removes only an earlier clone of the same repository. It could delete any
  folder `--dest` pointed at.
- `imy inject` checks the `.imy` file against the rules before cloning anything.
- A missing `.imy` file is reported at once. It used to create a `.imy/` folder and show a
  model spinner first.
- Rule errors are reported before the model is named or called.
- TypeScript needs Node 22.6 or newer, or `tsx`; an older Node now says so.
- SQL files in a folder with spaces in its name run.
- Ctrl+C in the console stops the running command and returns to the prompt.
- Long paths in messages are no longer cut in the middle of a word.
- `:edit N` and `:insert N` in the console take code as typed. A line with an apostrophe
  (`show ("it's ready")`) was refused as an unclosed quote, and the spaces that indent a
  line were dropped.

## 1.0.0

First release.
