from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import pytest

from conftest import FIXTURES, FakeLLM, make_compiler, reply, symbol, write
from imy.compiler import CompileOptions
from imy.errors import CompilationFailed, ErrorCode, MemoryStoreError
from imy.memory import (
    CompileCache,
    Memory,
    MemoryFile,
    MemoryStore,
    MemorySymbol,
    SymbolKind,
    cache_key,
    fingerprint,
    now_iso,
)
from imy.parser import parse_file, parse_text

SESSION1_SYMBOLS = [
    symbol("greet", "function", "prints Hello, <person>! for the given person", "def greet(person):"),
    symbol("XYZ", "variable_pack", "velocity pack of VelocityX, velocityY and velocityZ", 'VelocityX = velocityY = velocityZ = name variablepack = "XYZ"'),
]


def home() -> Path:
    return Path(os.environ["IMY_HOME"])


def saved(name: str, kind: SymbolKind, origin: str, fragment: str, meaning: str = "meaning") -> MemorySymbol:
    stamp = now_iso()
    return MemorySymbol(
        name=name, kind=kind, meaning=meaning, source_fragment=fragment, fingerprint=fingerprint(fragment),
        origin=origin, origin_line=1, created_at=stamp, updated_at=stamp,
    )


class TestStore:
    def test_missing_file_reads_as_empty(self, tmp_path: Path) -> None:
        assert MemoryStore(tmp_path / "memory.json", "global").load().symbols == []

    def test_round_trip_is_sorted_and_private(self, tmp_path: Path) -> None:
        store = MemoryStore(tmp_path / "memory.json", "global")
        data = MemoryFile(symbols=[saved("b", SymbolKind.FUNCTION, "/x.imy", "def b():"), saved("a", SymbolKind.FUNCTION, "/x.imy", "def a():")])
        store.save(data)
        loaded = store.load()
        assert [s.name for s in loaded.symbols] == ["a", "b"]
        assert oct(store.path.stat().st_mode & 0o777) == "0o600"

    def test_corrupt_file_is_a_clean_error(self, tmp_path: Path) -> None:
        path = tmp_path / "memory.json"
        path.write_text("{not json", encoding="utf-8")
        with pytest.raises(MemoryStoreError) as caught:
            MemoryStore(path, "global").load()
        assert "not valid JSON" in caught.value.message
        assert "imy memory clear" in (caught.value.hint or "")

    def test_wrong_shape_is_a_clean_error(self, tmp_path: Path) -> None:
        path = tmp_path / "memory.json"
        path.write_text(json.dumps({"format": "something-else"}), encoding="utf-8")
        with pytest.raises(MemoryStoreError):
            MemoryStore(path, "global").load()

    def test_local_memory_overrides_global(self, tmp_path: Path) -> None:
        global_store = MemoryStore(tmp_path / "g.json", "global")
        local_store = MemoryStore(tmp_path / "l.json", "local")
        global_store.save(MemoryFile(symbols=[saved("greet", SymbolKind.FUNCTION, "/a.imy", "def greet():", "global meaning")]))
        local_store.save(MemoryFile(symbols=[saved("greet", SymbolKind.FUNCTION, "/b.imy", "def greet(x):", "local meaning")]))
        memory = Memory(global_store, local_store)
        entries = memory.entries()
        assert [(scope, s.meaning) for scope, s in entries] == [("local", "local meaning")]
        assert memory.write_store is local_store

    def test_delete_and_clear(self, tmp_path: Path) -> None:
        store = MemoryStore(tmp_path / "g.json", "global")
        store.save(MemoryFile(symbols=[
            saved("greet", SymbolKind.FUNCTION, "/a.imy", "def greet():"),
            saved("score", SymbolKind.VARIABLE, "/a.imy", "score = 1"),
            saved("score", SymbolKind.VARIABLE, "/b.imy", "score = 2"),
        ]))
        memory = Memory(store)
        removed = memory.delete("score", origin="/a.imy")
        assert [(s.name, s.origin) for _, s in removed] == [("score", "/a.imy")]
        assert sorted((s.name, s.origin) for _, s in memory.entries()) == [("greet", "/a.imy"), ("score", "/b.imy")]
        assert memory.clear() == 2
        assert memory.entries() == []


