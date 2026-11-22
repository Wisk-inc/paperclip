from __future__ import annotations

import json
from pathlib import Path

import pytest

from conftest import FIXTURES, FakeLLM, make_compiler, reply, symbol, write
from imy.compiler import CompileOptions
from imy.errors import CompilationFailed, ConfigError, ErrorCode, LLMResponseError, Stage
from imy.languages import resolve_language
from imy.parser import parse_file, parse_text
from imy.postprocess import check_output, clean_output, find_comments
from imy.prompts import RESPONSE_SCHEMA, ResponseFormatError, extract_json_object, parse_compiler_response

HELLO = FIXTURES / "valid_hello.imy"
HELLO_PY = 'name = "Ava"\nletters = len(name)\nprint("Hello, " + name + "!")\nprint("Your name has " + str(letters) + " letters.")\n'


def compile_hello(tmp: Path, llm: FakeLLM, **options: object):
    compiler = make_compiler(tmp, llm)
    path = write(tmp / "hello.imy", HELLO.read_text(encoding="utf-8"))
    return compiler.compile_file(path, CompileOptions(target="python", **options))  # type: ignore[arg-type]


class TestContract:
    def test_schema_requires_every_field(self) -> None:
        assert set(RESPONSE_SCHEMA["required"]) == {"status", "errors", "extracted_symbols", "target_language", "compiled_code"}
        assert RESPONSE_SCHEMA["additionalProperties"] is False

    def test_plain_json(self) -> None:
        parsed = parse_compiler_response(reply("x = 1\n"))
        assert parsed.status == "ok" and parsed.compiled_code == "x = 1\n"

    def test_fenced_json_and_think_blocks_are_tolerated(self) -> None:
        text = "<think>planning</think>\nSure! Here it is:\n```json\n" + reply("x = 1\n") + "\n```"
        assert parse_compiler_response(text).compiled_code == "x = 1\n"

    def test_json_inside_prose(self) -> None:
        assert extract_json_object('The answer is {"a": 1} as requested.') == {"a": 1}

    @pytest.mark.parametrize(
        "payload, needle",
        [
            ("not json at all", "no JSON object"),
            ("[1, 2]", "not an object"),
            (json.dumps({"status": "ok", "errors": [], "extracted_symbols": [], "target_language": "python", "compiled_code": ""}), "compiled_code"),
            (json.dumps({"status": "error", "errors": [], "extracted_symbols": [], "target_language": "python", "compiled_code": ""}), "errors"),
            (json.dumps({"status": "ok", "errors": [{"code": "Nope", "line": 1, "message": "x"}], "extracted_symbols": [], "target_language": "python", "compiled_code": "x"}), "errors"),
        ],
    )
    def test_malformed_replies_are_rejected(self, payload: str, needle: str) -> None:
        with pytest.raises(ResponseFormatError) as caught:
            parse_compiler_response(payload)
        assert needle in str(caught.value)


