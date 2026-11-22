"""The languages IMY converts to and runs: names, runners, and what this machine has."""

from __future__ import annotations

import os
import platform
import shutil
from pathlib import Path

import pytest
from typer.testing import CliRunner

from conftest import FakeLLM, make_compiler, reply, write
from imy.cli import app, language_groups
from imy.compiler import CompileOptions
from imy.errors import RunnerError
from imy.languages import known_languages, language_for_extension, resolve_language
from imy.postprocess import find_comments
from imy.prompts import machine_name, target_note
from imy.runner import INSTALL_HINTS, NOT_RUNNABLE, RUNNER_TOOLS, BuildArtifact, build_artifact, run_artifact, runner_tool, toolchain_for

runner = CliRunner()
HELLO = '# ("prints a greeting with the user\'s name and how many letters the name has")\nname = "Ava"\nshow ("Hello, " + name + "!")\n'
# Languages IMY converts to but has no way to run: they need a project or a file layout of their own.
CONVERT_ONLY = {"vb", "ada", "erlang", "objc"}


def flat(text: str) -> str:
    return " ".join(text.split())


def fake_tools(folder: Path, names: set[str]) -> None:
    folder.mkdir(exist_ok=True)
    for name in names:
        tool = folder / name
        tool.write_text("#!/bin/sh\necho v24.0.0\n", encoding="utf-8")
        tool.chmod(0o755)


class TestNames:
    @pytest.mark.parametrize(
        "typed, name",
        [("assembly", "asm"), ("Assembler", "asm"), ("gas", "asm"), ("dlang", "d"), ("gnucobol", "cobol"), ("commonlisp", "lisp"),
         ("sbcl", "lisp"), ("guile", "scheme"), ("vlang", "v"), ("objective-c", "objc"), ("gnat", "ada"), ("gawk", "awk"),
         ("c++", "cpp"), ("rs", "rust"), ("rb", "ruby"), ("js", "javascript")],
    )
    def test_the_names_people_type(self, typed: str, name: str) -> None:
        assert resolve_language(typed).name == name

    @pytest.mark.parametrize(
        "extension, name",
        [(".asm", "asm"), (".s", "asm"), (".d", "d"), (".f95", "fortran"), (".cbl", "cobol"), (".lsp", "lisp"), (".ss", "scheme"),
         (".adb", "ada"), (".ads", "ada"), (".pp", "pascal"), (".mm", "objc"), (".hh", "cpp"), (".awk", "awk"), (".tcl", "tcl")],
    )
    def test_source_files_are_recognised_by_extension(self, extension: str, name: str) -> None:
        found = language_for_extension(extension)
        assert found is not None and found.name == name

    def test_every_name_and_alias_is_unique(self) -> None:
        seen: dict[str, str] = {}
        for language in known_languages():
            for key in (language.name, *language.aliases):
                assert key not in seen, f"{key} names both {seen.get(key)} and {language.name}"
                seen[key] = language.name


