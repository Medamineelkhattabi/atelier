"""Command and code execution: approval-gated, time-limited, confined to the
workspace, with a minimal environment that contains no secrets. Optionally inside
a Docker container with no network (setting shell.sandbox = "docker").
"""

from __future__ import annotations

import asyncio
import os
import signal
import subprocess
import sys
import uuid
from pathlib import Path

from pydantic import Field

from pae.tools.base import Args, Tool, ToolContext, ToolError, ToolResult, truncate

SAFE_ENV_KEYS = (
    "PATH",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "LANG",
    "LC_ALL",
    "TZ",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
)
MAX_OUTPUT = 60_000


def minimal_env() -> dict[str, str]:
    env = {k: os.environ[k] for k in SAFE_ENV_KEYS if k in os.environ}
    env["PYTHONIOENCODING"] = "utf-8"
    env["PAE_SANDBOXED"] = "1"
    return env


async def run_process(argv: list[str], cwd: Path, timeout_s: float) -> dict:
    kwargs: dict = {
        "cwd": str(cwd),
        "env": minimal_env(),
        "stdout": asyncio.subprocess.PIPE,
        "stderr": asyncio.subprocess.PIPE,
        "stdin": asyncio.subprocess.DEVNULL,
    }
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    process = await asyncio.create_subprocess_exec(*argv, **kwargs)
    timed_out = False
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout_s)
    except TimeoutError:
        await _kill_tree(process)
        stdout, stderr, timed_out = b"", b"", True
    except asyncio.CancelledError:
        await _kill_tree(process)  # a cancelled run must not leave processes behind
        raise
    return {
        "exit_code": process.returncode,
        "stdout": stdout.decode("utf-8", errors="replace"),
        "stderr": stderr.decode("utf-8", errors="replace"),
        "timed_out": timed_out,
    }


async def _kill_tree(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    try:
        if os.name == "nt":
            killer = await asyncio.create_subprocess_exec(
                "taskkill",
                "/T",
                "/F",
                "/PID",
                str(process.pid),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await killer.wait()
        else:
            os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, OSError):
        pass
    try:
        await asyncio.wait_for(process.wait(), timeout=5)
    except TimeoutError:
        pass


def shell_argv(command: str, ctx: ToolContext) -> list[str]:
    if ctx.settings.get("shell.sandbox") == "docker":
        image = ctx.settings.get("shell.docker_image", "python:3.12-slim")
        return [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--memory",
            "1g",
            "--cpus",
            "1",
            "--pids-limit",
            "256",
            "-v",
            f"{ctx.workspace.resolve()}:/workspace",
            "-w",
            "/workspace",
            image,
            "sh",
            "-c",
            command,
        ]
    if os.name == "nt":
        return ["cmd.exe", "/d", "/s", "/c", command]
    return ["/bin/sh", "-c", command]


def format_result(result: dict) -> str:
    parts = [f"exit code: {result['exit_code']}" + (" (timed out, process killed)" if result["timed_out"] else "")]
    if result["stdout"]:
        parts.append("stdout:\n" + truncate(result["stdout"], MAX_OUTPUT))
    if result["stderr"]:
        parts.append("stderr:\n" + truncate(result["stderr"], MAX_OUTPUT // 2))
    return "\n".join(parts)


class ShellArgs(Args):
    command: str = Field(description="Command line, run from the workspace root")
    timeout_s: float = Field(120, ge=1, le=1800)


async def shell_run(args: ShellArgs, ctx: ToolContext) -> ToolResult:
    if not args.command.strip():
        raise ToolError("empty command")
    result = await run_process(shell_argv(args.command, ctx), ctx.workspace, args.timeout_s)
    result["stdout"], result["stderr"] = ctx.redactor.text(result["stdout"]), ctx.redactor.text(result["stderr"])
    return ToolResult(
        format_result(result),
        {k: v for k, v in result.items() if k in ("exit_code", "timed_out")},
        is_error=result["timed_out"] or result["exit_code"] != 0,
    )


class PythonArgs(Args):
    code: str = Field(description="Python 3 source to execute in the workspace")
    timeout_s: float = Field(60, ge=1, le=600)


async def code_run_python(args: PythonArgs, ctx: ToolContext) -> ToolResult:
    scratch = ctx.workspace / ".pae_tmp"
    scratch.mkdir(parents=True, exist_ok=True)
    script = scratch / f"snippet_{uuid.uuid4().hex[:8]}.py"
    script.write_text(args.code, encoding="utf-8")
    try:
        if ctx.settings.get("shell.sandbox") == "docker":
            argv = shell_argv(f"python -I .pae_tmp/{script.name}", ctx)
        else:
            argv = [sys.executable, "-I", str(script)]
        result = await run_process(argv, ctx.workspace, args.timeout_s)
    finally:
        script.unlink(missing_ok=True)
    result["stdout"], result["stderr"] = ctx.redactor.text(result["stdout"]), ctx.redactor.text(result["stderr"])
    return ToolResult(
        format_result(result),
        {k: v for k, v in result.items() if k in ("exit_code", "timed_out")},
        is_error=result["timed_out"] or result["exit_code"] != 0,
    )


TOOLS = [
    Tool(
        "shell_run",
        "Run a command in the workspace (minimal environment, no secrets, time-limited).",
        ShellArgs,
        shell_run,
        "execute",
        "ask",
        "execution",
        timeout_s=1900,
    ),
    Tool(
        "code_run_python",
        "Execute a Python snippet in the workspace and return its output.",
        PythonArgs,
        code_run_python,
        "execute",
        "ask",
        "execution",
        timeout_s=700,
    ),
]
