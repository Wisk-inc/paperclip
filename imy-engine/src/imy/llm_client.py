"""Provider-agnostic model client.

Providers: Anthropic (official SDK), OpenAI, Google Gemini, any OpenAI-compatible
server (Ollama, vLLM, LM Studio, OpenRouter, ...) and Automa's free models
(through the bridge command Automa's IMY terminal provides). Every provider
failure becomes one of the LLMError types with a plain-language message.
"""

from __future__ import annotations

import json
import re
import shlex
import subprocess
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol
from urllib.parse import quote

import httpx2

from . import __version__
from .config import EnvView, ImyConfig
from .errors import (
    ConfigError,
    LLMAuthError,
    LLMConnectionError,
    LLMProviderError,
    LLMRateLimitError,
    LLMRefusalError,
    LLMResponseError,
    LLMTimeoutError,
)

Role = Literal["user", "assistant"]
USER_AGENT = f"imagenery/{__version__}"
_RETRY_STATUSES = frozenset({408, 409, 429, 500, 502, 503, 504, 529})


@dataclass(frozen=True)
class ChatMessage:
    role: Role
    content: str


@dataclass(frozen=True)
class LLMRequest:
    system: str
    messages: tuple[ChatMessage, ...]
    max_output_tokens: int
    json_schema: dict[str, Any] | None = None


@dataclass(frozen=True)
class LLMReply:
    text: str
    provider: str
    model: str
    input_tokens: int | None = None
    output_tokens: int | None = None
    stop_reason: str | None = None


class LLMClient(Protocol):
    provider: str
    model: str

    def complete(self, request: LLMRequest) -> LLMReply: ...


def _short(text: str, limit: int = 300) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _error_message(response: httpx2.Response) -> str:
    try:
        data = response.json()
    except ValueError:
        return _short(response.text or response.reason_phrase or "no details")
    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict):
            return _short(str(error.get("message") or error.get("status") or error))
        if isinstance(error, str):
            return _short(error)
        if "message" in data:
            return _short(str(data["message"]))
    if isinstance(data, list) and data and isinstance(data[0], dict):
        inner = data[0].get("error")
        if isinstance(inner, dict):
            return _short(str(inner.get("message") or inner))
    return _short(json.dumps(data))


_ADAPTIVE = re.compile(r"^claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?")


def supports_adaptive_thinking(model: str) -> bool:
    match = _ADAPTIVE.match(model)
    if not match:
        return False
    major = int(match.group(1))
    minor = int(match.group(2)) if match.group(2) and len(match.group(2)) <= 2 else 0
    return major >= 5 or (major == 4 and minor >= 6)


