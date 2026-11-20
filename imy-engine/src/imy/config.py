"""Provider, model and API key settings.

Settings come from (lowest to highest priority): built-in defaults,
``~/.imy/config.json``, a project ``.env`` file, ``IMY_*`` environment
variables, then command-line flags. ``IMY_HOME`` moves ``~/.imy``.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError, field_validator

from .errors import ConfigError

ProviderName = Literal["anthropic", "openai", "gemini", "openai-compatible", "automa"]
Effort = Literal["low", "medium", "high", "xhigh", "max"]
PROVIDERS: tuple[ProviderName, ...] = get_args(ProviderName)

_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


@dataclass(frozen=True)
class ProviderInfo:
    """What IMY knows about one provider before any network call."""

    name: ProviderName
    label: str
    default_model: str
    models: tuple[str, ...]
    key_env: tuple[str, ...]
    needs_key: bool
    default_base_url: str | None
    key_url: str | None
    notes: str = ""


AUTOMA_FREE_MODELS: tuple[str, ...] = (
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "deepseek/deepseek-v4.1-flash:free",
    "cohere/north-mini-code:free",
    "nvidia/nemotron-3.5-lightning:free",
    "recursive/flint-v1.0:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "qwen/qwen3.8-27b:free",
    "google/gemma-4-31b-it:free",
    "thinkingmachines/inkling:free",
    "openrouter/free",
)

PROVIDER_INFO: dict[str, ProviderInfo] = {
    "anthropic": ProviderInfo(
        name="anthropic",
        label="Anthropic (Claude)",
        default_model="claude-opus-5-5",
        models=(
            "claude-opus-5-5",
            "claude-fable-5-2",
            "claude-sonnet-5-5",
            "claude-haiku-5-5",
            "claude-opus-5",
            "claude-sonnet-5",
            "claude-opus-4-8",
        ),
        key_env=("ANTHROPIC_API_KEY",),
        needs_key=True,
        default_base_url=None,
        key_url="https://console.anthropic.com/settings/keys",
    ),
    "openai": ProviderInfo(
        name="openai",
        label="OpenAI (GPT)",
        default_model="gpt-6.1-sol",
        models=(
            "gpt-6.1-sol",
            "gpt-6.1-terra",
            "gpt-6.1-sol-pro",
            "gpt-6.1-terra-pro",
            "gpt-6-astra",
            "gpt-6-sol",
            "gpt-6-luna",
            "gpt-5.6-sol",
            "gpt-5.5",
        ),
        key_env=("OPENAI_API_KEY",),
        needs_key=True,
        default_base_url="https://api.openai.com/v1",
        key_url="https://platform.openai.com/api-keys",
    ),
    "gemini": ProviderInfo(
        name="gemini",
        label="Google (Gemini)",
        default_model="gemini-4-argon",
        models=("gemini-4-argon", "gemini-4-carbon", "gemini-4-hydrogen", "gemini-3.8-flash"),
        key_env=("GEMINI_API_KEY", "GOOGLE_API_KEY"),
        needs_key=True,
        default_base_url="https://generativelanguage.googleapis.com/v1beta",
        key_url="https://aistudio.google.com/apikey",
    ),
    "openai-compatible": ProviderInfo(
        name="openai-compatible",
        label="OpenAI-compatible server (Ollama, vLLM, LM Studio, OpenRouter, ...)",
        default_model="llama3.1",
        models=(),
        key_env=("IMY_COMPATIBLE_API_KEY",),
        needs_key=False,
        default_base_url="http://localhost:11434/v1",
        key_url=None,
        notes="Point base_url at the server's /v1 endpoint. A key is optional for local servers.",
    ),
    "automa": ProviderInfo(
        name="automa",
        label="Automa free models (no key)",
        default_model="nvidia/nemotron-3-ultra-550b-a55b:free",
        models=AUTOMA_FREE_MODELS,
        key_env=(),
        needs_key=False,
        default_base_url=None,
        key_url=None,
        notes="Works inside Automa's terminals, which provide the free-models bridge (IMY_AUTOMA_BRIDGE).",
    ),
}


def imy_home(env: Mapping[str, str] | None = None) -> Path:
    """The folder that holds config.json and the global memory store."""
    source = os.environ if env is None else env
    custom = source.get("IMY_HOME")
    return Path(custom).expanduser() if custom else Path.home() / ".imy"


def config_file(env: Mapping[str, str] | None = None) -> Path:
    return imy_home(env) / "config.json"


class ImyConfig(BaseModel):
    """Every setting IMY reads. Stored as JSON in ~/.imy/config.json."""

    model_config = ConfigDict(extra="ignore", validate_assignment=True)

    provider: ProviderName = "anthropic"
    model: str | None = None
    api_key: SecretStr | None = None
    api_key_env: str | None = None
    base_url: str | None = None
    timeout_seconds: float = Field(default=300.0, gt=0, le=3600)
    max_output_tokens: int = Field(default=32000, ge=256, le=200000)
    effort: Effort | None = None
    default_target: str = Field(default="python", min_length=1, max_length=40)
    repair_attempts: int = Field(default=1, ge=0, le=5)
    automa_bridge: str | None = None
    json_mode: bool = True

    @field_validator("model", "base_url", "automa_bridge", "api_key_env", mode="before")
    @classmethod
    def _blank_is_none(cls, value: Any) -> Any:
        if isinstance(value, str) and not value.strip():
            return None
        return value.strip() if isinstance(value, str) else value

    @field_validator("api_key", mode="before")
    @classmethod
    def _clean_key(cls, value: Any) -> Any:
        if isinstance(value, SecretStr):
            value = value.get_secret_value()
        if value is None:
            return None
        if not isinstance(value, str):
            raise ValueError("api_key must be text")
        cleaned = value.strip()
        if not cleaned:
            return None
        if any(ch.isspace() for ch in cleaned):
            raise ValueError("api_key contains spaces or line breaks; paste the key exactly as issued")
        return cleaned

    @field_validator("api_key_env")
    @classmethod
    def _env_name(cls, value: str | None) -> str | None:
        if value is not None and not _ENV_NAME.match(value):
            raise ValueError(f"{value!r} is not a valid environment variable name")
        return value

    @field_validator("base_url")
    @classmethod
    def _url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not re.match(r"^https?://[^\s/]+", value):
            raise ValueError(f"base_url must start with http:// or https:// (got {value!r})")
        return value.rstrip("/")

    @field_validator("default_target")
    @classmethod
    def _target(cls, value: str) -> str:
        return value.strip().lower()

    @property
    def info(self) -> ProviderInfo:
        return PROVIDER_INFO[self.provider]

    def resolved_model(self) -> str:
        return self.model or self.info.default_model

    def resolved_base_url(self) -> str | None:
        return self.base_url or self.info.default_base_url

    def resolve_api_key(self, env: EnvView) -> tuple[str | None, str]:
        """Return the key to use and a description of where it came from."""
        explicit = env.get("IMY_API_KEY")
        if explicit:
            return explicit.strip(), env.describe("IMY_API_KEY")
        if self.api_key_env:
            named = env.get(self.api_key_env)
            if named:
                return named.strip(), env.describe(self.api_key_env)
            return None, f"environment variable {self.api_key_env} (not set)"
        if self.api_key is not None:
            return self.api_key.get_secret_value(), f"stored in {config_file(env.values)}"
        for name in self.info.key_env:
            value = env.get(name)
            if value:
                return value.strip(), env.describe(name)
        return None, "not set"

    def resolve_bridge(self, env: EnvView) -> str | None:
        return self.automa_bridge or env.get("IMY_AUTOMA_BRIDGE") or None

    def stored_json(self) -> dict[str, Any]:
        data = self.model_dump(mode="json", exclude_none=True)
        if self.api_key is not None:
            data["api_key"] = self.api_key.get_secret_value()
        return data


@dataclass
class EnvView:
    """Environment variables merged with .env files, remembering where each came from."""

    values: dict[str, str]
    origins: dict[str, str] = field(default_factory=dict)

    def get(self, name: str) -> str | None:
        value = self.values.get(name)
        return value if value else None

    def describe(self, name: str) -> str:
        origin = self.origins.get(name)
        return f"environment variable {name}" if origin is None else f"{name} in {origin}"


def read_dotenv(path: Path) -> dict[str, str]:
    """Parse a .env file: KEY=VALUE lines, optional ``export``, quotes, # comments."""
    result: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return result
    except (OSError, UnicodeDecodeError) as exc:
        raise ConfigError(f"Can't read {path}: {exc}") from exc
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not _ENV_NAME.match(key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            quote = value[0]
            value = value[1:-1]
            if quote == '"':
                value = value.replace("\\n", "\n").replace('\\"', '"').replace("\\\\", "\\")
        else:
            hash_at = value.find(" #")
            if hash_at != -1:
                value = value[:hash_at].rstrip()
        result[key] = value
    return result


def environment(project_root: Path | None = None, base: Mapping[str, str] | None = None) -> EnvView:
    """The process environment, with .env files (project root, then cwd) filling gaps."""
    process = dict(os.environ if base is None else base)
    values: dict[str, str] = {}
    origins: dict[str, str] = {}
    candidates: list[Path] = []
    if project_root is not None:
        candidates.append(project_root / ".env")
    try:
        cwd_env = Path.cwd() / ".env"
    except OSError:
        cwd_env = None
    if cwd_env is not None and cwd_env not in candidates:
        candidates.append(cwd_env)
    for candidate in candidates:
        for key, value in read_dotenv(candidate).items():
            if key not in values:
                values[key] = value
                origins[key] = str(candidate)
    for key, value in process.items():
        values[key] = value
        origins.pop(key, None)
    return EnvView(values=values, origins=origins)


_ENV_FIELDS: dict[str, str] = {
    "IMY_PROVIDER": "provider",
    "IMY_MODEL": "model",
    "IMY_BASE_URL": "base_url",
    "IMY_TIMEOUT": "timeout_seconds",
    "IMY_MAX_TOKENS": "max_output_tokens",
    "IMY_EFFORT": "effort",
    "IMY_TARGET": "default_target",
    "IMY_API_KEY_ENV": "api_key_env",
    "IMY_REPAIR_ATTEMPTS": "repair_attempts",
}


def _validation_message(exc: ValidationError) -> str:
    parts = []
    for error in exc.errors():
        where = ".".join(str(p) for p in error.get("loc", ())) or "config"
        parts.append(f"{where}: {error.get('msg', 'invalid value')}")
    return "; ".join(parts)


def load_stored(env: Mapping[str, str] | None = None) -> ImyConfig:
    """Read ~/.imy/config.json (or defaults when it doesn't exist)."""
    path = config_file(env)
    if not path.exists():
        return ImyConfig()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ConfigError(
            f"{path} is not valid JSON (line {exc.lineno}, column {exc.colno}).",
            hint="Fix the file or run `imy init` to write a new one.",
        ) from exc
    except OSError as exc:
        raise ConfigError(f"Can't read {path}: {exc}") from exc
    if not isinstance(raw, dict):
        raise ConfigError(f"{path} must hold a JSON object.", hint="Run `imy init` to write a new one.")
    try:
        return ImyConfig.model_validate(raw)
    except ValidationError as exc:
        raise ConfigError(f"{path} has invalid settings: {_validation_message(exc)}", hint="Run `imy init` to fix them.") from exc


def load_config(
    project_root: Path | None = None,
    *,
    env: EnvView | None = None,
    overrides: Mapping[str, Any] | None = None,
) -> ImyConfig:
    """Stored config, then IMY_* variables (process or .env), then explicit overrides.

    Inside Automa's IMY terminal (IMY_AUTOMA_BRIDGE is set) and before anyone ran
    `imy init`, the default provider is Automa's free models, so IMY works with no key.
    """
    view = env if env is not None else environment(project_root)
    data = load_stored(view.values).stored_json()
    if not config_file(view.values).exists() and view.get("IMY_AUTOMA_BRIDGE"):
        data["provider"] = "automa"
    for env_name, field_name in _ENV_FIELDS.items():
        value = view.get(env_name)
        if value is not None:
            data[field_name] = value
    for key, value in (overrides or {}).items():
        if value is not None:
            data[key] = value
    try:
        return ImyConfig.model_validate(data)
    except ValidationError as exc:
        raise ConfigError(f"Invalid settings: {_validation_message(exc)}") from exc


def save_config(config: ImyConfig, env: Mapping[str, str] | None = None) -> Path:
    """Write config.json atomically, readable only by the current user."""
    path = config_file(env)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(path.parent, 0o700)
        except OSError:
            pass
        payload = json.dumps(config.stored_json(), indent=2, sort_keys=True) + "\n"
        fd, tmp = tempfile.mkstemp(prefix=".config.", suffix=".json", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except OSError as exc:
        raise ConfigError(f"Can't write {path}: {exc}") from exc
    return path
