from __future__ import annotations

from pathlib import Path

import pytest

from conftest import FIXTURES
from imy.errors import ErrorCode
from imy.parser import parse_file, parse_text
from imy.static_rules import MAX_SHORTCUT_LENGTH, check, prompting_reason


def codes(text: str, known: tuple[str, ...] = ()) -> list[ErrorCode]:
    return [d.code for d in check(parse_text(text), known).diagnostics]


def diagnostics_for(name: str):
    return check(parse_file(FIXTURES / name)).diagnostics


HEADER = '# ("test program that builds a small thing and shows how it works")\n'


class TestFixtures:
    def test_plain_english_prompting_is_rejected(self) -> None:
        found = diagnostics_for("invalid_prompting.imy")
        assert [d.code for d in found] == [ErrorCode.PROMPTING_DETECTED]
        assert found[0].line == 2
        assert found[0].family == "SyntaxError"

    def test_two_shortcuts_exceed_the_limit(self) -> None:
        found = diagnostics_for("invalid_two_shortcuts.imy")
        assert [d.code for d in found] == [ErrorCode.SHORTCUT_LIMIT_EXCEEDED]
        assert found[0].line == 4
        assert found[0].related == (3, 4)
        assert ".autotag (line 3)" in found[0].message and ".autosort (line 4)" in found[0].message

    def test_long_shortcut_exceeds_twenty_characters(self) -> None:
        found = diagnostics_for("invalid_long_shortcut.imy")
        assert [d.code for d in found] == [ErrorCode.SHORTCUT_LENGTH_EXCEEDED]
        assert "`.autodetect_every_widget_on_screen` is 34 characters" in found[0].message

    def test_out_of_order_blueprint_halts_with_both_lines(self) -> None:
        found = diagnostics_for("invalid_order.imy")
        assert [d.code for d in found] == [ErrorCode.EXECUTION_ORDER_VIOLATION]
        assert found[0].line == 3
        assert found[0].related == (5,)
        assert "never reorders" in found[0].message

    def test_magic_toggle_is_missing_mechanics(self) -> None:
        found = diagnostics_for("invalid_magic_toggle.imy")
        assert [d.code for d in found] == [ErrorCode.MISSING_MECHANICS]
        assert found[0].line == 3
        assert "DoubleJump" in found[0].message

    def test_dotted_toggle_is_missing_mechanics(self) -> None:
        found = diagnostics_for("invalid_dotted_toggle.imy")
        assert [d.code for d in found] == [ErrorCode.MISSING_MECHANICS]
        assert "editor.spellcheck" in found[0].message

    @pytest.mark.parametrize(
        "name",
        ["valid_platformer.imy", "valid_hello.imy", "valid_one_shortcut.imy", "website_right.imy",
         "website_wrong.imy", "session1.imy", "session2.imy"],
    )
    def test_valid_files_pass_the_static_stage(self, name: str) -> None:
        assert diagnostics_for(name) == ()

    def test_explicit_mechanics_file_has_no_shortcuts_and_a_pack(self) -> None:
        parsed = parse_file(FIXTURES / "valid_platformer.imy")
        assert parsed.shortcuts == []
        assert [(p.name, p.members) for p in parsed.packs] == [("XYZ", ("VelocityX", "velocityY", "velocityZ"))]
        assert [v.path for v in parsed.virtual_paths] == ["/save:slots"]

    def test_missing_header(self) -> None:
        found = diagnostics_for("missing_header.imy")
        assert [d.code for d in found] == [ErrorCode.MISSING_HEADER]
        assert found[0].line == 1

    def test_malformed_header(self) -> None:
        found = diagnostics_for("malformed_header.imy")
        assert [d.code for d in found] == [ErrorCode.MALFORMED_HEADER]


class TestHeader:
    def test_empty_file(self) -> None:
        assert codes("") == [ErrorCode.MISSING_HEADER]

    def test_header_without_body(self) -> None:
        assert codes(HEADER) == [ErrorCode.EMPTY_BODY]

    def test_too_short_description(self) -> None:
        assert codes('# ("calculator")\nx = 1\n') == [ErrorCode.MALFORMED_HEADER]

    def test_text_after_header_is_rejected(self) -> None:
        assert codes('# ("a calculator that adds numbers") extra\nx = 1\n') == [ErrorCode.MALFORMED_HEADER]

    def test_smart_quotes_from_phone_keyboards_are_accepted(self) -> None:
        assert codes("# (“a calculator that adds two numbers”)\ntotal = 1 + 2\n") == []

    def test_consecutive_headers_form_one_description(self) -> None:
        parsed = parse_text('# ("a calculator that adds")\n# ("and subtracts two numbers")\ntotal = 1 + 2\n')
        assert len(parsed.blocks) == 1
        assert parsed.blocks[0].description == "a calculator that adds and subtracts two numbers"
        assert check(parsed).ok

    def test_function_block_needs_its_own_header(self) -> None:
        text = HEADER + "total = 0\ndef add(a, b):\n    show (a + b)\nadd(1, 2)\n"
        found = check(parse_text(text)).diagnostics
        assert [d.code for d in found] == [ErrorCode.MISSING_HEADER]
        assert found[0].line == 3

    def test_function_block_with_header_passes(self) -> None:
        text = HEADER + 'total = 0\n# ("adds two numbers and shows the sum")\ndef add(a, b):\n    show (a + b)\nadd(1, 2)\n'
        assert codes(text) == []

    def test_hash_line_in_body_must_be_a_header(self) -> None:
        assert codes(HEADER + "x = 1\n#set x to two\n") == [ErrorCode.MALFORMED_HEADER]

    def test_comment_lines_are_rejected(self) -> None:
        assert codes(HEADER + "x = 1\n// make it faster\n") == [ErrorCode.COMMENT_IN_SOURCE]
        assert codes(HEADER + "x = 1\n-- note\n") == [ErrorCode.COMMENT_IN_SOURCE]
        assert codes(HEADER + "x = 1\n/* start\nmiddle\n*/\n") == [ErrorCode.COMMENT_IN_SOURCE] * 3

    def test_unterminated_string(self) -> None:
        assert codes(HEADER + 'name = "Ava\n') == [ErrorCode.UNTERMINATED_STRING]


