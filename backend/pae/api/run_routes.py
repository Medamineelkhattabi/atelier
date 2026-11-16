from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select

from pae.api.deps import Auth, platform
from pae.db import Approval, AuditEntry, Run, RunEvent
from pae.runtime import security_review
from pae.runtime.manager import ACTIVE, SubmitError
from pae.runtime.sessions import forget as forget_sessions

router = APIRouter(prefix="/api", tags=["runs"])


def run_summary(run: Run) -> dict:
    duration = None
    if run.started_at and run.finished_at:
        duration = round((run.finished_at - run.started_at).total_seconds(), 2)
    return {
        "id": run.id,
        "project_id": run.project_id,
        "origin": run.origin,
        "kind": run.kind,
        "agent_id": run.agent_id,
        "team_id": run.team_id,
        "parent_run_id": run.parent_run_id,
        "root_run_id": run.root_run_id,
        "role": run.role,
        "status": run.status,
        "task": run.task,
        "provider": run.provider,
        "model": run.model,
        "agent_version": run.agent_version,
        "steps": run.steps,
        "tool_calls": run.tool_calls,
        "input_tokens": run.input_tokens,
        "output_tokens": run.output_tokens,
        "cost_usd": run.cost_usd,
        "error": run.error,
        "created_at": run.created_at.isoformat(),
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
        "duration_s": duration,
        "team_name": (run.options or {}).get("team", {}).get("name") if run.kind == "team" else None,
        "follow_up_of": (run.options or {}).get("follow_up_of"),
        "verdict": _verdict(run),
    }


def _verdict(run: Run) -> str | None:
    """What a finished security review decided: "pass", "pass_with_warnings" or "block"."""
    if run.agent_id != "security" or not isinstance(run.output, dict):
        return None
    verdict = run.output.get("verdict")
    return verdict if isinstance(verdict, str) else None


def run_detail(run: Run) -> dict:
    return {
        **run_summary(run),
        "input": run.input,
        "output": run.output,
        "output_text": run.output_text,
        "workspace": run.workspace,
        "limits": run.limits,
        "resumes": (run.options or {}).get("resumes", 0),
        "team": (run.options or {}).get("team"),
        "scripted": run.provider == "scripted" or (run.options or {}).get("tree", {}).get("provider") == "scripted",
    }


class RunRequest(BaseModel):
    task: str = Field(min_length=1, max_length=100_000)
    agent_id: str | None = None
    team: dict | None = None
    input: dict | None = None
    workspace: str | None = None
    project_id: str | None = None
    provider: str | None = None
    model: str | None = None
    limits: dict | None = None
    options: dict | None = Field(None, description="Advanced: {'provider_options': {'script': [...]}, 'tree': {...}}")


class FollowUpRequest(BaseModel):
    message: str = Field(min_length=1, max_length=20_000)
    provider: str | None = None
    options: dict | None = Field(None, description="Advanced: same as POST /api/runs")


FOLLOW_UP_RESULT_CHARS = 8000


def follow_up_task(message: str, earlier: Run) -> str:
    """The new instruction first, then only the earlier request and its result: no accumulated history."""
    from pae.runtime.gate import wrap_untrusted

    result = earlier.output if earlier.output is not None else (earlier.output_text or earlier.error or "(no result)")
    text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, indent=1, default=str)
    if len(text) > FOLLOW_UP_RESULT_CHARS:
        text = text[:FOLLOW_UP_RESULT_CHARS] + "\n... [shortened]"
    request = earlier.task.split("\n\n## ")[0].strip()
    return (
        f"{message.strip()}\n\n## Earlier task this continues\n"
        f"Earlier request: {request}\nIts result (status {earlier.status}):\n" + wrap_untrusted("earlier-result", text)
    )


