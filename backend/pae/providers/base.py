"""Provider-neutral model interface.

The canonical message format uses content blocks:
  {"type": "text", "text": str}
  {"type": "tool_use", "id": str, "name": str, "input": dict}
  {"type": "tool_result", "tool_use_id": str, "content": str, "is_error": bool}
  {"type": "reasoning", "text": str}        # provider-supplied summary, never raw chain of thought

An assistant message may also carry "raw" (the provider-native content) and
"provider"/"model" so a provider can replay its own blocks unchanged.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


class ProviderError(Exception):
    """A model call failed. `retryable` says whether trying again can help."""

    def __init__(self, message: str, *, retryable: bool, status: int | None = None) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status = status


class ProviderNotConfigured(ProviderError):
    def __init__(self, message: str) -> None:
        super().__init__(message, retryable=False)


@dataclass
class ToolSpec:
    name: str
    description: str
    input_schema: dict


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0


@dataclass
class ModelRequest:
    model: str
    system: str
    messages: list[dict]
    tools: list[ToolSpec]
    max_tokens: int = 16000
    effort: str | None = None
    timeout_s: float = 300.0
    options: dict = field(default_factory=dict)


@dataclass
class ModelResponse:
    content: list[dict]  # canonical blocks
    stop_reason: str  # end_turn | tool_use | max_tokens | refusal | pause_turn | other
    usage: Usage
    model: str
    provider: str
    raw_content: Any = None  # provider-native blocks, replayed unchanged on the next request
    request_id: str | None = None
    stop_detail: str | None = None
    cost_usd: float | None = None  # set when the provider reports cost itself

    @property
    def tool_calls(self) -> list[dict]:
        return [b for b in self.content if b["type"] == "tool_use"]

    @property
    def text(self) -> str:
        return "".join(b["text"] for b in self.content if b["type"] == "text")


class ChatProvider(Protocol):
    """A provider that answers one request at a time; the platform runs the loop."""

    name: str
    kind: str  # "chat"

    async def complete(self, request: ModelRequest) -> ModelResponse: ...

    def status(self) -> dict: ...


def assistant_message(response: ModelResponse) -> dict:
    return {
        "role": "assistant",
        "content": response.content,
        "raw": response.raw_content,
        "provider": response.provider,
        "model": response.model,
    }


def tool_result_block(tool_use_id: str, content: str, is_error: bool = False) -> dict:
    return {"type": "tool_result", "tool_use_id": tool_use_id, "content": content, "is_error": is_error}
