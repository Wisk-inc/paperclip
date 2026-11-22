from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path

import httpx2
import pytest

from conftest import FIXTURES, FakeLLM, make_compiler, reply, write
from imy.compiler import CompileOptions
from imy.errors import RunnerError
from imy.parser import parse_text
from imy.runner import build_artifact, run_artifact
from imy.workspace import Workspace, map_virtual_files, prepare_virtual_files, virtual_location, web_location

PROGRAM = '# ("prints a greeting with the user\'s name and how many letters the name has")\nname = "Ava"\nshow ("Hello, " + name + "!")\n'


def build(tmp: Path, code: str, *, target: str = "python", source: str = PROGRAM, name: str = "hello.imy"):
    llm = FakeLLM([reply(code, target=target)])
    compiler = make_compiler(tmp, llm)
    path = write(tmp / name, source)
    result = compiler.compile_file(path, CompileOptions(target=target))
    return path, result, build_artifact(result, compiler.workspace), compiler.workspace


class TestRun:
    def test_runs_the_compiled_program_and_never_touches_the_source(self, tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
        path = write(tmp_path / "hello.imy", PROGRAM)
        os.utime(path, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
        before_bytes = path.read_bytes()
        before_mtime = path.stat().st_mtime_ns
        compiler = make_compiler(tmp_path, FakeLLM([reply('name = "Ava"\nprint("Hello, " + name + "!")\n')]))
        result = compiler.compile_file(path, CompileOptions(target="python"))
        workspace = compiler.workspace
        artifact = build_artifact(result, workspace)
        assert artifact.path == tmp_path / ".imy" / "build" / "hello.py"
        outcome = run_artifact(artifact, workspace)
        assert outcome.exit_code == 0
        assert capfd.readouterr().out == "Hello, Ava!\n"
        assert path.read_bytes() == before_bytes
        assert path.stat().st_mtime_ns == before_mtime

    def test_exit_code_and_arguments_reach_the_program(self, tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
        _, _, artifact, workspace = build(tmp_path, 'import sys\nprint("args:", sys.argv[1:])\nsys.exit(3)\n')
        outcome = run_artifact(artifact, workspace, args=["--speed", "2"])
        assert outcome.exit_code == 3
        assert "args: ['--speed', '2']" in capfd.readouterr().out

    def test_program_runs_next_to_the_imy_file_without_the_imy_key(self, tmp_path: Path, capfd: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("IMY_API_KEY", "secret-value")
        code = 'import os\nprint(os.getcwd())\nprint(os.environ.get("IMY_API_KEY"))\nprint(os.environ["IMY_VFS_ROOT"])\n'
        _, _, artifact, workspace = build(tmp_path, code)
        run_artifact(artifact, workspace)
        lines = capfd.readouterr().out.splitlines()
        assert lines[0] == str(tmp_path)
        assert lines[1] == "None"
        assert lines[2] == str(tmp_path / ".imy" / "vfs")

    def test_timeout_stops_the_program(self, tmp_path: Path) -> None:
        _, _, artifact, workspace = build(tmp_path, "import time\ntime.sleep(30)\n")
        started = time.monotonic()
        outcome = run_artifact(artifact, workspace, timeout=1)
        assert outcome.timed_out and outcome.exit_code == 124
        assert time.monotonic() - started < 15

    def test_detached_run_writes_a_log(self, tmp_path: Path) -> None:
        _, _, artifact, workspace = build(tmp_path, 'print("from the background")\n')
        outcome = run_artifact(artifact, workspace, detach=True)
        assert outcome.pid and outcome.log_path is not None
        for _ in range(100):
            if outcome.log_path.exists() and "from the background" in outcome.log_path.read_text():
                break
            time.sleep(0.1)
        assert "from the background" in outcome.log_path.read_text()

    @pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
    def test_javascript_runs_with_node(self, tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
        _, _, artifact, workspace = build(tmp_path, 'const name = "Ava";\nconsole.log("Hello, " + name + "!");\n', target="javascript")
        assert artifact.path.suffix == ".js"
        assert run_artifact(artifact, workspace).exit_code == 0
        assert capfd.readouterr().out == "Hello, Ava!\n"

    @pytest.mark.skipif(shutil.which("java") is None, reason="needs java")
    def test_java_gets_a_file_named_after_its_class(self, tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
        code = 'public class Main {\n    public static void main(String[] args) {\n        String name = "Ava";\n        System.out.println("Hello, " + name + "!");\n    }\n}\n'
        _, _, artifact, workspace = build(tmp_path, code, target="java")
        assert artifact.path.name == "Main.java"
        assert run_artifact(artifact, workspace).exit_code == 0
        assert capfd.readouterr().out.strip() == "Hello, Ava!"

    def test_missing_toolchain_is_a_clean_error(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        _, _, artifact, workspace = build(tmp_path, 'local name = "Ava"\nprint("Hello, " .. name .. "!")\n', target="lua")
        empty = tmp_path / "empty-path"
        empty.mkdir()
        monkeypatch.setenv("PATH", str(empty))
        with pytest.raises(RunnerError) as caught:
            run_artifact(artifact, workspace)
        assert "needs `lua`" in caught.value.message
        assert "apt install lua5.4" in (caught.value.hint or "")

    def fake_tool(self, folder: Path, name: str, script: str) -> None:
        folder.mkdir(exist_ok=True)
        tool = folder / name
        tool.write_text("#!/bin/sh\n" + script + "\n", encoding="utf-8")
        tool.chmod(0o755)

    def test_sql_files_in_folders_with_spaces_are_read_whole(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capfd: pytest.CaptureFixture[str]) -> None:
        project = tmp_path / "my project"
        project.mkdir()
        _, _, artifact, workspace = build(project, "SELECT 'Hello, Ava!';\n", target="sql")
        tools = tmp_path / "tools"
        self.fake_tool(tools, "sqlite3", 'printf "%s\\n" "$@"')
        monkeypatch.setenv("PATH", f"{tools}{os.pathsep}{os.environ['PATH']}")
        assert run_artifact(artifact, workspace).exit_code == 0
        assert capfd.readouterr().out.splitlines() == [":memory:", f'.read "{artifact.path}"']

    def test_typescript_needs_a_node_that_can_run_it(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        _, _, artifact, workspace = build(tmp_path, 'const name: string = "Ava";\nconsole.log("Hello, " + name + "!");\n', target="typescript")
        tools = tmp_path / "tools"
        self.fake_tool(tools, "node", "echo v20.11.0")
        monkeypatch.setenv("PATH", str(tools))
        with pytest.raises(RunnerError) as caught:
            run_artifact(artifact, workspace)
        assert "22.6" in caught.value.message and "tsx" in (caught.value.hint or "")

    def test_language_without_a_runner_points_to_convert(self, tmp_path: Path) -> None:
        _, _, artifact, workspace = build(tmp_path, 'DISPLAY "Hello, Ava!".\n', target="cobol")
        with pytest.raises(RunnerError) as caught:
            run_artifact(artifact, workspace)
        assert "imy convert --to cobol" in (caught.value.hint or "")


class TestWebsiteBuild:
    def test_site_is_built_with_its_assets(self, tmp_path: Path) -> None:
        (tmp_path / "menu logo.png").write_bytes(b"\x89PNG fake")
        html = (
            '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n</head>\n<body>\n<nav>\n<a href="#home">home</a>\n'
            '<a href="#game">game</a>\n<a href="#play">play</a>\n</nav>\n<img src="menu logo.png" alt="menu logo">\n</body>\n</html>\n'
        )
        source = (FIXTURES / "website_right.imy").read_text(encoding="utf-8")
        _, _, artifact, workspace = build(tmp_path, html, target="html", source=source, name="site.imy")
        assert artifact.path == tmp_path / ".imy" / "build" / "site-site" / "index.html"
        assert (artifact.folder / "menu logo.png").read_bytes() == b"\x89PNG fake"
        with pytest.raises(RunnerError) as caught:
            run_artifact(artifact, workspace)
        assert "--serve" in (caught.value.hint or "")


class TestWorkspaceDiscovery:
    def test_the_nearest_workspace_is_the_project(self, tmp_path: Path) -> None:
        project = tmp_path / "project"
        (project / ".imy").mkdir(parents=True)
        nested = project / "levels" / "one"
        nested.mkdir(parents=True)
        assert Workspace.discover(nested / "jump.imy").root == project
        assert Workspace.discover(project / "hello.imy").root == project
        fresh = tmp_path / "fresh"
        fresh.mkdir()
        assert Workspace.discover(fresh / "hello.imy").root == fresh

    def test_imy_home_is_never_a_project_workspace(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        user = tmp_path / "user"
        default_home = user / ".imy"
        default_home.mkdir(parents=True)
        (default_home / "memory.json").write_text("{}", encoding="utf-8")
        monkeypatch.setenv("HOME", str(user))
        code = user / "code"
        code.mkdir()

        assert Workspace.discover(code / "hello.imy", home=default_home).root == code
        elsewhere = tmp_path / "imy-home-elsewhere"
        elsewhere.mkdir()
        assert Workspace.discover(code / "hello.imy", home=elsewhere).root == code
        assert Workspace.discover(code / "hello.imy").root == code

        (code / ".imy").mkdir()
        deeper = code / "game"
        deeper.mkdir()
        assert Workspace.discover(deeper / "jump.imy", home=elsewhere).root == code


class TestVirtualFiles:
    def test_virtual_locations_never_escape(self) -> None:
        assert virtual_location("/file:paths") == "file/paths"
        assert virtual_location("../../etc/passwd") == "etc/passwd"
        assert virtual_location("C:\\Users\\me") == "C/Users/me"
        assert virtual_location("///") == "root"
        assert web_location("https://example.com/data/list.json?x=1").startswith("web/")
        assert web_location("https://example.com/data/list.json?x=1").endswith("-list.json")

    def test_parent_folders_and_manifest(self, tmp_path: Path) -> None:
        source = (FIXTURES / "valid_platformer.imy").read_text(encoding="utf-8")
        parsed = parse_text(source, path=tmp_path / "platformer.imy")
        workspace = Workspace(tmp_path)
        workspace.ensure()
        vmap = map_virtual_files(parsed, workspace, tmp_path)
        assert vmap.virtual_paths == {"/save:slots": ".imy/vfs/save/slots"}
        prepare_virtual_files(vmap, workspace)
        assert (tmp_path / ".imy" / "vfs" / "save").is_dir()
        assert not (tmp_path / ".imy" / "vfs" / "save" / "slots").exists()
        manifest = json.loads(workspace.manifest.read_text())
        assert manifest["virtual_paths"]["/save:slots"].endswith("/.imy/vfs/save/slots")

    def test_shipped_web_resources_are_mirrored_once(self, tmp_path: Path) -> None:
        source = '# ("loads the word list from the web and prints how many words it has")\nwords = ship ("https://example.com/words.txt")\nshow (count(words))\n'
        parsed = parse_text(source, path=tmp_path / "words.imy")
        workspace = Workspace(tmp_path)
        workspace.ensure()
        vmap = map_virtual_files(parsed, workspace, tmp_path)
        assert [(n.url, n.local_path is not None) for n in vmap.web] == [("https://example.com/words.txt", True)]
        hits: list[str] = []

        def handler(request: httpx2.Request) -> httpx2.Response:
            hits.append(str(request.url))
            return httpx2.Response(200, content=b"alpha\nbeta\n")

        transport = httpx2.MockTransport(handler)
        with pytest.raises(RunnerError):
            prepare_virtual_files(vmap, workspace, offline=True, transport=transport)
        assert prepare_virtual_files(vmap, workspace, transport=transport) == ["https://example.com/words.txt"]
        local = vmap.web_files["https://example.com/words.txt"]
        assert local.read_bytes() == b"alpha\nbeta\n"
        assert prepare_virtual_files(vmap, workspace, transport=transport) == []
        assert len(hits) == 1

    def test_failed_download_is_a_clean_error(self, tmp_path: Path) -> None:
        source = '# ("loads the word list from the web and prints how many words it has")\nwords = ship ("https://example.com/missing.txt")\nshow (count(words))\n'
        parsed = parse_text(source, path=tmp_path / "words.imy")
        workspace = Workspace(tmp_path)
        vmap = map_virtual_files(parsed, workspace, tmp_path)
        transport = httpx2.MockTransport(lambda request: httpx2.Response(404))
        with pytest.raises(RunnerError) as caught:
            prepare_virtual_files(vmap, workspace, transport=transport)
        assert "HTTP 404" in caught.value.message
        assert not any(p.name.startswith(".download.") for p in (tmp_path / ".imy" / "vfs" / "web").iterdir())
