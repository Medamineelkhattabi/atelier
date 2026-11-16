"""Project bootstrap: copy selected capability templates into a new project.

Each capability is a folder under templates/. Text files are rendered with
{{project_name}} and {{package_name}}. JSON files written by several capabilities
in the same init (e.g. .claude/settings.json) are deep-merged. Existing files are
never overwritten unless `force` is set.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from pae.config import REPO_ROOT

TEMPLATES = REPO_ROOT / "templates"
TEXT_SUFFIXES = {
    ".md",
    ".txt",
    ".toml",
    ".json",
    ".yaml",
    ".yml",
    ".py",
    ".ts",
    ".js",
    ".cfg",
    ".ini",
    ".gitignore",
    ".gitattributes",
    ".editorconfig",
    ".dockerignore",
    "",
}

CAPABILITIES: dict[str, dict] = {
    "base": {
        "description": "README, .gitignore, .gitattributes, .editorconfig, decision record template",
        "requires": [],
    },
    "claude": {
        "description": "CLAUDE.md project instructions and a .claude/settings.json permission baseline",
        "requires": [],
    },
    "claude-agents": {
        "description": "Claude Code subagents: read-only code reviewer, test runner",
        "requires": ["claude"],
    },
    "claude-skills": {
        "description": "Claude Code skills: architecture decision record, pre-merge review",
        "requires": ["claude"],
    },
    "hooks": {
        "description": "PreToolUse guard hook (blocks secret reads and destructive commands), with tests",
        "requires": ["claude"],
    },
    "python": {
        "description": "Python package skeleton: pyproject (ruff, pytest), src layout, smoke test",
        "requires": ["base"],
    },
    "typescript": {"description": "TypeScript skeleton: strict tsconfig, vitest, smoke test", "requires": ["base"]},
    "ci": {"description": "GitHub Actions workflow running lint and tests", "requires": ["base"]},
    "docker": {"description": "Dockerfile, compose.yaml and .dockerignore for a Python service", "requires": ["base"]},
    "platform": {
        "description": ".mcp.json connecting Claude Code to the platform's agents (pae mcp-serve)",
        "requires": ["claude"],
    },
    "docs": {"description": "Architecture and runbook documentation templates", "requires": ["base"]},
}


class ConflictError(FileExistsError):
    """Files that already exist; nothing was written."""

    def __init__(self, conflicts: list[str]) -> None:
        super().__init__(f"refusing to overwrite existing files: {', '.join(conflicts)}")
        self.conflicts = conflicts


def resolve(capabilities: list[str]) -> list[str]:
    ordered: list[str] = []

    def add(name: str) -> None:
        if name not in CAPABILITIES:
            raise ValueError(f"unknown capability '{name}' (available: {', '.join(CAPABILITIES)})")
        for dependency in CAPABILITIES[name]["requires"]:
            add(dependency)
        if name not in ordered:
            ordered.append(name)

    for name in capabilities or ["base"]:
        add(name)
    return ordered


def package_name(project: str) -> str:
    name = re.sub(r"[^a-z0-9_]", "_", project.lower()).strip("_") or "app"
    return name if not name[0].isdigit() else f"p_{name}"


def deep_merge(base, extra):
    if isinstance(base, dict) and isinstance(extra, dict):
        out = dict(base)
        for key, value in extra.items():
            out[key] = deep_merge(out[key], value) if key in out else value
        return out
    if isinstance(base, list) and isinstance(extra, list):
        return base + [item for item in extra if item not in base]
    return extra


def init_project(
    directory: str | Path,
    capabilities: list[str],
    *,
    name: str | None = None,
    force: bool = False,
    templates: Path = TEMPLATES,
) -> list[str]:
    target = Path(directory).expanduser().resolve()
    target.mkdir(parents=True, exist_ok=True)
    project = name or target.name
    values = {"project_name": project, "package_name": package_name(project)}
    written: dict[str, str] = {}
    planned: list[tuple[Path, Path]] = []
    for capability in resolve(capabilities):
        source = templates / capability
        if not source.is_dir():
            raise ValueError(f"template folder missing for '{capability}'")
        for path in sorted(p for p in source.rglob("*") if p.is_file()):
            relative = Path(render(str(path.relative_to(source)), values))
            planned.append((path, relative))
    conflicts = [rel.as_posix() for _, rel in planned if (target / rel).exists() and not force]
    if conflicts:
        raise ConflictError(sorted(set(conflicts)))
    for path, relative in planned:
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if path.suffix in TEXT_SUFFIXES or path.name.startswith("."):
            content = render(path.read_text(encoding="utf-8"), values)
            key = relative.as_posix()
            if key in written and relative.suffix == ".json":
                content = json.dumps(deep_merge(json.loads(written[key]), json.loads(content)), indent=2) + "\n"
            written[key] = content
            destination.write_text(content, encoding="utf-8", newline="\n")
        else:
            destination.write_bytes(path.read_bytes())
            written[relative.as_posix()] = ""
    return sorted(written)


def render(text: str, values: dict) -> str:
    return re.sub(r"\{\{(project_name|package_name)\}\}", lambda m: values[m.group(1)], text)
