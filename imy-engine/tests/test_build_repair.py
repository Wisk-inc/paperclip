"""A program its own build tool refuses is corrected by the model before anything runs."""

from __future__ import annotations

import io
import json
import platform
import shutil
from pathlib import Path

import pytest
from rich.console import Console
from typer.testing import CliRunner

from conftest import FakeLLM, make_compiler, reply, write
from imy.cli import app, open_session
from imy.compiler import CompileOptions
from imy.console import ImyConsole
from imy.errors import BuildFailed, LLMRateLimitError
from imy.memory import CompileCache
from imy.prompts import PROMPT_VERSION, build_failure_prompt, target_note
from imy.runner import build_artifact, build_report, prepare_program, report_headline, run_artifact, start_program, toolchain_for

runner = CliRunner()

PROGRAM = '# ("prints a greeting with the user\'s name and how many letters the name has")\nname = "Ava"\nshow ("Hello, " + name + "!")\n'
C_BROKEN = '#include <stdio.h>\nint main(void) {\n    const char *name = "Ava";\n    printf("Hello, %s!\\n", nmae);\n    return 0;\n}\n'
C_GOOD = '#include <stdio.h>\nint main(void) {\n    const char *name = "Ava";\n    printf("Hello, %s!\\n", name);\n    return 0;\n}\n'

needs_cc = pytest.mark.skipif(shutil.which("cc") is None, reason="needs a C compiler")


def compiled(tmp: Path, code: str, *, target: str, replies: tuple[str, ...] = ()):
    llm = FakeLLM([reply(code, target=target), *replies])
    compiler = make_compiler(tmp, llm)
    path = write(tmp / "hello.imy", PROGRAM)
    result = compiler.compile_file(path, CompileOptions(target=target))
    return llm, compiler, result


@pytest.fixture
def llm(monkeypatch: pytest.MonkeyPatch) -> FakeLLM:
    fake = FakeLLM()
    monkeypatch.setattr("imy.cli.make_client", lambda config, env: fake)
    return fake


