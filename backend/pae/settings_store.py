"""Owner-editable settings, persisted in the database with typed defaults."""

from __future__ import annotations

import copy
import threading
from typing import Any

from pae.db import Database, SettingRecord

DEFAULTS: dict[str, Any] = {
    # Providers
    # AI access: the owner's Claude subscription through Claude Code, nothing else (pae.subscription).
    "providers.default": "claude-code",  # only "claude-code" (or "scripted" in tests) is accepted
    "providers.claude_code.default_model": None,  # None: your plan's default; or an alias like "sonnet"
    "providers.claude_code.cli_path": None,  # None: the Claude Code binary bundled with claude-agent-sdk
    # Other agents a team member can run on, through the Agent Client Protocol (pae.engines): the owner's own ones,
    # or another way to start a known one. {"<id>": {"name": "...", "command": "...", "args": ["..."]}}
    "engines.agents": {},
    # Execution limits (per run unless stated)
    # Sized for real coding work: one change in Claude Code easily takes 50-100 turns.
    "limits.max_steps": 150,  # turns of one team member's step
    "limits.timeout_s": 7200,  # a whole task: its steps share this time; waiting for the owner is not counted
    "limits.max_tokens": 2_000_000,  # new tokens per step; re-reading the context from cache is not counted
    "limits.max_cost_usd": 25.0,  # usage budget: Claude Code's API-equivalent estimate, not a charge
    "limits.max_output_tokens": 16000,
    "limits.max_concurrent_runs": 2,  # each run is a Claude Code session on your plan
    "limits.max_delegation_depth": 2,
    "limits.max_children_per_run": 8,
    "limits.max_parallel_members": 3,  # parallel team members running at the same time
    "limits.provider_retries": 3,
    "limits.approval_timeout_s": 3600,
    "limits.tool_output_chars": 100_000,
    # Permissions: tool name -> allow | ask | deny (global layer)
    "permissions.tools": {},
    # "ask": actions that need the owner wait for an approval. "auto": they run at once, like Claude Code's bypass
    # mode, except deploying, pushing, publishing, sending data out and leaving the project (pae.runtime.auto_approve).
    # "all": those exceptions too. Refusals (private paths, secrets, read-only tasks) never change.
    "permissions.mode": "ask",
    # The owner's name, so the team addresses the owner correctly (the Claude account may show another name).
    "owner.name": "",
    # Integrations
    "http.allowed_domains": [
        "docs.python.org",
        "*.wikipedia.org",
        "github.com",
        "raw.githubusercontent.com",
        "pypi.org",
        "developer.mozilla.org",
    ],
    "http.allow_private_network": False,
    "shell.sandbox": "none",  # none | docker
    "shell.docker_image": "python:3.12-slim",
    "email.smtp": {},
    "mcp.servers": [],  # [{name, command, args, env_secrets, enabled, permission}]
    "workspaces.roots": [],  # extra directories agents may use as workspaces
    # Watching the projects' running apps (pae.watch): the checks are free; only a real problem uses the plan.
    "watch.interval_s": 120,
    "watch.diagnose": True,  # a problem starts a read-only Debugger task that looks for the cause
    "watch.max_diagnoses_per_day": 4,
    "notifications.windows": True,  # alerts appear as Windows notifications on this PC
    # Every code change gets a read-only review by the Security Engineer (pae.runtime.security_review).
    "security.review_changes": True,
    # Logging and retention
    "retention.days": 90,
    "logging.store_tool_outputs": True,
}


class SettingsStore:
    def __init__(self, db: Database) -> None:
        self.db = db
        self._cache: dict[str, Any] = {}
        self._lock = threading.Lock()
        self.reload()

    def reload(self) -> None:
        with self.db.session() as session:
            rows = session.query(SettingRecord).all()
            values = {row.key: row.value for row in rows}
        with self._lock:
            self._cache = values

    def get(self, key: str, default: Any = None) -> Any:
        with self._lock:
            if key in self._cache:
                return copy.deepcopy(self._cache[key])
        if key in DEFAULTS:
            return copy.deepcopy(DEFAULTS[key])
        return default

    def set(self, key: str, value: Any) -> None:
        if key not in DEFAULTS:
            raise KeyError(f"unknown setting '{key}'")
        with self.db.session() as session:
            row = session.get(SettingRecord, key)
            if row is None:
                session.add(SettingRecord(key=key, value=value))
            else:
                row.value = value
        with self._lock:
            self._cache[key] = copy.deepcopy(value)

    def all(self) -> dict[str, Any]:
        return {key: self.get(key) for key in DEFAULTS}
