from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ValidationError
from sqlalchemy import case, func

from pae.agents import AgentDefinition, AgentRegistry
from pae.api.deps import Auth, platform
from pae.api.run_routes import run_summary
from pae.db import AuditEntry, Run

router = APIRouter(prefix="/api", tags=["agents"])


def agent_stats(plat) -> dict[str, dict]:
    with plat.db.session() as session:
        rows = (
            session.query(
                Run.agent_id,
                func.count(Run.id),
                func.sum(case((Run.status == "completed", 1), else_=0)),
                func.sum(case((Run.status == "failed", 1), else_=0)),
                func.sum(case((Run.status.in_(("running", "waiting_approval", "queued")), 1), else_=0)),
                func.max(Run.created_at),
                func.sum(Run.cost_usd),
            )
            .filter(Run.agent_id.isnot(None))
            .group_by(Run.agent_id)
            .all()
        )
    stats = {}
    for agent_id, total, completed, failed, active, last, cost in rows:
        finished = (completed or 0) + (failed or 0)
        stats[agent_id] = {
            "runs": total,
            "completed": completed or 0,
            "failed": failed or 0,
            "active": active or 0,
            "success_rate": round((completed or 0) / finished, 3) if finished else None,
            "last_run_at": last.isoformat() if last else None,
            "cost_usd": round(cost or 0, 6),
        }
    return stats


def agent_view(plat, definition: AgentDefinition, meta: dict, stats: dict | None = None) -> dict:
    tools = []
    for name in definition.tools:
        tool = plat.tools.get(name)
        tools.append(
            {
                "name": name,
                "available": tool is not None,
                "risk": tool.risk if tool else None,
                "permission": definition.permissions.get(name) or (tool.default_permission if tool else None),
                "description": tool.description if tool else "not available",
            }
        )
    provider = plat.providers.resolve(definition.provider) if definition.provider == "default" else definition.provider
    status = "disabled" if not meta["enabled"] else ("misconfigured" if meta["problems"] else "ready")
    return {
        **definition.model_dump(),
        "tools_detail": tools,
        "effective_provider": provider,
        "effective_model": definition.model or plat.providers.default_model(provider),
        "status": status,
        **meta,
        "stats": stats or {},
    }


@router.get("/agents")
def list_agents(request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    stats = agent_stats(plat)
    return {
        "items": [agent_view(plat, d, m, stats.get(d.id)) for d, m in plat.registry.list()],
        "load_errors": plat.registry.load_errors,
    }


@router.get("/agents/{agent_id}")
def get_agent(agent_id: str, request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    found = plat.registry.get(agent_id)
    if found is None:
        raise HTTPException(status_code=404, detail="agent not found")
    definition, meta = found
    with plat.db.session() as session:
        runs = session.query(Run).filter(Run.agent_id == agent_id).order_by(Run.created_at.desc()).limit(25).all()
        recent = [run_summary(r) for r in runs]
    return {
        "agent": agent_view(plat, definition, meta, agent_stats(plat).get(agent_id)),
        "recent_runs": recent,
        "toml": AgentRegistry.to_toml(definition),
    }


class AgentPatch(BaseModel):
    enabled: bool | None = None
    overrides: dict | None = None


@router.patch("/agents/{agent_id}")
def patch_agent(agent_id: str, body: AgentPatch, request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    try:
        if body.enabled is not None:
            plat.registry.set_enabled(agent_id, body.enabled)
        if body.overrides:
            plat.registry.update_overrides(agent_id, body.overrides)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="agent not found") from exc
    except (ValueError, ValidationError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _audit(plat, identity, "agent.update", agent_id, body.model_dump(exclude_none=True))
    return get_agent(agent_id, request, identity)


@router.post("/agents/{agent_id}/reset")
def reset_agent(agent_id: str, request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    try:
        plat.registry.reset_overrides(agent_id)
    except KeyError as exc:
        raise HTTPException(status_code=400, detail="only file-defined agents have overrides to reset") from exc
    _audit(plat, identity, "agent.reset", agent_id, {})
    return get_agent(agent_id, request, identity)


@router.post("/agents")
def create_agent(body: dict, request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    try:
        definition = plat.registry.save_custom(body, create=True)
    except (ValueError, ValidationError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _audit(plat, identity, "agent.create", definition.id, {})
    return get_agent(definition.id, request, identity)


@router.put("/agents/{agent_id}")
def update_agent(agent_id: str, body: dict, request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    if body.get("id", agent_id) != agent_id:
        raise HTTPException(status_code=400, detail="the id cannot change")
    try:
        plat.registry.save_custom({**body, "id": agent_id}, create=False)
    except KeyError as exc:
        raise HTTPException(status_code=400, detail="only custom agents can be replaced; use PATCH overrides") from exc
    except (ValueError, ValidationError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _audit(plat, identity, "agent.replace", agent_id, {})
    return get_agent(agent_id, request, identity)


@router.delete("/agents/{agent_id}")
def delete_agent(agent_id: str, request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    try:
        plat.registry.delete_custom(agent_id)
    except KeyError as exc:
        raise HTTPException(status_code=400, detail="only custom agents can be deleted") from exc
    _audit(plat, identity, "agent.delete", agent_id, {})
    return {"deleted": agent_id}


@router.post("/agents/reload")
def reload_agents(request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    plat.registry.reload()
    _audit(plat, identity, "agents.reload", None, {})
    return {"agents": len(plat.registry.list()), "load_errors": plat.registry.load_errors}


@router.get("/teams")
def list_teams(request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    return {"items": [{**t.model_dump(), **m} for t, m in plat.registry.list_teams()]}


@router.post("/teams")
def save_team(body: dict, request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    try:
        team = plat.registry.save_team(body)
    except (ValueError, ValidationError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _audit(plat, identity, "team.save", team.id, {})
    return team.model_dump()


@router.delete("/teams/{team_id}")
def delete_team(team_id: str, request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    try:
        plat.registry.delete_team(team_id)
    except KeyError as exc:
        raise HTTPException(status_code=400, detail="only custom teams can be deleted") from exc
    _audit(plat, identity, "team.delete", team_id, {})
    return {"deleted": team_id}


def _audit(plat, identity: dict, action: str, target: str | None, details: dict) -> None:
    with plat.db.session() as session:
        session.add(
            AuditEntry(actor=identity["actor"], action=action, target=target, details=plat.redactor.obj(details))
        )