class TestRunners:
    def test_every_language_runs_is_a_page_or_is_convert_only(self) -> None:
        for language in known_languages():
            kinds = [language.name in RUNNER_TOOLS, language.name in NOT_RUNNABLE, language.name in CONVERT_ONLY]
            assert kinds.count(True) == 1, language.name
        assert set(RUNNER_TOOLS) <= {language.name for language in known_languages()}
        # A language IMY runs says how to get its tool; python is IMY's own.
        assert set(RUNNER_TOOLS) - set(INSTALL_HINTS) == {"python"}

    def test_each_runner_is_built_from_the_tools_the_listing_names(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        tools = tmp_path / "tools"
        fake_tools(tools, {name for names in RUNNER_TOOLS.values() for name in names})
        monkeypatch.setenv("PATH", str(tools))
        monkeypatch.delenv("IMY_PYTHON", raising=False)
        for language in known_languages():
            artifact = BuildArtifact(path=tmp_path / f"program{language.extension}", language=language, run_dir=tmp_path, folder=tmp_path)
            chain = toolchain_for(artifact)
            if language.name in RUNNER_TOOLS:
                assert chain is not None, language.name
                used = Path((chain.steps[0] if chain.steps else chain.run)[0]).name
                assert used in RUNNER_TOOLS[language.name], f"{language.name} runs with {used}"
                assert runner_tool(language.name) is not None
            else:
                assert chain is None, language.name

    def test_a_missing_tool_names_the_tool_and_how_to_install_it(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        empty = tmp_path / "empty"
        empty.mkdir()
        monkeypatch.setenv("PATH", str(empty))
        for name in ("asm", "d", "fortran", "pascal", "cobol", "clojure", "scheme", "lisp", "tcl", "awk", "v", "odin", "zig"):
            language = resolve_language(name)
            artifact = BuildArtifact(path=tmp_path / f"program{language.extension}", language=language, run_dir=tmp_path, folder=tmp_path)
            with pytest.raises(RunnerError) as caught:
                toolchain_for(artifact)
            assert "isn't installed" in caught.value.message and (caught.value.hint or "").startswith("Install"), name
            assert runner_tool(name) is None

    def test_assembly_is_assembled_and_linked_by_the_c_compiler(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        tools = tmp_path / "tools"
        fake_tools(tools, {"cc"})
        monkeypatch.setenv("PATH", str(tools))
        language = resolve_language("asm")
        artifact = BuildArtifact(path=tmp_path / "hello.s", language=language, run_dir=tmp_path, folder=tmp_path)
        chain = toolchain_for(artifact)
        assert chain is not None
        # Linked with the C library and its math library; and, should that be refused, as a fixed-position program.
        assert chain.steps == [[str(tools / "cc"), str(tmp_path / "hello.s"), "-o", str(tmp_path / "hello"), "-lm"]]
        assert chain.relaxed == [[str(tools / "cc"), "-no-pie", str(tmp_path / "hello.s"), "-o", str(tmp_path / "hello"), "-lm"]]
        assert chain.run == [str(tmp_path / "hello")]

    @pytest.mark.skipif(shutil.which("awk") is None, reason="needs awk")
    def test_awk_runs(self, tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
        compiler = make_compiler(tmp_path, FakeLLM([reply('BEGIN {\n    name = "Ava"\n    print "Hello, " name "!"\n}\n', target="awk")]))
        result = compiler.compile_file(write(tmp_path / "hello.imy", HELLO), CompileOptions(target="awk"))
        artifact = build_artifact(result, compiler.workspace)
        assert artifact.path.name == "hello.awk"
        assert run_artifact(artifact, compiler.workspace).exit_code == 0
        assert capfd.readouterr().out == "Hello, Ava!\n"

    @pytest.mark.skipif(shutil.which("cc") is None or platform.machine().lower() not in ("x86_64", "amd64", "aarch64", "arm64"), reason="needs cc on x86-64 or 64-bit ARM")
    def test_assembly_runs_on_this_machine(self, tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
        if platform.machine().lower() in ("x86_64", "amd64"):
            code = (
                '    .section .rodata\ngreeting:\n    .string "Hello, Ava!"\n    .text\n    .globl main\nmain:\n'
                "    subq $8, %rsp\n    leaq greeting(%rip), %rdi\n    call puts@PLT\n    movl $0, %eax\n    addq $8, %rsp\n    ret\n"
                '    .section .note.GNU-stack,"",@progbits\n'
            )
        else:
            code = (
                '    .section .rodata\ngreeting:\n    .string "Hello, Ava!"\n    .text\n    .globl main\nmain:\n'
                "    stp x29, x30, [sp, #-16]!\n    mov x29, sp\n    adrp x0, greeting\n    add x0, x0, :lo12:greeting\n    bl puts\n"
                '    mov w0, #0\n    ldp x29, x30, [sp], #16\n    ret\n    .section .note.GNU-stack,"",%progbits\n'
            )
        compiler = make_compiler(tmp_path, FakeLLM([reply(code, target="asm")]))
        result = compiler.compile_file(write(tmp_path / "hello.imy", HELLO), CompileOptions(target="assembly"))
        artifact = build_artifact(result, compiler.workspace)
        assert artifact.path.name == "hello.s"
        assert run_artifact(artifact, compiler.workspace).exit_code == 0
        assert capfd.readouterr().out == "Hello, Ava!\n"


class TestAssembly:
    def test_the_model_is_told_which_machine_it_writes_for(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(platform, "machine", lambda: "aarch64")
        assert machine_name() == "64-bit ARM (AArch64)"
        assert "Assembly for 64-bit ARM (AArch64) Linux in GNU assembler syntax" in (target_note("asm") or "")
        monkeypatch.setattr(platform, "machine", lambda: "x86_64")
        assert "Assembly for x86-64 Linux" in (target_note("asm") or "")
        assert target_note("ruby") == "Ruby 3. Print with puts."
        assert target_note("brainfog") is None

    def test_a_program_assembled_for_another_machine_is_compiled_again(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        llm = FakeLLM([reply("    .text\n    .globl main\nmain:\n    ret\n", target="asm")] * 2)
        compiler = make_compiler(tmp_path, llm)
        path = write(tmp_path / "hello.imy", HELLO)
        monkeypatch.setattr(platform, "machine", lambda: "x86_64")
        compiler.compile_file(path, CompileOptions(target="asm"))
        assert compiler.compile_file(path, CompileOptions(target="asm")).from_cache
        monkeypatch.setattr(platform, "machine", lambda: "aarch64")
        assert not compiler.compile_file(path, CompileOptions(target="asm")).from_cache
        assert llm.calls == 2

    def test_a_number_sign_is_a_comment_only_at_the_start_of_a_line(self) -> None:
        asm = resolve_language("asm")
        assert find_comments("    mov x0, #1\n    add x1, x1, #16\n    ret\n", asm) == []
        assert find_comments('    .string "# not a comment // either"\n', asm) == []
        assert [hit.line for hit in find_comments("# set up\n    mov x0, #1\n", asm)] == [1]
        assert [hit.line for hit in find_comments("    ret // done\n", asm)] == [1]
        assert [hit.line for hit in find_comments("    ret\n/* the end */\n", asm)] == [2]
        assert [hit.line for hit in find_comments("; old style\n@ arm style\n    ret\n", asm)] == [1, 2]


class TestListing:
    def test_what_this_machine_can_run(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        tools = tmp_path / "tools"
        fake_tools(tools, {"node", "ruby", "rustc", "cc"})
        monkeypatch.setenv("PATH", str(tools))
        ready, missing, pages, convert_only = language_groups()
        assert ready == ["python", "javascript", "typescript", "rust", "c", "ruby", "asm"]
        assert "lua" in missing and "zig" in missing and "cobol" in missing and "ruby" not in missing
        assert sorted(pages) == ["css", "html"] and set(convert_only) == CONVERT_ONLY

        listing = flat(runner.invoke(app, ["languages"]).stdout)
        assert "Ready on this machine (7): python, javascript, typescript, rust, c, ruby, asm" in listing
        assert "Need a tool installed" in listing and "Convert only: vb, ada, erlang, objc" in listing
        assert "--to <name>" in listing and ":target <name>" in listing

    def test_one_language_says_whether_it_runs_and_how_to_get_it(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        tools = tmp_path / "tools"
        fake_tools(tools, {"ruby"})
        monkeypatch.setenv("PATH", str(tools))
        assert f"✓ Ruby is ready: it runs with {tools / 'ruby'}." in flat(runner.invoke(app, ["languages", "rb"]).stdout)
        lua = flat(runner.invoke(app, ["languages", "lua"]).stdout)
        assert "✗ Lua needs `lua`. Install Lua (Debian/Ubuntu: sudo apt install lua5.4" in lua
        assert "imy convert file.imy --to lua" in lua
        assert "Ada converts: imy convert file.imy --to ada" in flat(runner.invoke(app, ["languages", "ada"]).stdout)
        assert "HTML is built, not run" in flat(runner.invoke(app, ["languages", "website"]).stdout)
        # A name IMY has never heard of still converts.
        assert "Brainfog converts" in flat(runner.invoke(app, ["languages", "Brainfog"]).stdout)
        bad = runner.invoke(app, ["languages", "not a name!"])
        assert bad.exit_code == 2 and "is not a language name" in bad.stderr
