"""Projects: isolated contexts for runs.

A project owns one workspace folder (never shared with or nested in another project's),
a brief given to every agent that runs in it, private paths no agent may open, and its own
secrets. Runs, events and approvals carry the project id, so nothing is mixed between projects.

The folder is either created by the platform inside an allowed workspace root, or an existing
folder anywhere on the computer chosen by the owner, except places that are never safe: a whole
drive, the user's home folder (or a folder containing it), system folders, and the platform's
own data folder (Claude sign-in, encrypted secrets, database).
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from sqlalchemy import func

from pae.db import AuditEntry, Database, Project, Run
from pae.tools.base import is_blocked, is_protected, set_blocked_paths

# The project's own instructions for Claude Code, which every Claude Code session in the folder reads first.
INSTRUCTION_FILES = ("CLAUDE.md", ".claude/CLAUDE.md")
INSTRUCTIONS_CHARS = 40_000


COMPOSE_FILES = ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml")
WATCH_PATTERNS_MAX = 20


def compose_file(workspace: str | Path) -> Path | None:
    """The project's Docker Compose file: the app the platform can watch (pae.watch)."""
    return next((Path(workspace) / n for n in COMPOSE_FILES if (Path(workspace) / n).is_file()), None)


# What tells a folder holds code: a Git repository, or a build or dependency file at its root or one folder down.
CODE_MARKERS = (
    "package.json", "pyproject.toml", "requirements.txt", "setup.py", "go.mod", "Cargo.toml", "pom.xml",
    "build.gradle", "build.gradle.kts", "composer.json", "Gemfile", "Makefile", "CMakeLists.txt", *COMPOSE_FILES,
)  # fmt: skip
DIRECT_MEMBER = "software-engineering"


def is_code_folder(workspace: str | Path) -> bool:
    root = Path(workspace)
    try:
        if (root / ".git").exists() or any((root / name).is_file() for name in CODE_MARKERS):
            return True
        folders = [d for d in sorted(root.iterdir())[:200] if d.is_dir() and not d.name.startswith(".")][:40]
        return any((folder / name).is_file() for folder in folders for name in CODE_MARKERS)
    except OSError:
        return False


def direct_member(workspace: str | Path) -> str | None:
    """Who takes a request in this project when the owner names nobody: in a code project the Software Engineer,
    alone and at once, as a Claude Code session would (no Coordinator, no plan). Elsewhere the Coordinator decides."""
    return DIRECT_MEMBER if is_code_folder(workspace) else None


def _pattern(value, where: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 300:
        raise ProjectError(f"{where}: a pattern is a regular expression of 1 to 300 characters")
    try:
        re.compile(value)
    except re.error as exc:
        raise ProjectError(f"{where}: invalid pattern '{value}': {exc}") from exc
    return value


def normalize_watch(current: dict, change: dict) -> dict:
    """Merge a change into a project's watch rules, checked:
    on (bool); alert / ignore (log-line patterns that alert, or never do); long_task (start and end
    patterns with a named group `id`, max_minutes, label): a task that starts and does not end in time alerts."""
    if not isinstance(change, dict):
        raise ProjectError("watch must be an object")
    unknown = set(change) - {"on", "alert", "ignore", "long_task"}
    if unknown:
        raise ProjectError(f"watch: unknown settings {sorted(unknown)}")
    merged = {**current, **{k: v for k, v in change.items() if v is not None}}
    if "on" in merged and not isinstance(merged["on"], bool):
        raise ProjectError("watch.on must be true or false")
    for key in ("alert", "ignore"):
        if key in merged:
            if not isinstance(merged[key], list) or len(merged[key]) > WATCH_PATTERNS_MAX:
                raise ProjectError(f"watch.{key}: a list of at most {WATCH_PATTERNS_MAX} patterns")
            merged[key] = [_pattern(p, f"watch.{key}") for p in merged[key]]
    task = merged.get("long_task")
    if task is not None and task != {}:
        if not isinstance(task, dict) or set(task) - {"start", "end", "max_minutes", "label"}:
            raise ProjectError("watch.long_task: {start, end, max_minutes, label}")
        for key in ("start", "end"):
            if "(?P<id>" not in _pattern(task.get(key), f"watch.long_task.{key}"):
                raise ProjectError(f"watch.long_task.{key} needs a named group (?P<id>...)")
        minutes = task.get("max_minutes", 60)
        if not isinstance(minutes, int) or not 5 <= minutes <= 1440:
            raise ProjectError("watch.long_task.max_minutes: 5 to 1440")
        label = str(task.get("label") or "task")[:40]
        merged["long_task"] = {"start": task["start"], "end": task["end"], "max_minutes": minutes, "label": label}
    return merged


def project_instructions(workspace: str | Path) -> str:
    """The folder's CLAUDE.md files, as Claude Code would load them (the platform does not load Claude Code
    settings, so they are read here). Private or protected files are left out."""
    parts = []
    for name in INSTRUCTION_FILES:
        path = Path(workspace) / name
        if not path.is_file() or is_blocked(path) or is_protected(path):
            continue
        text = path.read_text(encoding="utf-8", errors="replace").strip()
        if len(text) > INSTRUCTIONS_CHARS:
            text = text[:INSTRUCTIONS_CHARS] + "\n... [the rest is not shown]"
        if text:
            parts.append(f"## The project's {name} (its instructions for Claude Code)\n{text}")
    return "\n\n".join(parts)


SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}$")
ACTIVE = ("queued", "running", "waiting_approval")


