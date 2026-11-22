"""imy import: an existing project's functions and variables become saved definitions."""

from __future__ import annotations

import io
import json
import os
import subprocess
import shutil
from pathlib import Path

import pytest
from rich.console import Console
from typer.testing import CliRunner

from conftest import FakeLLM, make_compiler, reply, write
from imy import importer
from imy.cli import app, open_session
from imy.compiler import CompileOptions
from imy.config import ImyConfig
from imy.console import ImyConsole
from imy.errors import ConfigError, LLMRateLimitError
from imy.importer import ImportIndex, SourceFile, block_end, check_reported, collect, read_python, to_memory
from imy.languages import resolve_language
from imy.llm_client import LLMRequest
from imy.memory import Memory, SymbolKind

runner = CliRunner()

PRICES = '''"""Prices and tax for the shop."""
import math
from decimal import Decimal

TAX_RATE = 0.2
CURRENCY = "EUR"
FREE_SHIPPING_FROM: int = 50
__all__ = ["with_tax"]


def with_tax(amount):
    """Return the amount with tax added, rounded up to whole cents.

    Longer notes that are not part of the first sentence.
    """
    return math.ceil(amount * (1 + TAX_RATE) * 100) / 100


def shipping(total):
    if total >= FREE_SHIPPING_FROM:
        return 0
    return 4.5
'''

CART = '''from .prices import shipping, with_tax

ITEMS = []


class Cart:
    """A list of priced items."""

    def __init__(self, owner, limit=10):
        self.owner = owner
        self.limit = limit

    def add(self, price):
        ITEMS.append(price)


def cart_total(prices):
    """Add the prices, the tax and the shipping."""
    subtotal = sum(prices)
    return with_tax(subtotal) + shipping(subtotal)


def _label(amount, *parts, sep=" ", **more):
    return f"{amount:.2f}"


def main():
    print(_label(cart_total([4.5, 3.25, 10])))


if __name__ == "__main__":
    main()
'''

FORMAT_JS = '''const SYMBOLS = { EUR: "€", USD: "$" };

export function money(amount, currency) {
  const symbol = SYMBOLS[currency] || currency;
  return symbol + amount.toFixed(2);
}

function badge(count) {
  return count > 9 ? "9+" : String(count);
}
'''


def source(path: Path, text: str) -> SourceFile:
    write(path, text)
    language = resolve_language({".py": "python", ".js": "javascript", ".rb": "ruby", ".go": "go"}[path.suffix])
    return SourceFile(path=path, relative=path.name, language=language, text=text, digest="d" * 64)


def shop(root: Path) -> Path:
    write(root / "shop" / "prices.py", PRICES)
    write(root / "shop" / "cart.py", CART)
    write(root / "shop" / "web" / "format.js", FORMAT_JS)
    write(root / "shop" / "tests" / "test_cart.py", "def test_x():\n    assert True\n")
    write(root / "shop" / "test_prices.py", "def test_y():\n    assert True\n")
    write(root / "shop" / "README.md", "notes\n")
    write(root / "shop" / "node_modules" / "left-pad" / "index.js", "module.exports = function leftPad() {};\n")
    write(root / "shop" / ".hidden" / "secret.py", "TOKEN = 1\n")
    return root / "shop"


def js_reply(*, extra: list[dict[str, object]] | None = None) -> str:
    symbols: list[dict[str, object]] = [
        {"name": "SYMBOLS", "kind": "variable", "line": 1, "end_line": 1, "params": [], "meaning": "Maps a currency code to its sign.", "uses": []},
        {"name": "money", "kind": "function", "line": 3, "end_line": 6, "params": ["amount", "currency"], "meaning": "Formats an amount with its currency sign and two decimals.", "uses": ["SYMBOLS"]},
        {"name": "badge", "kind": "function", "line": 8, "end_line": 10, "params": ["count"], "meaning": "Shows a count, or 9+ above nine.", "uses": []},
    ]
    return json.dumps({"files": [{"file": 1, "symbols": symbols + (extra or [])}]})


@pytest.fixture
def llm(monkeypatch: pytest.MonkeyPatch) -> FakeLLM:
    fake = FakeLLM()
    monkeypatch.setattr("imy.cli.make_client", lambda config, env: fake)
    return fake


