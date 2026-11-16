"""Minimal stdio MCP server used by the MCP client tests."""

from mcp.server.mcpserver import MCPServer

server = MCPServer(name="echo")


@server.tool(description="Echo the text back")
def echo(text: str) -> str:
    return f"echo: {text}"


@server.tool(description="Add two integers")
def add(a: int, b: int) -> int:
    return a + b


if __name__ == "__main__":
    server.run("stdio")