class ProjectError(ValueError):
    pass


class ProjectConflict(ProjectError):
    pass


def system_folders() -> list[Path]:
    if os.name == "nt":
        names = ("SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData")
        return [Path(os.environ[n]).resolve() for n in names if os.environ.get(n)]
    names = ("/bin", "/boot", "/dev", "/etc", "/lib", "/proc", "/sbin", "/sys", "/usr", "/var", "/System")
    return [Path(p) for p in names]


def unsafe_folder(folder: Path, protected: list[Path]) -> str | None:
    """Why an existing folder outside the workspace roots cannot be a project folder, or None."""
    if folder.parent == folder:
        return "a whole drive cannot be a project folder: choose the project's own folder"
    home = Path.home().resolve()
    if folder == home or home.is_relative_to(folder):
        return "your user folder, or a folder containing it, cannot be a project folder"
    for system in system_folders():
        if folder == system or folder.is_relative_to(system):
            return "a system folder cannot be a project folder"
    for own in protected:
        if folder == own or folder.is_relative_to(own) or own.is_relative_to(folder):
            return "this folder holds the platform's own data (your Claude sign-in and passwords)"
    return None


def normalize_private(paths: list[str] | None) -> list[str]:
    """Relative paths inside the project folder ("backups", "data/raw/"), cleaned and checked."""
    out: list[str] = []
    for raw in paths or []:
        text = str(raw).strip().replace("\\", "/")
        while text.startswith("./"):
            text = text[2:]
        text = text.strip("/")
        if not text:
            continue
        if Path(text).is_absolute() or re.match(r"^[A-Za-z]:", text) or ".." in text.split("/"):
            raise ProjectError(f"private paths are written relative to the project folder, without '..': '{raw}'")
        if text not in out:
            out.append(text)
    if len(out) > 50:
        raise ProjectError("at most 50 private paths")
    return out


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60]
    return slug if len(slug) >= 2 else f"project-{slug or 'x'}"


MEMORY_INDEX = "MEMORY.md"
MEMORY_INDEX_CHARS = 25_000  # Claude Code itself only loads the start of a long index


def claude_memory_folder(workspace: str | Path, claude_home: Path) -> Path | None:
    """The memory Claude Code keeps for this folder (<claude home>/projects/<folder as slug>/memory),
    when the owner already worked on it with Claude Code. Read-only for the platform."""
    base = claude_home / "projects"
    slug = re.sub(r"[^A-Za-z0-9]", "-", str(Path(workspace)))
    candidates = [base / slug]
    if base.is_dir() and not candidates[0].is_dir():  # Windows paths are case-insensitive
        candidates += [d for d in base.iterdir() if d.name.lower() == slug.lower()]
    for folder in candidates:
        memory = folder / "memory"
        if (memory / MEMORY_INDEX).is_file():
            return memory
    return None


