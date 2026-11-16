"""Deterministic test provider. It is not a model.

It replays a script: one entry per model call, each giving the text and/or tool
calls to return. Tests and deterministic evals use it to exercise the real
runtime (tool execution, approvals, limits, events, persistence) at zero cost.
Runs that use it are labelled "scripted" everywhere in the UI.

Script entry fields:
  text: str                     assistant text
  tool_calls: [{name, input}]   tool calls to make
  stop_reason: str              override (default: tool_use if tool calls, else end_turn)
  error: {message, retryable}   raise a ProviderError instead of answering
  delay_s: float                sleep first (to test timeouts and cancellation)
  usage: {input_tokens, output_tokens}
"""

from __future__ import annotations

import asyncio
import json

from pae.providers.base import ModelRequest, ModelResponse, ProviderError, Usage


class ScriptedProvider:
    name = "scripted"
    kind = "chat"

    def __init__(self, script: list[dict] | None = None) -> None:
        self.default_script = script or []

    def status(self) -> dict:
        return {"configured": True, "detail": "Deterministic test provider (no model)."}

    async def complete(self, request: ModelRequest) -> ModelResponse:
        script = request.options.get("script", self.default_script)
        # The position in the script is the number of assistant turns so far,
        # so a resumed run continues where it stopped.
        position = sum(1 for m in request.messages if m["role"] == "assistant")
        position += request.options.get("_attempt_offset", 0)
        if position >= len(script):
            entry = {"text": "Script exhausted."}
        else:
            entry = script[position]

        if delay := entry.get("delay_s"):
            await asyncio.sleep(delay)
        if error := entry.get("error"):
            # Errors are consumed one attempt at a time so a retry can succeed.
            attempts = request.options.setdefault("_errors_seen", {})
            seen = attempts.get(position, 0)
            if seen < error.get("times", 1):
                attempts[position] = seen + 1
                raise ProviderError(error.get("message", "scripted failure"), retryable=error.get("retryable", True))

        content: list[dict] = []
        if text := entry.get("text"):
            content.append({"type": "text", "text": text})
        for index, call in enumerate(entry.get("tool_calls", [])):
            content.append(
                {
                    "type": "tool_use",
                    "id": call.get("id", f"call_{position}_{index}"),
                    "name": call["name"],
                    "input": call.get("input", {}),
                }
            )
        stop_reason = entry.get("stop_reason") or ("tool_use" if entry.get("tool_calls") else "end_turn")
        prompt_chars = len(request.system) + len(json.dumps(request.messages, default=str))
        usage = entry.get("usage") or {}
        return ModelResponse(
            content=content,
            stop_reason=stop_reason,
            usage=Usage(
                input_tokens=usage.get("input_tokens", max(1, prompt_chars // 4)),
                output_tokens=usage.get("output_tokens", max(1, len(json.dumps(content)) // 4)),
            ),
            model=request.model or "scripted",
            provider=self.name,
            raw_content=None,
            cost_usd=0.0,
        )
