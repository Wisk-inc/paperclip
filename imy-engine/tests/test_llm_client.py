from __future__ import annotations

import json
import shlex
import sys
from pathlib import Path
from typing import Any

import httpx2
import pytest

from conftest import reply
from imy.config import EnvView, ImyConfig
from imy.errors import (
    ConfigError,
    LLMAuthError,
    LLMConnectionError,
    LLMProviderError,
    LLMRateLimitError,
    LLMRefusalError,
    LLMResponseError,
    LLMTimeoutError,
)
from imy.llm_client import (
    AnthropicClient,
    AutomaBridgeClient,
    ChatMessage,
    GeminiClient,
    LLMRequest,
    OpenAICompatibleClient,
    build_client,
    supports_adaptive_thinking,
)
from imy.prompts import RESPONSE_SCHEMA

REQUEST = LLMRequest(
    system="You are the IMY compiler.",
    messages=(ChatMessage("user", "compile this"),),
    max_output_tokens=2048,
    json_schema=RESPONSE_SCHEMA,
)


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("imy.llm_client.time.sleep", lambda seconds: None)


class Recorder:
    def __init__(self, *responses: httpx2.Response | Exception) -> None:
        self.responses = list(responses)
        self.requests: list[httpx2.Request] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        item = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        if isinstance(item, Exception):
            raise item
        return item

    def body(self, index: int = -1) -> dict[str, Any]:
        return json.loads(self.requests[index].content)


def openai_ok(text: str, finish: str = "stop") -> httpx2.Response:
    return httpx2.Response(200, json={
        "model": "gpt-test", "choices": [{"message": {"role": "assistant", "content": text}, "finish_reason": finish}],
        "usage": {"prompt_tokens": 11, "completion_tokens": 22},
    })


def openai_client(recorder: Recorder, provider: str = "openai", fmt: str | None = "json_schema", key: str | None = "sk-test") -> OpenAICompatibleClient:
    return OpenAICompatibleClient(
        provider=provider, base_url="https://api.example.test/v1", api_key=key, model="gpt-test", timeout=30,
        response_format=fmt, transport=httpx2.MockTransport(recorder),  # type: ignore[arg-type]
    )


class TestOpenAI:
    def test_request_shape_and_reply(self) -> None:
        recorder = Recorder(openai_ok(reply("x = 1\n")))
        result = openai_client(recorder).complete(REQUEST)
        body = recorder.body()
        assert recorder.requests[0].url.path == "/v1/chat/completions"
        assert recorder.requests[0].headers["authorization"] == "Bearer sk-test"
        assert body["messages"][0] == {"role": "system", "content": "You are the IMY compiler."}
        assert body["max_completion_tokens"] == 2048 and "temperature" not in body
        assert body["response_format"]["type"] == "json_schema"
        assert body["response_format"]["json_schema"]["strict"] is True
        assert json.loads(result.text)["compiled_code"] == "x = 1\n"
        assert (result.input_tokens, result.output_tokens) == (11, 22)

    def test_compatible_servers_get_max_tokens_temperature_and_no_key(self) -> None:
        recorder = Recorder(openai_ok("{}"))
        openai_client(recorder, provider="openai-compatible", fmt="json_object", key=None).complete(REQUEST)
        body = recorder.body()
        assert body["max_tokens"] == 2048 and body["temperature"] == 0
        assert body["response_format"] == {"type": "json_object"}
        assert "authorization" not in recorder.requests[0].headers

    def test_unsupported_response_format_is_downgraded(self) -> None:
        rejection = httpx2.Response(400, json={"error": {"message": "response_format json_schema is not supported"}})
        recorder = Recorder(rejection, rejection, openai_ok("{}"))
        openai_client(recorder).complete(REQUEST)
        assert [r.get("response_format", {}).get("type") for r in map(json.loads, (q.content for q in recorder.requests))] == ["json_schema", "json_object", None]

    @pytest.mark.parametrize(
        "status, error",
        [(401, LLMAuthError), (403, LLMAuthError), (404, LLMProviderError), (429, LLMRateLimitError), (500, LLMProviderError), (422, LLMProviderError)],
    )
    def test_status_errors(self, status: int, error: type[Exception]) -> None:
        recorder = Recorder(httpx2.Response(status, json={"error": {"message": "nope"}}))
        with pytest.raises(error):
            openai_client(recorder).complete(REQUEST)

    def test_transient_failure_is_retried(self) -> None:
        recorder = Recorder(httpx2.Response(503, text="busy"), openai_ok("{}"))
        assert openai_client(recorder).complete(REQUEST).text == "{}"
        assert len(recorder.requests) == 2

    def test_timeouts_and_network_errors(self) -> None:
        with pytest.raises(LLMTimeoutError):
            openai_client(Recorder(httpx2.ReadTimeout("slow"))).complete(REQUEST)
        with pytest.raises(LLMConnectionError):
            openai_client(Recorder(httpx2.ConnectError("down"))).complete(REQUEST)

    def test_refusal_cutoff_and_garbage(self) -> None:
        refusal = httpx2.Response(200, json={"choices": [{"message": {"content": None, "refusal": "no"}, "finish_reason": "stop"}]})
        with pytest.raises(LLMRefusalError):
            openai_client(Recorder(refusal)).complete(REQUEST)
        with pytest.raises(LLMResponseError):
            openai_client(Recorder(openai_ok("{", finish="length"))).complete(REQUEST)
        with pytest.raises(LLMProviderError):
            openai_client(Recorder(httpx2.Response(200, text="<html>not json</html>"))).complete(REQUEST)


