"""Run manager: creates, schedules, executes, cancels, resumes and recovers runs."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from datetime import datetime, timedelta
from pathlib import Path

from pae.agents import AgentDefinition, AgentRegistry, TeamDefinition
from pae.db import AuditEntry, Database, Run, utcnow
from pae.engines import ACP_PREFIX
from pae.notify import notify as windows_notify
from pae.providers.base import ProviderError
from pae.runtime import security_review
from pae.runtime.acp import run_acp
from pae.runtime.approvals import ApprovalService
from pae.runtime.claude_code import run_claude_code
from pae.runtime.context import LimitExceeded, RunContext, RunFailure
from pae.runtime.events import EventBus
from pae.runtime.native import run_native
from pae.runtime.sessions import session_to_continue
from pae.runtime.teams import run_team
from pae.tools.memory import PROJECT_MEMORY_TOOLS

log = logging.getLogger("pae.runtime")
TERMINAL = {"completed", "failed", "cancelled"}
ACTIVE = {"queued", "running", "waiting_approval"}
TASK_NOTICE_AFTER_S = 60  # a task shorter than this ends in front of the owner: no notification
APPROVAL_NOTICE_EVERY_S = 300  # a task waiting for approvals tells the owner at most this often


def _first_line(task: str, limit: int = 140) -> str:
    line = next((part.strip() for part in task.splitlines() if part.strip()), "")
    return line if len(line) <= limit else line[: limit - 1] + "…"


class SubmitError(ValueError):
    pass


def preview(value, limit: int = 600) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return text if len(text) <= limit else text[:limit] + "..."


class RunManager:
    def __init__(
        self, *, config, db: Database, settings, registry: AgentRegistry, tools, providers, redactor, secrets
    ) -> None:
        self.config, self.db, self.settings = config, db, settings
        self.registry, self.tools, self.providers = registry, tools, providers
        self.redactor, self.secrets = redactor, secrets
        self.bus = EventBus(db, redactor)
        self.approvals = ApprovalService(db, self.bus)
        self._tasks: dict[str, asyncio.Task] = {}
        self._contexts: dict[str, RunContext] = {}
        self._cancel_requested: set[str] = set()
        self._slots: asyncio.Condition | None = None
        self._active_roots = 0
        self._shutting_down = False
        self._usage_block: dict | None = None
        self.projects = None  # pae.projects.ProjectService, set by the platform
        self._paused: dict[str, asyncio.Event] = {}  # root run id -> set while running is allowed
        self.notify = windows_notify  # Windows notifications for the owner (replaced in tests)
        self._approval_told: dict[str, float] = {}  # root run id -> when the owner was last told it waits
        self._followers: set[asyncio.Task] = set()

    def tools_bin(self) -> Path | None:
        """Extra commands for the team (the Security Engineer's scanners, scripts/install-security-tools.ps1)."""
        path = Path(self.config.data_dir) / "tools" / "bin"
        return path if path.is_dir() else None

    def page(self, path: str) -> str:
        """A link to a page of the platform, for notifications."""
        host = self.config.host
        host = "127.0.0.1" if host in ("0.0.0.0", "::") else host  # noqa: S104 - a link to open, not a bind
        return f"http://{host}:{self.config.port}{path}"

    # ------------------------------------------------------------ lifecycle

    async def start(self, recover: bool = True) -> None:
        self._slots = asyncio.Condition()
        if recover:
            await self.recover()

    async def recover(self) -> int:
        """Mark as interrupted what a stopped server left active. Only the instance's owner calls this
        (pae.instance_lock), and never for this process's own runs and approvals."""
        await self.approvals.expire_orphans()
        with self.db.session() as session:
            stale = [r for r in session.query(Run).filter(Run.status.in_(ACTIVE)).all() if r.id not in self._tasks]
            found = [(r.id, r.root_run_id, r.status) for r in stale]
            for run in stale:
                run.status, run.finished_at = "interrupted", utcnow()
                run.error = "The server stopped while this run was active. Resume it to continue from its checkpoint."
        for run_id, root_id, previous in found:
            await self.bus.emit(
                run_id, root_id, "run.interrupted", "runtime", {"previous_status": previous, "reason": "server restart"}
            )
        return len(found)

    async def shutdown(self) -> None:
        self._shutting_down = True
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def get_secret(self, name: str, project_id: str | None = None) -> str | None:
        return self.secrets.get(name, project_id=project_id)

    # ------------------------------------------------------------ subscription usage

    def claude_config_dir(self) -> Path:
        """Claude Code home for platform sessions: holds the owner's subscription login."""
        path = Path(self.config.claude_config_dir or self.config.data_dir / "claude-home")
        path.mkdir(parents=True, exist_ok=True)
        return path

    def record_usage_block(self, signal) -> None:
        until = signal.resets_at or (utcnow() + timedelta(minutes=15))
        self._usage_block = {
            "blocked_until": until.isoformat(),
            "window": signal.window,
            "reason": "overage" if signal.action == "stop_overage" else "limit",
            "message": signal.message,
        }

    def usage_state(self) -> dict | None:
        block = self._usage_block
        if block and datetime.fromisoformat(block["blocked_until"]) <= utcnow():
            self._usage_block = block = None
        return dict(block) if block else None

    def clear_usage_block(self) -> None:
        self._usage_block = None

    def check_usage_available(self) -> None:
        if state := self.usage_state():
            raise RunFailure(
                f"Your Claude subscription's usage limit is reached until {state['blocked_until']}; "
                "the platform does not use paid usage credits.",
                code="usage_limit",
            )

    def context_of(self, run_id: str) -> RunContext:
        ctx = self._contexts.get(run_id)
        if ctx is None:
            raise RunFailure("run is not active", code="delegation_refused")
        return ctx

    def active_count(self) -> int:
        return len(self._tasks)

    # ------------------------------------------------------------ helpers

    def update_run(self, run_id: str, **fields) -> None:
        with self.db.session() as session:
            run = session.get(Run, run_id)
            if run is not None:
                for key, value in fields.items():
                    setattr(run, key, value)

    async def set_status(self, ctx: RunContext, status: str) -> None:
        self.update_run(ctx.run_id, status=status)
        await ctx.emit("run.status", "runtime", {"status": status})

    # ------------------------------------------------------------ telling the owner

    def tell_owner(self, title: str, body: str, path: str) -> None:
        """A Windows notification for the owner (setting "notifications.windows"), without waiting for it."""
        if not self.settings.get("notifications.windows"):
            return
        sending = asyncio.create_task(asyncio.to_thread(self.notify, title, body, self.page(path)))
        self._followers.add(sending)
        sending.add_done_callback(self._followers.discard)

    async def approval_waiting(self, ctx: RunContext) -> None:
        """A step now waits for the owner: say so on the task and, at most every few minutes per task, on the
        owner's screen. A task that waits unseen wastes hours."""
        await self.set_status(ctx, "waiting_approval")
        now = time.monotonic()
        if now - self._approval_told.get(ctx.root_run_id, -APPROVAL_NOTICE_EVERY_S) < APPROVAL_NOTICE_EVERY_S:
            return
        self._approval_told[ctx.root_run_id] = now
        self.tell_owner("Your team is waiting for your approval", _first_line(ctx.task), "/approvals")

    def _tell_task_ended(self, ctx: RunContext, status: str) -> None:
        """The owner's own task ended after working for a while: they may have walked away."""
        if ctx.parent_run_id is not None or not ctx.options.get("tell_owner") or ctx.wall_s() < TASK_NOTICE_AFTER_S:
            return
        title = "Your task is finished" if status == "completed" else "Your task could not finish"
        self.tell_owner(title, _first_line(ctx.task), f"/workspace/{ctx.run_id}")

    def workspace_roots(self) -> list[Path]:
        extra = [Path(p).expanduser().resolve() for p in self.settings.get("workspaces.roots", []) if p]
        return [*self.config.workspace_roots, *extra]

    def _project_workspace(self, project_id: str | None, workspace: str | None) -> Path:
        """A project's runs stay inside the project's own folder; other runs use the roots."""
        if not project_id:
            return self.resolve_workspace(workspace)
        if self.projects is None:
            raise SubmitError("projects are not available")
        try:
            project = self.projects.require_active(project_id)
        except ValueError as exc:
            raise SubmitError(str(exc)) from exc
        root = Path(project["workspace"]).resolve()
        root.mkdir(parents=True, exist_ok=True)
        if not workspace:
            return root
        path = Path(workspace).expanduser().resolve()
        if not (path == root or path.is_relative_to(root)) or not path.is_dir():
            raise SubmitError(f"workspace must be an existing folder inside the project's folder ({root})")
        return path

    def resolve_workspace(self, path: str | None) -> Path:
        if not path:
            workspace = self.config.default_workspace
            workspace.mkdir(parents=True, exist_ok=True)
            return workspace.resolve()
        workspace = Path(path).expanduser().resolve()
        if not workspace.is_dir():
            raise SubmitError(f"workspace '{path}' does not exist")
        if not any(workspace == root or workspace.is_relative_to(root) for root in self.workspace_roots()):
            raise SubmitError(f"workspace '{path}' is outside the allowed workspace roots")
        return workspace

    def resolve_limits(self, agent_limits: dict | None, overrides: dict | None) -> dict:
        limits = {
            key.split(".", 1)[1]: value for key, value in self.settings.all().items() if key.startswith("limits.")
        }
        for source in (agent_limits or {}, overrides or {}):
            for key, value in source.items():
                if key in limits and value is not None:
                    limits[key] = value
        return limits

    def _agent(self, agent_id: str) -> tuple[AgentDefinition, dict]:
        found = self.registry.get(agent_id)
        if found is None:
            raise SubmitError(f"agent '{agent_id}' does not exist")
        definition, meta = found
        if not meta["enabled"]:
            raise SubmitError(f"agent '{agent_id}' is disabled")
        if meta["problems"]:
            raise SubmitError(f"agent '{agent_id}' is misconfigured: {'; '.join(meta['problems'])}")
        return definition, meta

    def _resolve_provider(self, name: str | None) -> str:
        try:
            return self.providers.resolve(name)
        except ProviderError as exc:
            raise SubmitError(str(exc)) from exc

    def _team_spec(self, team: dict) -> tuple[dict, str | None, str]:
        if team.get("team_id"):
            definition = self.registry.get_team(team["team_id"])
            if definition is None:
                raise SubmitError(f"team '{team['team_id']}' does not exist")
            spec = definition.model_dump()
            team_id, name = definition.id, definition.name
        else:
            spec = TeamDefinition.model_validate(
                {
                    "id": "adhoc-team",
                    "name": team.get("name") or "Ad-hoc team",
                    **{k: v for k, v in team.items() if k not in ("name", "id", "on_failure")},
                }
            ).model_dump()
            team_id, name = None, spec["name"]
        agents = [m["agent"] for m in spec["members"]]
        if spec["mode"] == "orchestrated":
            agents.append(spec.get("orchestrator") or "orchestrator")
        if spec.get("consolidator"):
            agents.append(spec["consolidator"])
        for agent_id in agents:
            self._agent(agent_id)
        spec["on_failure"] = team.get("on_failure", "stop")
        return spec, team_id, name

    # ------------------------------------------------------------ submission

    async def submit(
        self,
        *,
        task: str,
        agent_id: str | None = None,
        team: dict | None = None,
        input: dict | None = None,
        workspace: str | None = None,
        provider: str | None = None,
        model: str | None = None,
        limits: dict | None = None,
        options: dict | None = None,
        actor: str = "owner",
        project_id: str | None = None,
    ) -> str:
        if not task or not task.strip():
            raise SubmitError("task is required")
        if bool(agent_id) == bool(team):
            raise SubmitError("give exactly one of agent_id or team")
        options = dict(options or {})
        if not actor.startswith(("platform:", "eval:")):  # the owner's own task: they are told when it ends
            options.setdefault("tell_owner", True)
        tree = dict(options.pop("tree", {}))
        if provider:
            tree["provider"] = self._resolve_provider(provider)
        if model:
            tree["model"] = model
        workspace_path = self._project_workspace(project_id, workspace)
        if agent_id:
            definition, meta = self._agent(agent_id)
            provider_name = tree.get("provider") or self._resolve_provider(definition.provider)
            if provider_name == "claude-code" and (state := self.usage_state()):
                raise SubmitError(f"subscription usage limit reached until {state['blocked_until']}")
            model_name = tree.get("model") or definition.model or self.providers.default_model(provider_name)
            kind, team_id, version = "agent", None, f"{definition.version}+{meta['revision']}"
            run_limits = self.resolve_limits(definition.limits, limits)
        else:
            spec, team_id, _name = self._team_spec(team)
            options["team"] = spec
            kind, provider_name, model_name, version = "team", tree.get("provider"), tree.get("model"), spec["version"]
            run_limits = self.resolve_limits({}, limits)
        options["tree"] = tree
        with self.db.session() as session:
            run = Run(
                project_id=project_id,
                origin="quality_check" if actor.startswith("eval:") else "owner",
                kind=kind,
                agent_id=agent_id,
                team_id=team_id,
                status="queued",
                task=task.strip(),
                input=input,
                provider=provider_name,
                model=model_name,
                agent_version=version,
                workspace=str(workspace_path),
                options=options,
                limits=run_limits,
                root_run_id="",
            )
            session.add(run)
            session.flush()
            run.root_run_id = run.id
            run_id = run.id
            session.add(
                AuditEntry(
                    actor=actor,
                    action="run.submit",
                    target=run_id,
                    details={"agent_id": agent_id, "team": team_id or (team and "adhoc")},
                )
            )
        await self.bus.emit(
            run_id,
            run_id,
            "run.queued",
            "runtime",
            {
                "kind": kind,
                "agent_id": agent_id,
                "team_id": team_id,
                "task": preview(task),
                "provider": provider_name,
                "model": model_name,
                "workspace": str(workspace_path),
                "limits": run_limits,
            },
        )
        self._launch(run_id)
        return run_id

    def _launch(self, run_id: str) -> None:
        task = asyncio.create_task(self._execute_root(run_id), name=f"run-{run_id}")
        self._tasks[run_id] = task

    async def _execute_root(self, run_id: str) -> None:
        """Root runs wait for a slot; the limit is read live, so a settings change applies at once.
        Delegated child runs do not take slots (a parent waiting for its child must not deadlock)."""
        assert self._slots is not None, "RunManager.start() was not called"
        async with self._slots:
            await self._slots.wait_for(
                lambda: self._active_roots < max(1, int(self.settings.get("limits.max_concurrent_runs")))
            )
            self._active_roots += 1
        try:
            await self._execute(run_id)
        finally:
            async with self._slots:
                self._active_roots -= 1
                self._slots.notify_all()

    # ------------------------------------------------------------ execution

    def _context(self, run: Run, parent: RunContext | None) -> RunContext:
        options = run.options or {}
        if run.kind == "team":
            agent = AgentDefinition(
                id="team-run", name=options["team"]["name"], description="team run", instructions="-"
            )
        else:
            agent, _meta = self._agent(run.agent_id)
            if options.get("delegates") is not None:
                agent = agent.model_copy(update={"delegates": options["delegates"]})
            if agent.read_only:
                options = {**options, "read_only": True}
        if run.origin == "quality_check":
            options = {**options, "quality_check": True}  # approvals behave as in "ask" mode (pae.runtime.auto_approve)
        workspace = Path(run.workspace)
        earlier = None
        if run.kind == "agent" and run.provider == "claude-code":
            with self.db.session() as session:
                earlier = session_to_continue(session, session.get(Run, run.id), self.claude_config_dir())
        return RunContext(
            continue_session=earlier[0] if earlier else None,
            continue_from_run=earlier[1] if earlier else None,
            project_id=run.project_id,
            project_context=self.projects.context(run.project_id) if self.projects else "",
            project_trust_edits=self.projects.trusts_edits(run.project_id) if self.projects else False,
            project_tools=(
                list(PROJECT_MEMORY_TOOLS)
                if self.projects and run.kind != "team" and self.projects.memory_folder(run.project_id)
                else []
            ),
            run_id=run.id,
            root_run_id=run.root_run_id,
            parent_run_id=run.parent_run_id,
            depth=(parent.depth + 1) if parent else 0,
            agent=agent,
            agent_version=run.agent_version or "",
            task=run.task,
            input=run.input,
            workspace=workspace,
            provider_name=run.provider or "",
            model=run.model or "",
            limits=run.limits,
            options=options,
            manager=self,
            checkpoint=run.checkpoint,
            input_tokens=run.input_tokens,
            output_tokens=run.output_tokens,
            cost_usd=run.cost_usd,
            steps=run.steps,
            tool_calls=run.tool_calls,
        )

    async def _execute(self, run_id: str, parent: RunContext | None = None) -> dict:
        with self.db.session() as session:
            run = session.get(Run, run_id)
            resumed = bool(run.checkpoint)
        try:
            ctx = self._context(run, parent)
        except SubmitError as exc:
            self._finish(run_id, "failed", error=str(exc))
            await self.bus.emit(
                run_id, run.root_run_id, "run.failed", "runtime", {"error": str(exc), "code": "invalid"}
            )
            return self._summary(run_id)
        self._contexts[run_id] = ctx
        self.update_run(run_id, status="running", started_at=run.started_at or utcnow())
        await ctx.emit(
            "run.resumed" if resumed else "run.started",
            "runtime",
            {
                "agent_id": run.agent_id,
                "kind": run.kind,
                "provider": run.provider,
                "model": run.model,
                "agent_version": run.agent_version,
                "depth": ctx.depth,
                "role": (run.options or {}).get("role"),
            },
        )
        try:
            async with ctx.deadline(ctx.remaining_s()):  # stopped while the owner is awaited (owner_awaited)
                if run.kind == "team":
                    outcome = await run_team(ctx, ctx.options["team"])
                elif ctx.provider_name == "claude-code":
                    outcome = await run_claude_code(ctx)
                elif ctx.provider_name.startswith(ACP_PREFIX):
                    outcome = await run_acp(ctx)
                else:
                    outcome = await run_native(ctx)
            self._finish(run_id, "completed", output=outcome.output, output_text=outcome.output_text)
            await ctx.emit(
                "run.completed",
                "runtime",
                {
                    "output_preview": preview(
                        outcome.output if outcome.output is not None else (outcome.output_text or "")
                    ),
                    "steps": ctx.steps,
                    "tool_calls": ctx.tool_calls,
                    "input_tokens": ctx.input_tokens,
                    "output_tokens": ctx.output_tokens,
                    "cost_usd": round(ctx.cost_usd, 6),
                    "duration_s": round(ctx.wall_s(), 2),
                    "waited_for_owner_s": round(ctx.waited_s, 2),
                },
            )
            self._tell_task_ended(ctx, "completed")
            if parent is None and run.agent_id in security_review.CODING_AGENTS:
                follower = asyncio.create_task(security_review.after_change(self, run_id))
                self._followers.add(follower)
                follower.add_done_callback(self._followers.discard)
        except TimeoutError:
            message = f"run exceeded its timeout of {ctx.limits['timeout_s']}s"
            await ctx.emit("limit.exceeded", "runtime", {"limit": "timeout_s", "max": ctx.limits["timeout_s"]})
            await self._fail(ctx, message, "timeout")
            self._tell_task_ended(ctx, "failed")
        except LimitExceeded as exc:
            await self._fail(ctx, str(exc), exc.code)
            self._tell_task_ended(ctx, "failed")
        except RunFailure as exc:
            await self._fail(ctx, str(exc), exc.code)
            self._tell_task_ended(ctx, "failed")
        except ProviderError as exc:
            await self._fail(ctx, str(exc), "provider_error")
            self._tell_task_ended(ctx, "failed")
        except asyncio.CancelledError:
            if self._shutting_down and run_id not in self._cancel_requested:
                self._finish(run_id, "interrupted", error="The server stopped during this run. Resume it to continue.")
                await ctx.emit("run.interrupted", "runtime", {"reason": "server shutdown"})
            else:
                self._finish(
                    run_id,
                    "cancelled",
                    error="cancelled by the owner"
                    if run_id in self._cancel_requested
                    else "cancelled because its parent run was cancelled",
                )
                await ctx.emit("run.cancelled", "runtime", {"requested": run_id in self._cancel_requested})
        except Exception as exc:
            log.exception("run %s crashed", run_id)
            await self._fail(ctx, f"internal error: {type(exc).__name__}: {exc}", "internal_error")
        finally:
            await self.approvals.cancel_for_run(run_id, "run ended")
            gate = self._paused.pop(run_id, None)  # a finished root run releases anything still waiting
            if gate is not None:
                gate.set()
            self._contexts.pop(run_id, None)
            self._tasks.pop(run_id, None)
            self._cancel_requested.discard(run_id)
        return self._summary(run_id)

    async def _fail(self, ctx: RunContext, message: str, code: str) -> None:
        message = self.redactor.text(message)
        self._finish(ctx.run_id, "failed", error=message)
        await ctx.emit(
            "run.failed",
            "runtime",
            {"error": message, "code": code, "steps": ctx.steps, "cost_usd": round(ctx.cost_usd, 6)},
        )

    def _finish(self, run_id: str, status: str, *, output=None, output_text=None, error=None) -> None:
        self.update_run(
            run_id, status=status, output=output, output_text=output_text, error=error, finished_at=utcnow()
        )

    def _summary(self, run_id: str) -> dict:
        with self.db.session() as session:
            run = session.get(Run, run_id)
            return {
                "run_id": run.id,
                "status": run.status,
                "output": run.output,
                "output_text": run.output_text,
                "error": run.error,
            }

    # ------------------------------------------------------------ delegation

    async def run_child(
        self,
        *,
        parent_run_id: str,
        agent_id: str,
        task: str,
        input: dict | None = None,
        role: str | None = None,
        delegates: list[str] | None = None,
        on_created=None,
    ) -> dict:
        parent = self._contexts.get(parent_run_id)
        if parent is None:
            raise RunFailure("parent run is not active", code="delegation_refused")
        max_depth = int(self.settings.get("limits.max_delegation_depth"))
        if parent.depth + 1 > max_depth:
            raise RunFailure(f"delegation depth limit reached ({max_depth})", code="delegation_refused")
        if parent.children >= int(parent.limits["max_children_per_run"]):
            raise RunFailure("this run reached its limit of delegated runs", code="delegation_refused")
        try:
            definition, meta = self._agent(agent_id)
        except SubmitError as exc:
            raise RunFailure(str(exc), code="delegation_refused") from exc
        parent.children += 1
        tree = (parent.options or {}).get("tree", {})
        provider_name = tree.get("provider") or self.providers.resolve(definition.provider)
        model_name = tree.get("model") or definition.model or self.providers.default_model(provider_name)
        limits = self.resolve_limits(definition.limits, {})
        limits["timeout_s"] = max(10, min(float(limits["timeout_s"]), parent.remaining_s() - 5))
        options = {"tree": tree, "role": role, "delegates": delegates}
        with self.db.session() as session:
            # Scripted test double only: {"sequence": [s1, s2]} gives the nth run of this agent in the tree
            # the nth script (the last repeats), so retries can be exercised deterministically.
            script = tree.get("scripts", {}).get(agent_id)
            if isinstance(script, dict) and "sequence" in script:
                earlier = (
                    session.query(Run).filter(Run.root_run_id == parent.root_run_id, Run.agent_id == agent_id).count()
                )
                script = script["sequence"][min(earlier, len(script["sequence"]) - 1)]
            if script:
                options["provider_options"] = {"script": script}
            parent_run = session.get(Run, parent.run_id)
            child = Run(
                project_id=parent.project_id,
                origin=parent_run.origin if parent_run is not None else "owner",
                kind="agent",
                agent_id=agent_id,
                parent_run_id=parent.run_id,
                root_run_id=parent.root_run_id,
                role=role,
                status="queued",
                task=task,
                input=input,
                provider=provider_name,
                model=model_name,
                agent_version=f"{definition.version}+{meta['revision']}",
                workspace=str(parent.workspace),
                options=options,
                limits=limits,
            )
            session.add(child)
            session.flush()
            child_id = child.id
        await parent.emit(
            "delegation.started",
            "runtime",
            {"child_run_id": child_id, "agent_id": agent_id, "task": preview(task), "role": role},
        )
        await self.bus.emit(
            child_id,
            parent.root_run_id,
            "run.queued",
            "runtime",
            {
                "kind": "agent",
                "agent_id": agent_id,
                "parent_run_id": parent.run_id,
                "task": preview(task),
                "provider": provider_name,
                "model": model_name,
            },
        )
        if on_created is not None:
            await on_created(child_id)
        child_task = asyncio.create_task(self._execute(child_id, parent), name=f"run-{child_id}")
        self._tasks[child_id] = child_task
        summary = await child_task
        await parent.emit(
            "delegation.completed",
            "runtime",
            {
                "child_run_id": child_id,
                "agent_id": agent_id,
                "status": summary["status"],
                "output_preview": preview(
                    summary["output"]
                    if summary["output"] is not None
                    else (summary["output_text"] or summary["error"] or "")
                ),
            },
        )
        return summary

    # ------------------------------------------------------------ pause

    def is_paused(self, root_run_id: str) -> bool:
        gate = self._paused.get(root_run_id)
        return gate is not None and not gate.is_set()

    async def wait_while_paused(self, root_run_id: str, ctx: RunContext | None = None) -> None:
        gate = self._paused.get(root_run_id)
        if gate is None or gate.is_set():
            return
        with self.owner_awaited(ctx) if ctx is not None else contextlib.nullcontext():
            await gate.wait()

    @contextlib.contextmanager
    def owner_awaited(self, ctx: RunContext):
        """While the owner is awaited (an approval, a paused plan), the clock of this run and of every run above it
        stops: waiting for the owner never uses up a task's time."""
        chain: list[RunContext] = []
        current: RunContext | None = ctx
        while current is not None and all(current is not run for run in chain):
            chain.append(current)
            current = self._contexts.get(current.parent_run_id) if current.parent_run_id else None
        for run in chain:
            run.hold_clock()
        try:
            yield
        finally:
            for run in chain:
                run.release_clock()

    async def pause(self, run_id: str, actor: str = "owner") -> bool:
        root_id = self._root_of_active(run_id)
        gate = self._paused.get(root_id)
        if gate is None:
            gate = self._paused[root_id] = asyncio.Event()
            gate.set()
        if gate.is_set():  # not paused yet
            gate.clear()
            await self.bus.emit(root_id, root_id, "run.paused", "user", {"actor": actor})
        return True

    async def unpause(self, run_id: str, actor: str = "owner") -> bool:
        root_id = self._root_of_active(run_id)
        gate = self._paused.get(root_id)
        if gate is not None and not gate.is_set():
            gate.set()
            await self.bus.emit(root_id, root_id, "run.unpaused", "user", {"actor": actor})
        return False

    def _root_of_active(self, run_id: str) -> str:
        with self.db.session() as session:
            run = session.get(Run, run_id)
            if run is None:
                raise SubmitError("run not found")
            if run.parent_run_id:
                raise SubmitError("pause the root run of this execution")
            if run.status in TERMINAL or run.status == "interrupted":
                raise SubmitError(f"run is {run.status}")
            return run.id

    # ------------------------------------------------------------ owner actions

    async def cancel(self, run_id: str, actor: str = "owner") -> str:
        with self.db.session() as session:
            run = session.get(Run, run_id)
            if run is None:
                raise SubmitError("run not found")
            if run.status in TERMINAL:
                raise SubmitError(f"run is already {run.status}")
            root_id = run.root_run_id
            session.add(AuditEntry(actor=actor, action="run.cancel", target=run_id, details={}))
        self._cancel_requested.add(run_id)
        await self.bus.emit(run_id, root_id, "run.cancel_requested", "user", {"actor": actor})
        task = self._tasks.get(run_id)
        if task is not None:
            task.cancel()
            return "cancelling"
        self._cancel_requested.discard(run_id)
        await self.approvals.cancel_for_run(run_id, "run cancelled")
        self._finish(run_id, "cancelled", error="cancelled by the owner")
        await self.bus.emit(run_id, root_id, "run.cancelled", "runtime", {"requested": True})
        return "cancelled"

    async def resume(self, run_id: str, actor: str = "owner") -> str:
        with self.db.session() as session:
            run = session.get(Run, run_id)
            if run is None:
                raise SubmitError("run not found")
            if run.parent_run_id:
                raise SubmitError("resume the root run of this tree instead")
            if run.status not in {"interrupted", "failed"}:
                raise SubmitError(f"only interrupted or failed runs can be resumed (status: {run.status})")
            if run_id in self._tasks:
                raise SubmitError("run is already active")
            run.status, run.error, run.finished_at = "queued", None, None
            run.options = {**(run.options or {}), "resumes": (run.options or {}).get("resumes", 0) + 1}
            session.add(AuditEntry(actor=actor, action="run.resume", target=run_id, details={}))
        self._launch(run_id)
        return "queued"
