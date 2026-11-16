"""Dashboard, tools, providers, settings, secrets, tokens, MCP, workspaces, audit, health."""

from __future__ import annotations

import shutil
import time
from datetime import timedelta
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import case, func

from pae.api.agent_routes import _audit
from pae.api.deps import Auth, platform
from pae.api.run_routes import run_summary
from pae.db import ApiToken, Approval, AuditEntry, Run, RunEvent, utcnow
from pae.engines import engines_problem
from pae.security import new_token, token_hash
from pae.settings_store import DEFAULTS
from pae.subscription import ALLOWED_PROVIDERS, POLICY

router = APIRouter(prefix="/api", tags=["admin"])


@router.get("/health")
def health(request: Request) -> dict:
    plat = platform(request)
    try:
        with plat.db.session() as session:
            session.execute(func.count(Run.id).select())
        database = "ok"
    except Exception as exc:  # health must report, not raise
        database = f"error: {type(exc).__name__}"
    return {"status": "ok" if database == "ok" else "degraded", "database": database, "version": plat.version}


@router.get("/system")
def system(request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    usage = shutil.disk_usage(plat.config.data_dir)
    return {
        "version": plat.version,
        "uptime_s": int(time.time() - plat.started_at),
        "active_runs": plat.manager.active_count(),
        "max_concurrent_runs": plat.settings.get("limits.max_concurrent_runs"),
        "data_dir": str(plat.config.data_dir),
        "disk_free_gb": round(usage.free / 1e9, 1),
        "providers": plat.providers.status(),
        "mcp": plat.mcp.status(),
        "agents_dir": str(plat.config.agents_dir),
        "agent_load_errors": plat.registry.load_errors,
    }


@router.get("/dashboard")
def dashboard(request: Request, identity: dict = Auth, days: int = 30) -> dict:
    plat = platform(request)
    since = utcnow() - timedelta(days=days)
    agents = plat.registry.list()
    with plat.db.session() as session:
        counts = dict(
            session.query(Run.status, func.count(Run.id)).filter(Run.parent_run_id.is_(None)).group_by(Run.status).all()
        )
        root_window = (
            session.query(
                func.count(Run.id),
                func.sum(case((Run.status == "completed", 1), else_=0)),
                func.sum(case((Run.status == "failed", 1), else_=0)),
            )
            .filter(Run.created_at >= since, Run.parent_run_id.is_(None))
            .one()
        )
        usage_window = (
            session.query(func.sum(Run.input_tokens), func.sum(Run.output_tokens), func.sum(Run.cost_usd))
            .filter(Run.created_at >= since)
            .one()
        )
        window = (*root_window, *usage_window)
        recent = session.query(Run).filter(Run.parent_run_id.is_(None)).order_by(Run.created_at.desc()).limit(8).all()
        activity = (
            session.query(RunEvent)
            .filter(
                RunEvent.type.in_(
                    (
                        "run.started",
                        "run.completed",
                        "run.failed",
                        "run.cancelled",
                        "approval.requested",
                        "approval.decided",
                        "delegation.started",
                        "run.interrupted",
                    )
                )
            )
            .order_by(RunEvent.id.desc())
            .limit(15)
            .all()
        )
        pending = session.query(func.count(Approval.id)).filter(Approval.status == "pending").scalar()
        running = session.query(func.count(Run.id)).filter(Run.status.in_(("running", "waiting_approval"))).scalar()
        per_day = (
            session.query(
                func.date(Run.created_at),
                func.count(Run.id),
                func.sum(case((Run.status == "completed", 1), else_=0)),
                func.sum(Run.cost_usd),
            )
            .filter(Run.created_at >= since, Run.parent_run_id.is_(None))
            .group_by(func.date(Run.created_at))
            .all()
        )
        total, completed, failed, tokens_in, tokens_out, cost = window
        finished = (completed or 0) + (failed or 0)
        return {
            "agents": {"total": len(agents), "enabled": sum(1 for _, m in agents if m["enabled"])},
            "runs": {"running": running, "by_status": counts},
            "window": {
                "days": days,
                "runs": total or 0,
                "completed": completed or 0,
                "failed": failed or 0,
                "success_rate": round((completed or 0) / finished, 3) if finished else None,
                "input_tokens": tokens_in or 0,
                "output_tokens": tokens_out or 0,
                "cost_usd": round(cost or 0, 4),
            },
            "per_day": [
                {"date": str(d), "runs": n, "completed": c or 0, "cost_usd": round(k or 0, 4)} for d, n, c, k in per_day
            ],
            "pending_approvals": pending,
            "recent_runs": [run_summary(r) for r in recent],
            "activity": [
                {
                    "id": e.id,
                    "run_id": e.run_id,
                    "type": e.type,
                    "source": e.source,
                    "ts": e.ts.isoformat(),
                    "data": e.data,
                }
                for e in activity
            ],
            "providers": plat.providers.status(),
            "mcp": plat.mcp.status(),
        }


@router.get("/tools")
def list_tools(request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    overrides = plat.settings.get("permissions.tools", {})
    users: dict[str, list[str]] = {}
    for definition, _ in plat.registry.list():
        for name in definition.tools:
            users.setdefault(name, []).append(definition.id)
    return {
        "items": [
            {**t.describe(), "global_permission": overrides.get(t.name), "used_by": users.get(t.name, [])}
            for t in plat.tools.all()
        ]
    }


class PermissionBody(BaseModel):
    permission: str | None = Field(None, pattern="^(allow|ask|deny)$")


@router.put("/tools/{name}/permission")
def set_tool_permission(name: str, body: PermissionBody, request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    if plat.tools.get(name) is None and not name.startswith("claude_code."):
        raise HTTPException(status_code=404, detail="tool not found")
    overrides = plat.settings.get("permissions.tools", {})
    if body.permission is None:
        overrides.pop(name, None)
    else:
        overrides[name] = body.permission
    plat.settings.set("permissions.tools", overrides)
    _audit(plat, identity, "tool.permission", name, {"permission": body.permission})
    return {"name": name, "global_permission": body.permission}


@router.get("/usage")
def usage(request: Request, identity: dict = Auth) -> dict:
    """Subscription usage state as last reported by Claude Code (no model call)."""
    return {"policy": POLICY, "block": platform(request).manager.usage_state()}


@router.post("/usage/clear")
def clear_usage(request: Request, identity: dict = Auth) -> dict:
    """Owner override once the plan's limit has reset earlier than reported."""
    plat = platform(request)
    plat.manager.clear_usage_block()
    _audit(plat, identity, "usage.clear", None, {})
    return {"block": None}


@router.get("/providers")
def providers(request: Request, identity: dict = Auth) -> dict:
    return {"items": platform(request).providers.status()}


@router.get("/engines")
def engines(request: Request, identity: dict = Auth) -> dict:
    """The agents a team member can run on: Claude Code, then every ACP agent, and whether each is installed."""
    return {"items": platform(request).providers.engines_status()}


@router.post("/providers/claude-code/sign-in")
def claude_sign_in(request: Request, identity: dict = Auth) -> dict:
    """Open Anthropic's Claude Code sign-in in a window on this computer (see pae/claude_signin.py)."""
    from pae.claude_signin import open_sign_in_window

    plat = platform(request)
    result = open_sign_in_window(plat.config)
    _audit(plat, identity, "provider.sign_in_window", "claude-code", {"opened": result["opened"]})
    return result


@router.get("/settings")
def get_settings(request: Request, identity: dict = Auth) -> dict:
    return {"values": platform(request).settings.all()}


_TYPES = {bool: (bool,), int: (int,), float: (int, float), str: (str,), list: (list,), dict: (dict,)}


@router.patch("/settings")
async def patch_settings(body: dict, request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    for key, value in body.items():
        if key not in DEFAULTS:
            raise HTTPException(status_code=400, detail=f"unknown setting '{key}'")
        default = DEFAULTS[key]
        if value is not None and default is not None:
            expected = _TYPES.get(type(default), (type(default),))
            if not isinstance(value, expected) or (isinstance(value, bool) and bool not in expected):
                raise HTTPException(status_code=400, detail=f"'{key}' must be {type(default).__name__}")
        if key == "providers.default" and value not in ALLOWED_PROVIDERS:
            raise HTTPException(status_code=400, detail="unknown provider")
        if key == "shell.sandbox" and value not in ("none", "docker"):
            raise HTTPException(status_code=400, detail="shell.sandbox must be none or docker")
        if key == "permissions.mode" and value not in ("ask", "auto", "all"):
            raise HTTPException(status_code=400, detail="permissions.mode must be ask, auto or all")
        if key == "owner.name" and (len(value or "") > 80 or "\n" in (value or "")):
            raise HTTPException(status_code=400, detail="owner.name: one line, at most 80 characters")
        if key == "engines.agents":
            problem = engines_problem(value or {})
            if problem:
                raise HTTPException(status_code=400, detail=f"engines.agents: {problem}")
        if key == "workspaces.roots":
            for path in value or []:
                if not Path(path).expanduser().is_dir():
                    raise HTTPException(status_code=400, detail=f"workspace root '{path}' does not exist")
    for key, value in body.items():
        plat.settings.set(key, value)
    _audit(plat, identity, "settings.update", None, {"keys": sorted(body)})
    if any(k.startswith("mcp.") for k in body):
        await plat.mcp.restart()
    return {"values": plat.settings.all()}


@router.get("/secrets")
def list_secrets(request: Request, identity: dict = Auth, project_id: str | None = None) -> dict:
    return {"items": platform(request).secrets.list(project_id)}


class SecretBody(BaseModel):
    value: str = Field(min_length=1, max_length=10_000)


@router.put("/secrets/{name}")
def put_secret(
    name: str, body: SecretBody, request: Request, identity: dict = Auth, project_id: str | None = None
) -> dict:
    plat = platform(request)
    if project_id and plat.projects.get(project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")
    try:
        return plat.secrets.set(name, body.value, identity["actor"], project_id=project_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/secrets/{name}")
def delete_secret(name: str, request: Request, identity: dict = Auth, project_id: str | None = None) -> dict:
    try:
        platform(request).secrets.delete(name, identity["actor"], project_id=project_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="secret not found") from exc
    return {"deleted": name}


@router.get("/tokens")
def list_tokens(request: Request, identity: dict = Auth) -> dict:
    with platform(request).db.session() as session:
        rows = session.query(ApiToken).order_by(ApiToken.created_at.desc()).all()
        return {
            "items": [
                {
                    "id": t.id,
                    "name": t.name,
                    "hint": t.hint,
                    "created_at": t.created_at.isoformat(),
                    "last_used_at": t.last_used_at.isoformat() if t.last_used_at else None,
                }
                for t in rows
            ]
        }


class TokenBody(BaseModel):
    name: str = Field(min_length=2, max_length=100)


@router.post("/tokens")
def create_token(body: TokenBody, request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    if identity["kind"] != "session":
        raise HTTPException(status_code=403, detail="tokens can only be created from the owner session")
    token = "pae_" + new_token(24)
    with plat.db.session() as session:
        session.add(ApiToken(name=body.name, token_hash=token_hash(token), hint=token[-4:]))
    plat.redactor.add(token)
    _audit(plat, identity, "token.create", body.name, {})
    return {"name": body.name, "token": token, "note": "Copy it now: it will not be shown again."}


@router.delete("/tokens/{token_id}")
def delete_token(token_id: str, request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    with plat.db.session() as session:
        row = session.get(ApiToken, token_id)
        if row is None:
            raise HTTPException(status_code=404, detail="token not found")
        session.delete(row)
    _audit(plat, identity, "token.delete", token_id, {})
    return {"deleted": token_id}


@router.get("/mcp")
def mcp_status(request: Request, identity: dict = Auth) -> dict:
    return {"items": platform(request).mcp.status()}


@router.post("/mcp/restart")
async def mcp_restart(request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    await plat.mcp.restart()
    return {"items": plat.mcp.status()}


@router.get("/workspaces")
def workspaces(request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    roots = plat.manager.workspace_roots()
    items = []
    for root in roots:
        if root.is_dir():
            children = sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith("."))[:100]
            items.append({"root": str(root), "directories": [str(c) for c in children]})
    return {"default": str(plat.config.default_workspace), "roots": items}


@router.get("/audit")
def audit(request: Request, identity: dict = Auth, limit: int = 200) -> dict:
    with platform(request).db.session() as session:
        rows = session.query(AuditEntry).order_by(AuditEntry.id.desc()).limit(min(limit, 1000)).all()
        return {
            "items": [
                {
                    "id": r.id,
                    "ts": r.ts.isoformat(),
                    "actor": r.actor,
                    "action": r.action,
                    "target": r.target,
                    "details": r.details,
                }
                for r in rows
            ]
        }


@router.get("/projects/capabilities")
def project_capabilities(request: Request, identity: dict = Auth) -> dict:
    from pae.bootstrap import CAPABILITIES

    return {"items": [{"name": k, **v} for k, v in CAPABILITIES.items()]}


class BootstrapBody(BaseModel):
    directory: str = Field(min_length=1)
    capabilities: list[str] = Field(min_length=1)
    name: str | None = None
    force: bool = False


@router.post("/projects/bootstrap")
def bootstrap_project(body: BootstrapBody, request: Request, identity: dict = Auth) -> dict:
    """Create a project from templates. Only inside the allowed workspace roots."""
    from pae.bootstrap import ConflictError, init_project

    plat = platform(request)
    target = Path(body.directory).expanduser().resolve()
    if not any(target == root or target.is_relative_to(root) for root in plat.manager.workspace_roots()):
        raise HTTPException(status_code=400, detail="the project directory must be inside an allowed workspace root")
    try:
        written = init_project(
            target, body.capabilities, name=body.name, force=body.force, templates=plat.config.templates_dir
        )
    except ConflictError as exc:
        raise HTTPException(status_code=409, detail={"message": str(exc), "conflicts": exc.conflicts}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _audit(plat, identity, "project.bootstrap", str(target), {"capabilities": body.capabilities})
    return {"directory": str(target), "files": written}


class PurgeBody(BaseModel):
    days: int | None = Field(None, ge=0, le=3650)


@router.post("/maintenance/purge")
def purge(body: PurgeBody, request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    removed = plat.purge_expired(body.days)
    _audit(plat, identity, "maintenance.purge", None, {"days": body.days, "removed": removed})
    return {"removed_runs": removed}