class TestConflicts:
    def test_pack_saved_by_another_file_conflicts(self, tmp_path: Path) -> None:
        store = MemoryStore(tmp_path / "g.json", "global")
        store.save(MemoryFile(symbols=[saved("XYZ", SymbolKind.VARIABLE_PACK, "/other.imy", 'A = B = name pack = "XYZ"')]))
        parsed = parse_text('# ("defines a pack of three velocities")\nVx = Vy = Vz = name variablepack = "xyz"\n', path=tmp_path / "mine.imy")
        found = Memory(store).conflicts(parsed, str(tmp_path / "mine.imy"))
        assert [d.code for d in found] == [ErrorCode.MEMORY_CONFLICT]
        assert "--update-memory" in found[0].message
        assert found[0].line == 2

    def test_same_definition_from_another_file_is_not_a_conflict(self, tmp_path: Path) -> None:
        line = 'Vx = Vy = Vz = name variablepack = "XYZ"'
        store = MemoryStore(tmp_path / "g.json", "global")
        store.save(MemoryFile(symbols=[saved("XYZ", SymbolKind.VARIABLE_PACK, "/other.imy", line)]))
        parsed = parse_text('# ("defines a pack of three velocities")\n' + line + "\n", path=tmp_path / "mine.imy")
        assert Memory(store).conflicts(parsed, str(tmp_path / "mine.imy")) == []

    def test_variables_from_two_files_with_different_values_are_ambiguous(self, tmp_path: Path) -> None:
        store = MemoryStore(tmp_path / "g.json", "global")
        store.save(MemoryFile(symbols=[
            saved("score", SymbolKind.VARIABLE, "/a.imy", "score = 1"),
            saved("score", SymbolKind.VARIABLE, "/b.imy", "score = 2"),
        ]))
        parsed = parse_text('# ("shows the saved score on the screen")\nshow (score)\n', path=tmp_path / "c.imy")
        relevant = Memory(store).relevant(parsed, str(tmp_path / "c.imy"))
        assert relevant.symbols == []
        assert [d.code for d in relevant.diagnostics] == [ErrorCode.MEMORY_CONFLICT]

    def test_a_files_own_symbols_are_not_injected_back(self, tmp_path: Path) -> None:
        origin = str(tmp_path / "a.imy")
        store = MemoryStore(tmp_path / "g.json", "global")
        store.save(MemoryFile(symbols=[saved("greet", SymbolKind.FUNCTION, origin, "def greet(person):")]))
        parsed = parse_text('# ("greets one person by name")\ngreet ("Ava")\n', path=tmp_path / "a.imy")
        assert Memory(store).relevant(parsed, origin).symbols == []
        assert [s.name for s in Memory(store).relevant(parsed, str(tmp_path / "b.imy")).symbols] == ["greet"]


class TestRelevance:
    def memory_with(self, tmp_path: Path, *symbols: MemorySymbol) -> Memory:
        store = MemoryStore(tmp_path / "g.json", "global")
        store.save(MemoryFile(symbols=list(symbols)))
        return Memory(store)

    def names(self, memory: Memory, tmp_path: Path, body: str) -> list[str]:
        parsed = parse_text('# ("test file that uses saved symbols")\n' + body, path=tmp_path / "use.imy")
        relevant = memory.relevant(parsed, str(tmp_path / "use.imy"))
        assert relevant.diagnostics == []
        return [symbol.name for symbol in relevant.symbols]

    def test_a_variable_named_like_a_grammar_word_does_not_leak_into_other_files(self, tmp_path: Path) -> None:
        memory = self.memory_with(
            tmp_path,
            saved("if", SymbolKind.VARIABLE, "/site.imy", "if = menu.home page.structure"),
            saved("then", SymbolKind.VARIABLE, "/site.imy", "then = 5"),
            saved("name", SymbolKind.VARIABLE, "/hello.imy", 'name = "Ava"'),
        )
        assert self.names(memory, tmp_path, "if (score > 1)\n  then show (score)\nname the dog\n") == []
        assert self.names(memory, tmp_path, 'show ("Hi " + name)\ntotal = then + 1\n') == ["name", "then"]

    def test_a_saved_variable_is_reused_where_it_is_plainly_named_or_used(self, tmp_path: Path) -> None:
        memory = self.memory_with(tmp_path, saved("speed", SymbolKind.VARIABLE, "/a.imy", "speed = 4"))
        assert self.names(memory, tmp_path, "move player by speed\n") == ["speed"]
        assert self.names(memory, tmp_path, "distance = speed * 2\n") == ["speed"]
        assert self.names(memory, tmp_path, "speed = 9\nshow (speed)\n") == []

    def test_calling_a_word_is_not_using_the_variable_of_that_name(self, tmp_path: Path) -> None:
        memory = self.memory_with(
            tmp_path,
            saved("count", SymbolKind.VARIABLE, "/a.imy", "count = 3"),
            saved("count", SymbolKind.VARIABLE, "/b.imy", "count = 10"),
        )
        assert self.names(memory, tmp_path, 'letters = count("Ava")\nshow (letters)\n') == []

    def test_syntax_rules_match_their_text_even_with_several_words(self, tmp_path: Path) -> None:
        memory = self.memory_with(
            tmp_path,
            saved("repeat until", SymbolKind.SYNTAX_RULE, "/jump.imy", "repeat until (height < 0)"),
            saved("extract.font123", SymbolKind.SYNTAX_RULE, "/fonts.imy", 'extract.font123 ("a.pdf")'),
            saved("menu", SymbolKind.SYNTAX_RULE, "/site.imy", 'menu = options "a, b"'),
        )
        assert self.names(memory, tmp_path, "repeat until (done)\n  f = extract.font123 (doc)\n") == ["extract.font123", "repeat until"]
        assert self.names(memory, tmp_path, 'show ("repeat until")\nrepeat forever\nf = extract.font1234 (doc)\n') == []
        assert self.names(memory, tmp_path, "menu = 5\nshow (menu)\n") == []

    def test_the_home_folder_workspace_is_the_global_store_not_a_second_one(self, tmp_path: Path) -> None:
        home_dir = tmp_path / "user" / ".imy"
        home_dir.mkdir(parents=True)
        MemoryStore(home_dir / "memory.json", "global").save(
            MemoryFile(symbols=[saved("greet", SymbolKind.FUNCTION, "/a.imy", "def greet():")])
        )
        memory = Memory.open(home_dir, home_dir)
        assert memory.local_store is None
        assert [scope for scope, _ in memory.entries()] == ["global"]
        assert memory.clear() == 1
        project = tmp_path / "project" / ".imy"
        project.mkdir(parents=True)
        MemoryStore(project / "memory.json", "local").create()
        assert Memory.open(home_dir, project).local_store is not None