class TestCompilePipeline:
    def test_successful_compile_is_cached(self, tmp_path: Path) -> None:
        llm = FakeLLM([reply(HELLO_PY, symbols=[symbol("name", "variable", "the name Ava")])])
        first = compile_hello(tmp_path, llm)
        assert first.code == HELLO_PY and not first.from_cache and first.attempts == 1
        request = llm.requests[0]
        assert request.json_schema == RESPONSE_SCHEMA
        assert "IMY SOURCE (numbered" in request.messages[0].content
        assert ' 2 | name = "Ava"' in request.messages[0].content
        assert "Zero comments" in request.system
        second = compile_hello(tmp_path, llm)
        assert second.from_cache and llm.calls == 1 and second.code == HELLO_PY
        third = compile_hello(tmp_path, FakeLLM([reply(HELLO_PY)]), use_cache=False)
        assert not third.from_cache

    def test_static_errors_never_reach_the_model(self, tmp_path: Path) -> None:
        llm = FakeLLM()
        compiler = make_compiler(tmp_path, llm)
        with pytest.raises(CompilationFailed) as caught:
            compiler.compile_file(FIXTURES / "invalid_prompting.imy", CompileOptions(target="python"))
        assert caught.value.codes == [ErrorCode.PROMPTING_DETECTED]
        assert llm.calls == 0

    def test_model_reported_errors_cut_off_with_line_numbers(self, tmp_path: Path) -> None:
        llm = FakeLLM([reply(status="error", errors=[
            {"code": "AmbiguousIntent", "line": 3, "message": "count(name) could mean letters or words; say which"},
            {"code": "HeaderMismatch", "line": 99, "message": "out of range line"},
        ])])
        with pytest.raises(CompilationFailed) as caught:
            compile_hello(tmp_path, llm)
        found = caught.value.diagnostics
        assert [(d.code, d.line, d.stage) for d in found] == [
            (ErrorCode.HEADER_MISMATCH, 0, Stage.LLM),
            (ErrorCode.AMBIGUOUS_INTENT, 3, Stage.LLM),
        ]
        assert list((tmp_path / ".imy" / "cache").glob("*.json")) == []

    def test_malformed_reply_gets_one_repair(self, tmp_path: Path) -> None:
        llm = FakeLLM(["sorry, I can't produce JSON", reply(HELLO_PY)])
        result = compile_hello(tmp_path, llm)
        assert result.code == HELLO_PY and result.attempts == 2
        repair = llm.requests[1].messages
        assert [m.role for m in repair] == ["user", "assistant", "user"]
        assert "could not be used" in repair[-1].content

    def test_malformed_twice_is_a_clean_model_error(self, tmp_path: Path) -> None:
        llm = FakeLLM(["nope", "still nope"])
        with pytest.raises(LLMResponseError) as caught:
            compile_hello(tmp_path, llm)
        assert "after 2 attempt(s)" in caught.value.message

    def test_comment_in_output_is_repaired_then_accepted(self, tmp_path: Path) -> None:
        llm = FakeLLM([reply("# greet the user\n" + HELLO_PY), reply(HELLO_PY)])
        result = compile_hello(tmp_path, llm)
        assert result.code == HELLO_PY and result.attempts == 2
        assert "CommentsInOutput" in llm.requests[1].messages[-1].content

    def test_comment_in_output_twice_fails_with_output_lines(self, tmp_path: Path) -> None:
        bad = HELLO_PY + "print('done')  # finished\n"
        llm = FakeLLM([reply(bad), reply(bad)])
        with pytest.raises(CompilationFailed) as caught:
            compile_hello(tmp_path, llm)
        assert caught.value.codes == [ErrorCode.COMMENTS_IN_OUTPUT]
        diag = caught.value.diagnostics[0]
        assert diag.stage is Stage.OUTPUT and diag.line == 5
        assert caught.value.output_lines[4].startswith("print('done')")

    def test_fences_are_stripped_from_compiled_code(self, tmp_path: Path) -> None:
        llm = FakeLLM([reply("```python\n" + HELLO_PY + "```\n")])
        result = compile_hello(tmp_path, llm)
        assert result.code == HELLO_PY
        assert any("fence" in note for note in result.notes)

    def test_wrong_target_language_is_repaired(self, tmp_path: Path) -> None:
        llm = FakeLLM([reply(HELLO_PY, target="javascript"), reply(HELLO_PY, target="py")])
        result = compile_hello(tmp_path, llm)
        assert result.attempts == 2

    def test_python_syntax_errors_are_rejected(self, tmp_path: Path) -> None:
        llm = FakeLLM([reply("print('a'\n"), reply("print('a'\n")])
        with pytest.raises(CompilationFailed) as caught:
            compile_hello(tmp_path, llm)
        assert ErrorCode.INVALID_OUTPUT in caught.value.codes

    def test_unknown_language_name_is_a_config_error(self, tmp_path: Path) -> None:
        compiler = make_compiler(tmp_path, FakeLLM())
        with pytest.raises(ConfigError):
            compiler.compile_file(HELLO, CompileOptions(target="no such language!"))

    def test_lost_message_is_rejected(self, tmp_path: Path) -> None:
        changed = HELLO_PY.replace("Your name has ", "Name length: ")
        llm = FakeLLM([reply(changed), reply(changed)])
        with pytest.raises(CompilationFailed) as caught:
            compile_hello(tmp_path, llm)
        assert caught.value.codes == [ErrorCode.MESSAGE_NOT_PRESERVED]
        assert caught.value.diagnostics[0].line == 5

    @pytest.mark.parametrize(
        "source_line, compiled",
        [
            ('show ("Don\'t stop now")', "print('Don\\'t stop now')\n"),
            ('show ("She said \\"go on\\" twice")', 'print("She said \\"go on\\" twice")\n'),
            ('show ("Caf\u00e9 is open")', 'print("Caf\\u00e9 is open")\n'),
            ('show ("Tom & Jerry <3 cheese")', 'print("Tom & Jerry <3 cheese")\n'),
        ],
    )
    def test_a_message_written_with_escapes_still_counts_as_kept(self, tmp_path: Path, source_line: str, compiled: str) -> None:
        llm = FakeLLM([reply(compiled)])
        compiler = make_compiler(tmp_path, llm)
        path = write(tmp_path / "msg.imy", '# ("prints one message for the user to read")\n' + source_line + "\n")
        assert compiler.compile_file(path, CompileOptions(target="python")).code == compiled

    def test_virtual_paths_are_mapped_into_the_prompt(self, tmp_path: Path) -> None:
        llm = FakeLLM([reply("VelocityX = 0\n")])
        compiler = make_compiler(tmp_path, llm)
        path = write(tmp_path / "platformer.imy", (FIXTURES / "valid_platformer.imy").read_text(encoding="utf-8"))
        result = compiler.compile_file(path, CompileOptions(target="python"))
        assert result.vfs.virtual_paths == {"/save:slots": ".imy/vfs/save/slots"}
        assert '"/save:slots" -> ".imy/vfs/save/slots"' in llm.last_prompt()
        assert 'variable pack "XYZ" (line 4): members VelocityX, velocityY, velocityZ' in llm.last_prompt()


