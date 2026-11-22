from __future__ import annotations

import ast
import shutil
import subprocess
from pathlib import Path

import pytest

from conftest import FakeLLM, make_compiler, reply, write
from imy.errors import CompilationFailed, ErrorCode, InjectionError
from imy.languages import resolve_language
from imy.repo_injector import find_insertion, indent_unit, inject, parse_repo_url, reindent

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="needs git")

APP = '''import sys


def add(a, b):
    return a + b


def main():
    print("start")
    result = add(2, 3)
    print("end", result)


if __name__ == "__main__":
    main()
'''

IMY = '# ("adds two numbers inside the add helper and prints the sum before returning it")\ntotal = a + b\nshow ("Sum: " + total)\n'
SNIPPET = 'total = a + b\nprint("Sum: " + str(total))\n'


def make_repo(root: Path) -> Path:
    repo = root / "upstream"
    (repo / "pkg").mkdir(parents=True)
    (repo / "pkg" / "app.py").write_text(APP, encoding="utf-8")
    (repo / "README.md").write_text("demo\n", encoding="utf-8")
    git = ["git", "-c", "user.name=IMY Test", "-c", "user.email=imy@example.invalid", "-c", "init.defaultBranch=main"]
    subprocess.run([*git, "init", "-q", str(repo)], check=True)
    subprocess.run([*git, "-C", str(repo), "add", "."], check=True)
    subprocess.run([*git, "-C", str(repo), "commit", "-q", "-m", "demo"], check=True)
    return repo


class TestUrls:
    @pytest.mark.parametrize(
        "text, url",
        [
            ("https://github.com/huggingface/transformers", "https://github.com/huggingface/transformers.git"),
            ("https://github.com/huggingface/transformers.git", "https://github.com/huggingface/transformers.git"),
            ("https://github.com/huggingface/transformers/", "https://github.com/huggingface/transformers.git"),
            ("git@github.com:huggingface/transformers.git", "git@github.com:huggingface/transformers.git"),
            ("huggingface/transformers", "https://github.com/huggingface/transformers.git"),
            ("https://gitlab.com/group/sub/repo", "https://gitlab.com/group/sub/repo"),
            ("https://git.example.com/team/repo.git", "https://git.example.com/team/repo.git"),
            ("https://github.com/huggingface/transformers/tree/main/src", "https://github.com/huggingface/transformers.git"),
            ("https://www.github.com/huggingface/transformers/blob/main/README.md", "https://github.com/huggingface/transformers.git"),
            ("git@gitlab.com:group/sub/repo.git", "git@gitlab.com:group/sub/repo.git"),
        ],
    )
    def test_valid(self, text: str, url: str) -> None:
        assert parse_repo_url(text).url == url

    def test_every_way_of_naming_a_github_repository_shares_one_clone_folder(self) -> None:
        folders = {
            parse_repo_url(text).folder
            for text in ("huggingface/transformers", "https://github.com/huggingface/transformers.git",
                         "git@github.com:huggingface/transformers.git", "https://github.com/huggingface/transformers/tree/main")
        }
        assert folders == {"huggingface__transformers"}

    @pytest.mark.parametrize(
        "text",
        ["", "   ", "not a url", "--upload-pack=touch /tmp/x", "ext::sh -c touch", "https://example.com/page",
         "ftp://github.com/a/b", "https://github.com/onlyowner", "github.com", "https://github.com/a b/c",
         "fd::17", "foo::bar/baz", "https://github.com/a/..", "git@host:norepo", "-oProxyCommand=x"],
    )
    def test_invalid(self, text: str) -> None:
        with pytest.raises(InjectionError):
            parse_repo_url(text)

    def test_local_folder_must_be_a_repository(self, tmp_path: Path) -> None:
        with pytest.raises(InjectionError):
            parse_repo_url(str(tmp_path))
        repo = make_repo(tmp_path)
        assert parse_repo_url(str(repo)).local


class TestInsertion:
    LINES = APP.rstrip("\n").split("\n")

    def test_anchor_on_a_block_opener_goes_into_the_block(self) -> None:
        point = find_insertion(self.LINES, language=resolve_language("python"), anchor="def add(a, b):")
        assert (point.index, point.indent, point.position) == (4, "    ", "after")

    def test_anchor_before(self) -> None:
        point = find_insertion(self.LINES, language=resolve_language("python"), anchor='print("end", result)', before=True)
        assert (point.index, point.indent) == (10, "    ")

    def test_line_number(self) -> None:
        point = find_insertion(self.LINES, language=resolve_language("python"), line=11)
        assert (point.index, point.indent) == (10, "    ")
        with pytest.raises(InjectionError):
            find_insertion(self.LINES, language=resolve_language("python"), line=99)

    def test_ambiguous_and_missing_anchors(self) -> None:
        with pytest.raises(InjectionError) as caught:
            find_insertion(self.LINES, language=resolve_language("python"), anchor="print(")
        assert "appears 2 times" in caught.value.message
        with pytest.raises(InjectionError):
            find_insertion(self.LINES, language=resolve_language("python"), anchor="nowhere")
        with pytest.raises(InjectionError):
            find_insertion(self.LINES, language=resolve_language("python"), anchor="x", line=2)

    def test_indent_unit_and_reindent(self) -> None:
        assert indent_unit(["a", "  b", "    c"]) == "  "
        assert indent_unit(["a", "\tb"]) == "\t"
        text = 'x = """one\ntwo"""\nif x:\n    y = 1\n'
        assert reindent(text, "    ", resolve_language("python")) == ['    x = """one', 'two"""', "    if x:", "        y = 1"]