class TestCollect:
    def test_reads_source_files_and_leaves_tests_vendored_and_hidden_folders_alone(self, tmp_path: Path) -> None:
        found = collect(shop(tmp_path))
        assert [file.relative for file in found.files] == ["cart.py", "prices.py", "web/format.js"]
        assert [file.language.name for file in found.files] == ["python", "python", "javascript"]
        assert found.tests == 1 and found.other == 1 and found.left_out == 0 and found.skipped == []

    def test_tests_are_read_when_asked_for(self, tmp_path: Path) -> None:
        found = collect(shop(tmp_path), include_tests=True)
        assert [file.relative for file in found.files] == ["cart.py", "prices.py", "test_prices.py", "tests/test_cart.py", "web/format.js"]
        assert found.tests == 0

    def test_the_limit_keeps_the_shallowest_files(self, tmp_path: Path) -> None:
        found = collect(shop(tmp_path), max_files=2)
        assert [file.relative for file in found.files] == ["cart.py", "prices.py"]
        assert found.left_out == 1

    def test_large_binary_empty_and_generated_files_are_named_with_the_reason(self, tmp_path: Path) -> None:
        root = tmp_path / "proj"
        write(root / "big.py", "x = 1\n" * 10_000)
        write(root / "empty.py", "  \n")
        (root / "blob.py").write_bytes(b"x = 1\0\0")
        (root / "latin.py").write_bytes("naïve = 1\n".encode("latin-1"))
        write(root / "app.min.js", "var a=1;")
        write(root / "types.d.ts", "export declare const a: number;\n")
        write(root / "page.html", "<p>hi</p>\n")
        write(root / "ok.py", "x = 1\n")
        found = collect(root)
        assert [file.relative for file in found.files] == ["ok.py"]
        assert dict(found.skipped) == {
            "app.min.js": "generated or minified", "big.py": "larger than 40 KB", "blob.py": "not text",
            "empty.py": "empty", "latin.py": "not UTF-8 text", "types.d.ts": "generated or minified",
        }
        assert found.other == 1

    def test_links_are_never_followed(self, tmp_path: Path) -> None:
        outside = tmp_path / "outside"
        write(outside / "secret.py", "TOKEN = 1\n")
        root = tmp_path / "proj"
        write(root / "ok.py", "x = 1\n")
        (root / "linked").symlink_to(outside, target_is_directory=True)
        (root / "alias.py").symlink_to(outside / "secret.py")
        assert [file.relative for file in collect(root).files] == ["ok.py"]

    def test_one_file_can_be_imported(self, tmp_path: Path) -> None:
        path = write(tmp_path / "prices.py", PRICES)
        found = collect(path)
        assert [file.relative for file in found.files] == ["prices.py"]
        with pytest.raises(ConfigError, match="not a source file"):
            collect(write(tmp_path / "notes.md", "hi\n"))
        with pytest.raises(ConfigError, match="There is no file or folder"):
            collect(tmp_path / "missing")

    def test_a_windows_file_keeps_its_line_numbers(self, tmp_path: Path) -> None:
        path = tmp_path / "win.py"
        path.write_bytes(b"\xef\xbb\xbfA = 1\r\n\r\ndef f():\r\n    return A\r\n")
        file = collect(path).files[0]
        assert file.text == "A = 1\n\ndef f():\n    return A\n"
        assert [symbol.line for symbol in read_python(file).symbols] == [1, 3]


class TestPython:
    def test_functions_classes_and_variables_are_read_exactly(self, tmp_path: Path) -> None:
        read = read_python(source(tmp_path / "prices.py", PRICES))
        assert read.error is None and read.how == "parser"
        assert [(symbol.name, symbol.what, symbol.line, symbol.end_line) for symbol in read.symbols] == [
            ("TAX_RATE", "variable", 5, 5), ("CURRENCY", "variable", 6, 6), ("FREE_SHIPPING_FROM", "variable", 7, 7),
            ("with_tax", "function", 11, 16), ("shipping", "function", 19, 22),
        ]
        with_tax = read.symbols[3]
        assert with_tax.kind is SymbolKind.FUNCTION and with_tax.params == ("amount",)
        assert with_tax.meaning == "Return the amount with tax added, rounded up to whole cents."
        assert with_tax.fragment.startswith("def with_tax(amount):") and with_tax.fragment.endswith("* 100) / 100")
        # What it reads from outside itself, and the import lines it leans on.
        assert "TAX_RATE" in with_tax.refs and "amount" not in with_tax.refs and "with_tax" not in with_tax.refs
        assert with_tax.needs == ("import math",)
        assert read.symbols[2].fragment == "FREE_SHIPPING_FROM: int = 50"
        # Module plumbing such as __all__ is not something to call by name.
        assert "__all__" not in [symbol.name for symbol in read.symbols]

    def test_a_class_is_saved_with_its_constructor_and_the_entry_point_is_left_out(self, tmp_path: Path) -> None:
        read = read_python(source(tmp_path / "cart.py", CART))
        names = {symbol.name: symbol for symbol in read.symbols}
        assert list(names) == ["ITEMS", "Cart", "cart_total", "_label"]
        cart = names["Cart"]
        assert cart.kind is SymbolKind.FUNCTION and cart.what == "class" and cart.params == ("owner", "limit")
        assert cart.fragment.startswith("class Cart:") and "def add(self, price):" in cart.fragment
        assert "ITEMS" in cart.refs
        assert names["cart_total"].needs == ("from .prices import shipping, with_tax",)
        assert {"with_tax", "shipping"} <= set(names["cart_total"].refs) and "subtotal" not in names["cart_total"].refs
        assert names["_label"].params == ("amount", "*parts", "sep", "**more")
        assert read.skipped == [("main", "it is the file's own entry point")]

    def test_decorators_async_and_redefinitions(self, tmp_path: Path) -> None:
        text = "import functools\n\n@functools.cache\ndef once():\n    return 1\n\nasync def later(x):\n    return x\n\nA = 1\nA = 2\nx, y = 1, 2\nB: int\n"
        read = read_python(source(tmp_path / "m.py", text))
        names = {symbol.name: symbol for symbol in read.symbols}
        assert list(names) == ["once", "later", "A"]
        assert names["once"].line == 3 and names["once"].fragment.startswith("@functools.cache\ndef once():")
        assert names["once"].needs == ("import functools",)
        assert names["later"].fragment.startswith("async def later(x):")
        assert names["A"].fragment == "A = 2" and names["A"].line == 11

    def test_a_file_python_cannot_parse_is_reported_not_guessed(self, tmp_path: Path) -> None:
        read = read_python(source(tmp_path / "bad.py", "def f(:\n    pass\n"))
        assert read.symbols == [] and read.error is not None and "Python can't parse it (line 1" in read.error

    def test_a_definition_too_long_to_keep_is_left_out_by_name(self, tmp_path: Path) -> None:
        text = "def huge():\n" + "".join(f"    x{n} = {n}\n" for n in range(2500)) + "\ndef small():\n    return 1\n"
        read = read_python(source(tmp_path / "long.py", text))
        assert [symbol.name for symbol in read.symbols] == ["small"]
        assert read.skipped == [("huge", "its definition is longer than 16,000 characters")]

    def test_no_project_code_runs(self, tmp_path: Path) -> None:
        marker = tmp_path / "ran"
        text = f"import pathlib\npathlib.Path({str(marker)!r}).write_text('x')\n\ndef f():\n    return 1\n"
        read = read_python(source(tmp_path / "side.py", text))
        assert [symbol.name for symbol in read.symbols] == ["f"] and not marker.exists()