class TestLenientReplies:
    BASE = {"status": "ok", "errors": [], "target_language": "python", "compiled_code": "x = 1\n"}

    def test_one_unusable_symbol_does_not_sink_the_program(self) -> None:
        payload = {**self.BASE, "extracted_symbols": [
            {"name": "PI", "kind": "constant", "meaning": "3.14", "source_fragment": "PI = 3.14"},
            {"name": "XYZ", "kind": "Variable Pack", "meaning": "three speeds"},
            {"name": "weird", "kind": "galaxy", "meaning": "?"},
            {"name": "", "kind": "variable", "meaning": "no name"},
            "not an object",
            {"name": "greet", "kind": "method", "meaning": "greets", "source_fragment": 7},
        ]}
        parsed = parse_compiler_response(json.dumps(payload))
        assert [(s.name, s.kind.value, s.source_fragment) for s in parsed.extracted_symbols] == [
            ("PI", "variable", "PI = 3.14"), ("XYZ", "variable_pack", ""), ("greet", "function", ""),
        ]
        assert parse_compiler_response(json.dumps({**self.BASE, "extracted_symbols": None})).extracted_symbols == []

    @pytest.mark.parametrize(
        "code, expected",
        [("ShortcutLimitExceeded", "ShortcutLimitExceeded"), ("missing_mechanics", "MissingMechanics"),
         ("AMBIGUOUS INTENT", "AmbiguousIntent"), ("executionOrderViolation", "ExecutionOrderViolation"),
         ("CommentInSource", "CommentInSource")],
    )
    def test_error_codes_in_other_spellings_are_understood(self, code: str, expected: str) -> None:
        payload = {"status": "error", "errors": [{"code": code, "line": None, "message": "why"}],
                   "extracted_symbols": [], "target_language": "python", "compiled_code": None}
        parsed = parse_compiler_response(json.dumps(payload))
        assert [(e.code, e.line) for e in parsed.errors] == [(expected, 0)]

    def test_unknown_error_codes_go_back_for_repair(self, tmp_path: Path) -> None:
        bad = json.dumps({"status": "error", "errors": [{"code": "VibesOff", "line": 2, "message": "hm"}],
                          "extracted_symbols": [], "target_language": "python", "compiled_code": ""})
        with pytest.raises(ResponseFormatError) as caught:
            parse_compiler_response(bad)
        assert "ExecutionOrderViolation" in str(caught.value)
        llm = FakeLLM([bad, reply(HELLO_PY)])
        assert compile_hello(tmp_path, llm).attempts == 2

    def test_a_static_rule_code_from_the_model_is_reported_under_that_rule(self, tmp_path: Path) -> None:
        llm = FakeLLM([reply(status="error", errors=[{"code": "shortcut_limit_exceeded", "line": 3, "message": "two helpers"}])])
        with pytest.raises(CompilationFailed) as caught:
            compile_hello(tmp_path, llm)
        assert caught.value.codes == [ErrorCode.SHORTCUT_LIMIT_EXCEEDED]


