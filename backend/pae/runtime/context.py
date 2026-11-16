"""State shared by every step of one run."""

from __future__ import annotations

import asyncio
import contextlib
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pae.agents import AgentDefinition
    from pae.runtime.manager import RunManager


class RunFailure(Exception):
    def __init__(self, message: str, code: str = "failed") -> None:
        super().__init__(message)
        self.code = code


class LimitExceeded(RunFailure):
    def __init__(self, limit: str, value: Any, maximum: Any) -> None:
        super().__init__(f"limit exceeded: {limit} = {value} (max {maximum})", code="limit_exceeded")
        self.limit, self.value, self.maximum = limit, value, maximum


@dataclass
class Outcome:
    output: Any = None
    output_text: str | None = None


@dataclass
class RunContext:
    run_id: str
    root_run_id: str
    parent_run_id: str | None
    depth: int
    agent: AgentDefinition
    agent_version: str
    task: str
    input: dict | None
    workspace: Path
    provider_name: str
    model: str
    limits: dict
    options: dict
    manager: RunManager
    project_id: str | None = None
    project_context: str = ""
    # The owner lets the team edit files in this project without asking (pae.projects).
    project_trust_edits: bool = False
    # Tools the project itself offers every agent (e.g. its Claude Code memory), on top of the agent's own.
    project_tools: list[str] = field(default_factory=list)
    # The earlier Claude Code session this run continues, and the run it comes from (pae.runtime.sessions).
    continue_session: str | None = None
    continue_from_run: str | None = None
    checkpoint: dict | None = None
    provider_state: dict = field(default_factory=dict)
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    steps: int = 0
    tool_calls: int = 0
    children: int = 0
    started: float = field(default_factory=time.monotonic)
    # Time spent waiting for the owner (an approval, a paused plan) does not count against the time limit: the
    # clock stops (RunManager.owner_awaited) and every deadline of this run moves by the time waited.
    waited_s: float = 0.0
    deadlines: list[asyncio.Timeout] = field(default_factory=list)
    _holds: int = 0
    _held_since: float = 0.0
    _held_left: dict[int, float] = field(default_factory=dict)

    def tool_names(self) -> list[str]:
        """Every tool this run may call: the agent's own, then the project's."""
        return [*self.agent.tools, *(t for t in self.project_tools if t not in self.agent.tools)]

    async def emit(self, type_: str, source: str, data: dict | None = None) -> dict:
        return await self.manager.bus.emit(self.run_id, self.root_run_id, type_, source, data)

    def elapsed_s(self) -> float:
        """Time counted against the limit: since the start, minus the time spent waiting for the owner."""
        return self.wall_s() - self.waited_s - (time.monotonic() - self._held_since if self._holds else 0.0)

    def wall_s(self) -> float:
        return time.monotonic() - self.started

    def remaining_s(self) -> float:
        return max(0.0, float(self.limits["timeout_s"]) - self.elapsed_s())

    @contextlib.asynccontextmanager
    async def deadline(self, seconds: float):
        """asyncio.timeout(seconds), stopped while the owner is awaited and moved by the time waited."""
        async with asyncio.timeout(seconds) as timeout:
            self.deadlines.append(timeout)
            if self._holds:  # started while the clock is stopped: it waits too
                self._held_left[id(timeout)] = seconds
                _reschedule(timeout, None)
            try:
                yield timeout
            finally:
                self.deadlines.remove(timeout)
                self._held_left.pop(id(timeout), None)

    def hold_clock(self) -> None:
        self._holds += 1
        if self._holds > 1:
            return
        self._held_since = time.monotonic()
        now = asyncio.get_running_loop().time()
        for timeout in self.deadlines:
            when = timeout.when()
            if when is not None and _reschedule(timeout, None):
                self._held_left[id(timeout)] = when - now

    def release_clock(self) -> None:
        self._holds = max(0, self._holds - 1)
        if self._holds:
            return
        self.waited_s += time.monotonic() - self._held_since
        now = asyncio.get_running_loop().time()
        for timeout in self.deadlines:
            left = self._held_left.pop(id(timeout), None)
            if left is not None:
                _reschedule(timeout, now + left)
        self._held_left.clear()

    def save_counters(self) -> None:
        self.manager.update_run(
            self.run_id,
            input_tokens=self.input_tokens,
            output_tokens=self.output_tokens,
            cost_usd=round(self.cost_usd, 6),
            steps=self.steps,
            tool_calls=self.tool_calls,
        )

    def save_checkpoint(self, messages: list[dict], **extra) -> None:
        self.checkpoint = {"messages": messages, "step": self.steps, **extra}
        self.manager.update_run(self.run_id, checkpoint=self.checkpoint)

    def limits_over(self) -> list[tuple[str, Any, Any]]:
        """Usage limits this run went past: (limit, value, maximum)."""
        tokens = self.input_tokens + self.output_tokens
        over = []
        for name, value in (("max_tokens", tokens), ("max_cost_usd", self.cost_usd)):
            maximum = self.limits.get(name)
            if maximum is not None and value > float(maximum):
                over.append((name, value, maximum))
        return over

    async def check_limits(self) -> None:
        for name, value, maximum in self.limits_over()[:1]:
            await self.emit("limit.exceeded", "runtime", {"limit": name, "value": value, "max": maximum})
            raise LimitExceeded(name, value, maximum)


def _reschedule(timeout: asyncio.Timeout, when: float | None) -> bool:
    try:
        timeout.reschedule(when)
        return True
    except RuntimeError:  # already expiring or finished: nothing left to move
        return False
