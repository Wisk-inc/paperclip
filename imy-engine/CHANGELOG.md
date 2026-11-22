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
