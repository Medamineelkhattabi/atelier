"""Claude Code's memory for a project: the owner's earlier notes, read-only.

The index (MEMORY.md) is already in every task's project context (pae.projects); this tool opens
one note from it. It is only offered in projects whose folder has such a memory.
"""

from __future__ import annotations

import re

from pydantic import Field

from pae.tools.base import Args, Tool, ToolContext, ToolError, ToolResult, truncate

NOTE_NAME = re.compile(r"^[\w][\w.-]{0,150}\.md$")
NOTE_CHARS = 40_000


class MemoryReadArgs(Args):
    note: str = Field(description="The note's file name, as written in the memory index, e.g. 'rejet-un-par-un.md'.")


async def project_memory_read(args: MemoryReadArgs, ctx: ToolContext) -> ToolResult:
    projects = getattr(ctx.manager, "projects", None)
    folder = projects.memory_folder(ctx.project_id) if projects else None
    if folder is None:
        raise ToolError("this project has no Claude Code memory")
    name = args.note.strip().split("/")[-1].split("\\")[-1]
    if not NOTE_NAME.match(name):
        raise ToolError(f"'{args.note}' is not a memory note name (expected something like 'note-name.md')")
    path = (folder / name).resolve()
    if path.parent != folder.resolve() or not path.is_file():
        raise ToolError(f"there is no memory note named '{name}': use a name from the memory index")
    text = path.read_text(encoding="utf-8", errors="replace")
    return ToolResult(truncate(text, NOTE_CHARS), data={"note": name, "chars": len(text)})


TOOLS = [
    Tool(
        "project_memory_read",
        "Open one note of Claude Code's memory for this project (the owner's earlier rules, decisions and facts). "
        "The memory index is in your project context.",
        MemoryReadArgs,
        project_memory_read,
        "read",
        "allow",
        "files",
    ),
]

# Offered to every agent working in a project whose folder has a Claude Code memory.
PROJECT_MEMORY_TOOLS = [tool.name for tool in TOOLS]