class TestInject:
    def setup_repo(self, tmp_path: Path, *replies: str):
        upstream = make_repo(tmp_path)
        llm = FakeLLM(list(replies))
        project = tmp_path / "project"
        project.mkdir()
        compiler = make_compiler(project, llm)
        imy_file = write(project / "sum.imy", IMY)
        return upstream, llm, compiler, imy_file

    def test_inject_after_anchor_keeps_the_rest_intact_and_runs(self, tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
        upstream, llm, compiler, imy_file = self.setup_repo(tmp_path, reply(SNIPPET))
        result = inject(
            compiler,
            repo_url=str(upstream),
            target="pkg/app.py",
            imy_file=imy_file,
            anchor="def add(a, b):",
            run_command="python pkg/app.py",
        )
        new_text = result.target.read_text(encoding="utf-8")
        original = APP.split("\n")
        updated = new_text.split("\n")
        assert updated[:4] == original[:4]
        assert updated[4:6] == ["    total = a + b", '    print("Sum: " + str(total))']
        assert updated[6:] == original[4:]
        ast.parse(new_text)
        assert result.repo_dir == (compiler.workspace.repos / "upstream").resolve()
        assert "+    total = a + b" in result.diff
        assert result.run_exit_code == 0
        assert capfd.readouterr().out == "start\nSum: 5\nend 5\n"
        prompt = llm.last_prompt()
        assert "REPOSITORY CONTEXT" in prompt and "pkg/app.py" in prompt and "add, main" in prompt
        assert (upstream / "pkg" / "app.py").read_text(encoding="utf-8") == APP

    def test_existing_clone_is_reused(self, tmp_path: Path) -> None:
        upstream, _, compiler, imy_file = self.setup_repo(tmp_path, reply(SNIPPET), reply(SNIPPET))
        first = inject(compiler, repo_url=str(upstream), target="pkg/app.py", imy_file=imy_file, line=4)
        second = inject(compiler, repo_url=str(upstream), target="README.md", imy_file=imy_file, to="python", line=2)
        assert first.repo_dir == second.repo_dir

    def test_fresh_replaces_an_earlier_clone_but_never_another_folder(self, tmp_path: Path) -> None:
        upstream, _, compiler, imy_file = self.setup_repo(tmp_path, reply(SNIPPET), reply(SNIPPET))
        first = inject(compiler, repo_url=str(upstream), target="pkg/app.py", imy_file=imy_file, anchor="def add(a, b):")
        assert "total = a + b" in first.target.read_text(encoding="utf-8")
        again = inject(compiler, repo_url=str(upstream), target="pkg/app.py", imy_file=imy_file, anchor="def add(a, b):", fresh=True)
        assert again.target.read_text(encoding="utf-8").count("total = a + b") == 1

        documents = tmp_path / "my-documents"
        documents.mkdir()
        (documents / "thesis.txt").write_text("three years of work", encoding="utf-8")
        with pytest.raises(InjectionError) as caught:
            inject(compiler, repo_url=str(upstream), target="pkg/app.py", imy_file=imy_file, destination=documents, fresh=True)
        assert "will not delete" in caught.value.message
        assert (documents / "thesis.txt").read_text(encoding="utf-8") == "three years of work"

        other = make_repo(tmp_path / "elsewhere")
        with pytest.raises(InjectionError):
            inject(compiler, repo_url=str(upstream), target="pkg/app.py", imy_file=imy_file, destination=other, fresh=True)
        assert (other / "pkg" / "app.py").exists()

    def test_snippet_that_breaks_the_file_is_not_written(self, tmp_path: Path) -> None:
        upstream, _, compiler, imy_file = self.setup_repo(tmp_path, reply("total = (a +\n"))
        with pytest.raises(InjectionError) as caught:
            inject(compiler, repo_url=str(upstream), target="pkg/app.py", imy_file=imy_file, anchor="def add(a, b):")
        assert "Nothing was written" in (caught.value.hint or "")
        assert (compiler.workspace.repos / "upstream" / "pkg" / "app.py").read_text(encoding="utf-8") == APP

    def test_docstring_in_snippet_is_rejected(self, tmp_path: Path) -> None:
        bad = '"""Adds the numbers."""\n' + SNIPPET
        upstream, _, compiler, imy_file = self.setup_repo(tmp_path, reply(bad), reply(bad))
        with pytest.raises(CompilationFailed) as caught:
            inject(compiler, repo_url=str(upstream), target="pkg/app.py", imy_file=imy_file, anchor="def add(a, b):")
        assert caught.value.codes == [ErrorCode.COMMENTS_IN_OUTPUT]
        assert (compiler.workspace.repos / "upstream" / "pkg" / "app.py").read_text(encoding="utf-8") == APP

    def test_target_must_exist_inside_the_repository(self, tmp_path: Path) -> None:
        upstream, _, compiler, imy_file = self.setup_repo(tmp_path)
        with pytest.raises(InjectionError):
            inject(compiler, repo_url=str(upstream), target="../outside.py", imy_file=imy_file)
        with pytest.raises(InjectionError):
            inject(compiler, repo_url=str(upstream), target="pkg/missing.py", imy_file=imy_file)

    def test_unreachable_repository_is_a_clean_error(self, tmp_path: Path) -> None:
        _, _, compiler, imy_file = self.setup_repo(tmp_path)
        with pytest.raises(InjectionError) as caught:
            inject(compiler, repo_url=(tmp_path / "nope").as_uri(), target="a.py", imy_file=imy_file)
        assert "not a git repository" in caught.value.message