class TestPrompting:
    @pytest.mark.parametrize(
        "line",
        [
            "hello make me a calculator app",
            "can you build a snake game for me",
            "please add a cool menu with music",
            "the player should fly when space is pressed",
            "i want a website that shows my photos",
            "x = make me a cool calculator app please",
        ],
    )
    def test_requests_and_sentences_are_prompting(self, line: str) -> None:
        assert codes(HEADER + line + "\n") == [ErrorCode.PROMPTING_DETECTED]

    @pytest.mark.parametrize(
        "line",
        [
            'show ("hello make me a calculator app")',
            "then",
            'call image "menu logo.png"',
            "if = menu.home page.structure",
            "then velocityY = velocityY + gravity",
            "loop forever",
            'menu = options "home, game, play"',
            "score += 1",
        ],
    )
    def test_code_lines_are_not_prompting(self, line: str) -> None:
        parsed = parse_text(HEADER + "score = 0\nvelocityY = 0\ngravity = 1\n" + line + "\n")
        assert prompting_reason(parsed.line(5)) is None

    def test_if_can_be_a_custom_variable(self) -> None:
        assert codes(HEADER + "if = 5\nthen = if + 1\nshow (then)\n") == []


class TestShortcuts:
    def test_twenty_characters_dot_included_is_the_limit(self) -> None:
        exactly = ".auto" + "x" * (MAX_SHORTCUT_LENGTH - 5)
        over = exactly + "y"
        assert len(exactly) == 20 and len(over) == 21
        assert codes(HEADER + f"app = App.open()\napp{exactly}\n") == []
        assert codes(HEADER + f"app = App.open()\napp{over}\n") == [ErrorCode.SHORTCUT_LENGTH_EXCEEDED]

    def test_shortcuts_inside_strings_do_not_count(self) -> None:
        assert codes(HEADER + 'app = App.open()\napp.autosave\nshow ("use .autotag and .autosort")\n') == []

    def test_shortcut_names_are_case_insensitive(self) -> None:
        assert codes(HEADER + "app = App.open()\napp.AutoTag\napp.AUTOSORT\n") == [ErrorCode.SHORTCUT_LIMIT_EXCEEDED]

    def test_one_shortcut_is_allowed(self) -> None:
        assert diagnostics_for("valid_one_shortcut.imy") == ()


class TestMechanicsAndOrder:
    def test_toggle_that_is_read_is_real_state(self) -> None:
        text = HEADER + "running = True\ncount = 0\nloop.until(running == False)\n"
        assert codes(text) == []

    def test_toggle_known_from_memory_is_not_magic(self) -> None:
        assert codes(HEADER + "Turbo = True\n") == [ErrorCode.MISSING_MECHANICS]
        assert codes(HEADER + "Turbo = True\n", known=("Turbo",)) == []

    def test_dotted_toggle_on_a_coded_object_is_fine(self) -> None:
        assert codes(HEADER + "light = Lamp.getInstance()\nlight.on\n") == []

    def test_use_before_definition_cites_both_lines(self) -> None:
        found = check(parse_text(HEADER + "total = price * 2\nprice = 5\n")).diagnostics
        assert [(d.code, d.line, d.related) for d in found] == [(ErrorCode.EXECUTION_ORDER_VIOLATION, 2, (3,))]

    def test_call_before_definition(self) -> None:
        found = check(parse_text(HEADER + 'greet("Ava")\n# ("greets a person by name and prints it")\ndef greet(name):\n    show (name)\n')).diagnostics
        assert [d.code for d in found] == [ErrorCode.EXECUTION_ORDER_VIOLATION]

    def test_names_from_memory_count_as_defined(self) -> None:
        assert codes(HEADER + "total = price * 2\nprice = 5\n", known=("price",)) == []

    def test_pack_used_before_its_declaration(self) -> None:
        text = HEADER + 'from = "xyz" movement = forward\nA = B = C = name variablepack = "XYZ"\n'
        found = check(parse_text(text)).diagnostics
        assert [(d.code, d.line, d.related) for d in found] == [(ErrorCode.EXECUTION_ORDER_VIOLATION, 2, (3,))]

    def test_initialisation_calls_may_come_before_the_shortcut(self) -> None:
        text = HEADER + "world = World.getInstance()\nWorld.connect()\nphysics.autohook\nWorld.detect(world)\n"
        assert codes(text) == []

    def test_function_bodies_are_not_order_checked(self) -> None:
        text = HEADER + '# ("returns the area of a circle from its radius")\ndef area(r):\n    result = r * r * pi\n    return result\npi = 3.14\nshow (area(2))\n'
        assert codes(text) == []
