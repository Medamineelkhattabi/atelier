"""MCP client: connects configured stdio MCP servers and exposes their tools
through the platform's tool registry, behind the same permission gate.

Server config (setting "mcp.servers"):
  {"name": "playwright", "command": "npx", "args": ["-y", "@playwright/mcp@<pinned-version>"],
   "env_secrets": {"GITHUB_TOKEN": "GITHUB_TOKEN"}, "enabled": true, "permission": "ask"}
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re

import jsonschema
from pydantic import BaseModel, ConfigDict

from pae.tools.base import Tool, ToolContext, ToolError, ToolResult, truncate
from pae.tools.execution import minimal_env

log = logging.getLogger("pae.mcp")
_SAFE = re.compile(r"[^A-Za-z0-9_-]")


class PassthroughArgs(BaseModel):
    model_config = ConfigDict(extra="allow")


def tool_name(server: str, name: str) -> str:
    return f"mcp__{_SAFE.sub('_', server)}__{_SAFE.sub('_', name)}"[:64]


class MCPConnection:
    def __init__(self, config: dict, hub: MCPHub) -> None:
        self.config = config
        self.name = config["name"]
        self.hub = hub
        self.status = "stopped"
        self.error: str | None = None
        self.tool_names: list[str] = []
        self._requests: asyncio.Queue = asyncio.Queue()
        self._ready = asyncio.Event()
        self._task: asyncio.Task | None = None

    async def start(self, timeout_s: float = 60) -> None:
        self.status = "starting"
        self._task = asyncio.create_task(self._run(), name=f"mcp-{self.name}")
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=timeout_s)
        except TimeoutError:
            self.status, self.error = "error", f"did not start within {timeout_s}s"
            await self.stop()

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
        self.hub.tools.unregister_source(f"mcp:{self.name}")
        if self.status != "error":
            self.status = "stopped"

    async def _run(self) -> None:
        from mcp import ClientSession
        from mcp.client.stdio import StdioServerParameters, stdio_client

        env = minimal_env()
        for env_name, secret_name in (self.config.get("env_secrets") or {}).items():
            value = self.hub.secrets.get(secret_name)
            if value is None:
                self.status, self.error = "error", f"secret {secret_name} is not defined"
                self._ready.set()
                return
            env[env_name] = value
        params = StdioServerParameters(
            command=self.config["command"], args=list(self.config.get("args", [])), env=env, cwd=self.config.get("cwd")
        )
        try:
            async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
                await session.initialize()
                listed = await session.list_tools()
                for item in listed.tools:
                    self._register(item)
                self.status, self.error = "connected", None
                self._ready.set()
                while True:
                    name, arguments, future = await self._requests.get()
                    try:
                        future.set_result(await session.call_tool(name, arguments))
                    except Exception as exc:  # report per call, keep the connection
                        if not future.done():
                            future.set_exception(exc)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.status, self.error = "error", self.hub.redactor.text(f"{type(exc).__name__}: {exc}")
            log.warning("MCP server %s failed: %s", self.name, self.error)
        finally:
            self.hub.tools.unregister_source(f"mcp:{self.name}")
            self._ready.set()

    def _register(self, item) -> None:
        schema = item.input_schema or {"type": "object", "properties": {}}
        remote = item.name

        async def handler(args: PassthroughArgs, ctx: ToolContext) -> ToolResult:
            arguments = args.model_dump()
            try:
                jsonschema.validate(arguments, schema)
            except jsonschema.ValidationError as exc:
                raise ToolError(f"invalid arguments: {exc.message}") from exc
            result = await self.call(remote, arguments)
            texts = [getattr(c, "text", "") for c in result.content or [] if getattr(c, "type", "") == "text"]
            other = [c.type for c in result.content or [] if getattr(c, "type", "") != "text"]
            body = "\n".join(texts) + (f"\n[{len(other)} non-text item(s): {', '.join(other)}]" if other else "")
            return ToolResult(
                truncate(body or "(empty result)", 100_000),
                {"structured": result.structured_content},
                is_error=bool(result.is_error),
            )

        name = tool_name(self.name, remote)
        self.hub.tools.tools.pop(name, None)
        self.hub.tools.register(
            Tool(
                name=name,
                description=f"[MCP {self.name}] {item.description or remote}"[:1000],
                args_model=PassthroughArgs,
                handler=handler,
                risk="external",
                default_permission=self.config.get("permission", "ask"),
                category=f"mcp:{self.name}",
                untrusted_output=True,
                timeout_s=float(self.config.get("timeout_s", 120)),
                input_schema_override=schema,
                source=f"mcp:{self.name}",
            )
        )
        self.tool_names.append(name)

    async def call(self, name: str, arguments: dict):
        if self.status != "connected":
            raise ToolError(f"MCP server {self.name} is not connected ({self.status})")
        future = asyncio.get_running_loop().create_future()
        await self._requests.put((name, arguments, future))
        return await future

    def describe(self) -> dict:
        safe = {k: v for k, v in self.config.items() if k != "env"}
        return {"name": self.name, "status": self.status, "error": self.error, "tools": self.tool_names, "config": safe}


class MCPHub:
    def __init__(self, settings, tools, secrets, redactor) -> None:
        self.settings, self.tools, self.secrets, self.redactor = settings, tools, secrets, redactor
        self.connections: dict[str, MCPConnection] = {}

    async def start(self) -> None:
        for config in self.settings.get("mcp.servers", []):
            if config.get("enabled", True) and config.get("name") and config.get("command"):
                connection = MCPConnection(config, self)
                self.connections[connection.name] = connection
                await connection.start()

    async def stop(self) -> None:
        for connection in list(self.connections.values()):
            await connection.stop()
        self.connections.clear()

    async def restart(self) -> None:
        await self.stop()
        await self.start()

    def status(self) -> list[dict]:
        configured = {c.get("name"): c for c in self.settings.get("mcp.servers", [])}
        out = []
        for name, config in configured.items():
            if name in self.connections:
                out.append(self.connections[name].describe())
            else:
                out.append(
                    {
                        "name": name,
                        "status": "disabled" if not config.get("enabled", True) else "stopped",
                        "error": None,
                        "tools": [],
                        "config": config,
                    }
                )
        return out