class TestGemini:
    def client(self, recorder: Recorder) -> GeminiClient:
        return GeminiClient(api_key="AIza-test", model="gemini-test", timeout=30, base_url="https://gemini.example.test/v1beta",
                            transport=httpx2.MockTransport(recorder))  # type: ignore[arg-type]

    def test_request_shape_and_reply(self) -> None:
        recorder = Recorder(httpx2.Response(200, json={
            "candidates": [{"content": {"parts": [{"text": "thinking", "thought": True}, {"text": '{"ok": true}'}]}, "finishReason": "STOP"}],
            "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 6},
        }))
        result = self.client(recorder).complete(REQUEST)
        request = recorder.requests[0]
        assert request.url.path == "/v1beta/models/gemini-test:generateContent"
        assert request.headers["x-goog-api-key"] == "AIza-test"
        body = recorder.body()
        assert body["systemInstruction"]["parts"][0]["text"] == "You are the IMY compiler."
        assert body["contents"] == [{"role": "user", "parts": [{"text": "compile this"}]}]
        assert body["generationConfig"]["responseMimeType"] == "application/json"
        assert result.text == '{"ok": true}' and result.output_tokens == 6

    def test_bad_key_safety_and_cutoff(self) -> None:
        bad_key = httpx2.Response(400, json={"error": {"message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT"}})
        with pytest.raises(LLMAuthError):
            self.client(Recorder(bad_key)).complete(REQUEST)
        blocked = httpx2.Response(200, json={"promptFeedback": {"blockReason": "SAFETY"}})
        with pytest.raises(LLMRefusalError):
            self.client(Recorder(blocked)).complete(REQUEST)
        cut = httpx2.Response(200, json={"candidates": [{"content": {"parts": [{"text": "{"}]}, "finishReason": "MAX_TOKENS"}]})
        with pytest.raises(LLMResponseError):
            self.client(Recorder(cut)).complete(REQUEST)


