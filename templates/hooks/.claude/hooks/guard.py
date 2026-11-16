"""PreToolUse guard for Claude Code.

Reads the hook payload on stdin. Exit code 2 blocks the tool call and shows the
reason to Claude; exit code 0 lets the normal permission rules decide.
This is a deterministic backstop: it holds even if instructions are ignored.
"""

from __future__ import annotations

import json
import re
import sys

SECRET_PATHS = re.compile(r"(^|[\\/])(\.env(?!\.(example|sample|template))(\.[^\\/]*)?|[^\\/]*\.(pem|key|p12|pfx)|"
                          r"id_rsa[^\\/]*|id_ed25519[^\\/]*|"
                          r"\.git-credentials|\.netrc|credentials\.json)$", re.IGNORECASE)
DANGEROUS_COMMANDS = [
    (re.compile(r"\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b"), "recursive forced delete"),
    (re.compile(r"\bgit\s+push\b.*(--force|-f\b)"), "force push"),
    (re.compile(r"\bgit\s+reset\s+--hard\b"), "hard reset"),
    (re.compile(r"\bgit\s+clean\s+-[a-zA-Z]*f"), "git clean"),
    (re.compile(r"(?i)\b(Remove-Item)\b.*-Recurse"), "recursive delete"),
    (re.compile(r"\b(mkfs|dd\s+if=|format\s+[a-z]:)"), "disk operation"),
    (re.compile(r"(?i)(cat|type|more|less|head|tail|Get-Content)\s+[^|;&]*\.env\b"), "reading a .env file"),
    (re.compile(r"(?i)\b(curl|wget|Invoke-WebRequest)\b[^|;&]*\|\s*(sh|bash|iex|python)"), "piping a download into a shell"),
]


def check(payload: dict) -> str | None:
    tool = payload.get("tool_name", "")
    tool_input = payload.get("tool_input") or {}
    if tool in {"Read", "Edit", "Write", "MultiEdit", "NotebookEdit"}:
        path = str(tool_input.get("file_path") or tool_input.get("notebook_path") or "")
        if SECRET_PATHS.search(path):
            return f"{tool} on a secrets file is blocked by the project guard hook: {path}"
    if tool == "Bash":
        command = str(tool_input.get("command", ""))
        for pattern, label in DANGEROUS_COMMANDS:
            if pattern.search(command):
                return f"blocked by the project guard hook ({label}): {command[:200]}"
    return None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 0  # never break the session on a malformed payload
    reason = check(payload)
    if reason:
        print(reason, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