class TestCheckedAgainstTheFile:
    def reported(self, **fields: object) -> importer._ReportedSymbol:
        return importer._ReportedSymbol.model_validate(fields)

    def test_what_the_file_bears_out_is_kept_with_the_files_own_lines(self, tmp_path: Path) -> None:
        file = source(tmp_path / "format.js", FORMAT_JS)
        kept, skipped = check_reported(file, importer._ReadReply.model_validate(json.loads(js_reply())).files[0].symbols)
        assert skipped == []
        assert [(symbol.name, symbol.what, symbol.line, symbol.end_line) for symbol in kept] == [
            ("SYMBOLS", "variable", 1, 1), ("money", "function", 3, 6), ("badge", "function", 8, 10),
        ]
        money = kept[1]
        assert money.fragment == "export function money(amount, currency) {\n  const symbol = SYMBOLS[currency] || currency;\n  return symbol + amount.toFixed(2);\n}"
        assert money.params == ("amount", "currency") and "SYMBOLS" in money.refs and "amount" not in money.refs
        assert kept[0].params == ()

    def test_a_name_the_file_does_not_have_is_dropped(self, tmp_path: Path) -> None:
        file = source(tmp_path / "format.js", FORMAT_JS)
        kept, skipped = check_reported(file, [
            self.reported(name="formatCurrency", kind="function", line=3, end_line=6, meaning="invented"),
            self.reported(name="not a name!", kind="function", line=1),
            self.reported(name="money", kind="widget", line=3),
            self.reported(name="main", kind="function", line=1),
        ])
        assert kept == []
        assert skipped == [
            ("formatCurrency", "the file has no such name"), ("not a name!", "not a name"),
            ("money", "an unknown kind (widget)"), ("main", "it is the file's own entry point"),
        ]

    def test_a_wrong_line_is_corrected_to_where_the_name_is(self, tmp_path: Path) -> None:
        file = source(tmp_path / "format.js", FORMAT_JS)
        kept, _ = check_reported(file, [
            self.reported(name="badge", kind="func", line=2, end_line=99, params="count, bogus", meaning="  Shows   a count. "),
            self.reported(name="money", kind="Function", line="3", end_line=None),
            self.reported(name="money", kind="function", line=3, end_line=6),
        ])
        badge, money = sorted(kept, key=lambda symbol: symbol.name)
        # Line 2 does not name badge: the nearest line that does is taken, and the block is measured from there.
        assert (badge.line, badge.end_line) == (8, 10) and badge.fragment.endswith("}")
        assert badge.params == ("count",) and badge.meaning == "Shows a count."
        assert (money.line, money.end_line) == (3, 6)
        assert len(kept) == 2

    def test_kind_words_of_other_languages_are_understood(self, tmp_path: Path) -> None:
        text = "module Shop\n  RATE = 0.2\nend\n\ndef total(a)\n  a\nend\n\nLIMIT = 5\n"
        file = source(tmp_path / "shop.rb", text)
        kept, skipped = check_reported(file, [
            self.reported(name="Shop", kind="module", line=1, end_line=3),
            self.reported(name="total", kind="method", line=5, end_line=7, params=["a"]),
            self.reported(name="LIMIT", kind="constant", line=9, end_line=9),
        ])
        assert skipped == []
        assert [(symbol.name, symbol.what, symbol.kind) for symbol in kept] == [
            ("Shop", "function", SymbolKind.FUNCTION), ("total", "function", SymbolKind.FUNCTION), ("LIMIT", "variable", SymbolKind.VARIABLE),
        ]

    @pytest.mark.parametrize(
        "start, end",
        [(1, 1), (3, 8), (9, 12), (13, 16), (17, 19), (20, 24), (25, 25)],
    )
    def test_the_end_of_a_definition_is_found_by_its_indentation(self, start: int, end: int) -> None:
        lines = (
            "const TAX = 0.2;\nfile = open();\nfunction f(\n  a,\n  b\n) {\n  return a + b;\n}\nconst ITEMS = [\n  1,\n  2,\n];\n"
            "int g(int a)\n{\n    return a;\n}\ndef h\n  puts 1\nend\nif (x) {\n  y();\n} else {\n  z();\n}\nfinish();"
        ).split("\n")
        assert block_end(lines, start) == end