class AnthropicClient:
    """Claude through the official Anthropic SDK, streamed, with structured JSON output."""

    provider = "anthropic"

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        timeout: float,
        effort: str | None = None,
        base_url: str | None = None,
        http_client: Any | None = None,
        max_retries: int = 2,
    ) -> None:
        import anthropic

        self._sdk = anthropic
        options: dict[str, Any] = {"api_key": api_key, "timeout": timeout, "max_retries": max_retries}
        if base_url:
            options["base_url"] = base_url
        if http_client is not None:
            options["http_client"] = http_client
        self._client = anthropic.Anthropic(**options)
        self.model = model
        self._timeout = timeout
        self._effort = effort
        self._structured = True

    def complete(self, request: LLMRequest) -> LLMReply:
        sdk = self._sdk
        output_config: dict[str, Any] = {}
        if self._effort:
            output_config["effort"] = self._effort
        if request.json_schema is not None and self._structured:
            output_config["format"] = {"type": "json_schema", "schema": request.json_schema}
        params: dict[str, Any] = {
            "model": self.model,
            "max_tokens": request.max_output_tokens,
            "system": request.system,
            "messages": [{"role": m.role, "content": m.content} for m in request.messages],
        }
        if output_config:
            params["output_config"] = output_config
        if supports_adaptive_thinking(self.model):
            params["thinking"] = {"type": "adaptive"}
        try:
            with self._client.messages.stream(**params) as stream:
                message = stream.get_final_message()
        except sdk.BadRequestError as exc:
            detail = _short(getattr(exc, "message", str(exc)))
            if "format" in output_config and re.search(r"output_config|format|json_schema|schema", detail, re.I):
                self._structured = False
                return self.complete(request)
            raise LLMProviderError(f"Anthropic rejected the request (400): {detail}") from exc
        except sdk.AuthenticationError as exc:
            raise LLMAuthError(
                "Anthropic rejected the API key (401).",
                hint="Check it with `imy doctor --ping`, or save a new key with `imy init`.",
            ) from exc
        except sdk.PermissionDeniedError as exc:
            raise LLMAuthError(
                f"This Anthropic key is not allowed to use {self.model} (403): {_short(getattr(exc, 'message', str(exc)))}"
            ) from exc
        except sdk.NotFoundError as exc:
            raise LLMProviderError(
                f"Anthropic has no model named {self.model!r} (404).", hint="Pick another model with `imy init` or --model."
            ) from exc
        except sdk.RateLimitError as exc:
            raise LLMRateLimitError("Anthropic's rate limit was reached (429); wait a moment and try again.") from exc
        except sdk.APITimeoutError as exc:
            raise LLMTimeoutError(f"Anthropic did not answer within {self._timeout:g} seconds.") from exc
        except sdk.APIConnectionError as exc:
            raise LLMConnectionError("Could not reach Anthropic. Check your internet connection.") from exc
        except sdk.APIStatusError as exc:
            raise LLMProviderError(
                f"Anthropic error {exc.status_code}: {_short(getattr(exc, 'message', str(exc)))}"
            ) from exc
        if message.stop_reason == "refusal":
            details = getattr(message, "stop_details", None)
            explanation = getattr(details, "explanation", None) or "no reason given"
            raise LLMRefusalError(f"The model declined to compile this program ({_short(explanation)}).")
        text = "".join(getattr(block, "text", "") for block in message.content if block.type == "text")
        if message.stop_reason == "max_tokens":
            raise LLMResponseError(
                f"The answer was cut off at {request.max_output_tokens} tokens.",
                hint="Raise the limit (IMY_MAX_TOKENS or `imy init`) or split the program into smaller files.",
            )
        usage = getattr(message, "usage", None)
        return LLMReply(
            text=text,
            provider=self.provider,
            model=getattr(message, "model", None) or self.model,
            input_tokens=getattr(usage, "input_tokens", None),
            output_tokens=getattr(usage, "output_tokens", None),
            stop_reason=message.stop_reason,
        )


class _HttpProvider:
    """Shared HTTP plumbing: retries for transient failures and plain-language errors."""

    label = "The provider"
    provider = "http"

    def __init__(self, *, base_url: str, headers: dict[str, str], timeout: float, transport: Any | None) -> None:
        self._timeout = timeout
        self._base_url = base_url
        options: dict[str, Any] = {
            "base_url": base_url,
            "headers": {"User-Agent": USER_AGENT, "Content-Type": "application/json", **headers},
            "timeout": httpx2.Timeout(timeout, connect=min(30.0, timeout)),
        }
        if transport is not None:
            options["transport"] = transport
        self._http = httpx2.Client(**options)

    def _post(self, path: str, body: dict[str, Any], retries: int = 2) -> httpx2.Response:
        attempt = 0
        while True:
            try:
                response = self._http.post(path, json=body)
            except httpx2.TimeoutException as exc:
                if attempt < retries:
                    attempt += 1
                    time.sleep(min(2.0 * attempt, 6.0))
                    continue
                raise LLMTimeoutError(f"{self.label} did not answer within {self._timeout:g} seconds.") from exc
            except httpx2.TransportError as exc:
                if attempt < retries:
                    attempt += 1
                    time.sleep(min(2.0 * attempt, 6.0))
                    continue
                raise LLMConnectionError(
                    f"Could not reach {self._base_url}: {_short(str(exc)) or type(exc).__name__}.",
                    hint="Check your internet connection, or the server address (base_url).",
                ) from exc
            if response.status_code in _RETRY_STATUSES and attempt < retries:
                attempt += 1
                wait = min(2.0 * attempt, 6.0)
                retry_after = response.headers.get("retry-after")
                if retry_after and retry_after.isdigit():
                    wait = min(float(retry_after), 20.0)
                time.sleep(wait)
                continue
            return response

    def _raise_for_status(self, response: httpx2.Response, model: str) -> None:
        status = response.status_code
        if status < 400:
            return
        message = _error_message(response)
        if status == 401:
            raise LLMAuthError(
                f"{self.label} rejected the API key (401): {message}",
                hint="Save a new key with `imy init`, then test it with `imy doctor --ping`.",
            )
        if status == 403:
            raise LLMAuthError(f"{self.label} refused access (403): {message}")
        if status == 404:
            raise LLMProviderError(
                f"{self.label} has no model {model!r} at {self._base_url} (404): {message}",
                hint="Check the model name and base_url with `imy doctor`.",
            )
        if status == 429:
            raise LLMRateLimitError(f"{self.label} is rate-limiting requests (429): {message}")
        if status >= 500:
            raise LLMProviderError(f"{self.label} had a server error ({status}): {message}")
        raise LLMProviderError(f"{self.label} rejected the request ({status}): {message}")

    @staticmethod
    def _json(response: httpx2.Response, label: str) -> dict[str, Any]:
        try:
            data = response.json()
        except ValueError as exc:
            raise LLMProviderError(f"{label} answered with something that isn't JSON: {_short(response.text)}") from exc
        if not isinstance(data, dict):
            raise LLMProviderError(f"{label} answered with unexpected JSON: {_short(json.dumps(data))}")
        return data


