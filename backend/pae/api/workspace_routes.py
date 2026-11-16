"""Agent Workspace and Projects API."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from pae.api.agent_routes import _audit
from pae.api.deps import Auth, platform
from pae.db import Approval, Run, RunEvent
from pae.projects import ProjectConflict, ProjectError
from pae.runtime.graph import ROOT_OVER, build_graph
from pae.runtime.manager import SubmitError

router = APIRouter(prefix="/api", tags=["workspace"])


def agent_names(plat) -> dict[str, dict]:
    return {
        d.id: {"name": d.name, "responsibility": d.responsibility or d.description} for d, _ in plat.registry.list()
    }


# ------------------------------------------------------------ execution graph


@router.get("/runs/{run_id}/graph")
def run_graph(run_id: str, request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    with plat.db.session() as session:
        run = session.get(Run, run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run not found")
        root = run.root_run_id
        return build_graph(session, root, agent_names(plat), paused=plat.manager.is_paused(root))


@router.get("/workspace/executions")
def executions(
    request: Request,
    identity: dict = Auth,
    project_id: str | None = None,
    status: str | None = None,
    origin: str | None = "owner",
    limit: int = Query(50, ge=1, le=200),
) -> dict:
    """Collaborative executions: team runs and runs that delegated at least once."""
    plat = platform(request)
    with plat.db.session() as session:
        delegating = select(Run.root_run_id).where(Run.parent_run_id.isnot(None)).distinct()
        query = (
            session.query(Run).filter(Run.parent_run_id.is_(None)).filter((Run.kind == "team") | Run.id.in_(delegating))
        )
        if project_id:
            query = query.filter(Run.project_id == project_id)
        if origin and origin != "all":
            query = query.filter(Run.origin == origin)
        if status:
            query = query.filter(Run.status.in_(status.split(",")))
        roots = query.order_by(Run.created_at.desc()).limit(limit).all()
        ids = [r.id for r in roots]
        agents_by_root: dict[str, set] = {i: set() for i in ids}
        for root_id, agent_id in session.query(Run.root_run_id, Run.agent_id).filter(Run.root_run_id.in_(ids)):
            if agent_id:
                agents_by_root[root_id].add(agent_id)
        # Each task's latest state, so resumed plans and retries are not counted twice.
        states: dict[str, dict[tuple, str]] = {i: {} for i in ids}
        for root_id, type_, data in (
            session.query(RunEvent.root_run_id, RunEvent.type, RunEvent.data)
            .filter(
                RunEvent.root_run_id.in_(ids),
                RunEvent.type.in_(
                    ("task.assigned", "task.started", "task.retry", "task.completed", "task.failed", "task.skipped")
                ),
            )
            .order_by(RunEvent.id)
        ):
            key = ((data or {}).get("plan_id"), (data or {}).get("task_id"))
            current = states[root_id].get(key)
            if type_ == "task.assigned":
                states[root_id].setdefault(key, "pending")
            elif type_ in ("task.started", "task.retry"):
                states[root_id][key] = "running"
            elif current != "completed" or type_ == "task.completed":
                states[root_id][key] = type_.split(".")[1]
        # Nothing runs in a task that is over, even when a step's last event is missing.
        over = {r.id for r in roots if r.status in ROOT_OVER}
        task_counts = {
            i: {
                "total": len(states[i]),
                **{s: sum(1 for v in states[i].values() if v == s) for s in ("completed", "failed", "skipped")},
                "running": 0 if i in over else sum(1 for v in states[i].values() if v == "running"),
            }
            for i in ids
        }
        pending = dict(
            session.query(Approval.root_run_id, func.count(Approval.id))
            .filter(Approval.root_run_id.in_(ids), Approval.status == "pending")
            .group_by(Approval.root_run_id)
        )
        active = dict(
            session.query(Run.root_run_id, func.count(Run.id))
            .filter(
                Run.root_run_id.in_(ids), Run.parent_run_id.isnot(None), Run.status.in_(("running", "waiting_approval"))
            )
            .group_by(Run.root_run_id)
        )
        items = []
        for r in roots:
            items.append(
                {
                    "run_id": r.id,
                    "title": r.task,
                    "kind": r.kind,
                    "agent_id": r.agent_id,
                    "team_name": (r.options or {}).get("team", {}).get("name") if r.kind == "team" else None,
                    "project_id": r.project_id,
                    "status": r.status,
                    "paused": plat.manager.is_paused(r.id),
                    "created_at": r.created_at.isoformat(),
                    "finished_at": r.finished_at.isoformat() if r.finished_at else None,
                    "agents": sorted(agents_by_root[r.id]),
                    "tasks": task_counts[r.id],
                    "active_runs": active.get(r.id, 0),
                    "pending_approvals": pending.get(r.id, 0),
                }
            )
        return {"items": items}


@router.post("/runs/{run_id}/pause")
async def pause_run(run_id: str, request: Request, identity: dict = Auth) -> dict:
    try:
        return {"paused": await platform(request).manager.pause(run_id, identity["actor"])}
    except SubmitError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/runs/{run_id}/unpause")
async def unpause_run(run_id: str, request: Request, identity: dict = Auth) -> dict:
    try:
        return {"paused": await platform(request).manager.unpause(run_id, identity["actor"])}
    except SubmitError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ------------------------------------------------------------ projects


class ProjectCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    id: str | None = Field(None, pattern=r"^[a-z0-9][a-z0-9-]{1,62}$")
    description: str = Field("", max_length=2000)
    workspace: str | None = None
    context: str = Field("", max_length=20_000)
    tags: list[str] = Field(default_factory=list, max_length=20)
    private_paths: list[str] = Field(default_factory=list, max_length=50)
    scaffold: list[str] = Field(default_factory=list)


class ProjectPatch(BaseModel):
    name: str | None = Field(None, min_length=2, max_length=120)
    description: str | None = Field(None, max_length=2000)
    context: str | None = Field(None, max_length=20_000)
    tags: list[str] | None = Field(None, max_length=20)
    private_paths: list[str] | None = Field(None, max_length=50)
    trust_edits: bool | None = None
    watch: dict | None = Field(
        None, description='{"on": true} watches the running app; see pae.projects.normalize_watch'
    )
    archived: bool | None = None


class ScaffoldBody(BaseModel):
    capabilities: list[str] = Field(min_length=1)
    force: bool = False


def _project_error(exc: Exception) -> HTTPException:
    if isinstance(exc, ProjectConflict):
        return HTTPException(status_code=409, detail=str(exc))
    return HTTPException(status_code=400, detail=str(exc))


@router.get("/projects")
def list_projects(request: Request, identity: dict = Auth, include_archived: bool = False) -> dict:
    return {"items": platform(request).projects.list(include_archived)}


def _scaffold(plat, project: dict, capabilities: list[str], force: bool) -> list[str]:
    from pathlib import Path

    from pae.bootstrap import ConflictError, init_project

    try:
        return init_project(
            Path(project["workspace"]),
            capabilities,
            name=project["name"],
            force=force,
            templates=plat.config.templates_dir,
        )
    except ConflictError as exc:
        raise HTTPException(status_code=409, detail={"message": str(exc), "conflicts": exc.conflicts}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/projects")
def create_project(body: ProjectCreate, request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    try:
        project = plat.projects.create(
            name=body.name,
            project_id=body.id,
            description=body.description,
            workspace=body.workspace,
            context=body.context,
            tags=body.tags,
            private_paths=body.private_paths,
            actor=identity["actor"],
        )
    except ProjectError as exc:
        raise _project_error(exc) from exc
    if body.scaffold:
        try:
            project["files"] = _scaffold(plat, project, body.scaffold, force=False)
        except HTTPException:
            # Nothing was written (conflicts are checked first) and the project has no runs:
            # remove it so a corrected retry does not create '<id>-2'. The folder is left as it was.
            plat.projects.delete(project["id"], identity["actor"])
            raise
    return project


@router.get("/projects/{project_id}")
def get_project(project_id: str, request: Request, identity: dict = Auth) -> dict:
    project = platform(request).projects.get(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return project


@router.patch("/projects/{project_id}")
def patch_project(project_id: str, body: ProjectPatch, request: Request, identity: dict = Auth) -> dict:
    try:
        return platform(request).projects.update(project_id, body.model_dump(exclude_none=True), identity["actor"])
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="project not found") from exc
    except ProjectError as exc:
        raise _project_error(exc) from exc


@router.delete("/projects/{project_id}")
def delete_project(project_id: str, request: Request, identity: dict = Auth) -> dict:
    try:
        platform(request).projects.delete(project_id, identity["actor"])
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="project not found") from exc
    except ProjectError as exc:
        raise _project_error(exc) from exc
    return {"deleted": project_id}


@router.post("/projects/{project_id}/scaffold")
def scaffold_project(project_id: str, body: ScaffoldBody, request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    project = plat.projects.get(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    files = _scaffold(plat, project, body.capabilities, body.force)
    _audit(plat, identity, "project.scaffold", project_id, {"capabilities": body.capabilities})
    return {"directory": project["workspace"], "files": files}