class TestModelReading:
    def config(self, **settings: object) -> ImyConfig:
        return ImyConfig(provider="anthropic", model="claude-opus-5-5", **settings)

    def test_the_request_shows_numbered_files_and_asks_for_json(self, tmp_path: Path) -> None:
        file = source(tmp_path / "format.js", FORMAT_JS)
        llm = FakeLLM([js_reply()])
        reads = importer.read_with_model([file], llm, self.config())
        request = llm.requests[0]
        assert request.system == importer.READ_SYSTEM_PROMPT and request.json_schema == importer.READ_SCHEMA
        prompt = request.messages[0].content
        assert "FILE 1: format.js (JavaScript)" in prompt
        assert " 3 | export function money(amount, currency) {" in prompt
        assert [symbol.name for symbol in reads[0].symbols] == ["SYMBOLS", "money", "badge"]
        assert reads[0].how == "model" and reads[0].model == "fake-model" and reads[0].error is None

    def test_an_answer_that_is_not_the_json_asked_for_is_asked_for_again(self, tmp_path: Path) -> None:
        file = source(tmp_path / "format.js", FORMAT_JS)
        llm = FakeLLM(["Here is what I found: money and badge.", js_reply()])
        reads = importer.read_with_model([file], llm, self.config())
        assert llm.calls == 2 and [symbol.name for symbol in reads[0].symbols] == ["SYMBOLS", "money", "badge"]
        assert "could not be used" in llm.requests[1].messages[-1].content

    def test_an_answer_that_never_comes_right_marks_the_files_and_invents_nothing(self, tmp_path: Path) -> None:
        file = source(tmp_path / "format.js", FORMAT_JS)
        llm = FakeLLM(["nope", '{"files": "all of them"}'])
        reads = importer.read_with_model([file], llm, self.config())
        assert reads[0].symbols == [] and reads[0].error is not None and "could not be used" in reads[0].error

    def test_files_are_grouped_so_one_request_stays_readable(self, tmp_path: Path) -> None:
        small = [source(tmp_path / f"s{n}.js", "const a = 1;\n") for n in range(8)]
        assert [len(group) for group in importer.batches(small)] == [6, 2]
        big = [source(tmp_path / f"b{n}.js", "x" * 15_000) for n in range(3)]
        assert [len(group) for group in importer.batches(big)] == [1, 1, 1]
        assert importer.batches([]) == []


class TestSavedDefinitions:
    def test_names_are_linked_to_what_they_need_and_say_where_they_came_from(self, tmp_path: Path) -> None:
        reads = [read_python(source(tmp_path / "cart.py", CART)), read_python(source(tmp_path / "prices.py", PRICES))]
        saved = {symbol.name: symbol for symbol in to_memory(reads, "shop")}
        total = saved["cart_total"]
        assert total.language == "python" and total.kind is SymbolKind.FUNCTION and total.members == ["prices"]
        assert total.uses == ["shipping", "with_tax"]
        assert total.meaning == "Add the prices, the tax and the shipping. Imported from shop/cart.py. Its file imports: from .prices import shipping, with_tax."
        assert total.origin == str(tmp_path / "cart.py") and total.origin_line == 17
        assert saved["with_tax"].uses == ["TAX_RATE"]
        assert saved["shipping"].meaning == "Python function shipping(total). Imported from shop/prices.py."
        assert saved["TAX_RATE"].meaning == "Python variable: TAX_RATE = 0.2. Imported from shop/prices.py."
        assert saved["Cart"].meaning == "A list of priced items. A Python class. Imported from shop/cart.py."
        assert saved["Cart"].uses == ["ITEMS"]

    def test_words_every_program_uses_are_never_taken_over(self, tmp_path: Path) -> None:
        text = (
            "def show(text):\n    print('>>', text)\n\n"
            "def count(items):\n    return 99\n\n"
            "def Round(value):\n    return value\n\n"
            "start = 5\n\n"
            "def greet(person):\n    show('Hello ' + person)\n    return count(person)\n"
        )
        read = read_python(source(tmp_path / "words.py", text))
        saved = to_memory([read], "proj")
        # Saved, show or count would change what those words mean in every other program.
        assert [symbol.name for symbol in saved] == ["greet"]
        assert read.skipped == [
            ("show", "IMY reads that word itself in every program"),
            ("count", "IMY reads that word itself in every program"),
            ("Round", "IMY reads that word itself in every program"),
            ("start", "IMY reads that word itself in every program"),
        ]
        # greet is saved with its own code; the words it calls are not listed as helpers to bring along.
        assert saved[0].uses == [] and "show('Hello ' + person)" in saved[0].source_fragment

    def test_a_function_two_files_define_is_kept_from_the_first(self, tmp_path: Path) -> None:
        first = read_python(source(tmp_path / "a.py", "def helper():\n    return 1\n\nLIMIT = 1\n"))
        second = read_python(source(tmp_path / "b.py", "def helper():\n    return 2\n\nLIMIT = 2\n"))
        saved = to_memory([first, second], "proj")
        assert [(symbol.name, Path(symbol.origin).name) for symbol in saved] == [("helper", "a.py"), ("LIMIT", "a.py"), ("LIMIT", "b.py")]
        assert second.skipped == [("helper", "a.py already defines it")]