class ProjectService:
    def __init__(
        self,
        db: Database,
        roots_getter,
        protected_dirs: list[Path] | None = None,
        claude_home: Path | None = None,
    ) -> None:
        self.db = db
        self.roots = roots_getter  # callable -> list[Path] of allowed workspace roots
        self.protected = [Path(p).resolve() for p in (protected_dirs or [])]
        # The owner's own Claude Code home, read only for each project's memory notes.
        self.claude_home = claude_home or Path.home() / ".claude"
        self.refresh_blocked()

    def refresh_blocked(self) -> None:
        """Tell the file tools which paths are private, across all projects."""
        with self.db.session() as session:
            rows = session.query(Project.workspace, Project.private_paths).all()
        set_blocked_paths([Path(folder) / rel for folder, private in rows for rel in (private or [])])

    def _inside_roots(self, folder: Path) -> bool:
        return any(folder == root or folder.is_relative_to(root) for root in self.roots())

    # ------------------------------------------------------------ queries

    def _stats(self, session, project_id: str) -> dict:
        query = session.query(Run).filter(Run.project_id == project_id, Run.parent_run_id.is_(None))
        last = session.query(func.max(Run.created_at)).filter(Run.project_id == project_id).scalar()
        return {
            "runs": query.count(),
            "active": query.filter(Run.status.in_(ACTIVE)).count(),
            "last_run_at": last.isoformat() if last else None,
        }

    def _dict(self, session, project: Project) -> dict:
        return {
            "id": project.id,
            "name": project.name,
            "description": project.description,
            "workspace": project.workspace,
            "context": project.context,
            "tags": project.tags or [],
            "private_paths": project.private_paths or [],
            "trust_edits": bool(project.trust_edits),
            "watch": {
                "on": bool((project.watch or {}).get("on")),
                "available": compose_file(project.workspace) is not None,
            },
            "direct_member": direct_member(project.workspace),
            "external": not self._inside_roots(Path(project.workspace)),
            "claude_memory": self._memory_summary(project.workspace),
            "archived": project.archived,
            "created_at": project.created_at.isoformat(),
            "updated_at": project.updated_at.isoformat(),
            "stats": self._stats(session, project.id),
        }

    def list(self, include_archived: bool = False) -> list[dict]:
        with self.db.session() as session:
            query = session.query(Project)
            if not include_archived:
                query = query.filter(Project.archived.is_(False))
            return [self._dict(session, p) for p in query.order_by(Project.name)]

    def get(self, project_id: str) -> dict | None:
        with self.db.session() as session:
            project = session.get(Project, project_id)
            return self._dict(session, project) if project else None

    def require_active(self, project_id: str) -> dict:
        project = self.get(project_id)
        if project is None:
            raise ProjectError(f"project '{project_id}' does not exist")
        if project["archived"]:
            raise ProjectError(f"project '{project_id}' is archived")
        return project

    # ------------------------------------------------------------ changes

    def _check_workspace(self, workspace: Path, exclude: str | None = None) -> None:
        roots = self.roots()
        if any(workspace == root for root in roots):
            raise ProjectError("a project's workspace must be a folder inside a workspace root, not the root itself")
        if not self._inside_roots(workspace):
            problem = unsafe_folder(workspace, self.protected)
            if problem:
                raise ProjectError(problem)
            if not workspace.is_dir():
                raise ProjectError(f"'{workspace}' does not exist: choose an existing folder on this computer")
        with self.db.session() as session:
            for other in session.query(Project).filter(Project.id != (exclude or "")):
                existing = Path(other.workspace)
                if workspace == existing or workspace.is_relative_to(existing) or existing.is_relative_to(workspace):
                    raise ProjectConflict(f"workspace overlaps project '{other.id}' ({other.workspace})")

    def create(
        self,
        *,
        name: str,
        actor: str,
        description: str = "",
        workspace: str | None = None,
        context: str = "",
        tags: list[str] | None = None,
        project_id: str | None = None,
        private_paths: list[str] | None = None,
    ) -> dict:
        name = (name or "").strip()
        if not 2 <= len(name) <= 120:
            raise ProjectError("name must be 2 to 120 characters")
        base = project_id or slugify(name)
        if not SLUG.match(base):
            raise ProjectError("project id must be lowercase letters, digits and dashes")
        with self.db.session() as session:
            candidate, n = base, 2
            while session.get(Project, candidate) is not None:
                if project_id:
                    raise ProjectConflict(f"project '{project_id}' already exists")
                candidate, n = f"{base}-{n}", n + 1
        roots = self.roots()
        if not roots:
            raise ProjectError("no workspace root is configured")
        path = Path(workspace).expanduser().resolve() if workspace else (roots[0] / candidate).resolve()
        self._check_workspace(path)
        private = normalize_private(private_paths)
        if self._inside_roots(path):
            path.mkdir(parents=True, exist_ok=True)
        with self.db.session() as session:
            project = Project(
                id=candidate,
                name=name,
                description=description or "",
                workspace=str(path),
                context=context or "",
                tags=list(tags or []),
                private_paths=private,
                archived=False,
            )
            session.add(project)
            session.add(
                AuditEntry(actor=actor, action="project.create", target=candidate, details={"workspace": str(path)})
            )
            session.flush()
            result = self._dict(session, project)
        self.refresh_blocked()
        return result

    def update(self, project_id: str, changes: dict, actor: str) -> dict:
        allowed = {"name", "description", "context", "tags", "archived", "private_paths", "trust_edits", "watch"}
        unknown = set(changes) - allowed
        if unknown:
            raise ProjectError(f"cannot change: {sorted(unknown)} (a project's workspace is fixed)")
        with self.db.session() as session:
            project = session.get(Project, project_id)
            if project is None:
                raise KeyError(project_id)
            for key, value in changes.items():
                if value is None:
                    continue
                if key == "private_paths":
                    value = normalize_private(value)
                elif key == "watch":
                    value = normalize_watch(project.watch or {}, value)
                    if value.get("on") and compose_file(project.workspace) is None:
                        raise ProjectError("this project's folder has no docker-compose file: there is no app to watch")
                setattr(project, key, value)
            session.add(
                AuditEntry(actor=actor, action="project.update", target=project_id, details={"fields": sorted(changes)})
            )
            session.flush()
            result = self._dict(session, project)
        self.refresh_blocked()
        return result

    def delete(self, project_id: str, actor: str) -> None:
        with self.db.session() as session:
            project = session.get(Project, project_id)
            if project is None:
                raise KeyError(project_id)
            if session.query(Run).filter(Run.project_id == project_id).count():
                raise ProjectConflict("the project has runs: archive it instead of deleting it")
            session.delete(project)
            session.add(AuditEntry(actor=actor, action="project.delete", target=project_id, details={}))
        self.refresh_blocked()

    def watched(self) -> list[dict]:
        """Active projects whose running app the platform watches, with their full watch rules."""
        with self.db.session() as session:
            rows = session.query(Project).filter(Project.archived.is_(False)).order_by(Project.name).all()
            return [
                {"id": p.id, "name": p.name, "workspace": p.workspace, "watch": dict(p.watch or {})}
                for p in rows
                if (p.watch or {}).get("on") and compose_file(p.workspace) is not None
            ]

    def trusts_edits(self, project_id: str | None) -> bool:
        if not project_id:
            return False
        with self.db.session() as session:
            project = session.get(Project, project_id)
            return bool(project and project.trust_edits)

    # ------------------------------------------------------------ Claude Code memory

    def memory_folder(self, project_id: str | None) -> Path | None:
        if not project_id:
            return None
        with self.db.session() as session:
            project = session.get(Project, project_id)
            workspace = project.workspace if project else None
        return claude_memory_folder(workspace, self.claude_home) if workspace else None

    def _memory_summary(self, workspace: str) -> dict | None:
        folder = claude_memory_folder(workspace, self.claude_home)
        if folder is None:
            return None
        notes = [p for p in folder.glob("*.md") if p.name != MEMORY_INDEX]
        return {"notes": len(notes), "folder": str(folder)}

    def context(self, project_id: str | None) -> str:
        """The owner's notes, then the index of Claude Code's memory for the folder (as a new
        Claude Code session would load it); single notes open with project_memory_read."""
        if not project_id:
            return ""
        with self.db.session() as session:
            project = session.get(Project, project_id)
            if project is None:
                return ""
            notes, workspace = project.context or "", project.workspace
        instructions = project_instructions(workspace)
        if instructions:
            notes = f"{notes.strip()}\n\n{instructions}" if notes.strip() else instructions
        folder = claude_memory_folder(workspace, self.claude_home)
        if folder is None:
            return notes
        index = (folder / MEMORY_INDEX).read_text(encoding="utf-8", errors="replace").strip()
        if len(index) > MEMORY_INDEX_CHARS:
            index = index[:MEMORY_INDEX_CHARS] + "\n... [the rest of the index is not shown]"
        memory = (
            "## Claude Code's memory for this folder\n"
            "The owner already worked on this project with Claude Code. These are its memory notes: the owner's "
            "rules, decisions and facts learned so far. Follow them. Before working on a subject, open the notes "
            "that concern it with project_memory_read (the file name in parentheses).\n\n" + index
        )
        return f"{notes.strip()}\n\n{memory}" if notes.strip() else memory