class OpenAICompatibleClient(_HttpProvider):
    """OpenAI's Chat Completions API, which OpenAI-compatible servers also speak."""

    def __init__(
        self,
        *,
        provider: str,
        base_url: str,
        api_key: str | None,
        model: str,
        timeout: float,
        response_format: Literal["json_schema", "json_object"] | None,
        transport: Any | None = None,
    ) -> None:
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        super().__init__(base_url=base_url, headers=headers, timeout=timeout, transport=transport)
        self.provider = provider
        self.label = "OpenAI" if provider == "openai" else f"The server at {base_url}"
        self.model = model
        self._format = response_format

    def _body(self, request: LLMRequest, response_format: str | None) -> dict[str, Any]:
        messages = [{"role": "system", "content": request.system}]
        messages.extend({"role": m.role, "content": m.content} for m in request.messages)
        body: dict[str, Any] = {"model": self.model, "messages": messages}
        if self.provider == "openai":
            body["max_completion_tokens"] = request.max_output_tokens
        else:
            body["max_tokens"] = request.max_output_tokens
            body["temperature"] = 0
        if request.json_schema is not None and response_format == "json_schema":
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "imy_compiler_response", "strict": True, "schema": request.json_schema},
            }
        elif request.json_schema is not None and response_format == "json_object":
            body["response_format"] = {"type": "json_object"}
        return body

    def complete(self, request: LLMRequest) -> LLMReply:
        fmt = self._format
        while True:
            response = self._post("/chat/completions", self._body(request, fmt))
            if response.status_code in (400, 422) and fmt is not None and re.search(
                r"response_format|json_schema|json_object|structured", _error_message(response), re.I
            ):
                fmt = "json_object" if fmt == "json_schema" else None
                self._format = fmt
                continue
            break
        self._raise_for_status(response, self.model)
        data = self._json(response, self.label)
        choices = data.get("choices")
        if not isinstance(choices, list) or not choices:
            raise LLMProviderError(f"{self.label} returned no choices: {_short(json.dumps(data))}")
        choice = choices[0] if isinstance(choices[0], dict) else {}
        message = choice.get("message") or {}
        refusal = message.get("refusal")
        if refusal:
            raise LLMRefusalError(f"The model declined to compile this program ({_short(str(refusal))}).")
        content = message.get("content")
        if isinstance(content, list):
            content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
        if not isinstance(content, str):
            content = ""
        finish = choice.get("finish_reason")
        if finish == "length":
            raise LLMResponseError(
                f"The answer was cut off at {request.max_output_tokens} tokens.",
                hint="Raise the limit (IMY_MAX_TOKENS or `imy init`) or split the program.",
            )
        if finish == "content_filter":
            raise LLMRefusalError("The provider's content filter stopped the answer.")
        usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        return LLMReply(
            text=content,
            provider=self.provider,
            model=str(data.get("model") or self.model),
            input_tokens=usage.get("prompt_tokens"),
            output_tokens=usage.get("completion_tokens"),
            stop_reason=finish,
        )