class TestImportProject:
    def run(self, tmp_path: Path, llm: FakeLLM, **options: object) -> tuple[importer.ImportOutcome, Memory]:
        compiler = make_compiler(tmp_path / "work", llm)
        index = ImportIndex(compiler.workspace.dot / "imports.json")
        outcome = importer.import_project(
            tmp_path / "shop", memory=compiler.memory, index=index, config=compiler.config, client_factory=lambda: llm, **options  # type: ignore[arg-type]
        )
        return outcome, compiler.memory

    def test_a_whole_project_is_saved_python_by_the_parser_the_rest_by_the_model(self, tmp_path: Path) -> None:
        shop(tmp_path)
        llm = FakeLLM([js_reply()])
        heard: list[str] = []
        outcome, memory = self.run(tmp_path, llm, on_read=lambda read: heard.append(f"{read.file.relative}:{read.how}"), on_model=lambda count: heard.append(f"model:{count}"))
        assert heard == ["cart.py:parser", "prices.py:parser", "model:1", "web/format.js:model"]
        assert llm.calls == 1 and outcome.model_error is None and outcome.project == "shop"
        assert outcome.report is not None and len(outcome.report.added) == 12 and outcome.report.conflicts == []
        saved = {symbol.name: symbol for _, symbol in memory.entries()}
        assert saved["money"].language == "javascript" and saved["money"].uses == ["SYMBOLS"]
        assert saved["money"].meaning == "Formats an amount with its currency sign and two decimals. Imported from shop/web/format.js."
        assert saved["money"].source_fragment.startswith("export function money(amount, currency) {")
        assert (outcome.count("function"), outcome.count("class"), outcome.count("variable")) == (6, 1, 5)

    def test_importing_again_reads_nothing_twice_and_changes_nothing(self, tmp_path: Path) -> None:
        shop(tmp_path)
        llm = FakeLLM([js_reply()])
        self.run(tmp_path, llm)
        outcome, _ = self.run(tmp_path, llm)
        assert llm.calls == 1
        assert [read.how for read in outcome.reads] == ["saved", "saved", "saved"]
        assert outcome.report is not None and outcome.report.added == [] and len(outcome.report.unchanged) == 12

    def test_a_changed_file_is_read_again_and_its_definition_updated(self, tmp_path: Path) -> None:
        shop(tmp_path)
        llm = FakeLLM([js_reply()])
        self.run(tmp_path, llm)
        write(tmp_path / "shop" / "prices.py", PRICES.replace("TAX_RATE = 0.2", "TAX_RATE = 0.25"))
        outcome, memory = self.run(tmp_path, llm)
        assert llm.calls == 1
        assert [read.how for read in outcome.reads] == ["saved", "parser", "saved"]
        assert outcome.report is not None and [symbol.name for symbol in outcome.report.updated] == ["TAX_RATE"]
        assert {symbol.name: symbol for _, symbol in memory.entries()}["TAX_RATE"].source_fragment == "TAX_RATE = 0.25"

    def test_fresh_reads_every_file_again(self, tmp_path: Path) -> None:
        shop(tmp_path)
        llm = FakeLLM([js_reply(), js_reply()])
        self.run(tmp_path, llm)
        outcome, _ = self.run(tmp_path, llm, fresh=True)
        assert llm.calls == 2 and [read.how for read in outcome.reads] == ["parser", "parser", "model"]

    def test_what_another_file_saved_is_not_replaced_unless_asked(self, tmp_path: Path) -> None:
        shop(tmp_path)
        llm = FakeLLM([reply('def with_tax(amount):\n    return amount\n', symbols=[{"name": "with_tax", "kind": "function", "meaning": "my own", "source_fragment": "function with_tax(amount)"}])])
        compiler = make_compiler(tmp_path / "work", llm)
        mine = write(tmp_path / "work" / "mine.imy", '# ("defines my own way of adding tax to an amount and shows it")\nfunction with_tax(amount)\n    return amount\nshow (with_tax(3))\n')
        compiler.compile_file(mine, CompileOptions(target="python"))
        llm.queue(js_reply())
        outcome, memory = self.run(tmp_path, llm)
        assert outcome.report is not None
        assert len(outcome.report.conflicts) == 1 and "`with_tax` (function) is already saved" in outcome.report.conflicts[0].message
        # Everything else was saved all the same.
        assert len(outcome.report.added) == 11
        assert {symbol.name: symbol for _, symbol in memory.entries()}["with_tax"].language == ""
        again, memory = self.run(tmp_path, llm, update=True)
        assert again.report is not None and [symbol.name for symbol in again.report.replaced] == ["with_tax"]
        assert {symbol.name: symbol for _, symbol in memory.entries()}["with_tax"].language == "python"

    def test_a_provider_problem_keeps_what_was_read_and_names_what_was_not(self, tmp_path: Path) -> None:
        shop(tmp_path)

        def busy(request: LLMRequest) -> str:
            raise LLMRateLimitError("The model is busy.", hint="Try again in a minute.")

        llm = FakeLLM([busy])
        outcome, memory = self.run(tmp_path, llm)
        assert isinstance(outcome.model_error, LLMRateLimitError)
        assert [file.relative for file in outcome.unread] == ["web/format.js"]
        assert outcome.report is not None and len(outcome.report.added) == 9
        assert "money" not in {symbol.name for _, symbol in memory.entries()}
        # Importing again asks only about the file that was not read.
        llm.queue(js_reply())
        again, memory = self.run(tmp_path, llm)
        assert llm.calls == 2 and [read.how for read in again.reads] == ["saved", "saved", "model"]
        assert "money" in {symbol.name for _, symbol in memory.entries()}

    def test_forgetting_removes_only_what_came_from_that_folder(self, tmp_path: Path) -> None:
        shop(tmp_path)
        write(tmp_path / "other" / "tools.py", "def tool():\n    return 1\n")
        llm = FakeLLM([js_reply()])
        _, memory = self.run(tmp_path, llm)
        compiler = make_compiler(tmp_path / "work", llm)
        importer.import_project(tmp_path / "other", memory=compiler.memory, index=ImportIndex(compiler.workspace.dot / "imports.json"), config=compiler.config, client_factory=lambda: llm)
        removed = compiler.memory.forget_imported((tmp_path / "shop").resolve())
        assert len(removed) == 12
        assert [symbol.name for _, symbol in compiler.memory.entries()] == ["tool"]
        assert compiler.memory.forget_imported((tmp_path / "other" / "tools.py").resolve())[0][1].name == "tool"


