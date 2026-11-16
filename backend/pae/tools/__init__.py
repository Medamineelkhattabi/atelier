"""Built-in tool registry."""

from __future__ import annotations

from pae.tools import agents, data, documents, execution, fs, memory, messaging, vcs, web
from pae.tools.base import ToolRegistry


def builtin_registry() -> ToolRegistry:
    registry = ToolRegistry()
    for module in (fs, documents, data, web, execution, vcs, messaging, agents, memory):
        for tool in module.TOOLS:
            registry.register(tool)
    return registry