class TestCacheKey:
    def test_same_inputs_same_key(self) -> None:
        a = cache_key(normalized_source="x", target="python", memory_snapshot=[{"name": "a"}], prompt_version="v1")
        b = cache_key(normalized_source="x", target="python", memory_snapshot=[{"name": "a"}], prompt_version="v1")
        assert a == b and len(a) == 64

    @pytest.mark.parametrize(
        "change",
        [
            {"normalized_source": "y"},
            {"target": "lua"},
            {"memory_snapshot": [{"name": "b"}]},
            {"context": "repo"},
            {"prompt_version": "v2"},
        ],
    )
    def test_each_input_changes_the_key(self, change: dict[str, object]) -> None:
        base: dict[str, object] = {"normalized_source": "x", "target": "python", "memory_snapshot": [{"name": "a"}], "context": "", "prompt_version": "v1"}
        assert cache_key(**base) != cache_key(**{**base, **change})  # type: ignore[arg-type]

    def test_corrupt_cache_entry_is_ignored(self, tmp_path: Path) -> None:
        cache = CompileCache(tmp_path)
        (tmp_path / ("0" * 64 + ".json")).write_text("{oops", encoding="utf-8")
        assert cache.get("0" * 64) is None
        assert not (tmp_path / ("0" * 64 + ".json")).exists()


