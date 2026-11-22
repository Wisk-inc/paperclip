# Changelog

## 1.1.1

### Changed

- **The console reads like the file you are writing.** It opens with one line: the name of
  the program file the code becomes (`main.py`, `main.rb`, `Main.java`, `main.go`) and the
  version. Each line is asked for behind its number and a bar, as in an editor's margin;
  there is no `imy>` before every line any more. Once entered, a line is set again in
  colour (the header, quoted text, numbers, shortcuts), and a line too long for the
  terminal continues between words under its own beginning. A command keeps no number, so
  the numbered lines are the program.
- **The code a line became stands under it.** With live conversion on, the lines of the
  program file that are new or changed appear under the lines they came from, each behind a
  broken bar and its own number in that file, in the target language's colours. The line
  that named the model and the seconds is gone. `:code` and `:convert <lang>` show the
  program the same way: the file's name, then its numbered lines.
- **Nothing is said that was not asked for.** No opening lines on how to begin, no hint
  after a command, no "compiled to …" line and no "exit code 0": `:run` prints what the
  program prints, and an exit code only when it is not 0. `:target ruby` answers with the
  new file's name; `:target`, `:model` and `:live` with nothing after them say what is set.
  `:help` still lists every command.
- **Indentation as in an editor.** A new line begins where the line before it began
  (Backspace takes the indentation away), and Tab indents to the next stop, in the step the
  code already uses, four spaces otherwise. After a command, Tab completes a file's name.
  Text that arrives at once (a paste, a line a phone keyboard commits whole) keeps the
  indentation it has.
- **Commands that change the file answer with the file.** `:edit`, `:insert` and `:header`
  show the line as it now stands behind its number, and `:load` lists a file that fits the
  screen, as an editor opens it. Ctrl+C with nothing typed leaves the margin where it is.
- The program `:run` builds is `.imy/build/main.<ext>` (it was `console.<ext>`).

### Fixes

- Several lines pasted at once were taken as one numbered line, so every number after them
  was wrong. Each pasted line is now a line of its own, a command among them is carried out
  in its place, and on a terminal the pasted block is set again as numbered lines.
- A line that begins with a colon and no letter, such as `:: end` in the countdown example,
  was refused as an unknown command. It is code now. A colon and a word is still a command.
- On a narrow terminal a converted result could land in a line being typed (the first row
  of a wrapped line was then shown twice), and a command entered at the moment a result
  arrived could vanish from the screen. Only the console's own thread writes to the screen
  now: a result is written above the margin while nothing is being typed, or as soon as the
  line being typed is entered.
- When two conversions came in one after the other, a line of the program could be shown
  twice: once as the model had it while a block was still empty (`pass`), once as it
  became. Of results that come in together only the newest is shown, and a newer result
  takes the place of the one written just before it.
- Keys pressed while the seconds of a compile were counted landed in that line, and Enter
  left the line behind on the screen. While that line is redrawn, keys are not shown
  (`imy run`, `imy check` and the console alike); they are taken as typed right after.
- Closing the terminal, or a plain `kill`, now ends the console the way `:quit` does: the
  terminal is put back as it was and the lines typed are kept in the history.
- `imy console --to js` answers `javascript` to `:target`, like `:target js` does, and a
  `--to` value that is no language name is refused at once (exit code 2).
- A line of nothing but spaces is an empty line, and Enter on an empty first line adds
  nothing.

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
- **Reads well on a phone.** The console's opening lines and `:help` wrap between words at
  the terminal's own width, `:help` gives each command its own row, and a live-conversion
  line that would not fit drops the model's long name and keeps the seconds.
- **`imy import`: bring an existing project in.** Every function, class and variable a
  project's files define at their top level is saved to memory with the project's own code
  as the definition, so a `.imy` file uses them by name and they come out in whatever
  language that file compiles to, each with the helpers it leans on. Python is read by
  Python's own parser (exact, no model); every other language by the model, with each
  answer checked against the file. No project code runs. `--dry-run` shows what would be
  read and what the model would see; `--forget` removes an import; a folder, a file or a
  git repository address can be given. In the console: `:import <folder>`.
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

- A common helper the code calls without defining it (`round`, `count`, `show`) is given the
  target language's usual idiom where the language has no built-in for it. Converting to
  Lua, which has no `round`, was sometimes refused as a missing mechanic.
- When the tool that runs a language is missing, the message says how to install it and
  that `imy convert` needs no tool. For someone who is already root (the Linux layer on a
  phone), the install line leaves `sudo` out.
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
