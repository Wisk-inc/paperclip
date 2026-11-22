# IMY in use: real sessions

Everything below was run for real with Automa's free models: the console sessions in
section 4 with `imy 1.1.1`, the others with `imy 1.1.0` (those commands print the same in
1.1.1). Each console block is cut from the session as it happened; where a command names
the model that compiled a program and the seconds it took, that is in the output. The
programs are the ones that come with IMY (`imy examples`), so you can repeat every session.

Free models differ from day to day in speed and in what they accept, and IMY never swaps
in another model, so your times will differ and a strict reading may differ too. Where a
model refused something, that is shown as it happened.

1. [Getting the examples](#1-getting-the-examples)
2. [A first program](#2-a-first-program)
3. [Syntax you invent](#3-syntax-you-invent)
4. [The console: converted as you type](#4-the-console-converted-as-you-type)
5. [One program, many languages](#5-one-program-many-languages)
6. [Assembly, and a program that did not build at first](#6-assembly-and-a-program-that-did-not-build-at-first)
7. [What IMY refuses](#7-what-imy-refuses)
8. [Memory across files](#8-memory-across-files)
9. [Bringing a project you already have](#9-bringing-a-project-you-already-have)
10. [A strict web page](#10-a-strict-web-page)
11. [A made-up path that becomes a real file](#11-a-made-up-path-that-becomes-a-real-file)
12. [Run again on every save](#12-run-again-on-every-save)
13. [Injecting into a repository](#13-injecting-into-a-repository)
14. [Which models answer right now](#14-which-models-answer-right-now)

## 1. Getting the examples

```console
$ imy examples
  hello       a first program
  tip         numbers and rounding
  countdown   syntax you invent (<-, say >>, :: end)
  calculator  asking the person for input
  jump        a loop with your own block words
  notes       a made-up file path that becomes a real file
  session1    saving a function and a variable pack to memory
  session2    using what session1 saved, without defining it
  website     a strict web page: only what the code defines
imy examples hello shows one, imy examples hello --copy writes hello.imy here, and in the console :example hello loads it.

$ imy examples --all --copy
✓ wrote hello.imy
✓ wrote tip.imy
✓ wrote countdown.imy
✓ wrote calculator.imy
✓ wrote jump.imy
✓ wrote notes.imy
✓ wrote session1.imy
✓ wrote session2.imy
✓ wrote website.imy
Run one with imy run hello.imy.
```

`imy examples hello` prints one; in the console, `:example hello` loads it.

## 2. A first program

```text
# ("prints a greeting with the user's name and how many letters the name has")
name = "Ava"
letters = count(name)
show ("Hello, " + name + "!")
show ("Your name has " + letters + " letters.")
```

The first line says what the program builds. Under it, every step is coded. `show` and
`count` are not defined anywhere: IMY reads them by their plain meaning.

```console
$ imy run hello.imy
memory: saved name, letters
▶ hello.imy (python, nvidia/nemotron-3-ultra-550b-a55b:free, 19 s)
Hello, Ava!
Your name has 3 letters.

$ imy run hello.imy
▶ hello.imy (python, cached)
Hello, Ava!
Your name has 3 letters.
```

The second run is the same code, so it comes from the cache at once: no model, no wait.

## 3. Syntax you invent

Nothing here is a language IMY was taught. `<-` assigns, `say >>` prints, and a block runs
from `::` to `:: end`, because the program uses them that way.

```text
# ("rocket countdown: counts from 5 down to 1, one number per line, then prints Liftoff")
count <- 5
loop while count > 0 ::
  say >> count
  count <- count - 1
:: end
say >> "Liftoff!"
```

```console
$ imy run countdown.imy
memory: saved <-, say >>
▶ countdown.imy (python, nvidia/nemotron-3-ultra-550b-a55b:free, 17 s)
5
4
3
2
1
Liftoff!
```

`jump.imy` makes up its own loop words and codes the physics step by step:

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

```console
$ imy run jump.imy
memory: saved height, speed, gravity, tick, repeat until
▶ jump.imy (python, nvidia/nemotron-3-ultra-550b-a55b:free, 37 s)
tick 1: height 0.5
tick 2: height 0.9
tick 3: height 1.2
tick 4: height 1.4
tick 5: height 1.5
tick 6: height 1.5
tick 7: height 1.4
tick 8: height 1.2
tick 9: height 0.9
tick 10: height 0.5
tick 11: height 0.0
tick 12: height -0.6
landed after 12 ticks

$ imy convert jump.imy --to lua
local height = 0
local speed = 0.5
local gravity = 0.1
local tick = 0

local function round(x, n)
  local mult = 10 ^ n
  return math.floor(x * mult + 0.5) / mult
end

repeat
  tick = tick + 1
  height = height + speed
  speed = speed - gravity
  print("tick " .. tick .. ": height " .. round(height, 2))
until height < 0

print("landed after " .. tick .. " ticks")
```

## 4. The console: converted as you type

`imy console` reads like the file you are writing. Its first line is the name of the
program file your code becomes. Each line you enter stands behind its number and a bar,
and when the model has converted the lines so far, the lines of the program file that are
new or changed appear under them, behind a broken bar and their own number in that file.
`:run` prints what the program prints and nothing else.

Both sessions were typed on a terminal 55 columns wide, a phone's width, so long lines
continue on a second row.

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

`:target ruby` answers with the new file's name, `main.rb`, and the whole program follows
in Ruby; `:run` then compiles and runs the same four lines as Ruby.

A block keeps its indentation. In the next session the two spaces before `show` on line 4
were typed once; line 5 began with them by itself, and Backspace took them away again
before `:: end`. That last line begins with a colon and is code all the same: only a colon
and a letter starts a command.

```console
$ imy console
main.py  IMY 1.1.1 · :help
  1 │ # ("greets each person on a list by name and says
      how long the name is")
  2 │ people = ["Bo", "Ava"]
    ┆ 1 people = ["Bo", "Ava"]
  3 │ for each person in people ::
    ┆ 2 for person in people: pass
  4 │   show ("Hi, " + person + "!")
    ┆ 2 for person in people:
    ┆ 3     print("Hi, " + person + "!")
  5 │   show (count(person) + " letters")
    ┆ 4     print(str(len(person)) + " letters")
  6 │ :: end
      :code
main.py
    ┆ 1 people = ["Bo", "Ava"]
    ┆ 2 for person in people:
    ┆ 3     print("Hi, " + person + "!")
    ┆ 4     print(str(len(person)) + " letters")
      :run
Hi, Bo!
2 letters
Hi, Ava!
3 letters
      :quit
```

When line 3 was entered the loop had nothing in it yet, so the model closed it with
`pass`. With line 4 in, line 2 of the program changed and line 3 was new, and both are
shown under line 4. `:: end` changed nothing in the program, so nothing is shown under it.
`:code` lists the program file as it stands.

## 5. One program, many languages

One file, `tip.imy`:

```text
# ("tip splitter: adds a 15 percent tip to a dinner bill and splits the total between four friends, printing the tip and each share rounded to two decimal places")
bill = 84.00
tip = bill * 0.15
total = bill + tip
friends = 4
share = total / friends
show ("Tip: " + round(tip, 2))
show ("Each of " + friends + " friends pays " + round(share, 2))
```

```console
$ imy run tip.imy
memory: saved bill, tip, total, friends, share
▶ tip.imy (python, nvidia/nemotron-3-ultra-550b-a55b:free, 39 s)
Tip: 12.6
Each of 4 friends pays 24.15
```

```console
$ imy languages
Ready on this machine (14): python, javascript, typescript, java, rust, go, c, cpp, ruby, php, bash, perl, asm, awk
Need a tool installed (28): kotlin, scala, csharp, swift, dart, lua, powershell, r, julia, elixir, crystal, nim, haskell, sql, zig, ocaml, fsharp, clojure, groovy, fortran, pascal, d, cobol, scheme, lisp, tcl, v, odin
Web pages: css, html (built; --serve shows them)
Convert only: vb, ada, erlang, objc
Pick one with --to <name> (or :target <name> in the console). imy languages <name> says how to get one running. Any other language name converts too.
```

The same file, run as Ruby, C, Go and AWK:

```console
$ imy run tip.imy --to ruby
memory: saved bill, tip, total, friends, share
▶ tip.imy (ruby, nvidia/nemotron-3-ultra-550b-a55b:free, 20 s)
Tip: 12.6
Each of 4 friends pays 24.15

$ imy run tip.imy --to c
▶ tip.imy (c, nvidia/nemotron-3-ultra-550b-a55b:free, 37 s)
Tip: 12.60
Each of 4 friends pays 24.15

$ imy run tip.imy --to go
▶ tip.imy (go, nvidia/nemotron-3-ultra-550b-a55b:free, 24 s)
Tip: 12.60
Each of 4 friends pays 24.15

$ imy run tip.imy --to awk
▶ tip.imy (awk, nvidia/nemotron-3-ultra-550b-a55b:free, 38 s)
Tip: 12.60
Each of 4 friends pays 24.15
```

`imy convert` writes the program without running it, so it needs no tool of the language.
Here as Rust, and as COBOL, whose compiler is not installed on this machine:

```console
$ imy convert tip.imy --to rust
fn main() {
    let bill = 84.00;
    let tip = bill * 0.15;
    let total = bill + tip;
    let friends = 4;
    let share = total / friends as f64;
    println!("Tip: {:.2}", tip);
    println!("Each of {} friends pays {:.2}", friends, share);
}

$ imy convert tip.imy --to cobol
IDENTIFICATION DIVISION.
PROGRAM-ID. TIP-SPLITTER.
DATA DIVISION.
WORKING-STORAGE SECTION.
01 BILL PIC 9(5)V99 VALUE 84.00.
01 TIP PIC 9(5)V99.
01 TOTAL PIC 9(5)V99.
01 FRIENDS PIC 9 VALUE 4.
01 SHARE PIC 9(5)V99.
01 TIP-DISPLAY PIC ZZZ9.99.
01 SHARE-DISPLAY PIC ZZZ9.99.
01 FRIENDS-DISPLAY PIC Z9.
PROCEDURE DIVISION.
COMPUTE TIP = BILL * 0.15
COMPUTE TOTAL = BILL + TIP
COMPUTE SHARE = TOTAL / FRIENDS
MOVE TIP TO TIP-DISPLAY
MOVE SHARE TO SHARE-DISPLAY
MOVE FRIENDS TO FRIENDS-DISPLAY
DISPLAY "Tip: " TIP-DISPLAY
DISPLAY "Each of " FRIENDS-DISPLAY " friends pays " SHARE-DISPLAY
STOP RUN.
```

## 6. Assembly, and a program that did not build at first

`--to asm` writes assembly for the processor IMY runs on (here x86-64) and builds it with
the C compiler. The first version the model wrote was refused by the assembler. IMY sent
the assembler's words back, got a corrected version, built it and ran it:

```console
$ imy run tip.imy --to asm --show-code --no-cache
cc refused the program: tip.s:23: Error: operand type mismatch for `cvtsi2sd'
corrected (nvidia/nemotron-3-ultra-550b-a55b:free, 1 min 00 s)
   1 .section .rodata
   2 fmt1: .asciz "Tip: %.2f\n"
   3 fmt2: .asciz "Each of %d friends pays %.2f\n"
   4 bill: .double 84.0
   5 factor: .double 0.15
   6
   7 .section .text
   8 .globl main
   9 main:
  10     pushq %rbp
  11     movq %rsp, %rbp
  12     subq $32, %rsp
  13
  14     movsd bill(%rip), %xmm0
  15     mulsd factor(%rip), %xmm0
  16     movsd %xmm0, -8(%rbp)
  17
  18     movsd bill(%rip), %xmm0
  19     addsd -8(%rbp), %xmm0
  20     movsd %xmm0, -16(%rbp)
  21
  22     movsd -16(%rbp), %xmm0
  23     movl $4, %eax
  24     cvtsi2sdl %eax, %xmm1
  25     divsd %xmm1, %xmm0
  26     movsd %xmm0, -24(%rbp)
  27
  28     leaq fmt1(%rip), %rdi
  29     movsd -8(%rbp), %xmm0
  30     movl $1, %eax
  31     call printf@PLT
  32
  33     leaq fmt2(%rip), %rdi
  34     movl $4, %esi
  35     movsd -24(%rbp), %xmm0
  36     movl $1, %eax
  37     call printf@PLT
  38
  39     xorl %eax, %eax
  40     movq %rbp, %rsp
  41     popq %rbp
  42     ret
  43
  44 .section .note.GNU-stack,"",@progbits
  45
▶ tip.imy (asm, nvidia/nemotron-3-ultra-550b-a55b:free, 1 min 00 s)
Tip: 12.60
Each of 4 friends pays 24.15

$ imy run tip.imy --to asm
▶ tip.imy (asm, cached)
Tip: 12.60
Each of 4 friends pays 24.15
```

## 7. What IMY refuses

These never reach a model: the rules are checked first, for free, and the lines are named.

An English request in place of code:

```console
$ imy run bad_prompt.imy
✗ 1 error in bad_prompt.imy; nothing was run.

SyntaxError [PromptingDetected] line 2
  this line reads like a request to an assistant: "please make me a nice to-do list app with a dark theme". The body must be code (assignments, calls, operators, blocks); say what you are building in the # ("...") header and code every step yourself
    1 │ # ("to-do list for my week that adds tasks and prints them")
  ❱ 2 │ please make me a nice to-do list app with a dark theme
(exit code 1)
```

Two shortcuts in one file:

```console
$ imy run bad_shortcuts.imy
✗ 1 error in bad_shortcuts.imy; nothing was run.

CompilerError [ShortcutLimitExceeded] line 4
  2 auto-helper shortcuts in one file: .autotag (line 3), .autosort (line 4). IMY allows at most 1 per file; code the other mechanics yourself
    3 │ gallery.autotag
  ❱ 4 │ gallery.autosort
  see line 3: gallery.autotag
(exit code 1)
```

A switch that turns on a feature the code never builds:

```console
$ imy run bad_toggle.imy
✗ 1 error in bad_toggle.imy; nothing was run.

CompilerError [MissingMechanics] line 3
  `editor.spellcheck.on` turns `editor.spellcheck` on by name, but nothing in this file codes `editor.spellcheck`. Code its mechanics step by step instead of a magic toggle
    2 │ editor = Editor.getInstance()
  ❱ 3 │ editor.spellcheck.on
(exit code 1)
```

Things used before the line that defines them (IMY never reorders your code):

```console
$ imy run bad_order.imy
✗ 3 errors in bad_order.imy; nothing was run.

CompilerError [ExecutionOrderViolation] line 2
  line 2 uses `total` before line 3 defines it. IMY never reorders code: move the definition of `total` above line 2
    1 │ # ("shopping cart: adds the price of two items and prints the total with tax")
  ❱ 2 │ show ("Total: " + total)
    3 │ total = price + tax
  see line 3: total = price + tax

CompilerError [ExecutionOrderViolation] line 3
  line 3 uses `price` before line 4 defines it. IMY never reorders code: move the definition of `price` above line 3
    2 │ show ("Total: " + total)
  ❱ 3 │ total = price + tax
    4 │ price = 12.50
  see line 4: price = 12.50

CompilerError [ExecutionOrderViolation] line 3
  line 3 uses `tax` before line 5 defines it. IMY never reorders code: move the definition of `tax` above line 3
    2 │ show ("Total: " + total)
  ❱ 3 │ total = price + tax
    4 │ price = 12.50
  see line 5: tax = price * 0.2
(exit code 1)
```

No header:

```console
$ imy run bad_header.imy
✗ 1 error in bad_header.imy; nothing was run.

SyntaxError [MissingHeader] line 1
  every IMY file must start with a header line: # ("what this code builds and how it works")
  ❱ 1 │ total = 2 + 3
    2 │ show (total)
(exit code 1)
```

## 8. Memory across files

`session1.imy` defines a function and a variable pack:

```text
# ("saves a greeting helper and a velocity pack for later sessions")
def greet(person):
    show ("Hello, " + person + "!")
VelocityX = velocityY = velocityZ = name variablepack = "XYZ"
greet ("Ava")
```

`session2.imy` only uses the function. It is never defined there:

```text
# ("greets two players with the greeting helper saved in session one")
greet ("Bo")
greet ("Cy")
```

```console
$ imy run session1.imy
memory: saved greet, XYZ, VelocityX, velocityY, velocityZ
▶ session1.imy (python, nvidia/nemotron-3-ultra-550b-a55b:free, 1 min 18 s)
Hello, Ava!

$ imy run session2.imy
▶ session2.imy (python, nvidia/nemotron-3-ultra-550b-a55b:free, 57 s)
Hello, Bo!
Hello, Cy!
```

```console
$ imy memory list
                                             IMY memory
┏━━━━━━━━━━━┳━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━┓
┃ name      ┃ kind          ┃ meaning                              ┃ from                 ┃ scope  ┃
┡━━━━━━━━━━━╇━━━━━━━━━━━━━━━╇━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━┩
│ greet     │ function      │ function that takes a person         │ session1.imy line 2  │ global │
│           │               │ parameter and displays a greeting    │                      │        │
│ <-        │ syntax_rule   │ assignment operator                  │ countdown.imy line 2 │ global │
│ say >>    │ syntax_rule   │ output/print statement               │ countdown.imy line 4 │ global │
│ letters   │ variable      │ integer length of name               │ hello.imy line 3     │ global │
│ name      │ variable      │ string "Ava"                         │ hello.imy line 2     │ global │
│ VelocityX │ variable      │ member of variable pack XYZ          │ session1.imy line 4  │ global │
│ velocityY │ variable      │ member of variable pack XYZ          │ session1.imy line 4  │ global │
│ velocityZ │ variable      │ member of variable pack XYZ          │ session1.imy line 4  │ global │
│ XYZ       │ variable_pack │ variable pack containing VelocityX,  │ session1.imy line 4  │ global │
│           │               │ velocityY, velocityZ                 │                      │        │
└───────────┴───────────────┴──────────────────────────────────────┴──────────────────────┴────────┘
```

## 9. Bringing a project you already have

`shop/` is an ordinary small project: two Python files and one JavaScript file.
`imy import` saves what they define. Python is read on this machine by Python's own
parser; the JavaScript file is read by the model, and each thing it reports is checked
against the file.

```console
$ imy import shop --dry-run
Would read 3 files from ~/demo/shop:
  cart.py Python  read here, by Python's own parser
  prices.py Python  read here, by Python's own parser
  web/format.js JavaScript  read by automa/nvidia/nemotron-3-ultra-550b-a55b:free (its text is sent to that model)
Not read: 1 other file (not source code).
Nothing was read or saved.

$ imy import shop
✓ cart.py Python  2 functions, 1 class, 1 variable
    left out main: it is the file's own entry point
✓ prices.py Python  2 functions, 3 variables
1 file in other languages than Python: automa/nvidia/nemotron-3-ultra-550b-a55b:free reads them (their text is sent to it).
✓ web/format.js JavaScript  2 functions, 1 variable  (nvidia/nemotron-3-ultra-550b-a55b:free, 8 s)
Saved to memory: 12 new  (~/.imy/memory.json)
Use them by name in a .imy file, for example:
  show (Cart(owner, limit))
imy memory list shows everything saved; imy import shop --forget removes this import.
```

What was saved is the project's own code:

```console
$ imy memory show cart_total
cart_total (function, global memory)
  meaning   Add the prices, the tax and the shipping. Imported from shop/cart.py. Its file imports: from .prices import shipping, with_tax.
  members   prices
  from      ~/demo/shop/cart.py line 18
  imported  Python code, brought in with imy import
  needs     shipping, with_tax
  saved     2026-11-22T04:19:54+00:00 (updated 2026-11-22T04:19:54+00:00)
  defined as:
def cart_total(prices):
    """Add the prices, the tax and the shipping."""
    subtotal = sum(prices)
    return with_tax(subtotal) + shipping(subtotal)

$ imy memory show money
money (function, global memory)
  meaning   Formats a numeric amount with the appropriate currency symbol and two decimal places. Imported from shop/web/format.js.
  members   amount, currency
  from      ~/demo/shop/web/format.js line 3
  imported  JavaScript code, brought in with imy import
  needs     SYMBOLS
  saved     2026-11-22T04:19:54+00:00 (updated 2026-11-22T04:19:54+00:00)
  defined as:
export function money(amount, currency) {
  const symbol = SYMBOLS[currency] || currency;
  return symbol + amount.toFixed(2);
}
```

`cart_total` is Python and `money` is JavaScript. One IMY file uses both:

```text
# ("prints the price of three shop items with tax and shipping, as a money label in euros")
prices = [4.50, 3.25, 10.00]
total = cart_total(prices)
show ("To pay: " + money(total, "EUR"))
```

Compiled to Python, the JavaScript function arrives as Python; compiled to JavaScript, the
Python functions arrive as JavaScript. The helpers and constants they lean on come along,
and nothing else of the project does:

```console
$ imy run receipt.imy --show-code
memory: saved prices, total
   1 import math
   2
   3 TAX_RATE = 0.2
   4 FREE_SHIPPING_FROM = 50
   5 SYMBOLS = {"EUR": "€", "USD": "$"}
   6
   7 def with_tax(amount):
   8     return math.ceil(amount * (1 + TAX_RATE) * 100) / 100
   9
  10 def shipping(total):
  11     if total >= FREE_SHIPPING_FROM:
  12         return 0
  13     return 4.5
  14
  15 def cart_total(prices):
  16     subtotal = sum(prices)
  17     return with_tax(subtotal) + shipping(subtotal)
  18
  19 def money(amount, currency):
  20     symbol = SYMBOLS.get(currency, currency)
  21     return f"{symbol}{amount:.2f}"
  22
  23 prices = [4.50, 3.25, 10.00]
  24 total = cart_total(prices)
  25 print("To pay: " + money(total, "EUR"))
  26
▶ receipt.imy (python, nvidia/nemotron-3-ultra-550b-a55b:free, 35 s)
To pay: €25.80

$ imy run receipt.imy --to javascript --show-code
   1 const FREE_SHIPPING_FROM = 50;
   2 const TAX_RATE = 0.2;
   3 const SYMBOLS = { EUR: "€", USD: "$" };
   4
   5 function with_tax(amount) {
   6   return Math.ceil(amount * (1 + TAX_RATE) * 100) / 100;
   7 }
   8
   9 function shipping(total) {
  10   if (total >= FREE_SHIPPING_FROM) {
  11     return 0;
  12   }
  13   return 4.5;
  14 }
  15
  16 function cart_total(prices) {
  17   const subtotal = prices.reduce((sum, p) => sum + p, 0);
  18   return with_tax(subtotal) + shipping(subtotal);
  19 }
  20
  21 function money(amount, currency) {
  22   const symbol = SYMBOLS[currency] || currency;
  23   return symbol + amount.toFixed(2);
  24 }
  25
  26 const prices = [4.50, 3.25, 10.00];
  27 const total = cart_total(prices);
  28 console.log("To pay: " + money(total, "EUR"));
  29
▶ receipt.imy (javascript, nvidia/nemotron-3-ultra-550b-a55b:free, 22 s)
To pay: €25.80
```

Importing again reads nothing twice, and `--forget` removes the import:

```console
$ imy import shop
✓ cart.py Python  2 functions, 1 class, 1 variable  (read before, unchanged)
✓ prices.py Python  2 functions, 3 variables  (read before, unchanged)
✓ web/format.js JavaScript  2 functions, 1 variable  (read before, unchanged)
Saved to memory: 12 already saved and unchanged  (~/.imy/memory.json)
Use them by name in a .imy file, for example:
  show (Cart(owner, limit))
imy memory list shows everything saved; imy import shop --forget removes this import.

$ imy import shop --forget
removed 12 saved definitions that came from ~/demo/shop
```

## 10. A strict web page

```text
# ("creates the home page directory with menus and logos for each")
if = menu.home page.structure
menu = options "home, game, play"
call image "menu logo.png"
```

```console
$ imy run website.imy --to html
memory: saved if, menu, call image
✓ built ~/demo/.imy/build/website-site/index.html

$ cat .imy/build/website-site/index.html
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
</head>
<body>
<nav>
<a href="#">home</a>
<a href="#">game</a>
<a href="#">play</a>
</nav>
<img src="menu logo.png" alt="menu logo">
</body>
</html>
```

The page has the three menu options and the image the code names. No styling, no extra
words, no invented logo. A header that promises more than the code builds is refused:

```text
# ("creates the home page and add cool logo to the menu")
if create.home page = "arcade stuff, arcade logo"
```

```console
$ imy run bad_site.imy --to html
✗ 3 errors in bad_site.imy; nothing was run.

CompilerError [AmbiguousIntent] line 2
  Line 'if create.home page = "arcade stuff, arcade logo"' has multiple valid parsings: (1) three variables 'if', 'create.home', 'page' all bound to the string; (2) 'if' receives the result of calling 'create.home' with argument 'page'; (3) 'create.home' is a method on 'create' and 'page' is a separate variable. The header and surrounding code do not resolve which mechanic is intended.
    1 │ # ("creates the home page and add cool logo to the menu")
  ❱ 2 │ if create.home page = "arcade stuff, arcade logo"

CompilerError [HeaderMismatch] line 2
  Header promises 'creates the home page and add cool logo to the menu' but the code line neither creates a menu structure nor references a logo file; it only appears to assign a string value.
    1 │ # ("creates the home page and add cool logo to the menu")
  ❱ 2 │ if create.home page = "arcade stuff, arcade logo"

CompilerError [MissingMechanics] line 2
  No mechanic coded for menu creation, no logo file specified, and no logo insertion into a menu. The header's 'cool logo' and 'menu' have no corresponding code: no image asset named, no menu instance, no hook or state to add a logo to a menu.
    1 │ # ("creates the home page and add cool logo to the menu")
  ❱ 2 │ if create.home page = "arcade stuff, arcade logo"
(exit code 1)
```

## 11. A made-up path that becomes a real file

```text
# ("note keeper: adds today's note to a notes file on a virtual path, then prints every saved note")
notes = ship ("/notes:today.txt")
note = "Bought paint for the fence"
append.line (notes, note)
show (read.all (notes))
```

`ship ("/notes:today.txt")` is a path that exists nowhere. IMY gives it a real place inside
`.imy/vfs/`, and the program writes there:

```console
$ imy run notes.imy --show-code
memory: saved notes, note, ship, /notes:today.txt
   1 import os
   2
   3 notes_path = ".imy/vfs/notes/today.txt"
   4 os.makedirs(os.path.dirname(notes_path), exist_ok=True)
   5
   6 note = "Bought paint for the fence"
   7
   8 with open(notes_path, "a", encoding="utf-8") as f:
   9     f.write(note + "\n")
  10
  11 with open(notes_path, "r", encoding="utf-8") as f:
  12     content = f.read()
  13 print(content, end="")
  14
▶ notes.imy (python, nvidia/nemotron-3-ultra-550b-a55b:free, 16 s)
Bought paint for the fence

$ imy run notes.imy
▶ notes.imy (python, cached)
Bought paint for the fence
Bought paint for the fence

$ cat .imy/vfs/notes/today.txt
Bought paint for the fence
Bought paint for the fence
```

## 12. Run again on every save

`imy run w.imy --watch` runs the file, then again each time it is saved. Here the file was
saved once with a line that breaks a rule, and then Ctrl+C was pressed:

```console
$ imy run w.imy --watch
▶ w.imy (python, cached)
version one
watching w.imy: save it to run again, Ctrl+C to stop
── w.imy changed ──
✗ 1 error in w.imy; nothing was run.

SyntaxError [PromptingDetected] line 2
  this line reads like a request to an assistant: "please print version two". The body must be code (assignments, calls, operators, blocks); say what you are building in the # ("...") header and code every step yourself
    1 │ # ("prints one line that says which version of the note this is")
  ❱ 2 │ please print version two
watching w.imy: save it to run again, Ctrl+C to stop
^Cstopped watching
```

## 13. Injecting into a repository

A one-line IMY file, compiled and placed inside a function of an existing repository:

```console
$ cat banner.imy
# ("prints a line that says the room planner has started, before the room size is printed")
show ("Room planner started")
```

```console
$ imy inject ~/room-planner --target app.py --anchor def main(): --imy banner.imy --run python3 app.py
✓ injected 1 line(s) of python into app.py (after line 5) in ~/demo/.imy/repos/room-planner
--- a/app.py
+++ b/app.py
@@ -3,6 +3,7 @@


 def main():
+    print("Room planner started")
     print("Room size:", area(4, 5))



▶ python3 app.py
Room planner started
Room size: 20
exit code 0
```

## 14. Which models answer right now

```console
$ imy models --check
Automa free models (no key)
  ✗ not served now  nvidia/nemotron-3-super-120b-a12b:free
  ✓ 0.6 s  nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free
  ✓ 1.2 s  nvidia/nemotron-3-ultra-550b-a55b:free
  ✓ 0.9 s  nvidia/nemotron-3.5-super-vl:free
  ✓ 1.2 s  nvidia/nemotron-3.5-lightning:free
  ✗ not served now  deepseek/deepseek-v4.1-flash:free
  ✓ 1.9 s  google/gemma-4-26b-a4b-it:free
  ✓ 0.6 s  qwen/qwen3.8-27b:free
  ✗ not served now  qwen/qwen3.8-27b-abliterated-cyber:free
  ✓ 3.1 s  google/gemma-4-31b-it:free
  ✗ not served now  thinkingmachines/inkling:free
  ✗ not served now  thinkingmachines/inkling-small:free
  ✗ not served now  cohere/north-mini-code:free
  ✓ 0.8 s  recursive/flint-v1.0:free
  ✗ not served now  internlm/atria-dawn-preview:free
  ✗ not served now  apodex/apodex-1.1-mini:free
  ✗ not served now  liquid/lfm-2.5-2.6b:free
  ✗ not served now  xingchen-agi/xing4.0-29b-a4b:free
  ✓ 0.8 s  liquid/lfm-3-1.7b:free
  … busy  inclusionai/ling-3.2-flash:free
  ✓ 1.6 s  baidu/ernie-5.5-flash-preview:free
  ✓ 0.7 s  particle-ai/particle-1:free
  ✓ 0.6 s  openrouter/free
  ✓ 5.1 s  prism-ml/ternary-bonsai-27b:free
13 of 24 answer now. Fastest: qwen/qwen3.8-27b:free (0.6 s). The busy ones may answer in a minute.
Use one for a run with --free-model <id>, or keep it with imy init.
```