class TestZeroComments:
    @pytest.mark.parametrize(
        "language, code, lines",
        [
            ("python", "x = 1  # note\n", [1]),
            ("python", 'def f():\n    """Explain."""\n    return 1\n', [2]),
            ("python", 'x = "# not a comment"\ny = 2\n', []),
            ("javascript", "let a = 1; // note\n", [1]),
            ("javascript", "/* block */\nlet a = 1;\n", [1]),
            ("javascript", 'let u = "http://example.com"; let r = /a\\/\\/b/;\n', []),
            ("javascript", "let t = `// inside a template`;\n", []),
            ("typescript", "const a: number = 1 // note\n", [1]),
            ("java", 'char c = \'/\'; String s = "/*x*/";\n', []),
            ("java", "int a = 1; /* note */\n", [1]),
            ("rust", "fn f<'a>(x: &'a str) -> &'a str { x }\n", []),
            ("rust", 'let s = r#"// raw"#;\n', []),
            ("rust", "let a = 1; // note\n", [1]),
            ("go", "s := `// raw`\n", []),
            ("go", "x := 1 // note\n", [1]),
            ("c", "#include <stdio.h>\nint main(void) { return 0; }\n", []),
            ("lua", 'print("-- not a comment")\n', []),
            ("lua", "print(1) -- note\n", [1]),
            ("lua", "--[[ long\ncomment ]]\nprint(1)\n", [1]),
            ("bash", 'echo "${#items[@]}"\nn=$#\n', []),
            ("bash", "echo hi # note\n", [1]),
            ("bash", "#!/bin/bash\necho hi\n", [1]),
            ("ruby", "puts 'hi' # note\n", [1]),
            ("ruby", "=begin\nnote\n=end\nputs 1\n", [1]),
            ("php", "<?php\n#[Attr]\nfunction f() {}\n", []),
            ("php", "<?php\n$a = 1; # note\n", [2]),
            ("sql", "SELECT 1; -- note\n", [1]),
            ("css", "a { color: red; } /* note */\n", [1]),
            ("html", "<!DOCTYPE html>\n<html><body><!-- note --><p>hi</p></body></html>\n", [2]),
            ("html", "<html><body><script>\nlet a = 1; // note\n</script></body></html>\n", [2]),
            ("cobol", "       // generic note\n", [1]),
        ],
    )
    def test_comment_detection(self, language: str, code: str, lines: list[int]) -> None:
        hits = find_comments(code, resolve_language(language))
        assert [hit.line for hit in hits] == lines

    @pytest.mark.parametrize(
        "language, code, lines",
        [
            ("java", 'String s = """\n  see http://x.example // text\n  # text\n  """;\nint a = 1; // real\n', [5]),
            ("kotlin", 'val s = """\n a // b\n """\nprintln(s) // real\n', [4]),
            ("swift", 'let s = """\n  a // b\n  """\nprint(s) // real\n', [4]),
            ("dart", "var s = \'\'\'\n a // b\n \'\'\';\nprint(s); // real\n", [4]),
            ("csharp", 'var s = """\n a // b\n """;\nConsole.WriteLine(s); // real\n', [4]),
            ("julia", 's = """\n a # b\n """\nprintln(s) # real\n', [4]),
            ("elixir", 's = """\n a # b\n """\nIO.puts(s) # real\n', [4]),
            ("java", "char q = '\\'';\nchar c = '\"';\nint a = 1;\n", []),
        ],
    )
    def test_text_blocks_are_text_not_comments(self, language: str, code: str, lines: list[int]) -> None:
        assert [hit.line for hit in find_comments(code, resolve_language(language))] == lines

    def test_convert_rejects_any_comment_token(self, tmp_path: Path) -> None:
        llm = FakeLLM([reply("console.log('hi'); // done\n", target="javascript")] * 2)
        compiler = make_compiler(tmp_path, llm)
        path = write(tmp_path / "hi.imy", '# ("prints a single greeting to the console")\nshow ("hi")\n')
        with pytest.raises(CompilationFailed) as caught:
            compiler.compile_file(path, CompileOptions(target="javascript", save_memory=False))
        assert caught.value.codes == [ErrorCode.COMMENTS_IN_OUTPUT]

    def test_chat_prose_lines_are_removed_but_code_is_kept(self) -> None:
        code, notes = clean_output("Here is the code:\nprint(1)\noutput: int = 5\n")
        assert code == "print(1)\noutput: int = 5\n"
        assert len(notes) == 1