def sse(text: str, stop_reason: str = "end_turn") -> bytes:
    events = [
        ("message_start", {"type": "message_start", "message": {"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-opus-5-5", "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 12, "output_tokens": 1}}}),
        ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
        ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}}),
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        ("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop_reason, "stop_sequence": None}, "usage": {"output_tokens": 34}}),
        ("message_stop", {"type": "message_stop"}),
    ]
    return "".join(f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events).encode()


class TestAnthropic:
    def client(self, recorder: Recorder, model: str = "claude-opus-5-5", effort: str | None = None) -> AnthropicClient:
        import anthropic

        http = anthropic.DefaultHttpxClient(transport=httpx2.MockTransport(recorder))
        return AnthropicClient(api_key="sk-ant-test", model=model, timeout=30, effort=effort, http_client=http, max_retries=0)

    def test_streams_with_structured_output_and_adaptive_thinking(self) -> None:
        recorder = Recorder(httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=sse(reply("x = 1\n"))))
        result = self.client(recorder, effort="high").complete(REQUEST)
        body = recorder.body()
        assert recorder.requests[0].url.path == "/v1/messages"
        headers = recorder.requests[0].headers
        assert headers.get("x-api-key") == "sk-ant-test" or headers.get("authorization") == "Bearer sk-ant-test"
        assert body["stream"] is True and body["model"] == "claude-opus-5-5" and body["max_tokens"] == 2048
        assert body["system"] == "You are the IMY compiler."
        assert body["output_config"] == {"effort": "high", "format": {"type": "json_schema", "schema": RESPONSE_SCHEMA}}
        assert body["thinking"] == {"type": "adaptive"}
        assert json.loads(result.text)["compiled_code"] == "x = 1\n"
        assert (result.input_tokens, result.output_tokens) == (12, 34)

    def test_errors_are_plain_language(self) -> None:
        unauthorized = httpx2.Response(401, json={"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}})
        with pytest.raises(LLMAuthError):
            self.client(Recorder(unauthorized)).complete(REQUEST)
        missing = httpx2.Response(404, json={"type": "error", "error": {"type": "not_found_error", "message": "model: nope"}})
        with pytest.raises(LLMProviderError) as caught:
            self.client(Recorder(missing), model="claude-nope").complete(REQUEST)
        assert "claude-nope" in caught.value.message

    def test_unsupported_structured_output_falls_back_to_the_prompt(self) -> None:
        rejected = httpx2.Response(400, json={"type": "error", "error": {"type": "invalid_request_error", "message": "output_config.format is not supported for this model"}})
        ok = httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=sse("{}"))
        recorder = Recorder(rejected, ok)
        assert self.client(recorder).complete(REQUEST).text == "{}"
        assert "output_config" not in recorder.body(-1)

    def test_refusal_and_cutoff(self) -> None:
        refused = httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=sse("", stop_reason="refusal"))
        with pytest.raises(LLMRefusalError):
            self.client(Recorder(refused)).complete(REQUEST)
        cut = httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=sse("{", stop_reason="max_tokens"))
        with pytest.raises(LLMResponseError):
            self.client(Recorder(cut)).complete(REQUEST)

    @pytest.mark.parametrize(
        "model, expected",
        [("claude-opus-5-5", True), ("claude-fable-5-2", True), ("claude-haiku-5-5", True), ("claude-opus-4-8", True),
         ("claude-sonnet-4-20250514", False), ("claude-3-5-sonnet-latest", False), ("my-proxy-model", False)],
    )
    def test_adaptive_thinking_only_where_supported(self, model: str, expected: bool) -> None:
        assert supports_adaptive_thinking(model) is expected


BRIDGE = r'''
import json, sys
request = json.loads(sys.stdin.read())
if request.get("op") == "models":
    print(json.dumps({"ok": True, "models": [{"id": "free/one", "label": "Free One"}, {"id": "free/two", "label": "Free Two"}]}))
    raise SystemExit(0)
model = request["model"]
if model == "busy":
    print(json.dumps({"ok": False, "error": {"kind": "busy", "message": "the free model is busy"}}))
elif model in ("daily_limit", "restricted", "withdrawn", "refused", "timeout", "network", "rejected"):
    print(json.dumps({"ok": False, "error": {"kind": model, "message": "free model said " + model}}))
elif model == "garbage":
    print("not json")
elif model == "crash":
    sys.stderr.write("boom")
    raise SystemExit(3)
else:
    print("log line that is not json")
    echo = {"system": request["system"][:10], "messages": request["messages"], "maxTokens": request["maxTokens"], "json": request["json"]}
    print(json.dumps({"ok": True, "text": json.dumps(echo), "model": model, "usage": {"inputTokens": 7, "outputTokens": 8}}))
'''


