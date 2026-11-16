"""Tool contract, registry and the workspace boundary every tool goes through."""

from __future__ import annotations

import fnmatch
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from pae.providers.base import ToolSpec

Risk = Literal["read", "write", "external", "execute", "destructive"]
Permission = Literal["allow", "ask", "deny"]
PERMISSION_ORDER = {"allow": 0, "ask": 1, "deny": 2}

# Files no tool may read or write, even inside a workspace.
PROTECTED_PATTERNS = (
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "id_rsa*",
    "id_ed25519*",
    "*.kdbx",
    ".git-credentials",
    ".netrc",
    ".npmrc",
    ".pypirc",
    "secret.key",
    "credentials.json",
    ".credentials.json",
)
# Folders and files the owner marked private in a project (absolute, normalised): no tool may open,
# list or search them. Kept up to date by pae.projects.ProjectService.
_BLOCKED: tuple[str, ...] = ()


def set_blocked_paths(paths) -> None:
    global _BLOCKED
    _BLOCKED = tuple(os.path.normcase(str(Path(p).resolve())) for p in paths)


def is_blocked(path: Path) -> bool:
    """True when `path` is a private path of a project, or inside one."""
    if not _BLOCKED:
        return False
    text = os.path.normcase(str(path.resolve()))
    return any(text == b or text.startswith(b.rstrip(os.sep) + os.sep) for b in _BLOCKED)


def blocked_names() -> set[str]:
    """The last part of every private path ("backups", "backup.conf"), normalised."""
    return {os.path.basename(b.rstrip(os.sep)) for b in _BLOCKED}


def blocked_inside(folder: Path) -> list[str]:
    """The private paths a search of `folder` (and everything under it) would reach."""
    root = os.path.normcase(str(folder.resolve())).rstrip(os.sep)
    return [b for b in _BLOCKED if b == root or b.startswith(root + os.sep)]


SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", "dist", "build"}


class ToolError(Exception):
    """A tool refused or failed in a way the model should be told about."""


class Args(BaseModel):
    model_config = ConfigDict(extra="forbid")


@dataclass
class ToolResult:
    content: str  # what the model sees
    data: Any = None  # structured detail for the UI and evals
    is_error: bool = False


@dataclass
class ToolContext:
    run_id: str
    root_run_id: str
    agent_id: str
    workspace: Path
    settings: Any  # pae.settings_store.SettingsStore
    secrets: Callable[[str], str | None]
    redactor: Any
    emit: Callable[..., Awaitable[None]]
    manager: Any = None  # pae.runtime.manager.RunManager, for delegation
    agent: Any = None  # pae.agents.AgentDefinition
    depth: int = 0
    project_id: str | None = None


@dataclass
class Tool:
    name: str
    description: str
    args_model: type[Args]
    handler: Callable[[Any, ToolContext], Awaitable[ToolResult]]
    risk: Risk
    default_permission: Permission
    category: str
    untrusted_output: bool = False
    timeout_s: float = 60.0
    # Optional: decide permission from the actual arguments (e.g. GET to an allowed domain).
    dynamic_permission: Callable[[Any, ToolContext], Permission | None] | None = None
    input_schema_override: dict | None = None
    source: str = "builtin"

    @property
    def input_schema(self) -> dict:
        if self.input_schema_override is not None:
            return self.input_schema_override
        schema = self.args_model.model_json_schema()
        schema.pop("title", None)
        return schema

    def spec(self) -> ToolSpec:
        return ToolSpec(name=self.name, description=self.description, input_schema=self.input_schema)

    def describe(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "category": self.category,
            "risk": self.risk,
            "default_permission": self.default_permission,
            "untrusted_output": self.untrusted_output,
            "timeout_s": self.timeout_s,
            "input_schema": self.input_schema,
            "source": self.source,
        }


@dataclass
class ToolRegistry:
    tools: dict[str, Tool] = field(default_factory=dict)

    def register(self, tool: Tool) -> None:
        if tool.name in self.tools:
            raise ValueError(f"duplicate tool {tool.name}")
        self.tools[tool.name] = tool

    def unregister_source(self, source: str) -> None:
        for name in [n for n, t in self.tools.items() if t.source == source]:
            del self.tools[name]

    def get(self, name: str) -> Tool | None:
        return self.tools.get(name)

    def all(self) -> list[Tool]:
        return sorted(self.tools.values(), key=lambda t: (t.category, t.name))


def resolve_path(workspace: Path, path: str, *, must_exist: bool = False) -> Path:
    """Resolve `path` inside `workspace`, following symlinks; refuse anything outside."""
    root = workspace.resolve()
    candidate = Path(path)
    target = (candidate if candidate.is_absolute() else root / candidate).resolve()
    if target != root and not target.is_relative_to(root):
        raise ToolError(f"'{path}' is outside the workspace")
    if is_protected(target):
        raise ToolError(f"'{path}' is a protected file (credentials or keys) and cannot be accessed")
    if is_blocked(target):
        raise ToolError(f"'{path}' is private: the owner does not let the team open it")
    if must_exist and not target.exists():
        raise ToolError(f"'{path}' does not exist")
    return target


def is_protected(path: Path) -> bool:
    name = path.name.lower()
    return any(fnmatch.fnmatch(name, pattern) for pattern in PROTECTED_PATTERNS)


def rel(workspace: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(workspace.resolve()).as_posix() or "."
    except ValueError:
        return path.as_posix()


def truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... [truncated: {len(text) - limit} more characters]"