class GeminiClient(_HttpProvider):
    """Google's Gemini generateContent API with JSON output."""

    provider = "gemini"
    label = "Gemini"

    def __init__(self, *, api_key: str, model: str, timeout: float, base_url: str, transport: Any | None = None) -> None:
        super().__init__(base_url=base_url, headers={"x-goog-api-key": api_key}, timeout=timeout, transport=transport)
        self.model = model

    def _raise_for_status(self, response: httpx2.Response, model: str) -> None:
        if response.status_code == 400 and re.search(r"API key not valid|API_KEY_INVALID", response.text):
            raise LLMAuthError(
                "Gemini rejected the API key.", hint="Save a new key with `imy init` (get one at aistudio.google.com/apikey)."
            )
        super()._raise_for_status(response, model)

    def complete(self, request: LLMRequest) -> LLMReply:
        contents = [
            {"role": "model" if m.role == "assistant" else "user", "parts": [{"text": m.content}]}
            for m in request.messages
        ]
        generation: dict[str, Any] = {"maxOutputTokens": request.max_output_tokens, "temperature": 0}
        if request.json_schema is not None:
            generation["responseMimeType"] = "application/json"
        body = {
            "systemInstruction": {"parts": [{"text": request.system}]},
            "contents": contents,
            "generationConfig": generation,
        }
        response = self._post(f"/models/{quote(self.model, safe='')}:generateContent", body)
        self._raise_for_status(response, self.model)
        data = self._json(response, self.label)
        feedback = data.get("promptFeedback") or {}
        if isinstance(feedback, dict) and feedback.get("blockReason"):
            raise LLMRefusalError(f"Gemini blocked the request ({feedback['blockReason']}).")
        candidates = data.get("candidates") or []
        if not candidates or not isinstance(candidates[0], dict):
            raise LLMResponseError("Gemini returned no answer.")
        candidate = candidates[0]
        finish = candidate.get("finishReason")
        parts = (candidate.get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts if isinstance(p, dict) and not p.get("thought"))
        if finish in ("SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"):
            raise LLMRefusalError(f"Gemini stopped the answer ({finish}).")
        if finish == "MAX_TOKENS":
            raise LLMResponseError(
                f"The answer was cut off at {request.max_output_tokens} tokens.",
                hint="Raise the limit (IMY_MAX_TOKENS or `imy init`) or split the program.",
            )
        usage = data.get("usageMetadata") or {}
        return LLMReply(
            text=text,
            provider=self.provider,
            model=str(data.get("modelVersion") or self.model),
            input_tokens=usage.get("promptTokenCount"),
            output_tokens=usage.get("candidatesTokenCount"),
            stop_reason=finish,
        )