class TestUsingWhatWasImported:
    def test_an_imy_file_gets_the_definition_and_everything_it_needs(self, tmp_path: Path) -> None:
        shop(tmp_path)
        llm = FakeLLM([js_reply()])
        compiler = make_compiler(tmp_path / "work", llm)
        importer.import_project(tmp_path / "shop", memory=compiler.memory, index=ImportIndex(compiler.workspace.dot / "imports.json"), config=compiler.config, client_factory=lambda: llm)
        receipt = write(
            tmp_path / "work" / "receipt.imy",
            '# ("prints the price of three shop items with tax and shipping on the screen")\nprices = [4.50, 3.25, 10.00]\nshow ("To pay: " + cart_total(prices))\n',
        )
        compiled = (
            "import math\n\nTAX_RATE = 0.2\nFREE_SHIPPING_FROM = 50\n\n\ndef with_tax(amount):\n    return math.ceil(amount * (1 + TAX_RATE) * 100) / 100\n\n\n"
            "def shipping(total):\n    if total >= FREE_SHIPPING_FROM:\n        return 0\n    return 4.5\n\n\n"
            "def cart_total(prices):\n    subtotal = sum(prices)\n    return with_tax(subtotal) + shipping(subtotal)\n\n\n"
            'prices = [4.50, 3.25, 10.00]\nprint("To pay: " + str(cart_total(prices)))\n'
        )
        # The model also lists cart_total among what it saw: this file only uses it.
        llm.queue(reply(compiled, symbols=[
            {"name": "prices", "kind": "variable", "meaning": "three item prices", "source_fragment": "prices = [4.50, 3.25, 10.00]"},
            {"name": "cart_total", "kind": "function", "meaning": "adds prices, tax and shipping", "source_fragment": "def cart_total(prices):"},
        ]))
        result = compiler.compile_file(receipt, CompileOptions(target="python"))
        # cart_total is used by name; what it leans on comes along, and nothing else does.
        assert sorted(symbol.name for symbol in result.relevant_memory) == ["FREE_SHIPPING_FROM", "TAX_RATE", "cart_total", "shipping", "with_tax"]
        prompt = llm.last_prompt()
        assert "- cart_total (function, imported from Python, cart.py line 17): members: prices; needs: shipping, with_tax; meaning: Add the prices" in prompt
        assert "    defined as:\n        def cart_total(prices):\n            \"\"\"Add the prices, the tax and the shipping.\"\"\"\n            subtotal = sum(prices)" in prompt
        assert "- TAX_RATE (variable, imported from Python, prices.py line 5): meaning: Python variable: TAX_RATE = 0.2." in prompt
        assert "money" not in prompt.split("MEMORY")[1] and "Cart" not in prompt.split("MEMORY")[1]
        assert "imported from <language>" in llm.requests[-1].system
        # Using an imported name saves nothing new and never turns it into this file's own.
        assert result.memory_report is not None and [symbol.name for symbol in result.memory_report.added] == ["prices"]
        assert result.memory_report.skipped == ["cart_total"] and result.memory_report.conflicts == []
        saved = {symbol.name: symbol for _, symbol in compiler.memory.entries()}
        assert saved["cart_total"].language == "python" and Path(saved["cart_total"].origin).name == "cart.py"

    def test_the_program_built_from_imported_code_runs(self, tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
        from imy.runner import build_artifact, run_artifact

        shop(tmp_path)
        llm = FakeLLM([js_reply()])
        compiler = make_compiler(tmp_path / "work", llm)
        importer.import_project(tmp_path / "shop", memory=compiler.memory, index=ImportIndex(compiler.workspace.dot / "imports.json"), config=compiler.config, client_factory=lambda: llm)
        receipt = write(tmp_path / "work" / "receipt.imy", '# ("prints the price of three shop items with tax and shipping on the screen")\nprices = [4.50, 3.25, 10.00]\nshow (cart_total(prices))\n')
        llm.queue(reply(
            "import math\n\nTAX_RATE = 0.2\nFREE_SHIPPING_FROM = 50\n\n\ndef with_tax(amount):\n    return math.ceil(amount * (1 + TAX_RATE) * 100) / 100\n\n\n"
            "def shipping(total):\n    if total >= FREE_SHIPPING_FROM:\n        return 0\n    return 4.5\n\n\n"
            "def cart_total(prices):\n    subtotal = sum(prices)\n    return with_tax(subtotal) + shipping(subtotal)\n\n\nprices = [4.50, 3.25, 10.00]\nprint(cart_total(prices))\n"
        ))
        result = compiler.compile_file(receipt, CompileOptions(target="python"))
        assert run_artifact(build_artifact(result, compiler.workspace), compiler.workspace).exit_code == 0
        assert capfd.readouterr().out == "25.8\n"

    def test_a_file_that_defines_the_name_itself_uses_its_own(self, tmp_path: Path) -> None:
        shop(tmp_path)
        llm = FakeLLM([js_reply()])
        compiler = make_compiler(tmp_path / "work", llm)
        importer.import_project(tmp_path / "shop", memory=compiler.memory, index=ImportIndex(compiler.workspace.dot / "imports.json"), config=compiler.config, client_factory=lambda: llm)
        own = write(tmp_path / "work" / "own.imy", '# ("shows a tax rate of my own and the price of two items on the screen")\nTAX_RATE = 0.5\nshow (TAX_RATE)\nshow (with_tax(10))\n')
        llm.queue(reply("import math\n\nTAX_RATE = 0.5\n\n\ndef with_tax(amount):\n    return math.ceil(amount * (1 + TAX_RATE) * 100) / 100\n\n\nprint(TAX_RATE)\nprint(with_tax(10))\n"))
        result = compiler.compile_file(own, CompileOptions(target="python"))
        # with_tax needs TAX_RATE, but this file sets its own: the imported one is not sent along.
        assert [symbol.name for symbol in result.relevant_memory] == ["with_tax"]

    def test_the_cache_key_follows_the_imported_code(self, tmp_path: Path) -> None:
        shop(tmp_path)
        llm = FakeLLM([js_reply()])
        compiler = make_compiler(tmp_path / "work", llm)
        index = ImportIndex(compiler.workspace.dot / "imports.json")
        importer.import_project(tmp_path / "shop", memory=compiler.memory, index=index, config=compiler.config, client_factory=lambda: llm)
        receipt = write(tmp_path / "work" / "r.imy", '# ("shows the shipping cost of an order of twenty on the screen")\nshow (shipping(20))\n')
        llm.queue(reply("FREE_SHIPPING_FROM = 50\n\n\ndef shipping(total):\n    if total >= FREE_SHIPPING_FROM:\n        return 0\n    return 4.5\n\n\nprint(shipping(20))\n"))
        first = compiler.compile_file(receipt, CompileOptions(target="python"))
        assert compiler.compile_file(receipt, CompileOptions(target="python")).from_cache
        write(tmp_path / "shop" / "prices.py", PRICES.replace("return 4.5", "return 5.5"))
        importer.import_project(tmp_path / "shop", memory=compiler.memory, index=ImportIndex(compiler.workspace.dot / "imports.json"), config=compiler.config, client_factory=lambda: llm)
        llm.queue(reply("FREE_SHIPPING_FROM = 50\n\n\ndef shipping(total):\n    if total >= FREE_SHIPPING_FROM:\n        return 0\n    return 5.5\n\n\nprint(shipping(20))\n"))
        second = compiler.compile_file(receipt, CompileOptions(target="python"))
        assert not second.from_cache and second.cache_key != first.cache_key


class TestCommand:
    def test_import_reports_each_file_and_how_to_use_what_was_saved(self, isolated: Path, llm: FakeLLM) -> None:
        shop(isolated)
        llm.queue(js_reply())
        result = runner.invoke(app, ["import", "shop"])
        assert result.exit_code == 0, result.stderr + result.stdout
        text = result.stdout
        assert "✓ cart.py Python  2 functions, 1 class, 1 variable" in text
        assert "✓ prices.py Python  2 functions, 3 variables" in text
        assert "✓ web/format.js JavaScript  2 functions, 1 variable  (fake-model," in text
        assert "left out main: it is the file's own entry point" in text
        assert "1 file in other languages than Python: anthropic/" in text and "(their text is sent to it)" in text
        assert "Not read: 1 test file (--include-tests reads them)." in text
        assert "Saved to memory: 12 new" in text
        assert "Use them by name in a .imy file, for example:" in text and "show (cart_total(prices))" in text
        assert "imy import shop --forget removes this import." in text
        listed = runner.invoke(app, ["memory", "list"]).stdout
        assert "cart_total" in listed and "(Python)" in listed and "(JavaScript)" in listed
        shown = runner.invoke(app, ["memory", "show", "money"]).stdout
        assert "imported  JavaScript code, brought in with imy import" in shown and "needs     SYMBOLS" in shown

    def test_dry_run_lists_what_would_be_read_and_reads_nothing(self, isolated: Path, llm: FakeLLM) -> None:
        shop(isolated)
        result = runner.invoke(app, ["import", "shop", "--dry-run"])
        assert result.exit_code == 0
        assert "Would read 3 files from" in result.stdout
        assert "cart.py Python  read here, by Python's own parser" in result.stdout
        assert "web/format.js JavaScript  read by anthropic/" in result.stdout and "(its text is sent to that model)" in result.stdout
        assert "1 test file" in result.stdout and "1 other file (not source code)" in result.stdout
        assert "Nothing was read or saved." in result.stdout
        assert llm.calls == 0 and "Memory is empty" in runner.invoke(app, ["memory", "list"]).stdout

    def test_forget_removes_the_import(self, isolated: Path, llm: FakeLLM) -> None:
        shop(isolated)
        llm.queue(js_reply())
        runner.invoke(app, ["import", "shop"])
        result = runner.invoke(app, ["import", "shop", "--forget"])
        assert result.exit_code == 0 and "removed 12 saved definitions that came from" in result.stdout
        assert "Memory is empty" in runner.invoke(app, ["memory", "list"]).stdout
        assert "Nothing saved came from" in runner.invoke(app, ["import", "shop", "--forget"]).stdout
        # Forgetting also forgets what was read, so the next import asks the model again.
        llm.queue(js_reply())
        assert runner.invoke(app, ["import", "shop"]).exit_code == 0 and llm.calls == 2

    def test_local_saves_into_the_projects_own_memory(self, isolated: Path, llm: FakeLLM) -> None:
        write(isolated / "tools.py", "def tool():\n    return 1\n")
        result = runner.invoke(app, ["import", "tools.py", "--local"])
        assert result.exit_code == 0, result.stdout + result.stderr
        assert "Saved to this project's memory: 1 new" in result.stdout
        local = json.loads((isolated / ".imy" / "memory.json").read_text())
        assert [entry["name"] for entry in local["symbols"]] == ["tool"]
        assert not (Path(os.environ["IMY_HOME"]) / "memory.json").exists() or json.loads((Path(os.environ["IMY_HOME"]) / "memory.json").read_text())["symbols"] == []

    def test_conflicts_and_provider_problems_are_said_plainly(self, isolated: Path, llm: FakeLLM) -> None:
        shop(isolated)

        def busy(request: LLMRequest) -> str:
            raise LLMRateLimitError("The model is busy.", hint="Try again in a minute.")

        llm.queue(busy)
        result = runner.invoke(app, ["import", "shop"])
        assert result.exit_code == 3
        assert "The model is busy." in result.stdout and "Try again in a minute." in result.stdout
        assert "Not read: web/format.js. Import again to read them; what was read is kept." in result.stdout
        assert "Saved to memory: 9 new" in result.stdout

    def test_a_folder_with_no_source_and_a_missing_one(self, isolated: Path, llm: FakeLLM) -> None:
        write(isolated / "docs" / "notes.md", "hi\n")
        empty = runner.invoke(app, ["import", "docs"])
        assert empty.exit_code == 2 and "No source files to import" in empty.stdout
        missing = runner.invoke(app, ["import", "nowhere/at/all"])
        assert missing.exit_code == 2
        assert "There is no file or folder at nowhere/at/all." in missing.stderr
        assert "imy import https://github.com/<owner>/<repo>" in missing.stderr
        flags = runner.invoke(app, ["import", "docs", "--branch", "main"])
        assert flags.exit_code == 2 and "--branch and --subdir are for a repository that is cloned" in flags.stderr

    @pytest.mark.skipif(shutil.which("git") is None, reason="needs git")
    def test_a_repository_address_is_cloned_into_the_workspace_and_imported(self, isolated: Path, llm: FakeLLM, tmp_path: Path) -> None:
        origin = tmp_path / "origin"
        write(origin / "lib" / "tools.py", "LIMIT = 3\n\ndef tool(x):\n    return x * LIMIT\n")
        write(origin / "README.md", "hi\n")
        env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}
        for command in (["git", "init", "-q", "-b", "main"], ["git", "add", "-A"], ["git", "commit", "-q", "-m", "first"]):
            subprocess.run(command, cwd=origin, check=True, env=env, capture_output=True)
        result = runner.invoke(app, ["import", origin.as_uri(), "--subdir", "lib"])
        assert result.exit_code == 0, result.stdout + result.stderr
        assert "✓ tools.py Python  1 function, 1 variable" in result.stdout
        assert (isolated / ".imy" / "repos" / "origin" / "lib" / "tools.py").is_file()
        outside = runner.invoke(app, ["import", origin.as_uri(), "--subdir", "../.."])
        assert outside.exit_code == 2 and "points outside the repository" in outside.stderr

    def test_the_console_imports_too(self, isolated: Path, llm: FakeLLM) -> None:
        write(isolated / "tools.py", "LIMIT = 3\n\ndef tool(x):\n    return x * LIMIT\n")
        console = Console(record=True, width=160, force_terminal=False, file=io.StringIO())
        feed = iter([":import tools.py", ":import", ":import nowhere", ":memory", ":quit"])
        session = open_session(isolated / "console.imy")
        repl = ImyConsole(lambda p, m: session, target="python", console=console, input_fn=lambda prompt: next(feed))
        assert repl.loop() == 0
        text = console.export_text()
        assert "✓ tools.py Python  1 function, 1 variable" in text and "Saved to memory: 2 new" in text
        assert "show (tool(x))" in text and "imy import tools.py --forget" in text
        assert "Usage: :import <folder, file or repository address>" in text
        assert "There is no file or folder at nowhere." in text
        assert "tool" in text.split("There is no file or folder at nowhere.")[1]
