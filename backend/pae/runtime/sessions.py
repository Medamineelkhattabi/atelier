"""Claude Code sessions that later work continues instead of starting cold.

Like the owner in Claude Code, a team member that comes back to a project picks up its own earlier
session: what it already read and decided is still there, so it does not explore the project again.
A run continues the most recent session of the same agent in the same folder, within its own task or
the earlier tasks it follows up (or its own session when an interrupted run is resumed). Sessions are
never shared between agents, and each continuation is a fork, so two steps never write to one session.
Transcripts live in the platform's own Claude Code home, never in the owner's ~/.claude.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path

from sqlalchemy import func

from pae.db import Run

SESSION_ID = re.compile(r"^[A-Za-z0-9-]{8,64}$")
FINISHED = ("completed", "failed", "cancelled", "interrupted")
FOLLOW_UP_DEPTH = 20


def transcript(config_dir: Path, session_id: str | None) -> Path | None:
    """The saved transcript of a session, or None when there is none (deleted, or never saved)."""
    if not session_id or not SESSION_ID.match(session_id):
        return None
    projects = config_dir / "projects"
    if not projects.is_dir():
        return None
    return next((p for p in projects.glob(f"*/{session_id}.jsonl") if p.is_file()), None)


def forget(config_dir: Path, session_ids) -> int:
    """Delete the transcripts of these sessions (and the files Claude Code keeps beside them)."""
    removed = 0
    for session_id in {s for s in session_ids if s}:
        path = transcript(config_dir, session_id)
        if path is None:
            continue
        path.unlink(missing_ok=True)
        shutil.rmtree(path.with_suffix(""), ignore_errors=True)
        removed += 1
    return removed


def related_roots(session, run: Run) -> list[str]:
    """This run's task, then the earlier tasks it follows up, nearest first."""
    roots = [run.root_run_id]
    current = session.get(Run, run.root_run_id)
    while current is not None and len(roots) < FOLLOW_UP_DEPTH:
        earlier_id = (current.options or {}).get("follow_up_of")
        earlier = session.get(Run, earlier_id) if earlier_id else None
        if earlier is None or earlier.root_run_id in roots:
            break
        roots.append(earlier.root_run_id)
        current = session.get(Run, earlier.root_run_id)
    return roots


def session_to_continue(session, run: Run, config_dir: Path) -> tuple[str, str] | None:
    """(session id, run id it comes from) for the session this run should continue, or None to start fresh."""
    if run.kind != "agent" or not run.agent_id:
        return None
    if transcript(config_dir, run.claude_session_id):  # an interrupted or failed run that is resumed
        return run.claude_session_id, run.id
    roots = related_roots(session, run)
    candidates = (
        session.query(Run)
        .filter(
            Run.root_run_id.in_(roots),
            Run.agent_id == run.agent_id,
            Run.workspace == run.workspace,
            Run.claude_session_id.is_not(None),
            Run.status.in_(FINISHED),
            Run.id != run.id,
        )
        .order_by(func.coalesce(Run.finished_at, Run.created_at).desc())
        .limit(10)
        .all()
    )
    by_root = sorted(candidates, key=lambda r: roots.index(r.root_run_id))  # stable: newest first within a task
    for candidate in by_root:
        if transcript(config_dir, candidate.claude_session_id):
            return candidate.claude_session_id, candidate.id
    return None
