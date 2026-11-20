"""Error codes, diagnostics and exceptions shared by every IMY stage."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path


class ErrorCode(StrEnum):
    """Every error IMY can report. The value is what users see in brackets."""

    MISSING_HEADER = "MissingHeader"
    MALFORMED_HEADER = "MalformedHeader"
    EMPTY_BODY = "EmptyBody"
    PROMPTING_DETECTED = "PromptingDetected"
    COMMENT_IN_SOURCE = "CommentInSource"
    UNTERMINATED_STRING = "UnterminatedString"
    HEADER_MISMATCH = "HeaderMismatch"
    SHORTCUT_LIMIT_EXCEEDED = "ShortcutLimitExceeded"
    SHORTCUT_LENGTH_EXCEEDED = "ShortcutLengthExceeded"
    SHORTCUT_VIOLATION = "ShortcutViolation"
    MISSING_MECHANICS = "MissingMechanics"
    EXECUTION_ORDER_VIOLATION = "ExecutionOrderViolation"
    AMBIGUOUS_INTENT = "AmbiguousIntent"
    MEMORY_CONFLICT = "MemoryConflict"
    COMMENTS_IN_OUTPUT = "CommentsInOutput"
    INVALID_OUTPUT = "InvalidOutput"
    INVENTED_STYLING = "InventedStyling"
    INVENTED_ASSET = "InventedAsset"
    INVENTED_CONTENT = "InventedContent"
    MESSAGE_NOT_PRESERVED = "MessageNotPreserved"


SYNTAX_ERROR_CODES: frozenset[ErrorCode] = frozenset(
    {
        ErrorCode.MISSING_HEADER,
        ErrorCode.MALFORMED_HEADER,
        ErrorCode.EMPTY_BODY,
        ErrorCode.PROMPTING_DETECTED,
        ErrorCode.COMMENT_IN_SOURCE,
        ErrorCode.UNTERMINATED_STRING,
    }
)


class Stage(StrEnum):
    """Where a diagnostic came from."""

    STATIC = "static"
    MEMORY = "memory"
    LLM = "llm"
    OUTPUT = "output"


@dataclass(frozen=True)
class Diagnostic:
    """One precise, line-referenced problem.

    ``line`` is 1-based. For the static, memory and llm stages it points into the
    user's .imy file (0 means the whole file). For the output stage it points into
    the compiled code the model returned.
    """

    code: ErrorCode
    line: int
    message: str
    stage: Stage = Stage.STATIC
    related: tuple[int, ...] = ()

    @property
    def family(self) -> str:
        return "SyntaxError" if self.code in SYNTAX_ERROR_CODES else "CompilerError"

    @property
    def location(self) -> str:
        if self.line <= 0:
            return "whole file"
        if self.stage is Stage.OUTPUT:
            return f"compiled output line {self.line}"
        return f"line {self.line}"

    def headline(self) -> str:
        return f"{self.family} [{self.code.value}] {self.location}: {self.message}"


class ImyError(Exception):
    """Base class for every error IMY reports to the user (never a traceback)."""

    exit_code = 2

    def __init__(self, message: str, *, hint: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint


class SourceFileError(ImyError):
    """The .imy file is missing, unreadable, binary or too large."""


class ConfigError(ImyError):
    """Provider, model, key or config file problems."""


class MemoryStoreError(ImyError):
    """The cross-session memory file can't be read or written."""


class CompilationFailed(ImyError):
    """The program broke a rule. Nothing was executed."""

    exit_code = 1

    def __init__(
        self,
        diagnostics: list[Diagnostic],
        *,
        source_lines: list[str] | None = None,
        output_lines: list[str] | None = None,
        path: Path | None = None,
    ) -> None:
        ordered = sorted(diagnostics, key=lambda d: (d.stage is Stage.OUTPUT, d.line, d.code.value))
        count = len(ordered)
        noun = "error" if count == 1 else "errors"
        where = f" in {path.name}" if path is not None else ""
        super().__init__(f"{count} {noun}{where}; nothing was run.")
        self.diagnostics = ordered
        self.source_lines = source_lines or []
        self.output_lines = output_lines or []
        self.path = path

    @property
    def codes(self) -> list[ErrorCode]:
        return [d.code for d in self.diagnostics]


class LLMError(ImyError):
    """The AI provider could not produce a usable answer."""

    exit_code = 3


class LLMAuthError(LLMError):
    """The API key is missing, wrong or not allowed to use the model."""


class LLMTimeoutError(LLMError):
    """The provider did not answer in time."""


class LLMConnectionError(LLMError):
    """The provider could not be reached."""


class LLMRateLimitError(LLMError):
    """The provider asked us to slow down."""


class LLMRefusalError(LLMError):
    """The model declined the request."""


class LLMProviderError(LLMError):
    """Any other provider-side failure (bad model name, 5xx, bad request)."""


class LLMResponseError(LLMError):
    """The model kept answering in a shape IMY can't use (bad JSON, cut off)."""


class RunnerError(ImyError):
    """Building or starting the compiled program failed."""

    exit_code = 4


class InjectionError(ImyError):
    """Cloning, locating or patching a repository failed."""

    exit_code = 5
