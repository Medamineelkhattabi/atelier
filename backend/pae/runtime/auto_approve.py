"""The owner's auto-approve mode (setting "permissions.mode" = "auto"), like Claude Code's bypass mode.

Every action that would ask the owner runs at once, except the few that act beyond the project and that the
owner still confirms:
- deploying, or changing the running app's containers (`docker compose up/restart/stop...`), or showing their
  secrets (`docker inspect`, `docker compose config`);
- pushing code, publishing, reaching another machine (ssh, kubectl...), sending data out (POST requests, e-mail,
  webhooks, MCP services);
- changing this PC outside the project (global installs, scheduled tasks, registry);
- commands that name a path outside the project folder.
With "permissions.mode" = "all" (the owner's choice: approve everything), those exceptions run without asking too.
In both modes private folders and secret files stay closed: a command that names one is refused (nobody approves
one by one, so it must not run, and refusing at once lets the agent carry on another way). Nothing else that is
refused changes either: file tools outside the project, read-only tasks and the owner's own "deny" rules. The
owner's explicit "ask" rules (global or per agent) still ask.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from pae.tools.base import blocked_names, is_protected

AUTO_RULE = "auto-approve (owner's choice)"
EVERYTHING_RULE = "auto-approve everything (owner's choice)"
DOCKER_READS = {"ps", "logs", "ls", "images", "top", "version", "info", "events", "stats", "port", "history", "diff"}
DOCKER_SECRETS = {"inspect", "config"}
DOCKER_OPTIONS_WITH_VALUE = {"-f", "--file", "-p", "--project-name", "--project-directory", "--env-file", "--context",
                             "-c", "--host", "-H", "--profile"}  # fmt: skip
# Where a command starts: the beginning, after ; & | ( or a newline, after VAR=value prefixes.
CMD = r"(?:^|[;&|(\n]\s*)(?:\w+=\S*\s+)*"
PATTERNS = [
    (re.compile(CMD + r"git(?:\s+(?:-C|-c)\s+\S+|\s+--[\w-]+(?:=\S+)?)*\s+push\b", re.I),
     "pushes code to another place"),
    (re.compile(CMD + r"(?:(?:bash|sh|zsh|pwsh|powershell(?:\.exe)?|source|\.|make|npm|pnpm|yarn)\s+(?:run\s+)?"
                r"(?:-\S+\s+)*)?[\"']?[\w./\\:-]*deploy", re.I), "deploys"),
    (re.compile(CMD + r"(ssh|scp|sftp|rsync|kubectl|helm|terraform|ansible|ansible-playbook)\b", re.I),
     "reaches another machine"),
    (re.compile(CMD + r"((npm|pnpm|yarn)\s+publish|twine\s+upload|gh\s+(pr|release|repo|issue|api|gist|workflow))\b",
                re.I), "publishes"),
    (re.compile(CMD + r"(curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm)\b[^;&|\n]*?(\s-d\b|\s--data|\s-F\b"
                r"|\s--form|\s-T\b|\s--upload-file|\s-X\s*(post|put|patch|delete)\b|\s--post-(data|file)"
                r"|\s-method\s+(post|put|patch|delete)\b|\s-body\b)", re.I), "sends data outside"),
    (re.compile(CMD + r"((npm|pnpm|yarn)\s+(i|install|add)\b[^;&|\n]*\s(-g|--global)\b|winget\b|choco\b|scoop\b"
                r"|pip\d?(\.exe)?\s+install\b[^;&|\n]*\s--user\b|setx\b|reg(\.exe)?\s+(add|delete|import)\b"
                r"|schtasks\b|\S*scheduledtask|set-executionpolicy|shutdown\b)", re.I),
     "changes this PC outside the project"),
]  # fmt: skip
WORD_SPLIT = re.compile(r"[\s;&|()<>`]+")
# The current folder written as a variable: "$(pwd)/backend" is the project's backend, not "/backend".
CURRENT_FOLDER = re.compile(r"\$\(\s*pwd\s*\)|\$\{PWD\}|\$PWD\b|`pwd`")
CLOSED = ("touches a private folder", "touches a secret file")


def is_on(ctx) -> bool:
    # Quality checks verify the approval mechanism itself: they always run in "ask" mode.
    if (ctx.options or {}).get("quality_check"):
        return False
    return ctx.manager.settings.get("permissions.mode") in ("auto", "all")


def still_asks(command: str, workspace: Path) -> str | None:
    """Why this command still needs the owner in auto mode, or None when it can run."""
    for pattern, reason in PATTERNS:
        if pattern.search(command):
            return reason
    words = _words(command)
    return _docker_reason(words) or _closed_reason(words) or _outside_reason(words, workspace)


def closed_reason(command: str) -> str | None:
    """Why this command stays closed in both auto modes (it names a private folder or a secret file), or None."""
    return _closed_reason(_words(command))


def _words(command: str) -> list[str]:
    command = CURRENT_FOLDER.sub(".", command)
    return [w.strip("'\"") for w in WORD_SPLIT.split(command) if w.strip("'\"")]


def _docker_reason(words: list[str]) -> str | None:
    for i, word in enumerate(words):
        name = Path(word).name.lower().removesuffix(".exe")
        if name not in ("docker", "docker-compose"):
            continue
        rest = words[i + 1 :]
        if name == "docker" and rest[:1] == ["compose"]:
            rest = rest[1:]
        while rest and rest[0].startswith("-"):
            option = rest.pop(0)
            if option in DOCKER_OPTIONS_WITH_VALUE and rest:
                rest.pop(0)
        command = rest[0].lower() if rest else ""
        if command in ("container", "image", "volume", "network", "system") and len(rest) > 1:
            command = rest[1].lower()
        if command in DOCKER_SECRETS:
            return "shows the running app's secrets"
        if command and command not in DOCKER_READS:
            return "changes the running app"
    return None


def _path_words(words: list[str]) -> list[str]:
    return [w for w in words if not w.startswith("-") and w not in ("/dev/null", "NUL", "nul")]


def _closed_reason(words: list[str]) -> str | None:
    private = blocked_names()
    for word in _path_words(words):
        parts = [p for p in word.replace("\\", "/").split("/") if p]
        if any(os.path.normcase(p) in private for p in parts):
            return CLOSED[0]
        if is_protected(Path(word)):
            return CLOSED[1]
    return None


def _outside_reason(words: list[str], workspace: Path) -> str | None:
    root = workspace.resolve()
    for word in _path_words(words):
        parts = [p for p in word.replace("\\", "/").split("/") if p]
        looks_absolute = word.startswith(("/", "~")) or re.match(r"^[A-Za-z]:[\\/]", word)
        if looks_absolute or ".." in parts:
            target = _resolve(word, root)
            if target is None or not (target == root or target.is_relative_to(root)):
                return "reaches outside the project folder"
    return None


def _resolve(word: str, root: Path) -> Path | None:
    text = word
    match = re.match(r"^/([a-zA-Z])(/|$)", text)  # Git Bash: /c/Users -> C:/Users
    if os.name == "nt" and match:
        text = f"{match.group(1)}:/{text[3:]}"
    try:
        path = Path(os.path.expanduser(text))
        return (path if path.is_absolute() else root / path).resolve()
    except (OSError, ValueError):
        return None


def decide(ctx, decision: str, rule: str, tool: str, command: str | None = None, external: bool = False):
    """Apply auto mode to a permission decision: an "ask" becomes "allow" unless it is one of the exceptions."""
    if decision != "ask" or rule in ("global", "agent") or not is_on(ctx):
        return decision, rule
    closed = closed_reason(command) if command is not None else None
    if closed:
        return "deny", (
            f"it {closed}: the owner keeps private folders and secret files closed, even when actions are approved"
            " automatically. Work without it."
        )
    if ctx.manager.settings.get("permissions.mode") == "all":
        return "allow", EVERYTHING_RULE
    reason = "sends data outside" if external else None
    if reason is None and command is not None:
        reason = still_asks(command, Path(ctx.workspace))
    return ("ask", f"still asks in auto mode: it {reason}") if reason else ("allow", AUTO_RULE)