class AutomaBridgeClient:
    """Automa's free models, reached through the bridge command Automa's IMY terminal sets.

    The bridge reads one JSON request on stdin and prints one JSON reply on
    stdout. It runs inside Automa's own code, so no key ever reaches IMY.
    """

    provider = "automa"

    def __init__(self, *, command: Sequence[str], model: str, timeout: float) -> None:
        if not command:
            raise ConfigError("The free-models bridge command is empty.")
        self._command = list(command)
        self.model = model
        self._timeout = timeout

    def _run(self, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            proc = subprocess.run(
                self._command,
                input=json.dumps(payload),
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=self._timeout,
            )
        except FileNotFoundError as exc:
            raise ConfigError(
                f"The free-models bridge was not found ({self._command[0]}).",
                hint="Open IMY from Automa (Terminals, then IMY), or set IMY_AUTOMA_BRIDGE.",
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise LLMTimeoutError(f"The free model did not answer within {self._timeout:g} seconds.") from exc
        except OSError as exc:
            raise LLMConnectionError(f"Could not start the free-models bridge: {exc.strerror or exc}") from exc
        lines = [line for line in proc.stdout.splitlines() if line.strip().startswith("{")]
        if not lines:
            detail = _short(proc.stderr) or f"exit code {proc.returncode}"
            raise LLMProviderError(f"The free-models bridge gave no answer ({detail}).")
        try:
            data = json.loads(lines[-1])
        except json.JSONDecodeError as exc:
            raise LLMProviderError(f"The free-models bridge answered with broken JSON: {_short(lines[-1])}") from exc
        if not isinstance(data, dict):
            raise LLMProviderError("The free-models bridge answered with unexpected JSON.")
        if data.get("ok") is False:
            error = data.get("error") if isinstance(data.get("error"), dict) else {}
            kind = str(error.get("kind") or "")
            message = _short(str(error.get("message") or "the free model failed"))
            switch_hint = "Pick another free model with `imy models` and --model (or :model in the console)."
            if kind in ("busy", "rate_limit"):
                raise LLMRateLimitError(message, hint="Wait a moment and try again, or pick another free model.")
            if kind == "daily_limit":
                raise LLMRateLimitError(message, hint="This free model's daily limit is used up. " + switch_hint)
            if kind == "refused":
                raise LLMRefusalError(message)
            if kind == "timeout":
                raise LLMTimeoutError(message)
            if kind == "network":
                raise LLMConnectionError(message, hint="Check the phone's or computer's internet connection.")
            if kind in ("restricted", "withdrawn", "no_tools", "charged"):
                raise LLMProviderError(message, hint=switch_hint)
            raise LLMProviderError(message)
        if proc.returncode != 0:
            raise LLMProviderError(f"The free-models bridge exited with code {proc.returncode}: {_short(proc.stderr)}")
        return data

    def complete(self, request: LLMRequest) -> LLMReply:
        payload = {
            "op": "complete",
            "model": self.model,
            "system": request.system,
            "messages": [{"role": m.role, "content": m.content} for m in request.messages],
            "maxTokens": request.max_output_tokens,
            "json": request.json_schema is not None,
        }
        data = self._run(payload)
        text = data.get("text")
        if not isinstance(text, str):
            raise LLMProviderError("The free-models bridge answered without text.")
        usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        return LLMReply(
            text=text,
            provider=self.provider,
            model=str(data.get("model") or self.model),
            input_tokens=usage.get("inputTokens"),
            output_tokens=usage.get("outputTokens"),
            stop_reason=data.get("stopReason"),
        )

    def list_models(self) -> list[tuple[str, str]]:
        data = self._run({"op": "models"})
        models = data.get("models")
        result: list[tuple[str, str]] = []
        if isinstance(models, list):
            for item in models:
                if isinstance(item, dict) and isinstance(item.get("id"), str):
                    result.append((item["id"], str(item.get("label") or item["id"])))
        return result


def build_client(config: ImyConfig, env: EnvView, *, transport: Any | None = None) -> LLMClient:
    """The client for the configured provider. Raises ConfigError when a key or bridge is missing."""
    provider = config.provider
    model = config.resolved_model()
    timeout = config.timeout_seconds
    if provider == "automa":
        bridge = config.resolve_bridge(env)
        if not bridge:
            raise ConfigError(
                "Automa's free models need the bridge that Automa's IMY terminal provides.",
                hint="Open IMY from Automa (Terminals, then IMY), set IMY_AUTOMA_BRIDGE, or pick another provider with `imy init`.",
            )
        try:
            command = shlex.split(bridge)
        except ValueError as exc:
            raise ConfigError(f"IMY_AUTOMA_BRIDGE is not a valid command: {exc}") from exc
        return AutomaBridgeClient(command=command, model=model, timeout=timeout)

    key, _source = config.resolve_api_key(env)
    if key is not None and any(ch.isspace() for ch in key):
        raise ConfigError("The API key contains spaces or line breaks.", hint="Paste the key exactly as issued with `imy init`.")
    info = config.info
    if provider == "openai-compatible":
        base_url = config.resolved_base_url()
        if not base_url:
            raise ConfigError("Set base_url for the OpenAI-compatible server.", hint="Run `imy init`.")
        return OpenAICompatibleClient(
            provider="openai-compatible",
            base_url=base_url,
            api_key=key,
            model=model,
            timeout=timeout,
            response_format="json_object" if config.json_mode else None,
            transport=transport,
        )
    if not key:
        names = " or ".join(info.key_env) if info.key_env else "IMY_API_KEY"
        where = f" Get one at {info.key_url}." if info.key_url else ""
        raise ConfigError(
            f"No {info.label} API key is set.",
            hint=f"Run `imy init` and enter your key, or set {names}.{where}",
        )
    if provider == "anthropic":
        return AnthropicClient(api_key=key, model=model, timeout=timeout, effort=config.effort, base_url=config.base_url)
    if provider == "openai":
        return OpenAICompatibleClient(
            provider="openai",
            base_url=config.resolved_base_url() or "https://api.openai.com/v1",
            api_key=key,
            model=model,
            timeout=timeout,
            response_format="json_schema" if config.json_mode else None,
            transport=transport,
        )
    if provider == "gemini":
        return GeminiClient(
            api_key=key,
            model=model,
            timeout=timeout,
            base_url=config.resolved_base_url() or "https://generativelanguage.googleapis.com/v1beta",
            transport=transport,
        )
    raise ConfigError(f"Unknown provider {provider!r}.", hint="Run `imy init` to pick one.")
