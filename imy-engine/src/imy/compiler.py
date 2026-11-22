"""The IMY pipeline: static rules, memory, cache, model, output checks, memory update.

Stage 1 (deterministic, free): parser + static rules + memory conflicts.
Stage 2 (model): strict semantic validation and compilation in one JSON reply.
Stage 3 (deterministic): fences and prose stripped, zero comments proven,
syntax checked, website strictness and exact messages verified. A reply that
fails stage 3 gets ``repair_attempts`` corrections, then the compile is cut off.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from . import __version__
from .config import ImyConfig
from .errors import (
    CompilationFailed,
    ConfigError,
    Diagnostic,
    ErrorCode,
    LLMResponseError,
    Stage,
)
from .languages import Language, normalize_language_name, resolve_language
from .llm_client import ChatMessage, LLMClient, LLMRequest
from .memory import CacheEntry, CompileCache, Memory, MemorySymbol, MemoryUpdateReport, cache_key, now_iso
from .parser import ParsedSource, parse_text, read_source
from .postprocess import check_output
from .prompts import (
    PROMPT_VERSION,
    RESPONSE_SCHEMA,
    CompilerErrorItem,
    ExtractedSymbol,
    RepoContext,
    ResponseFormatError,
    build_repair_prompt,
    build_user_prompt,
    machine_name,
    parse_compiler_response,
    system_prompt,
)
from .static_rules import check as run_static_rules
from .workspace import VirtualFileMap, Workspace, map_virtual_files

ClientFactory = Callable[[], LLMClient]


@dataclass
class CompileOptions:
    target: str
    update_memory: bool = False
    use_cache: bool = True
    save_memory: bool = True
    run_dir: Path | None = None
    repo_context: RepoContext | None = None
    fragment: bool = False
    # A conversion of a program still being typed (the console's live mode): the model is told
    # more lines may follow, nothing is saved to memory, and the result has its own place in
    # the cache, so it never stands in for the strict compile that `run` does.
    preview: bool = False


@dataclass
class CompileResult:
    parsed: ParsedSource
    language: Language
    code: str
    symbols: list[ExtractedSymbol]
    from_cache: bool
    cache_key: str
    provider: str
    model: str
    vfs: VirtualFileMap
    relevant_memory: list[MemorySymbol] = field(default_factory=list)
    memory_report: MemoryUpdateReport | None = None
    notes: list[str] = field(default_factory=list)
    attempts: int = 0
    # Seconds spent waiting for the model (0 when the program came from the cache).
    seconds: float = 0.0


@dataclass
class _ModelOutput:
    code: str
    symbols: list[ExtractedSymbol]
    provider: str
    model: str
    notes: list[str]
    attempts: int


class Compiler:
    def __init__(
        self,
        *,
        config: ImyConfig,
        workspace: Workspace,
        memory: Memory,
        client_factory: ClientFactory,
    ) -> None:
        self.config = config
        self.workspace = workspace
        self.memory = memory
        self._client_factory = client_factory
        self._client: LLMClient | None = None

    def client(self) -> LLMClient:
        if self._client is None:
            self._client = self._client_factory()
        return self._client

    def compile_file(self, path: Path, options: CompileOptions) -> CompileResult:
        source = read_source(path)
        return self.compile_parsed(parse_text(source, path=path.resolve()), options)

    def compile_text(self, text: str, options: CompileOptions, *, path: Path | None = None) -> CompileResult:
        return self.compile_parsed(parse_text(text, path=path), options)

    def static_check(self, parsed: ParsedSource) -> None:
        """Stage 1 only: raises CompilationFailed on any static or memory problem."""
        origin = self._origin(parsed)
        known = self.memory.known_names(exclude_origin=origin)
        report = run_static_rules(parsed, known)
        if report.diagnostics:
            raise CompilationFailed(list(report.diagnostics), source_lines=parsed.raw_lines, path=parsed.path)

    def compile_parsed(self, parsed: ParsedSource, options: CompileOptions) -> CompileResult:
        try:
            language = resolve_language(options.target)
        except ValueError as exc:
            raise ConfigError(f"{options.target!r} is not a language name.", hint="Try --to python, javascript, lua, html, rust, ...") from exc
        origin = self._origin(parsed)
        self.static_check(parsed)

        problems: list[Diagnostic] = []
        if not options.update_memory:
            problems.extend(self.memory.conflicts(parsed, origin))
        relevant = self.memory.relevant(parsed, origin)
        problems.extend(relevant.diagnostics)
        if problems:
            raise CompilationFailed(problems, source_lines=parsed.raw_lines, path=parsed.path)

        run_dir = options.run_dir or (parsed.path.parent if parsed.path is not None else self.workspace.root)
        vmap = map_virtual_files(parsed, self.workspace, run_dir)
        context = json.dumps(
            {
                "repo": options.repo_context.fingerprint_text() if options.repo_context else "",
                "virtual": vmap.virtual_paths,
                "web": [[note.url, note.local_path] for note in vmap.web],
                **({"preview": True} if options.preview else {}),
                **({"machine": machine_name()} if language.name == "asm" else {}),
            },
            sort_keys=True,
        )
        key = cache_key(
            normalized_source=parsed.text,
            target=language.name,
            memory_snapshot=relevant.snapshot(),
            context=context,
            prompt_version=PROMPT_VERSION,
        )
        cache = CompileCache(self.workspace.cache)
        cached = cache.get(key) if options.use_cache else None
        if cached is not None:
            symbols = _symbols_from_cache(cached.extracted_symbols)
            result = CompileResult(
                parsed=parsed,
                language=language,
                code=cached.compiled_code,
                symbols=symbols,
                from_cache=True,
                cache_key=key,
                provider=cached.provider,
                model=cached.model,
                vfs=vmap,
                relevant_memory=relevant.symbols,
            )
        else:
            started = time.monotonic()
            output = self._call_model(parsed, language, relevant.symbols, vmap, options)
            waited = time.monotonic() - started
            cache.put(
                CacheEntry(
                    key=key,
                    target_language=language.name,
                    compiled_code=output.code,
                    extracted_symbols=[symbol.model_dump(mode="json") for symbol in output.symbols],
                    provider=output.provider,
                    model=output.model,
                    created_at=now_iso(),
                    imy_version=__version__,
                )
            )
            result = CompileResult(
                parsed=parsed,
                language=language,
                code=output.code,
                symbols=output.symbols,
                from_cache=False,
                cache_key=key,
                provider=output.provider,
                model=output.model,
                vfs=vmap,
                relevant_memory=relevant.symbols,
                notes=output.notes,
                attempts=output.attempts,
                seconds=waited,
            )

        if options.save_memory and not options.preview:
            report = self.memory.apply(parsed, origin, result.symbols, update=options.update_memory)
            if report.conflicts:
                raise CompilationFailed(report.conflicts, source_lines=parsed.raw_lines, path=parsed.path)
            result.memory_report = report
        return result

    @staticmethod
    def _origin(parsed: ParsedSource) -> str:
        return str(parsed.path) if parsed.path is not None else "<console>"

    def _call_model(
        self,
        parsed: ParsedSource,
        language: Language,
        memory_symbols: list[MemorySymbol],
        vmap: VirtualFileMap,
        options: CompileOptions,
    ) -> _ModelOutput:
        client = self.client()
        user = build_user_prompt(
            parsed=parsed,
            target=language.name,
            memory=memory_symbols,
            virtual_paths=vmap.virtual_paths,
            web_resources=vmap.web,
            repo_context=options.repo_context,
            preview=options.preview,
        )
        messages: list[ChatMessage] = [ChatMessage("user", user)]
        attempts = 1 + self.config.repair_attempts
        last_format_problems: list[str] = []
        last_output: list[Diagnostic] = []
        last_lines: list[str] = []
        accepted_names = {language.name, *language.aliases}
        for attempt in range(1, attempts + 1):
            reply = client.complete(
                LLMRequest(
                    system=system_prompt(),
                    messages=tuple(messages),
                    max_output_tokens=self.config.max_output_tokens,
                    json_schema=RESPONSE_SCHEMA,
                )
            )
            try:
                response = parse_compiler_response(reply.text)
            except ResponseFormatError as exc:
                last_format_problems = exc.problems
                last_output = []
                messages.append(ChatMessage("assistant", reply.text or "(empty reply)"))
                messages.append(ChatMessage("user", build_repair_prompt(exc.problems, language.name)))
                continue
            if response.status == "error":
                raise CompilationFailed(
                    [_llm_diagnostic(item, parsed) for item in response.errors],
                    source_lines=parsed.raw_lines,
                    path=parsed.path,
                )
            format_problems: list[str] = []
            if normalize_language_name(response.target_language) not in accepted_names:
                format_problems.append(
                    f'target_language was "{response.target_language}" but the program must be {language.name}'
                )
            checked = check_output(response.compiled_code, language, parsed, fragment=options.fragment)
            if not checked.diagnostics and not format_problems:
                return _ModelOutput(
                    code=checked.code,
                    symbols=list(response.extracted_symbols),
                    provider=reply.provider,
                    model=reply.model,
                    notes=checked.notes,
                    attempts=attempt,
                )
            last_format_problems = format_problems
            last_output = checked.diagnostics
            last_lines = checked.code.split("\n")
            if attempt < attempts:
                repair = [diag.headline() for diag in checked.diagnostics] + format_problems
                messages.append(ChatMessage("assistant", reply.text))
                messages.append(ChatMessage("user", build_repair_prompt(repair, language.name)))
        if last_output:
            extra = [Diagnostic(ErrorCode.INVALID_OUTPUT, 0, problem, stage=Stage.OUTPUT) for problem in last_format_problems]
            raise CompilationFailed(
                last_output + extra, source_lines=parsed.raw_lines, output_lines=last_lines, path=parsed.path
            )
        summary = "; ".join(last_format_problems)[:400] or "no usable answer"
        raise LLMResponseError(
            f"The model did not return the JSON object IMY needs after {attempts} attempt(s): {summary}",
            hint="Try again, or pick a stronger model with `imy init` or --model.",
        )


def _llm_diagnostic(item: CompilerErrorItem, parsed: ParsedSource) -> Diagnostic:
    line = item.line if 0 <= item.line <= len(parsed.lines) else 0
    return Diagnostic(code=ErrorCode(item.code), line=line, message=item.message.strip(), stage=Stage.LLM)


def _symbols_from_cache(raw: list[dict[str, object]]) -> list[ExtractedSymbol]:
    symbols: list[ExtractedSymbol] = []
    for item in raw:
        try:
            symbols.append(ExtractedSymbol.model_validate(item))
        except ValueError:
            continue
    return symbols