class TestBuildFailure:
    @needs_cc
    def test_a_refused_program_says_which_tool_and_what_it_said(self, tmp_path: Path) -> None:
        _, compiler, result = compiled(tmp_path, C_BROKEN, target="c")
        artifact = build_artifact(result, compiler.workspace)
        with pytest.raises(BuildFailed) as caught:
            prepare_program(artifact, compiler.workspace)
        failure = caught.value
        assert failure.tool == "cc"
        assert failure.exit_code == 4
        assert "Building the C program failed" in failure.message
        assert "nmae" in failure.report
        # The folders it was built in are not part of what goes back to the model.
        assert str(tmp_path) not in failure.report
        assert "hello.c" in failure.report

    @needs_cc
    def test_nothing_runs_when_the_build_fails(self, tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
        _, compiler, result = compiled(tmp_path, C_BROKEN, target="c")
        with pytest.raises(BuildFailed):
            run_artifact(build_artifact(result, compiler.workspace), compiler.workspace)
        assert capfd.readouterr().out == ""

    def test_the_line_shown_is_the_one_that_names_the_error(self) -> None:
        gcc = "hello.c: In function 'main':\nhello.c:4:29: error: 'nmae' undeclared (first use in this function)\n    4 |     printf(nmae);"
        assert report_headline(gcc) == "hello.c:4:29: error: 'nmae' undeclared (first use in this function)"
        assert report_headline("/usr/bin/ld: main.o: undefined reference to `puts2'\ncollect2: error: ld returned 1") == (
            "/usr/bin/ld: main.o: undefined reference to `puts2'"
        )
        assert report_headline("something odd\nmore") == "something odd"
        assert report_headline("") == ""

    def test_the_report_is_short_and_names_no_folder(self, tmp_path: Path) -> None:
        _, compiler, result = compiled(tmp_path, 'print("Hello, Ava!")\n', target="python")
        artifact = build_artifact(result, compiler.workspace)
        noise = "\n".join(f"{artifact.path}:{n}: error: something is wrong here" for n in range(1, 200))
        report = build_report(noise + "\n\n", artifact)
        lines = report.splitlines()
        assert len(lines) == 30
        assert lines[0] == "hello.py:1: error: something is wrong here"
        assert str(tmp_path) not in report
        assert len(build_report("x" * 10_000, artifact)) < 3100

    @pytest.mark.parametrize(
        "target, tool, broken, good",
        [
            ("javascript", "node", 'const name = "Ava";\nconsole.log("Hello, " + name + "!";\n', 'const name = "Ava";\nconsole.log("Hello, " + name + "!");\n'),
            ("ruby", "ruby", 'name = "Ava"\nputs("Hello, " + name + "!"\n', 'name = "Ava"\nputs("Hello, " + name + "!")\n'),
            ("php", "php", '<?php\n$name = "Ava";\necho "Hello, " . $name . "!\\n"\n$x = ;\n', '<?php\n$name = "Ava";\necho "Hello, " . $name . "!\\n";\n'),
            ("perl", "perl", 'my $name = "Ava";\nprint("Hello, " . $name . "!\\n";\n', 'my $name = "Ava";\nprint("Hello, " . $name . "!\\n");\n'),
            ("bash", "bash", 'name="Ava"\nif [ -n "$name" ]; then\necho "Hello, $name!"\n', 'name="Ava"\necho "Hello, $name!"\n'),
        ],
    )
    def test_script_languages_are_checked_with_their_own_tool_when_the_code_is_new(
        self, tmp_path: Path, capfd: pytest.CaptureFixture[str], target: str, tool: str, broken: str, good: str
    ) -> None:
        if shutil.which(tool) is None:
            pytest.skip(f"needs {tool}")
        _, compiler, result = compiled(tmp_path / "bad", broken, target=target)
        artifact = build_artifact(result, compiler.workspace)
        with pytest.raises(BuildFailed) as caught:
            prepare_program(artifact, compiler.workspace, check_syntax=True)
        assert caught.value.tool == tool and caught.value.report
        assert "mistake its own tool found" in caught.value.message
        # Without the check the language's own run reports it, as before.
        assert prepare_program(artifact, compiler.workspace).run[-1] == str(artifact.path)
        capfd.readouterr()

        _, compiler, result = compiled(tmp_path / "good", good, target=target)
        artifact = build_artifact(result, compiler.workspace)
        toolchain = prepare_program(artifact, compiler.workspace, check_syntax=True)
        # The check prints nothing of its own ("Syntax OK" stays out of the program's output).
        assert capfd.readouterr().out == ""
        assert start_program(toolchain, artifact, compiler.workspace).exit_code == 0
        assert capfd.readouterr().out == "Hello, Ava!\n"

    def test_lua_is_checked_with_luac_when_it_is_installed(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        tools = tmp_path / "tools"
        tools.mkdir()
        for name in ("lua", "luac"):
            tool = tools / name
            tool.write_text("#!/bin/sh\nexit 0\n")
            tool.chmod(0o755)
        monkeypatch.setenv("PATH", str(tools))
        _, compiler, result = compiled(tmp_path, 'print("Hello, Ava!")\n', target="lua")
        artifact = build_artifact(result, compiler.workspace)
        toolchain = toolchain_for(artifact)
        assert toolchain is not None and toolchain.checks == [[str(tools / "luac"), "-p", str(artifact.path)]]
        (tools / "luac").unlink()
        assert toolchain_for(artifact).checks == []

    @pytest.mark.skipif(shutil.which("go") is None, reason="needs Go")
    def test_go_is_built_before_it_runs(self, tmp_path: Path, capfd: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("GOCACHE", str(tmp_path / "gocache"))
        monkeypatch.setenv("GOFLAGS", "-mod=mod")
        broken = 'package main\n\nimport "fmt"\n\nfunc main() {\n\tname := "Ava"\n\tfmt.Println("Hello, " + nmae + "!")\n}\n'
        _, compiler, result = compiled(tmp_path / "bad", broken, target="go")
        with pytest.raises(BuildFailed) as caught:
            prepare_program(build_artifact(result, compiler.workspace), compiler.workspace)
        assert caught.value.tool == "go" and "nmae" in caught.value.report
        good = broken.replace("nmae", "name")
        _, compiler, result = compiled(tmp_path / "good", good, target="go")
        assert run_artifact(build_artifact(result, compiler.workspace), compiler.workspace).exit_code == 0
        assert capfd.readouterr().out == "Hello, Ava!\n"

    @pytest.mark.skipif(shutil.which("javac") is None or shutil.which("java") is None, reason="needs a JDK")
    def test_java_is_compiled_before_it_runs(self, tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
        broken = 'public class Hello {\n    public static void main(String[] args) {\n        String name = "Ava";\n        System.out.println("Hello, " + nmae + "!");\n    }\n}\n'
        _, compiler, result = compiled(tmp_path / "bad", broken, target="java")
        with pytest.raises(BuildFailed) as caught:
            prepare_program(build_artifact(result, compiler.workspace), compiler.workspace)
        assert caught.value.tool == "javac" and "nmae" in caught.value.report
        _, compiler, result = compiled(tmp_path / "good", broken.replace("nmae", "name"), target="java")
        assert run_artifact(build_artifact(result, compiler.workspace), compiler.workspace).exit_code == 0
        assert capfd.readouterr().out == "Hello, Ava!\n"

    def test_java_without_a_compiler_on_path_still_runs_the_file(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        tools = tmp_path / "tools"
        tools.mkdir()
        java = tools / "java"
        java.write_text("#!/bin/sh\nexit 0\n")
        java.chmod(0o755)
        monkeypatch.setenv("PATH", str(tools))
        _, compiler, result = compiled(tmp_path, 'public class Hello {\n    public static void main(String[] args) {\n    }\n}\n', target="java")
        artifact = build_artifact(result, compiler.workspace)
        toolchain = toolchain_for(artifact)
        assert toolchain is not None and toolchain.steps == [] and toolchain.run == [str(java), str(artifact.path)]


class TestAssembly:
    ABSOLUTE = (
        '.section .data\nmsg: .string "Hello, Ava!"\n.section .text\n.globl main\nmain:\n'
        "    pushq %rbp\n    movq %rsp, %rbp\n    movq $msg, %rdi\n    call puts\n    xorl %eax, %eax\n    popq %rbp\n    ret\n"
        '.section .note.GNU-stack,"",@progbits\n'
    )

    @needs_cc
    @pytest.mark.skipif(platform.machine() not in ("x86_64", "amd64"), reason="x86-64 assembly")
    def test_code_that_addresses_data_absolutely_links_as_a_fixed_position_program(
        self, tmp_path: Path, capfd: pytest.CaptureFixture[str]
    ) -> None:
        _, compiler, result = compiled(tmp_path, self.ABSOLUTE, target="asm")
        artifact = build_artifact(result, compiler.workspace)
        toolchain = toolchain_for(artifact)
        assert toolchain is not None and toolchain.relaxed[0][1] == "-no-pie"
        assert run_artifact(artifact, compiler.workspace).exit_code == 0
        assert capfd.readouterr().out == "Hello, Ava!\n"

    @needs_cc
    def test_assembly_with_a_real_mistake_is_refused_with_the_assemblers_words(self, tmp_path: Path) -> None:
        _, compiler, result = compiled(tmp_path, ".globl main\nmain:\n    notaninstruction %rax\n    ret\n", target="asm")
        with pytest.raises(BuildFailed) as caught:
            prepare_program(build_artifact(result, compiler.workspace), compiler.workspace)
        assert "notaninstruction" in caught.value.report or "no such instruction" in caught.value.report.lower()

    def test_the_rules_are_the_ones_of_the_processor_it_runs_on(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(platform, "machine", lambda: "x86_64")
        note = target_note("asm") or ""
        assert "x86-64" in note and "(%rip)" in note and "@PLT" in note and "%eax" in note and "pushq %rbp" in note
        assert '.note.GNU-stack,"",@progbits' in note
        monkeypatch.setattr(platform, "machine", lambda: "aarch64")
        note = target_note("asm") or ""
        assert "AArch64" in note and "adrp" in note and ":lo12:" in note and "stp x29, x30" in note and "bl printf" in note
        assert "%rip" not in note and '.note.GNU-stack,"",%progbits' in note
        monkeypatch.setattr(platform, "machine", lambda: "riscv64")
        note = target_note("asm") or ""
        assert "riscv64" in note and "calling convention" in note and "%rip" not in note and "adrp" not in note


class TestRepair:
    def test_the_models_own_answer_and_the_tools_words_go_back(self, tmp_path: Path) -> None:
        llm, compiler, result = compiled(tmp_path, C_BROKEN, target="c", replies=(reply(C_GOOD, target="c"),))
        assert result.options is not None and result.build_repairs == 0
        fixed = compiler.repair(result, tool="cc", report="hello.c:4:29: error: 'nmae' undeclared")
        assert fixed.code == C_GOOD and fixed.build_repairs == 1 and not fixed.from_cache
        assert fixed.cache_key == result.cache_key and fixed.language.name == "c"
        assert llm.calls == 2
        first, answer, request = llm.requests[1].messages
        assert first.role == "user" and first.content == llm.requests[0].messages[0].content
        assert answer.role == "assistant" and json.loads(answer.content)["compiled_code"] == C_BROKEN
        assert request.role == "user"
        assert "does not build" in request.content and "`cc` reported" in request.content
        assert "'nmae' undeclared" in request.content and 'target_language "c"' in request.content
        # The corrected program takes the refused one's place: the next compile reuses it.
        again = compiler.compile_file(tmp_path / "hello.imy", CompileOptions(target="c"))
        assert again.from_cache and again.code == C_GOOD and llm.calls == 2

    def test_a_correction_that_breaks_an_output_rule_is_asked_for_again(self, tmp_path: Path) -> None:
        commented = C_GOOD.replace("    return 0;", "    return 0; // done")
        llm, compiler, result = compiled(
            tmp_path, C_BROKEN, target="c", replies=(reply(commented, target="c"), reply(C_GOOD, target="c"))
        )
        fixed = compiler.repair(result, tool="cc", report="hello.c:4: error")
        assert fixed.code == C_GOOD and llm.calls == 3

    def test_forgetting_a_program_makes_the_next_compile_ask_again(self, tmp_path: Path) -> None:
        llm, compiler, result = compiled(tmp_path, C_BROKEN, target="c", replies=(reply(C_GOOD, target="c"),))
        assert CompileCache(compiler.workspace.cache).get(result.cache_key) is not None
        compiler.forget(result)
        assert CompileCache(compiler.workspace.cache).get(result.cache_key) is None
        compiler.forget(result)
        again = compiler.compile_file(tmp_path / "hello.imy", CompileOptions(target="c"))
        assert not again.from_cache and again.code == C_GOOD and llm.calls == 2

    def test_the_request_names_the_tool_and_keeps_the_rules(self) -> None:
        text = build_failure_prompt("rustc", "error[E0425]: cannot find value `nmae`", "rust")
        assert "`rustc` reported:\nerror[E0425]: cannot find value `nmae`\n" in text
        assert "zero comments" in text and "nothing invented" in text and 'target_language "rust"' in text

    def test_the_prompt_version_moved_with_the_prompt(self) -> None:
        assert PROMPT_VERSION == "imy-compiler-3"


@needs_cc
class TestRunCommand:
    def test_run_corrects_a_program_the_compiler_refuses_then_runs_it(self, isolated: Path, llm: FakeLLM) -> None:
        path = write(isolated / "hello.imy", PROGRAM)
        llm.queue(reply(C_BROKEN, target="c"), reply(C_GOOD, target="c"))
        result = runner.invoke(app, ["run", str(path), "--to", "c"])
        assert result.exit_code == 0, result.stderr
        assert result.stdout == "" or "Hello, Ava!" in result.stdout
        assert "cc refused the program:" in result.stderr and "nmae" in result.stderr
        assert "corrected (" in result.stderr
        assert llm.calls == 2
        assert (isolated / ".imy" / "build" / "hello.c").read_text() == C_GOOD
        # The second run is the corrected program from the cache: no model, no build problem.
        again = runner.invoke(app, ["run", str(path), "--to", "c"])
        assert again.exit_code == 0 and "refused" not in again.stderr and "cached" in again.stderr
        assert llm.calls == 2

    def test_show_code_prints_the_corrected_program(self, isolated: Path, llm: FakeLLM) -> None:
        path = write(isolated / "hello.imy", PROGRAM)
        llm.queue(reply(C_BROKEN, target="c"), reply(C_GOOD, target="c"))
        result = runner.invoke(app, ["run", str(path), "--to", "c", "--show-code"])
        assert result.exit_code == 0, result.stderr
        assert "name);" in result.stderr and "nmae);" not in result.stderr.split("corrected (")[1]

    def test_with_no_repairs_allowed_the_failure_is_reported_and_not_kept(self, isolated: Path, llm: FakeLLM, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("IMY_REPAIR_ATTEMPTS", "0")
        path = write(isolated / "hello.imy", PROGRAM)
        llm.queue(reply(C_BROKEN, target="c"), reply(C_GOOD, target="c"))
        result = runner.invoke(app, ["run", str(path), "--to", "c"])
        assert result.exit_code == 4
        assert "Building the C program failed" in result.stderr and "nmae" in result.stderr
        assert llm.calls == 1
        # The refused program was not kept: running again asks the model afresh.
        again = runner.invoke(app, ["run", str(path), "--to", "c"])
        assert again.exit_code == 0, again.stderr
        assert llm.calls == 2

    def test_a_program_that_never_builds_stops_after_the_allowed_corrections(self, isolated: Path, llm: FakeLLM) -> None:
        path = write(isolated / "hello.imy", PROGRAM)
        llm.queue(reply(C_BROKEN, target="c"), reply(C_BROKEN.replace("nmae", "naem"), target="c"))
        result = runner.invoke(app, ["run", str(path), "--to", "c"])
        assert result.exit_code == 4
        assert result.stderr.count("refused the program") == 1
        assert "Building the C program failed" in result.stderr and "naem" in result.stderr
        assert llm.calls == 2

    def test_when_the_model_cannot_be_asked_the_build_failure_is_what_is_reported(self, isolated: Path, llm: FakeLLM) -> None:
        def busy(request: object) -> str:
            raise LLMRateLimitError("The model is busy.", hint="Try again in a minute.")

        path = write(isolated / "hello.imy", PROGRAM)
        llm.queue(reply(C_BROKEN, target="c"), busy)
        result = runner.invoke(app, ["run", str(path), "--to", "c"])
        assert result.exit_code == 4
        assert "Building the C program failed" in result.stderr
        assert "The model could not correct it (The model is busy)" in result.stderr

    def test_the_console_corrects_it_too(self, isolated: Path, llm: FakeLLM, capfd: pytest.CaptureFixture[str]) -> None:
        llm.queue(reply(C_BROKEN, target="c"), reply(C_GOOD, target="c"))
        console = Console(record=True, width=160, force_terminal=False, file=io.StringIO())
        feed = iter(['# ("prints a greeting with the user\'s name and how many letters the name has")', 'name = "Ava"', 'show ("Hello, " + name + "!")', ":run", ":code", ":quit"])
        session = open_session(isolated / "console.imy")
        repl = ImyConsole(lambda p, m: session, target="c", console=console, input_fn=lambda prompt: next(feed))
        assert repl.loop() == 0
        text = console.export_text()
        assert "cc refused the program:" in text and "corrected (" in text and "exit code 0" in text
        assert "Hello, Ava!" in capfd.readouterr().out
        # :code shows the program that ran, not the refused one.
        assert "name);" in text.split("exit code 0")[1] and "nmae" not in text.split("exit code 0")[1]
