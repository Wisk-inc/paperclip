from __future__ import annotations

import os
from pathlib import Path

import pytest

from conftest import write
from imy.config import ImyConfig, environment, is_loopback_url, load_config, read_dotenv, save_config
from imy.errors import ConfigError


class TestProviderSwitch:
    def test_another_provider_for_one_run_gets_none_of_the_stored_providers_settings(self, isolated: Path) -> None:
        save_config(ImyConfig(provider="anthropic", model="claude-opus-5-5", api_key="sk-ant-stored", base_url="https://proxy.example/v1"))
        same = load_config(isolated)
        assert (same.provider, same.resolved_model(), same.base_url) == ("anthropic", "claude-opus-5-5", "https://proxy.example/v1")
        assert same.api_key is not None

        switched = load_config(isolated, overrides={"provider": "openai"})
        assert switched.provider == "openai"
        assert switched.resolved_model() == "gpt-6.1-sol"
        assert switched.api_key is None and switched.api_key_env is None
        assert switched.resolved_base_url() == "https://api.openai.com/v1"
        assert switched.resolve_api_key(environment(isolated))[0] is None

    def test_a_model_given_with_the_provider_is_kept(self, isolated: Path) -> None:
        save_config(ImyConfig(provider="anthropic", model="claude-opus-5-5"))
        config = load_config(isolated, overrides={"provider": "gemini", "model": "gemini-3.8-flash"})
        assert (config.provider, config.resolved_model()) == ("gemini", "gemini-3.8-flash")

    def test_provider_from_the_environment_also_drops_stored_settings(self, isolated: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        save_config(ImyConfig(provider="openai", model="gpt-6.1-sol", api_key="sk-stored"))
        monkeypatch.setenv("IMY_PROVIDER", "anthropic")
        config = load_config(isolated)
        assert (config.provider, config.resolved_model(), config.api_key) == ("anthropic", "claude-opus-5-5", None)

    def test_other_settings_survive_a_provider_switch(self, isolated: Path) -> None:
        save_config(ImyConfig(provider="anthropic", default_target="lua", timeout_seconds=42, repair_attempts=3))
        config = load_config(isolated, overrides={"provider": "openai"})
        assert (config.default_target, config.timeout_seconds, config.repair_attempts) == ("lua", 42, 3)


class TestDotenv:
    def test_keys_and_plain_settings_are_read(self, isolated: Path) -> None:
        write(isolated / ".env", 'OPENAI_API_KEY="sk-from-dotenv"\nIMY_PROVIDER=openai\nexport IMY_MODEL=gpt-6-luna # fast\nIMY_TARGET=lua\n')
        env = environment(isolated)
        config = load_config(isolated, env=env)
        assert (config.provider, config.resolved_model(), config.default_target) == ("openai", "gpt-6-luna", "lua")
        key, source = config.resolve_api_key(env)
        assert key == "sk-from-dotenv" and ".env" in source

    def test_the_shell_environment_wins_over_dotenv(self, isolated: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        write(isolated / ".env", "IMY_MODEL=from-dotenv\n")
        monkeypatch.setenv("IMY_MODEL", "from-shell")
        assert load_config(isolated).resolved_model() == "from-shell"

    @pytest.mark.parametrize(
        "line",
        ["IMY_AUTOMA_BRIDGE=sh -c 'touch /tmp/x'", "IMY_PYTHON=/tmp/evil-python", "IMY_HOME=/tmp/elsewhere", "IMY_API_KEY_ENV=AWS_SECRET_ACCESS_KEY"],
    )
    def test_a_dotenv_cannot_run_commands_or_move_the_key_lookup(self, isolated: Path, line: str) -> None:
        write(isolated / ".env", line + "\n")
        with pytest.raises(ConfigError) as caught:
            environment(isolated)
        name = line.split("=", 1)[0]
        assert name in caught.value.message and ".env" in caught.value.message
        assert "your own shell" in (caught.value.hint or "")

    def test_a_dotenv_cannot_point_imy_at_a_remote_server(self, isolated: Path) -> None:
        save_config(ImyConfig(provider="openai-compatible", api_key="sk-stored", base_url="http://localhost:11434/v1"))
        write(isolated / ".env", "IMY_BASE_URL=https://collector.example/v1\n")
        with pytest.raises(ConfigError) as caught:
            load_config(isolated)
        assert "collector.example" in caught.value.message
        assert "imy init" in (caught.value.hint or "")

    def test_a_dotenv_may_name_a_server_on_this_machine(self, isolated: Path) -> None:
        write(isolated / ".env", "IMY_PROVIDER=openai-compatible\nIMY_BASE_URL=http://127.0.0.1:8000/v1\n")
        config = load_config(isolated)
        assert config.resolved_base_url() == "http://127.0.0.1:8000/v1"

    def test_the_same_values_are_fine_from_the_shell(self, isolated: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("IMY_BASE_URL", "https://my-server.example/v1")
        monkeypatch.setenv("IMY_AUTOMA_BRIDGE", "node /opt/bridge.mjs")
        config = load_config(isolated, overrides={"provider": "openai-compatible"})
        assert config.resolved_base_url() == "https://my-server.example/v1"
        assert config.resolve_bridge(environment(isolated)) == "node /opt/bridge.mjs"

    @pytest.mark.parametrize(
        "url, expected",
        [("http://localhost:11434/v1", True), ("http://127.0.0.1:8000", True), ("http://[::1]:8000/v1", True),
         ("http://api.localhost/v1", True), ("https://example.com/v1", False), ("http://127.0.0.1.evil.example/v1", False),
         ("http://localhost.evil.example/v1", False), ("not a url", False)],
    )
    def test_loopback_detection(self, url: str, expected: bool) -> None:
        assert is_loopback_url(url) is expected

    def test_dotenv_parsing(self, isolated: Path) -> None:
        write(isolated / "x.env", "# note\nA=1\nexport B='two words'\nC=\"line\\nbreak\"\nD=value # trailing\nbad line\n1X=no\n")
        assert read_dotenv(isolated / "x.env") == {"A": "1", "B": "two words", "C": "line\nbreak", "D": "value"}
        assert read_dotenv(isolated / "missing.env") == {}


class TestStoredConfig:
    def test_broken_config_file_is_a_clean_error(self, isolated: Path) -> None:
        path = Path(os.environ["IMY_HOME"]) / "config.json"
        write(path, "{broken")
        with pytest.raises(ConfigError) as caught:
            load_config(isolated)
        assert "not valid JSON" in caught.value.message
        write(path, '{"provider": "nope"}')
        with pytest.raises(ConfigError):
            load_config(isolated)

    def test_invalid_values_are_reported_by_name(self, isolated: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("IMY_TIMEOUT", "-5")
        with pytest.raises(ConfigError) as caught:
            load_config(isolated)
        assert "timeout_seconds" in caught.value.message