class TestCrossSession:
    def test_session2_reuses_session1_definitions(self, fixtures_dir: Path) -> None:
        llm = FakeLLM()
        compiler = make_compiler(fixtures_dir, llm)
        session1 = fixtures_dir / "session1.imy"
        llm.queue(reply('def greet(person):\n    print("Hello, " + person + "!")\nVelocityX = velocityY = velocityZ = 0\ngreet("Ava")\n', symbols=SESSION1_SYMBOLS))
        first = compiler.compile_file(session1, CompileOptions(target="python"))
        assert first.memory_report is not None
        assert sorted(s.name for s in first.memory_report.added) == ["XYZ", "greet"]

        stored = {s.name: s for _, s in compiler.memory.entries()}
        assert stored["XYZ"].members == ["VelocityX", "velocityY", "velocityZ"]
        assert stored["XYZ"].origin == str(session1.resolve())
        assert stored["greet"].source_fragment.startswith("def greet(person):")

        session2 = fixtures_dir / "session2.imy"
        llm.queue(reply('def greet(person):\n    print("Hello, " + person + "!")\ngreet("Bo")\ngreet("Cy")\nprint("XYZ")\n', symbols=[
            symbol("greet", "function", "saved greeting helper", 'greet ("Bo")'),
        ]))
        second = compiler.compile_file(session2, CompileOptions(target="python"))
        prompt = llm.last_prompt()
        assert "MEMORY (saved definitions" in prompt
        assert "greet (function, from session1.imy line 2)" in prompt
        assert "def greet(person):" in prompt
        assert "XYZ (variable_pack, from session1.imy line 4)" in prompt
        assert [s.name for s in second.relevant_memory] == ["greet", "XYZ"]
        assert second.memory_report is not None and second.memory_report.added == []

        third = compiler.compile_file(session2, CompileOptions(target="python"))
        assert third.from_cache and llm.calls == 2
        assert third.code == second.code

    def test_redefining_a_saved_pack_in_another_file_halts(self, fixtures_dir: Path) -> None:
        llm = FakeLLM()
        compiler = make_compiler(fixtures_dir, llm)
        llm.queue(reply('print("ok")\n', symbols=SESSION1_SYMBOLS))
        compiler.compile_file(fixtures_dir / "session1.imy", CompileOptions(target="python"))
        other = write(fixtures_dir / "other.imy", '# ("a different pack named XYZ holding two colours")\nRed = Blue = name variablepack = "XYZ"\nshow (Red)\n')
        with pytest.raises(CompilationFailed) as caught:
            compiler.compile_file(other, CompileOptions(target="python"))
        assert caught.value.codes == [ErrorCode.MEMORY_CONFLICT]
        assert llm.calls == 1

        llm.queue(reply('print("ok")\n', symbols=[symbol("XYZ", "variable_pack", "two colours", 'Red = Blue = name variablepack = "XYZ"')]))
        replaced = compiler.compile_file(other, CompileOptions(target="python", update_memory=True))
        assert replaced.memory_report is not None
        assert [s.name for s in replaced.memory_report.replaced] == ["XYZ"]
        stored = {s.name: s for _, s in compiler.memory.entries()}
        assert stored["XYZ"].members == ["Red", "Blue"]

    def test_changing_a_definition_in_its_own_file_updates_with_a_notice(self, fixtures_dir: Path) -> None:
        llm = FakeLLM()
        compiler = make_compiler(fixtures_dir, llm)
        path = write(fixtures_dir / "own.imy", '# ("keeps a score and shows it on the screen")\nscore = 1\nshow (score)\n')
        llm.queue(reply('score = 1\nprint(score)\n', symbols=[symbol("score", "variable", "the score")]))
        compiler.compile_file(path, CompileOptions(target="python"))
        write(path, '# ("keeps a score and shows it on the screen")\nscore = 2\nshow (score)\n')
        llm.queue(reply('score = 2\nprint(score)\n', symbols=[symbol("score", "variable", "the score")]))
        result = compiler.compile_file(path, CompileOptions(target="python"))
        assert result.memory_report is not None
        assert [s.name for s in result.memory_report.updated] == ["score"]

    def test_syntax_rule_keeps_its_first_meaning(self, tmp_path: Path) -> None:
        llm = FakeLLM()
        compiler = make_compiler(tmp_path, llm)
        path = write(tmp_path / "fonts.imy", '# ("extracts the font from a document and prints its name")\nfont = extract.font123 ("doc.pdf")\nshow (font)\n')
        llm.queue(reply('print("x")\n', symbols=[symbol("extract.font123", "syntax_rule", "read the first font name of a PDF")]))
        compiler.compile_file(path, CompileOptions(target="python"))
        other = write(tmp_path / "fonts2.imy", '# ("extracts the font from a second document and prints it")\nf = extract.font123 ("b.pdf")\nshow (f)\n')
        llm.queue(reply('print("y")\n', symbols=[symbol("extract.font123", "syntax_rule", "something else")]))
        result = compiler.compile_file(other, CompileOptions(target="python"))
        assert "read the first font name of a PDF" in llm.last_prompt()
        stored = {s.name: s for _, s in compiler.memory.entries()}
        assert stored["extract.font123"].meaning == "read the first font name of a PDF"
        assert result.memory_report is not None and result.memory_report.conflicts == []

    def test_check_does_not_save_memory(self, fixtures_dir: Path) -> None:
        llm = FakeLLM([reply('print("ok")\n', symbols=SESSION1_SYMBOLS)])
        compiler = make_compiler(fixtures_dir, llm)
        compiler.compile_file(fixtures_dir / "session1.imy", CompileOptions(target="python", save_memory=False))
        assert compiler.memory.entries() == []

    def test_symbols_the_file_does_not_contain_are_skipped(self, tmp_path: Path) -> None:
        llm = FakeLLM([reply('print("ok")\n', symbols=[symbol("ghost", "function", "never written", "def ghost():")])])
        compiler = make_compiler(tmp_path, llm)
        path = write(tmp_path / "a.imy", '# ("prints one fixed word to the screen")\nshow ("ok")\n')
        result = compiler.compile_file(path, CompileOptions(target="python"))
        assert result.memory_report is not None and result.memory_report.skipped == ["ghost"]
        assert compiler.memory.entries() == []