@router.post("/runs/{run_id}/follow-up")
async def follow_up(run_id: str, body: FollowUpRequest, request: Request, identity: dict = Auth) -> dict:
    """Continue a finished task with a new instruction, as a new task in the same project."""
    plat = platform(request)
    with plat.db.session() as session:
        run = session.get(Run, run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run not found")
        root = session.get(Run, run.root_run_id) or run
        if root.status in ACTIVE:
            raise HTTPException(status_code=400, detail="this task is still running: wait for it to finish")
        task = follow_up_task(body.message, root)
        agent_id = root.agent_id if root.kind != "team" else "orchestrator"
        # What the owner asks after a security review ("fix it") goes to whoever made the change, who continues its
        # own session with the review's findings: the Security Engineer itself only reads.
        reviewed = session.get(Run, (root.options or {}).get("reviews_change_of") or "")
        if reviewed is not None and reviewed.agent_id:
            agent_id = reviewed.agent_id
        project_id, workspace, earlier_id = root.project_id, root.workspace, root.id
    try:
        new_id = await plat.manager.submit(
            task=task,
            agent_id=agent_id,
            project_id=project_id,
            workspace=None if project_id else workspace,
            provider=body.provider,
            options={**(body.options or {}), "follow_up_of": earlier_id},
            actor=identity["actor"],
        )
    except (SubmitError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"run_id": new_id, "follow_up_of": earlier_id}


@router.post("/runs")
async def create_run(body: RunRequest, request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    try:
        run_id = await plat.manager.submit(
            task=body.task,
            agent_id=body.agent_id,
            team=body.team,
            input=body.input,
            workspace=body.workspace,
            provider=body.provider,
            model=body.model,
            limits=body.limits,
            options=body.options,
            actor=identity["actor"],
            project_id=body.project_id,
        )
    except (SubmitError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"run_id": run_id}


@router.get("/runs")
def list_runs(
    request: Request,
    identity: dict = Auth,
    status: str | None = None,
    agent_id: str | None = None,
    q: str | None = None,
    kind: str | None = None,
    project_id: str | None = None,
    origin: str | None = None,
    root_only: bool = True,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> dict:
    plat = platform(request)
    query = select(Run)
    if root_only:
        query = query.where(Run.parent_run_id.is_(None))
    if status:
        query = query.where(Run.status.in_(status.split(",")))
    if agent_id:
        query = query.where(Run.agent_id == agent_id)
    if kind:
        query = query.where(Run.kind == kind)
    if project_id:
        query = query.where(Run.project_id == project_id)
    if origin:  # "owner": the owner's own work; "quality_check": runs started by evaluation suites
        query = query.where(Run.origin == origin)
    if q:
        like = f"%{q}%"
        query = query.where(or_(Run.task.ilike(like), Run.output_text.ilike(like), Run.error.ilike(like), Run.id == q))
    with plat.db.session() as session:
        total = session.execute(select(func.count()).select_from(query.subquery())).scalar()
        rows = session.execute(query.order_by(Run.created_at.desc()).limit(limit).offset(offset)).scalars().all()
        totals = tree_totals(session, [r.root_run_id for r in rows])
        return {"total": total, "items": [{**run_summary(r), "tree_totals": totals.get(r.root_run_id)} for r in rows]}


def tree_totals(session, root_ids: list[str]) -> dict[str, dict]:
    """Steps, tool calls, tokens and cost summed over every run of each tree."""
    if not root_ids:
        return {}
    rows = session.execute(
        select(
            Run.root_run_id,
            func.count(Run.id),
            func.sum(Run.steps),
            func.sum(Run.tool_calls),
            func.sum(Run.input_tokens),
            func.sum(Run.output_tokens),
            func.sum(Run.cost_usd),
        )
        .where(Run.root_run_id.in_(set(root_ids)))
        .group_by(Run.root_run_id)
    ).all()
    return {
        root: {
            "runs": n,
            "steps": steps or 0,
            "tool_calls": calls or 0,
            "input_tokens": tin or 0,
            "output_tokens": tout or 0,
            "cost_usd": round(cost or 0, 6),
        }
        for root, n, steps, calls, tin, tout, cost in rows
    }


@router.get("/runs/{run_id}")
def get_run(run_id: str, request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    with plat.db.session() as session:
        run = session.get(Run, run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run not found")
        tree = session.query(Run).filter(Run.root_run_id == run.root_run_id).order_by(Run.created_at).all()
        approvals = (
            session.query(Approval).filter(Approval.root_run_id == run.root_run_id).order_by(Approval.created_at).all()
        )
        totals = {
            "input_tokens": sum(r.input_tokens for r in tree),
            "output_tokens": sum(r.output_tokens for r in tree),
            "cost_usd": round(sum(r.cost_usd for r in tree), 6),
            "steps": sum(r.steps for r in tree),
            "tool_calls": sum(r.tool_calls for r in tree),
            "runs": len(tree),
        }
        return {
            "run": {**run_detail(run), "paused": plat.manager.is_paused(run.root_run_id)},
            "tree": [run_summary(r) for r in tree],
            "tree_totals": totals,
            "approvals": [approval_dict(a) for a in approvals],
            "security_review": security_review.review_state(
                session, session.get(Run, run.root_run_id) or run, bool(plat.settings.get("security.review_changes"))
            ),
        }


@router.get("/runs/{run_id}/events")
def run_events(run_id: str, request: Request, identity: dict = Auth, after: int = 0, tree: bool = True) -> dict:
    plat = platform(request)
    with plat.db.session() as session:
        run = session.get(Run, run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run not found")
        root = run.root_run_id
    events = (
        plat.manager.bus.history(root_run_id=root, after_id=after)
        if tree
        else plat.manager.bus.history(run_id=run_id, after_id=after)
    )
    return {"events": events}


def _sse(event: dict) -> str:
    return f"id: {event['id']}\ndata: {json.dumps(event, default=str)}\n\n"


async def _stream(request: Request, *, root_run_id: str | None, after: int):
    bus = platform(request).manager.bus
    subscription = bus.subscribe(root_run_id=root_run_id)
    try:
        last = after
        if root_run_id:
            for event in bus.history(root_run_id=root_run_id, after_id=after):
                last = event["id"]
                yield _sse(event)
        yield ": connected\n\n"
        while True:
            if await request.is_disconnected():
                break
            try:
                event = await asyncio.wait_for(subscription.queue.get(), timeout=15)
            except TimeoutError:
                yield ": keepalive\n\n"
                continue
            if event["id"] <= last:
                continue
            last = event["id"]
            yield _sse(event)
            if subscription.overflowed:
                break  # the browser reconnects with Last-Event-ID and replays from the database
    finally:
        bus.unsubscribe(subscription)


@router.get("/runs/{run_id}/stream")
async def stream_run(
    run_id: str, request: Request, identity: dict = Auth, last_event_id: str | None = Header(None), after: int = 0
) -> StreamingResponse:
    plat = platform(request)
    with plat.db.session() as session:
        run = session.get(Run, run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run not found")
        root = run.root_run_id
    start = int(last_event_id) if last_event_id and last_event_id.isdigit() else after
    return StreamingResponse(
        _stream(request, root_run_id=root, after=start),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/stream")
async def stream_all(request: Request, identity: dict = Auth) -> StreamingResponse:
    """Live feed of all new events (dashboard, approval badge). No replay."""
    return StreamingResponse(
        _stream(request, root_run_id=None, after=0),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: str, request: Request, identity: dict = Auth) -> dict:
    try:
        return {"status": await platform(request).manager.cancel(run_id, identity["actor"])}
    except SubmitError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/runs/{run_id}/resume")
async def resume_run(run_id: str, request: Request, identity: dict = Auth) -> dict:
    try:
        return {"status": await platform(request).manager.resume(run_id, identity["actor"])}
    except SubmitError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/runs/{run_id}")
def delete_run(run_id: str, request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    with plat.db.session() as session:
        run = session.get(Run, run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run not found")
        if run.parent_run_id:
            raise HTTPException(status_code=400, detail="delete the root run instead")
        if run.status in ACTIVE:
            raise HTTPException(status_code=400, detail="cancel the run before deleting it")
        sessions = [s for (s,) in session.query(Run.claude_session_id).filter(Run.root_run_id == run_id)]
        session.query(RunEvent).filter(RunEvent.root_run_id == run_id).delete(synchronize_session=False)
        session.query(Approval).filter(Approval.root_run_id == run_id).delete(synchronize_session=False)
        session.query(Run).filter(Run.root_run_id == run_id).delete(synchronize_session=False)
        session.add(AuditEntry(actor=identity["actor"], action="run.delete", target=run_id, details={}))
    forget_sessions(plat.manager.claude_config_dir(), sessions)  # a deleted task leaves no saved session behind
    return {"deleted": run_id}


def approval_dict(a: Approval) -> dict:
    return {
        "id": a.id,
        "run_id": a.run_id,
        "root_run_id": a.root_run_id,
        "agent_id": a.agent_id,
        "tool": a.tool,
        "tool_call_id": a.tool_call_id,
        "args": a.args,
        "risk": a.risk,
        "reason": a.reason,
        "status": a.status,
        "note": a.note,
        "created_at": a.created_at.isoformat(),
        "decided_at": a.decided_at.isoformat() if a.decided_at else None,
        "expires_at": a.expires_at.isoformat() if a.expires_at else None,
    }


@router.get("/approvals")
def list_approvals(
    request: Request,
    identity: dict = Auth,
    status: str = "pending",
    project_id: str | None = None,
    limit: int = Query(100, le=500),
) -> dict:
    plat = platform(request)
    with plat.db.session() as session:
        query = session.query(Approval)
        if status != "all":
            query = query.filter(Approval.status.in_(status.split(",")))
        if project_id:
            query = query.filter(Approval.run_id.in_(session.query(Run.id).filter(Run.project_id == project_id)))
        rows = query.order_by(Approval.created_at.desc()).limit(limit).all()
        wanted = {a.run_id for a in rows} | {a.root_run_id for a in rows}
        runs = {r.id: r for r in session.query(Run).filter(Run.id.in_(wanted))}
        return {
            "items": [
                {
                    **approval_dict(a),
                    "run_task": runs[a.run_id].task if a.run_id in runs else None,
                    # The owner's own request (the root task), for "For your task ..." in the UI.
                    "root_task": runs[a.root_run_id].task if a.root_run_id in runs else None,
                    "project_id": runs[a.run_id].project_id if a.run_id in runs else None,
                }
                for a in rows
            ]
        }


class Decision(BaseModel):
    approve: bool
    note: str | None = Field(None, max_length=2000)


@router.post("/approvals/{approval_id}/decision")
async def decide(approval_id: str, body: Decision, request: Request, identity: dict = Auth) -> dict:
    from pae.runtime.approvals import ApprovalError

    try:
        return await platform(request).manager.approvals.decide(approval_id, body.approve, body.note, identity["actor"])
    except ApprovalError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