class TestWebsiteStrictness:
    RIGHT_HTML = (
        '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n</head>\n<body>\n<nav>\n'
        '<a href="#home">home</a>\n<a href="#game">game</a>\n<a href="#play">play</a>\n</nav>\n'
        '<img src="menu logo.png" alt="menu logo">\n</body>\n</html>\n'
    )

    def _compile(self, tmp: Path, name: str, *replies: str):
        llm = FakeLLM(list(replies))
        compiler = make_compiler(tmp, llm)
        path = write(tmp / name, (FIXTURES / name).read_text(encoding="utf-8"))
        return compiler.compile_file(path, CompileOptions(target="html", save_memory=False)), llm

    def test_right_blueprint_compiles_line_for_line(self, tmp_path: Path) -> None:
        result, llm = self._compile(tmp_path, "website_right.imy", reply(self.RIGHT_HTML, target="html"))
        assert result.code == self.RIGHT_HTML
        assert "STRICT WEBSITE RULES" in llm.last_prompt()

    def test_wrong_blueprint_with_invented_logo_and_style_is_rejected(self, tmp_path: Path) -> None:
        flashy = (
            '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<style>body { background: black; }</style>\n</head>\n'
            '<body class="theme-dark">\n<img src="logo.png" alt="arcade logo">\n<h1>Welcome!</h1>\n<p>arcade stuff, arcade logo</p>\n'
            "</body>\n</html>\n"
        )
        with pytest.raises(CompilationFailed) as caught:
            self._compile(tmp_path, "website_wrong.imy", reply(flashy, target="html"), reply(flashy, target="html"))
        codes = caught.value.codes
        assert ErrorCode.INVENTED_STYLING in codes
        assert ErrorCode.INVENTED_ASSET in codes
        assert ErrorCode.INVENTED_CONTENT in codes

    def test_wrong_blueprint_as_a_bare_white_page_is_accepted(self, tmp_path: Path) -> None:
        bare = '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n</head>\n<body>\n<p>arcade stuff, arcade logo</p>\n</body>\n</html>\n'
        result, _ = self._compile(tmp_path, "website_wrong.imy", reply(bare, target="html"))
        assert "<style" not in result.code and "<img" not in result.code

    def test_wrong_blueprint_can_halt_with_missing_mechanics(self, tmp_path: Path) -> None:
        refusal = reply(status="error", target="html", errors=[
            {"code": "MissingMechanics", "line": 2, "message": "the logo is described but no image file is named"},
        ])
        with pytest.raises(CompilationFailed) as caught:
            self._compile(tmp_path, "website_wrong.imy", refusal)
        assert caught.value.codes == [ErrorCode.MISSING_MECHANICS]

    def test_a_script_from_the_web_that_the_code_never_names_is_rejected(self) -> None:
        parsed = parse_text('# ("shows one greeting on the home page")\nshow "Hello there"\n')
        html = (
            '<!DOCTYPE html>\n<html><head><meta charset="utf-8">\n<script src="https://cdn.example/x.js"></script>\n'
            "</head><body><p>Hello there</p></body></html>\n"
        )
        checked = check_output(html, resolve_language("html"), parsed)
        assert [(d.code, d.line) for d in checked.diagnostics] == [(ErrorCode.INVENTED_ASSET, 3)]
        named = parse_text('# ("loads my chart script and shows one greeting")\nload script "https://cdn.example/x.js"\nshow "Hello there"\n')
        assert check_output(html, resolve_language("html"), named).ok

    def test_srcset_lists_are_checked_one_file_at_a_time(self) -> None:
        parsed = parse_text('# ("shows one photo of the shop on the page")\ncall image "shop photo.png"\n')
        html = (
            '<!DOCTYPE html>\n<html><head><meta charset="utf-8"></head><body>\n'
            '<img src="shop photo.png" srcset="shop%20photo.png 1x, shop-hd.png 2x">\n</body></html>\n'
        )
        checked = check_output(html, resolve_language("html"), parsed)
        assert [(d.code, d.line) for d in checked.diagnostics] == [(ErrorCode.INVENTED_ASSET, 3)]
        assert "shop-hd.png" in checked.diagnostics[0].message

    def test_styling_is_allowed_when_the_code_defines_it(self) -> None:
        parsed = parse_text('# ("shows a red title on the home page")\ntitle = text "Hi there" color "red"\n')
        html = '<!DOCTYPE html>\n<html><head><meta charset="utf-8"></head><body><h1 style="color: red">Hi there</h1></body></html>\n'
        checked = check_output(html, resolve_language("html"), parsed)
        assert checked.ok, checked.diagnostics
