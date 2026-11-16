"""File tools, confined to the run's workspace."""

from __future__ import annotations

import fnmatch
import os
import re
from pathlib import Path
from typing import Literal

from pydantic import Field

from pae.tools.base import (
    SKIP_DIRS,
    Args,
    Tool,
    ToolContext,
    ToolError,
    ToolResult,
    is_blocked,
    is_protected,
    rel,
    resolve_path,
    truncate,
)

MAX_READ_BYTES = 2_000_000


class ListArgs(Args):
    path: str = Field(".", description="Directory relative to the workspace")
    pattern: str = Field("*", description="Glob pattern for names, e.g. '*.py'")
    recursive: bool = False
    max_entries: int = Field(300, ge=1, le=2000)


async def fs_list(args: ListArgs, ctx: ToolContext) -> ToolResult:
    base = resolve_path(ctx.workspace, args.path, must_exist=True)
    if not base.is_dir():
        raise ToolError(f"'{args.path}' is not a directory")
    entries = []
    iterator = base.rglob(args.pattern) if args.recursive else base.glob(args.pattern)
    for item in iterator:
        if any(part in SKIP_DIRS for part in item.relative_to(base).parts) or is_blocked(item):
            continue
        entries.append(
            {
                "path": rel(ctx.workspace, item),
                "type": "dir" if item.is_dir() else "file",
                "size": item.stat().st_size if item.is_file() else None,
            }
        )
        if len(entries) >= args.max_entries:
            break
    entries.sort(key=lambda e: e["path"])
    lines = [
        f"{e['path']}{'/' if e['type'] == 'dir' else ''}" + (f"  ({e['size']} B)" if e["size"] is not None else "")
        for e in entries
    ]
    note = f"\n[stopped at {args.max_entries} entries]" if len(entries) >= args.max_entries else ""
    return ToolResult("\n".join(lines) + note if lines else "(no matching entries)", {"entries": entries})


class ReadArgs(Args):
    path: str = Field(description="File relative to the workspace")
    start_line: int = Field(1, ge=1)
    max_lines: int = Field(400, ge=1, le=5000)


async def fs_read(args: ReadArgs, ctx: ToolContext) -> ToolResult:
    target = resolve_path(ctx.workspace, args.path, must_exist=True)
    if not target.is_file():
        raise ToolError(f"'{args.path}' is not a file")
    if target.stat().st_size > MAX_READ_BYTES:
        raise ToolError(f"'{args.path}' is larger than {MAX_READ_BYTES} bytes; use doc_extract_text or fs_search")
    raw = target.read_bytes()
    if b"\x00" in raw[:4096]:
        raise ToolError(f"'{args.path}' looks binary; use doc_extract_text for documents")
    lines = raw.decode("utf-8", errors="replace").splitlines()
    end = min(len(lines), args.start_line - 1 + args.max_lines)
    shown = [f"{n:>5}  {lines[n - 1]}" for n in range(args.start_line, end + 1)]
    footer = f"\n[lines {args.start_line}-{end} of {len(lines)}]" if end < len(lines) or args.start_line > 1 else ""
    return ToolResult("\n".join(shown) + footer, {"path": rel(ctx.workspace, target), "total_lines": len(lines)})


class SearchArgs(Args):
    pattern: str = Field(description="Python regular expression")
    path: str = "."
    glob: str = Field("*", description="Only search files whose name matches this glob")
    ignore_case: bool = False
    max_results: int = Field(100, ge=1, le=1000)


async def fs_search(args: SearchArgs, ctx: ToolContext) -> ToolResult:
    base = resolve_path(ctx.workspace, args.path, must_exist=True)
    try:
        regex = re.compile(args.pattern, re.IGNORECASE if args.ignore_case else 0)
    except re.error as exc:
        raise ToolError(f"invalid regular expression: {exc}") from exc

    matches = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not is_blocked(Path(dirpath) / d)]
        for filename in filenames:
            if not fnmatch.fnmatch(filename, args.glob):
                continue
            p = Path(dirpath) / filename
            if is_protected(p) or is_blocked(p):
                continue
            try:
                if p.stat().st_size > MAX_READ_BYTES:
                    continue
                data = p.read_bytes()
            except OSError:
                continue
            if b"\x00" in data[:4096]:
                continue
            for number, line in enumerate(data.decode("utf-8", errors="replace").splitlines(), 1):
                if regex.search(line):
                    matches.append({"path": rel(ctx.workspace, p), "line": number, "text": line.strip()[:300]})
                    if len(matches) >= args.max_results:
                        break
            if len(matches) >= args.max_results:
                break
        if len(matches) >= args.max_results:
            break
    text = "\n".join(f"{m['path']}:{m['line']}: {m['text']}" for m in matches) or "(no matches)"
    return ToolResult(truncate(text, 60_000), {"matches": matches})


class WriteArgs(Args):
    path: str
    content: str
    mode: Literal["create", "overwrite", "append"] = Field("create", description="'create' fails if the file exists")


async def fs_write(args: WriteArgs, ctx: ToolContext) -> ToolResult:
    target = resolve_path(ctx.workspace, args.path)
    if target.exists() and target.is_dir():
        raise ToolError(f"'{args.path}' is a directory")
    if args.mode == "create" and target.exists():
        raise ToolError(f"'{args.path}' already exists; use mode 'overwrite' to replace it")
    target.parent.mkdir(parents=True, exist_ok=True)
    existed = target.exists()
    with open(target, "a" if args.mode == "append" else "w", encoding="utf-8", newline="\n") as handle:
        handle.write(args.content)
    verb = "appended to" if args.mode == "append" else ("overwrote" if existed else "created")
    return ToolResult(
        f"{verb} {rel(ctx.workspace, target)} ({len(args.content)} characters)",
        {"path": rel(ctx.workspace, target), "mode": args.mode, "bytes": len(args.content.encode())},
    )


class DeleteArgs(Args):
    path: str


async def fs_delete(args: DeleteArgs, ctx: ToolContext) -> ToolResult:
    target = resolve_path(ctx.workspace, args.path, must_exist=True)
    if target == ctx.workspace.resolve():
        raise ToolError("refusing to delete the workspace root")
    if target.is_dir():
        if any(target.iterdir()):
            raise ToolError("refusing to delete a non-empty directory")
        target.rmdir()
    else:
        target.unlink()
    return ToolResult(f"deleted {rel(ctx.workspace, target)}", {"path": rel(ctx.workspace, target)})


TOOLS = [
    Tool("fs_list", "List files and directories in the workspace.", ListArgs, fs_list, "read", "allow", "files"),
    Tool(
        "fs_read",
        "Read a text file from the workspace, with line numbers.",
        ReadArgs,
        fs_read,
        "read",
        "allow",
        "files",
        untrusted_output=True,
    ),
    Tool(
        "fs_search",
        "Search workspace files for a regular expression; returns path:line matches.",
        SearchArgs,
        fs_search,
        "read",
        "allow",
        "files",
        untrusted_output=True,
    ),
    Tool(
        "fs_write",
        "Create, overwrite or append to a text file in the workspace.",
        WriteArgs,
        fs_write,
        "write",
        "ask",
        "files",
    ),
    Tool(
        "fs_delete",
        "Delete a file or an empty directory in the workspace.",
        DeleteArgs,
        fs_delete,
        "destructive",
        "ask",
        "files",
    ),
]