class TestAutomaBridge:
    def bridge(self, tmp_path: Path, model: str = "free/one") -> AutomaBridgeClient:
        script = tmp_path / "bridge.py"
        script.write_text(BRIDGE, encoding="utf-8")
        return AutomaBridgeClient(command=[sys.executable, str(script)], model=model, timeout=30)

    def test_complete_round_trip(self, tmp_path: Path) -> None:
        result = self.bridge(tmp_path).complete(REQUEST)
        echoed = json.loads(result.text)
        assert echoed == {"system": "You are th", "messages": [{"role": "user", "content": "compile this"}], "maxTokens": 2048, "json": True}
        assert (result.provider, result.model, result.input_tokens) == ("automa", "free/one", 7)

    def test_models(self, tmp_path: Path) -> None:
        assert self.bridge(tmp_path).list_models() == [("free/one", "Free One"), ("free/two", "Free Two")]

    def test_errors(self, tmp_path: Path) -> None:
        with pytest.raises(LLMRateLimitError):
            self.bridge(tmp_path, "busy").complete(REQUEST)
        with pytest.raises(LLMProviderError):
            self.bridge(tmp_path, "garbage").complete(REQUEST)
        with pytest.raises(LLMProviderError) as caught:
            self.bridge(tmp_path, "crash").complete(REQUEST)
        assert "boom" in caught.value.message

    @pytest.mark.parametrize(
        "kind, error, hint",
        [
            ("daily_limit", LLMRateLimitError, "daily limit"),
            ("restricted", LLMProviderError, "another free model"),
            ("withdrawn", LLMProviderError, "another free model"),
            ("rejected", LLMProviderError, None),
            ("refused", LLMRefusalError, None),
            ("timeout", LLMTimeoutError, None),
            ("network", LLMConnectionError, "internet connection"),
        ],
    )
    def test_error_kinds_map_to_clear_errors(self, tmp_path: Path, kind: str, error: type[Exception], hint: str | None) -> None:
        with pytest.raises(error) as caught:
            self.bridge(tmp_path, kind).complete(REQUEST)
        assert f"free model said {kind}" in caught.value.message  # type: ignore[attr-defined]
        if hint:
            assert hint in (caught.value.hint or "")  # type: ignore[attr-defined]

    def test_missing_bridge_program(self) -> None:
        with pytest.raises(ConfigError):
            AutomaBridgeClient(command=["/nonexistent/imy-bridge"], model="x", timeout=5).complete(REQUEST)


class TestBuildClient:
    def env(self, **values: str) -> EnvView:
        return EnvView(values=dict(values))

    def test_missing_keys_are_config_errors(self) -> None:
        for provider in ("anthropic", "openai", "gemini"):
            with pytest.raises(ConfigError) as caught:
                build_client(ImyConfig(provider=provider), self.env())
            assert "imy init" in (caught.value.hint or "")

    def test_automa_needs_the_bridge(self, tmp_path: Path) -> None:
        with pytest.raises(ConfigError):
            build_client(ImyConfig(provider="automa"), self.env())
        script = tmp_path / "bridge.py"
        script.write_text(BRIDGE, encoding="utf-8")
        command = f"{shlex.quote(sys.executable)} {shlex.quote(str(script))}"
        client = build_client(ImyConfig(provider="automa"), self.env(IMY_AUTOMA_BRIDGE=command))
        assert isinstance(client, AutomaBridgeClient)

    def test_key_sources_in_priority_order(self) -> None:
        config = ImyConfig(provider="openai", api_key="sk-stored")
        assert config.resolve_api_key(self.env(OPENAI_API_KEY="sk-env"))[0] == "sk-stored"
        assert config.resolve_api_key(self.env(IMY_API_KEY="sk-imy"))[0] == "sk-imy"
        named = ImyConfig(provider="openai", api_key_env="MY_KEY")
        assert named.resolve_api_key(self.env(MY_KEY="sk-named"))[0] == "sk-named"
        assert ImyConfig(provider="openai").resolve_api_key(self.env(OPENAI_API_KEY="sk-env"))[0] == "sk-env"

    def test_compatible_server_needs_no_key(self) -> None:
        client = build_client(ImyConfig(provider="openai-compatible", base_url="http://localhost:11434/v1"), self.env())
        assert isinstance(client, OpenAICompatibleClient)

    def test_keys_with_spaces_are_rejected(self) -> None:
        with pytest.raises(ValueError):
            ImyConfig(provider="openai", api_key="sk-a b")
        with pytest.raises(ConfigError):
            build_client(ImyConfig(provider="openai"), self.env(OPENAI_API_KEY="sk a"))
