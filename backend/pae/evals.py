"""Evaluation suites: run cases through the real runtime and score them.

Deterministic assertions first (status, schema validity, tools used, output
content, files produced, steps, cost, approvals). A case may add a model-graded
rubric (`judge`), scored by the `evaluator` agent, for what assertions cannot check.
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import time
import tomllib
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from pae.db import EvalRun, Run, utcnow
from pae.runtime.native import validate_output


class Expect(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: str | None = "completed"
    output_valid: bool | None = None
    tools_called: list[str] = Field(default_factory=list)
    tools_not_called: list[str] = Field(default_factory=list)
    tools_completed: list[str] = Field(default_factory=list)
    output_contains: list[str] = Field(default_factory=list)
    output_not_contains: list[str] = Field(default_factory=list)
    output_paths: dict[str, Any] = Field(default_factory=dict)
    error_contains: str | None = None
    max_steps: int | None = None
    max_cost_usd: float | None = None
    approval_requested: list[str] = Field(default_factory=list)
    delegated_to: list[str] = Field(default_factory=list)
    file_exists: list[str] = Field(default_factory=list)
    file_absent: list[str] = Field(default_factory=list)
    file_contains: dict[str, str] = Field(default_factory=dict)
    judge: str | None = None


class Case(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    category: str = "task_completion"
    agent: str | None = None
    team: dict | None = None
    task: str
    input: dict | None = None
    files: dict[str, str] = Field(default_factory=dict)
    script: list[dict] | None = None
    scripts: dict[str, list[dict]] = Field(default_factory=dict)
    approvals: dict[str, str] = Field(default_factory=dict)  # tool -> approve|reject, "*" for default
    limits: dict | None = None
    expect: Expect = Field(default_factory=Expect)


class Suite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    name: str
    description: str = ""
    provider: str | None = None  # None: each agent's own provider
    live: bool = False  # true when cases call a real model (costs usage)
    cases: list[Case]


def load_suites(directory: Path) -> tuple[dict[str, Suite], dict[str, str]]:
    suites, errors = {}, {}
    for path in sorted(directory.glob("*.toml")) if directory.is_dir() else []:
        try:
            suite = Suite.model_validate(tomllib.loads(path.read_text(encoding="utf-8")))
            suites[suite.id] = suite
        except (tomllib.TOMLDecodeError, ValidationError) as exc:
            errors[path.name] = str(exc)
    return suites, errors


def get_path(value: Any, path: str) -> Any:
    for part in [p for p in re.split(r"[.\[\]]", path) if p]:
        if isinstance(value, list) and part.isdigit():
            value = value[int(part)] if int(part) < len(value) else None
        elif isinstance(value, dict):
            value = value.get(part)
        else:
            return None
    return value


def check_path(actual: Any, expected: Any) -> bool:
    if expected == "nonempty":
        return actual not in (None, "", [], {})
    if isinstance(expected, str) and expected.startswith("len>="):
        return isinstance(actual, list | str | dict) and len(actual) >= int(expected[5:])
    if isinstance(expected, str) and expected.startswith("~"):
        return isinstance(actual, str) and expected[1:].lower() in actual.lower()
    if isinstance(expected, int | float) and isinstance(actual, int | float):
        return abs(actual - expected) < 1e-6
    return actual == expected


class EvalRunner:
    def __init__(self, platform) -> None:
        self.platform = platform
        self.manager = platform.manager

    async def run_suite(
        self,
        suite: Suite,
        *,
        provider: str | None = None,
        case_ids: list[str] | None = None,
        eval_run_id: str | None = None,
    ) -> dict:
        provider = provider or suite.provider
        with self.platform.db.session() as session:
            record = session.get(EvalRun, eval_run_id) if eval_run_id else None
            if record is None:
                record = EvalRun(suite=suite.id, status="running", provider=provider)
                session.add(record)
                session.flush()
            eval_run_id = record.id
        cases = [c for c in suite.cases if not case_ids or c.id in case_ids]
        results = []
        for case in cases:
            results.append(await self.run_case(suite, case, provider, eval_run_id))
            with self.platform.db.session() as session:
                session.get(EvalRun, eval_run_id).results = results
        summary = summarize(results)
        with self.platform.db.session() as session:
            row = session.get(EvalRun, eval_run_id)
            row.status, row.summary, row.results, row.finished_at = "completed", summary, results, utcnow()
        return {"id": eval_run_id, "summary": summary, "results": results}

    async def run_case(self, suite: Suite, case: Case, provider: str | None, eval_run_id: str) -> dict:
        workspace = self.platform.config.workspace_roots[0] / "evals" / eval_run_id / case.id
        if workspace.exists():
            shutil.rmtree(workspace)
        workspace.mkdir(parents=True)
        for name, content in case.files.items():
            target = (workspace / name).resolve()
            if not target.is_relative_to(workspace.resolve()):
                raise ValueError(f"case file '{name}' escapes the workspace")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        options: dict = {"tree": {}}
        if case.script is not None:
            options["provider_options"] = {"script": case.script}
        if case.scripts:
            options["tree"]["scripts"] = case.scripts
        started = time.monotonic()
        # Subscribe before submitting: the first approval request can be emitted before
        # the approver task gets to run.
        subscription = self.manager.bus.subscribe()
        try:
            run_id = await self.manager.submit(
                task=case.task,
                agent_id=case.agent,
                team=case.team,
                input=case.input,
                workspace=str(workspace),
                provider=provider,
                limits=case.limits,
                options=options,
                actor=f"eval:{suite.id}",
            )
        except ValueError as exc:
            self.manager.bus.unsubscribe(subscription)
            return {
                "case": case.id,
                "category": case.category,
                "passed": False,
                "run_id": None,
                "checks": [{"name": "submit", "passed": False, "detail": str(exc)}],
                "duration_s": 0,
            }
        approver = asyncio.create_task(self._auto_approve(run_id, case.approvals, subscription))
        try:
            run = await self._wait(run_id)
        finally:
            approver.cancel()
        duration = round(time.monotonic() - started, 2)
        events = self.manager.bus.history(root_run_id=run_id)
        checks = await self.check(case, run, events, workspace)
        tree_cost = self._tree_cost(run_id)
        return {
            "case": case.id,
            "category": case.category,
            "run_id": run_id,
            "status": run["status"],
            "passed": all(c["passed"] for c in checks),
            "checks": checks,
            "duration_s": duration,
            "steps": run["steps"],
            "tool_calls": run["tool_calls"],
            "cost_usd": tree_cost,
            "input_tokens": run["input_tokens"],
            "output_tokens": run["output_tokens"],
        }

    def _tree_cost(self, root_id: str) -> float:
        with self.platform.db.session() as session:
            return round(sum(r.cost_usd for r in session.query(Run).filter(Run.root_run_id == root_id)), 6)

    async def _auto_approve(self, run_id: str, policy: dict[str, str], sub) -> None:
        try:
            while True:
                event = await sub.queue.get()
                if event["type"] != "approval.requested" or event["root_run_id"] != run_id:
                    continue
                tool = event["data"]["tool"]
                decision = policy.get(tool, policy.get("*", "reject"))
                await self.manager.approvals.decide(
                    event["data"]["approval_id"], decision == "approve", f"eval policy: {decision}", "eval"
                )
        finally:
            self.manager.bus.unsubscribe(sub)

    async def _wait(self, run_id: str, timeout_s: float = 3600) -> dict:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            with self.platform.db.session() as session:
                run = session.get(Run, run_id)
                if run.status in ("completed", "failed", "cancelled", "interrupted"):
                    return {c.name: getattr(run, c.name) for c in Run.__table__.columns}
            await asyncio.sleep(0.05)
        await self.manager.cancel(run_id, "eval")
        raise TimeoutError(f"eval run {run_id} did not finish")

    async def check(self, case: Case, run: dict, events: list[dict], workspace: Path) -> list[dict]:
        expect, checks = case.expect, []

        def add(name: str, passed: bool, detail: str = "") -> None:
            checks.append({"name": name, "passed": bool(passed), "detail": detail})

        # Tool checks cover the whole run tree, so team and delegation cases work too.
        called = [e["data"]["tool"] for e in events if e["type"] == "agent.tool_call"]
        completed = [e["data"]["tool"] for e in events if e["type"] == "tool.completed"]
        output_blob = json.dumps(run["output"], ensure_ascii=False, default=str) + "\n" + (run["output_text"] or "")
        if expect.status:
            add("status", run["status"] == expect.status, f"got {run['status']}: {run['error'] or ''}"[:300])
        if expect.output_valid is not None:
            schema = self._schema(case)
            valid = run["output"] is not None and (not schema or not validate_output(schema, run["output"]))
            add("output_valid", valid == expect.output_valid, "" if valid else "missing or invalid structured output")
        for tool in expect.tools_called:
            add(f"called:{tool}", tool in called, f"called: {sorted(set(called))}")
        for tool in expect.tools_not_called:
            add(f"not_called:{tool}", tool not in called, f"called: {sorted(set(called))}")
        for tool in expect.tools_completed:
            add(f"completed:{tool}", tool in completed, f"completed: {sorted(set(completed))}")
        for text in expect.output_contains:
            add(f"contains:{text[:30]}", text.lower() in output_blob.lower())
        for text in expect.output_not_contains:
            add(f"not_contains:{text[:30]}", text.lower() not in output_blob.lower())
        for path, expected in expect.output_paths.items():
            actual = get_path(run["output"], path)
            add(f"path:{path}", check_path(actual, expected), f"got {json.dumps(actual, default=str)[:200]}")
        if expect.error_contains:
            add("error_contains", expect.error_contains.lower() in (run["error"] or "").lower(), run["error"] or "")
        if expect.max_steps is not None:
            add("max_steps", run["steps"] <= expect.max_steps, f"steps={run['steps']}")
        if expect.max_cost_usd is not None:
            cost = self._tree_cost(run["id"])
            add("max_cost", cost <= expect.max_cost_usd, f"cost={cost}")
        requested = [e["data"]["tool"] for e in events if e["type"] == "approval.requested"]
        for tool in expect.approval_requested:
            add(f"approval:{tool}", tool in requested, f"requested: {requested}")
        delegated = [e["data"]["agent_id"] for e in events if e["type"] == "delegation.started"]
        for agent in expect.delegated_to:
            add(f"delegated:{agent}", agent in delegated, f"delegated: {delegated}")
        for name in expect.file_exists:
            add(f"file:{name}", (workspace / name).is_file())
        for name in expect.file_absent:
            add(f"no_file:{name}", not (workspace / name).exists())
        for name, text in expect.file_contains.items():
            path = workspace / name
            content = path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""
            add(f"file_contains:{name}", text.lower() in content.lower())
        if expect.judge:
            checks.append(await self.judge(case, run, expect.judge))
        return checks

    def _schema(self, case: Case) -> dict | None:
        if not case.agent:
            return None
        found = self.platform.registry.get(case.agent)
        return found[0].output_schema if found else None

    async def judge(self, case: Case, run: dict, rubric: str) -> dict:
        task = (
            f"Grade an agent's result against a rubric.\n\n## Original task\n{case.task}\n\n## Rubric\n{rubric}\n\n"
            f"## Agent output\n{json.dumps(run['output'], indent=1, default=str) if run['output'] else ''}\n"
            f"{run['output_text'] or ''}"
        )
        try:
            judge_id = await self.manager.submit(task=task, agent_id="evaluator", actor="eval:judge")
            judged = await self._wait(judge_id, timeout_s=900)
        except (ValueError, TimeoutError) as exc:
            return {"name": "judge", "passed": False, "detail": f"judge unavailable: {exc}"}
        verdict = judged["output"] or {}
        return {
            "name": "judge",
            "passed": bool(verdict.get("passed")),
            "detail": f"score={verdict.get('score')}: {verdict.get('reasoning', judged['error'] or '')}"[:500],
            "judge_run_id": judge_id,
        }


def summarize(results: list[dict]) -> dict:
    total = len(results)
    by_category: dict[str, dict] = {}
    for result in results:
        bucket = by_category.setdefault(result["category"], {"cases": 0, "passed": 0})
        bucket["cases"] += 1
        bucket["passed"] += int(result["passed"])
    for bucket in by_category.values():
        bucket["pass_rate"] = round(bucket["passed"] / bucket["cases"], 3)
    durations = sorted(r["duration_s"] for r in results)
    return {
        "cases": total,
        "passed": sum(r["passed"] for r in results),
        "pass_rate": round(sum(r["passed"] for r in results) / total, 3) if total else None,
        "by_category": by_category,
        "total_cost_usd": round(sum(r.get("cost_usd") or 0 for r in results), 6),
        "median_duration_s": durations[len(durations) // 2] if durations else None,
        "max_duration_s": durations[-1] if durations else None,
    }
