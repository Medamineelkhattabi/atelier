"""Process configuration, read once from environment variables.

Runtime-editable settings (providers, limits, permissions, retention) live in the
database and are managed through the API; this module only covers what must be
known before the database is open.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _path(name: str, default: Path) -> Path:
    value = os.environ.get(name)
    return Path(value).expanduser().resolve() if value else default


def _int(name: str, default: int) -> int:
    value = os.environ.get(name)
    return int(value) if value else default


def _bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Config:
    data_dir: Path
    database_url: str
    host: str
    port: int
    agents_dir: Path
    evals_dir: Path
    templates_dir: Path
    frontend_dist: Path
    workspace_roots: tuple[Path, ...]
    default_workspace: Path
    cookie_secure: bool
    session_ttl_hours: int
    setup_token: str | None
    claude_code_path: str | None
    log_level: str
    claude_config_dir: Path | None = None  # Claude Code home for platform sessions
    extra: dict = field(default_factory=dict)

    @property
    def key_file(self) -> Path:
        return self.data_dir / "secret.key"


def load_config() -> Config:
    data_dir = _path("PAE_DATA_DIR", Path.home() / ".pae")
    default_workspace = _path("PAE_DEFAULT_WORKSPACE", data_dir / "workspaces" / "default")
    roots_env = os.environ.get("PAE_WORKSPACE_ROOTS", "")
    roots = tuple(Path(p).expanduser().resolve() for p in roots_env.split(os.pathsep) if p.strip())
    if not roots:
        roots = (data_dir / "workspaces",)
    return Config(
        data_dir=data_dir,
        database_url=os.environ.get("PAE_DATABASE_URL", f"sqlite:///{(data_dir / 'pae.db').as_posix()}"),
        host=os.environ.get("PAE_HOST", "127.0.0.1"),
        port=_int("PAE_PORT", 8600),
        agents_dir=_path("PAE_AGENTS_DIR", REPO_ROOT / "agents"),
        evals_dir=_path("PAE_EVALS_DIR", REPO_ROOT / "evals"),
        templates_dir=_path("PAE_TEMPLATES_DIR", REPO_ROOT / "templates"),
        frontend_dist=_path("PAE_FRONTEND_DIST", REPO_ROOT / "frontend" / "dist"),
        workspace_roots=roots,
        default_workspace=default_workspace,
        cookie_secure=_bool("PAE_COOKIE_SECURE", False),
        session_ttl_hours=_int("PAE_SESSION_TTL_HOURS", 12),
        setup_token=os.environ.get("PAE_SETUP_TOKEN") or None,
        claude_code_path=os.environ.get("PAE_CLAUDE_CODE_PATH") or None,
        log_level=os.environ.get("PAE_LOG_LEVEL", "INFO"),
        claude_config_dir=_path("PAE_CLAUDE_CONFIG_DIR", data_dir / "claude-home"),
    )
