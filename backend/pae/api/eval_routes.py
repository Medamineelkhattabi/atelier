from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from pae.api.agent_routes import _audit
from pae.api.deps import Auth, platform
from pae.db import EvalRun, utcnow
from pae.evals import EvalRunner, load_suites

router = APIRouter(prefix="/api", tags=["evals"])
log = logging.getLogger("pae.evals")
_background: set[asyncio.Task] = set()


def eval_dict(row: EvalRun, full: bool = False) -> dict:
    data = {
        "id": row.id,
        "suite": row.suite,
        "status": row.status,
        "provider": row.provider,
        "summary": row.summary,
        "started_at": row.started_at.isoformat(),
        "finished_at": row.finished_at.isoformat() if row.finished_at else None,
    }
    if full:
        data["results"] = row.results
    return data


@router.get("/evals")
def list_suites(request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    suites, errors = load_suites(plat.config.evals_dir)
    with plat.db.session() as session:
        latest = {}
        for row in session.query(EvalRun).order_by(EvalRun.started_at.desc()).limit(200):
            latest.setdefault(row.suite, eval_dict(row))
    return {
        "items": [
            {
                "id": s.id,
                "name": s.name,
                "description": s.description,
                "provider": s.provider,
                "live": s.live,
                "cases": [
                    {"id": c.id, "category": c.category, "agent": c.agent, "team": bool(c.team)} for c in s.cases
                ],
                "latest": latest.get(s.id),
            }
            for s in suites.values()
        ],
        "errors": errors,
    }


class EvalRequest(BaseModel):
    provider: str | None = None
    cases: list[str] | None = None


@router.post("/evals/{suite_id}/run")
async def run_suite(suite_id: str, body: EvalRequest, request: Request, identity: dict = Auth) -> dict:
    plat = platform(request)
    suites, _ = load_suites(plat.config.evals_dir)
    suite = suites.get(suite_id)
    if suite is None:
        raise HTTPException(status_code=404, detail="suite not found")
    with plat.db.session() as session:
        row = EvalRun(suite=suite.id, status="running", provider=body.provider or suite.provider)
        session.add(row)
        session.flush()
        eval_id = row.id
    _audit(plat, identity, "eval.run", suite_id, {"provider": body.provider, "cases": body.cases})

    async def job() -> None:
        try:
            await EvalRunner(plat).run_suite(suite, provider=body.provider, case_ids=body.cases, eval_run_id=eval_id)
        except Exception as exc:
            log.exception("eval %s failed", eval_id)
            with plat.db.session() as session:
                failed = session.get(EvalRun, eval_id)
                failed.status, failed.finished_at = "failed", utcnow()
                failed.summary = {**(failed.summary or {}), "error": str(exc)}

    task = asyncio.create_task(job())
    _background.add(task)
    task.add_done_callback(_background.discard)
    return {"eval_run_id": eval_id}


@router.get("/eval-runs")
def list_eval_runs(request: Request, identity: dict = Auth, suite: str | None = None) -> dict:
    with platform(request).db.session() as session:
        query = session.query(EvalRun)
        if suite:
            query = query.filter(EvalRun.suite == suite)
        return {"items": [eval_dict(r) for r in query.order_by(EvalRun.started_at.desc()).limit(100)]}


@router.get("/eval-runs/{eval_id}")
def get_eval_run(eval_id: str, request: Request, identity: dict = Auth) -> dict:
    with platform(request).db.session() as session:
        row = session.get(EvalRun, eval_id)
        if row is None:
            raise HTTPException(status_code=404, detail="eval run not found")
        return eval_dict(row, full=True)
