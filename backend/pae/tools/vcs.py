"""Git and SQL-database tools."""

from __future__ import annotations

import asyncio
import json
import sqlite3

from pydantic import Field

from pae.tools.base import Args, Tool, ToolContext, ToolError, ToolResult, resolve_path, truncate
from pae.tools.execution import run_process

# Hooks, fsmonitor and pagers are disabled so a repository cannot run code through git.
GIT_SAFE = [
    "git",
    "-c",
    "core.hooksPath=",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.pager=cat",
    "-c",
    "color.ui=never",
]


async def git(ctx: ToolContext, *args: str, timeout_s: float = 60) -> str:
    if not (ctx.workspace / ".git").exists():
        raise ToolError("the workspace is not a git repository")
    result = await run_process([*GIT_SAFE, *args], ctx.workspace, timeout_s)
    if result["exit_code"] != 0:
        raise ToolError(f"git {args[0]} failed: {result['stderr'].strip()[:1000]}")
    return result["stdout"]


class NoArgs(Args):
    pass


async def git_status(_args: NoArgs, ctx: ToolContext) -> ToolResult:
    out = await git(ctx, "status", "--short", "--branch")
    return ToolResult(out or "(clean)")


class DiffArgs(Args):
    ref: str | None = Field(None, description="Compare against this ref (default: working tree vs HEAD)")
    staged: bool = False
    path: str | None = None


async def git_diff(args: DiffArgs, ctx: ToolContext) -> ToolResult:
    argv = ["diff", "--no-ext-diff"]
    if args.staged:
        argv.append("--staged")
    if args.ref:
        if args.ref.startswith("-"):
            raise ToolError("invalid ref")
        argv.append(args.ref)
    if args.path:
        argv += ["--", str(resolve_path(ctx.workspace, args.path).relative_to(ctx.workspace.resolve()))]
    out = await git(ctx, *argv)
    return ToolResult(truncate(out, 80_000) or "(no differences)")


class LogArgs(Args):
    max_count: int = Field(20, ge=1, le=200)


async def git_log(args: LogArgs, ctx: ToolContext) -> ToolResult:
    out = await git(ctx, "log", f"--max-count={args.max_count}", "--pretty=format:%h %ad %an %s", "--date=short")
    return ToolResult(out or "(no commits)")


class CommitArgs(Args):
    message: str = Field(min_length=3)
    paths: list[str] = Field(default_factory=list, description="Paths to stage first (default: all changes)")


async def git_commit(args: CommitArgs, ctx: ToolContext) -> ToolResult:
    paths = [str(resolve_path(ctx.workspace, p).relative_to(ctx.workspace.resolve())) for p in args.paths]
    await git(ctx, "add", "--", *(paths or ["."]))
    out = await git(ctx, "commit", "--no-verify", "-m", args.message)
    return ToolResult(out.strip())


class SqlArgs(Args):
    database: str = Field(description="SQLite database file in the workspace")
    sql: str = Field(description="A read-only SELECT statement")
    max_rows: int = Field(200, ge=1, le=5000)


def _sql(path, sql: str, max_rows: int) -> dict:
    connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    try:
        allowed = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION}
        connection.set_authorizer(lambda action, *_: sqlite3.SQLITE_OK if action in allowed else sqlite3.SQLITE_DENY)
        try:
            cursor = connection.execute(sql)
        except sqlite3.DatabaseError as exc:
            raise ToolError(f"query rejected: {exc}") from exc
        rows = cursor.fetchmany(max_rows + 1)
        return {
            "columns": [d[0] for d in cursor.description or []],
            "rows": [list(r) for r in rows[:max_rows]],
            "truncated": len(rows) > max_rows,
        }
    finally:
        connection.close()


async def sql_query(args: SqlArgs, ctx: ToolContext) -> ToolResult:
    path = resolve_path(ctx.workspace, args.database, must_exist=True)
    result = await asyncio.to_thread(_sql, path, args.sql, args.max_rows)
    return ToolResult(truncate(json.dumps(result, default=str), 100_000), result)


TOOLS = [
    Tool(
        "git_status",
        "Show the git branch and changed files of the workspace.",
        NoArgs,
        git_status,
        "read",
        "allow",
        "git",
    ),
    Tool(
        "git_diff",
        "Show a git diff of the workspace.",
        DiffArgs,
        git_diff,
        "read",
        "allow",
        "git",
        untrusted_output=True,
    ),
    Tool("git_log", "Show recent commits.", LogArgs, git_log, "read", "allow", "git"),
    Tool(
        "git_commit", "Stage paths and create a commit (hooks disabled).", CommitArgs, git_commit, "write", "ask", "git"
    ),
    Tool(
        "sql_query",
        "Run a read-only SELECT against a SQLite database file in the workspace.",
        SqlArgs,
        sql_query,
        "read",
        "allow",
        "data",
        untrusted_output=True,
    ),
]
