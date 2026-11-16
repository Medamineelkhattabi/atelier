"""Wires every component together. One instance per process."""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import timedelta
from pathlib import Path

from pae import __version__
from pae.agents import AgentRegistry
from pae.config import Config
from pae.db import Approval, Database, Run, RunEvent, User, utcnow
from pae.instance_lock import InstanceLock
from pae.migrations_runner import upgrade
from pae.projects import ProjectService
from pae.providers.registry import Providers
from pae.runtime.claude_code import find_cli
from pae.runtime.manager import TERMINAL, RunManager
from pae.runtime.sessions import forget as forget_sessions
from pae.secrets_service import SecretsService
from pae.security import RateLimiter, Redactor, SecretBox, new_token
from pae.settings_store import SettingsStore
from pae.subscription import scrub_environment
from pae.tools import builtin_registry
from pae.tools.mcp_client import MCPHub
from pae.watch import AppWatcher

log = logging.getLogger("pae")
OWNERSHIP_RETRY_S = 30  # a process that started second checks this often whether the owner stopped


class Platform:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.started_at = time.time()
        # Subscription-only policy: no paid credential may reach Claude Code (pae.subscription).
        self.removed_paid_env = scrub_environment()
        config.data_dir.mkdir(parents=True, exist_ok=True)
        self.db = Database(config.database_url)
        upgrade(config.database_url)
        self.redactor = Redactor()
        self.box = SecretBox(config.key_file)
        self.secrets = SecretsService(self.db, self.box, self.redactor)
        self.settings = SettingsStore(self.db)
        self.tools = builtin_registry()
        self.registry = AgentRegistry(self.db, config.agents_dir, known_tools=self.tools.tools)
        self.providers = Providers(
            self.settings,
            config_dir_getter=lambda: self.manager.claude_config_dir(),
            cli_finder=self.cli_path,
            usage_state_getter=lambda: self.manager.usage_state(),
        )
        self.manager = RunManager(
            config=config,
            db=self.db,
            settings=self.settings,
            registry=self.registry,
            tools=self.tools,
            providers=self.providers,
            redactor=self.redactor,
            secrets=self.secrets,
        )
        self.projects = ProjectService(self.db, self.manager.workspace_roots, protected_dirs=[config.data_dir])
        self.manager.projects = self.projects
        self.mcp = MCPHub(self.settings, self.tools, self.secrets, self.redactor)
        self.login_limiter = RateLimiter(max_events=5, window_s=300)
        self.api_limiter = RateLimiter(max_events=1200, window_s=60)
        self.setup_token: str | None = None
        self._maintenance: asyncio.Task | None = None
        self.watcher = AppWatcher(self)
        self._watching: asyncio.Task | None = None
        # One process owns the instance (pae.instance_lock): normally the server, not a `pae` command next to it.
        self.instance_lock = InstanceLock(config.data_dir / "instance.lock")
        self._ownership: asyncio.Task | None = None
        if not self.has_owner():
            self.setup_token = config.setup_token or new_token(12)

    def cli_path(self) -> str | None:
        return find_cli(self.settings.get("providers.claude_code.cli_path") or self.config.claude_code_path)

    def has_owner(self) -> bool:
        with self.db.session() as session:
            return session.query(User).count() > 0

    @property
    def version(self) -> str:
        return __version__

    @property
    def owns_instance(self) -> bool:
        return self.instance_lock.held

    async def start(self) -> None:
        Path(self.config.default_workspace).mkdir(parents=True, exist_ok=True)
        await self.manager.start(recover=False)
        await self.mcp.start()
        if self.instance_lock.acquire():
            await self._take_ownership()
        else:
            log.warning(
                "Another process (the platform server) already runs on %s: this one only runs its own tasks. It "
                "leaves the server's tasks and approvals alone, cleans nothing up and watches no app.",
                self.config.data_dir,
            )
            self._ownership = asyncio.create_task(self._wait_for_ownership())
        if self.setup_token:
            log.warning("No owner account yet. Open the UI and use this one-time setup token: %s", self.setup_token)

    async def _take_ownership(self) -> None:
        await self.manager.recover()  # what a stopped server left unfinished, never this process's own tasks
        self._maintenance = asyncio.create_task(self._maintenance_loop())
        self._watching = asyncio.create_task(self.watcher.run_forever())  # does nothing until a project is watched

    async def _wait_for_ownership(self) -> None:
        """Started while another process owned the instance (e.g. the server during a `pae` command): take over
        once it stops, so a server never runs for long without recovery, clean-up and app watching."""
        while not self.instance_lock.acquire():
            await asyncio.sleep(OWNERSHIP_RETRY_S)
        log.info("This process now owns the platform instance in %s.", self.config.data_dir)
        await self._take_ownership()

    async def stop(self) -> None:
        for task in (self._ownership, self._maintenance, self._watching):
            if task:
                task.cancel()
        await self.manager.shutdown()
        await self.mcp.stop()
        self.instance_lock.release()
        self.db.dispose()

    async def _maintenance_loop(self) -> None:
        while True:
            try:
                self.purge_expired()
            except Exception:
                log.exception("retention purge failed")
            await asyncio.sleep(6 * 3600)

    def purge_expired(self, days: int | None = None) -> int:
        """Delete finished run trees older than the retention period, with their events and approvals."""
        days = int(days if days is not None else self.settings.get("retention.days"))
        cutoff = utcnow() - timedelta(days=days)
        with self.db.session() as session:
            roots = [
                r.id
                for r in session.query(Run).filter(
                    Run.parent_run_id.is_(None), Run.status.in_(TERMINAL), Run.created_at < cutoff
                )
            ]
            if not roots:
                return 0
            sessions = [s for (s,) in session.query(Run.claude_session_id).filter(Run.root_run_id.in_(roots))]
            session.query(RunEvent).filter(RunEvent.root_run_id.in_(roots)).delete(synchronize_session=False)
            session.query(Approval).filter(Approval.root_run_id.in_(roots)).delete(synchronize_session=False)
            session.query(Run).filter(Run.root_run_id.in_(roots)).delete(synchronize_session=False)
        forget_sessions(self.manager.claude_config_dir(), sessions)
        return len(roots)
