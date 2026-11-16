"""Open Anthropic's own Claude Code sign-in from the web interface.

The button in the UI does what `pae claude-login` does in a terminal: it starts the
platform's Claude Code binary with `auth login --claudeai` in a new console window on
this computer. The sign-in itself stays entirely in Anthropic's flow (that window and
the browser); the platform never sees, reads or stores the credential.

Only possible when the server runs on the owner's own Windows desktop and listens on
the loopback address: a window opened on a remote server or in a container would be
useless. Elsewhere the UI shows the command to run instead.
"""

from __future__ import annotations

import os
import subprocess

from pae.config import Config

COMMAND = "pae claude-login"
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


def can_open_window(config: Config) -> tuple[bool, str]:
    if os.name != "nt":
        return False, "Opening a sign-in window is supported when the platform runs on your Windows desktop."
    if config.host not in LOCAL_HOSTS:
        return False, "The platform is not running on this computer only (it listens on a network address)."
    return True, ""


def open_sign_in_window(config: Config) -> dict:
    """Start Claude Code's subscription sign-in in a new console window. Never raises for expected cases."""
    from pae.runtime.claude_code import find_cli

    possible, reason = can_open_window(config)
    if not possible:
        return {"opened": False, "reason": reason, "command": COMMAND}
    cli = find_cli(config.claude_code_path)
    if not cli:
        return {"opened": False, "reason": "The Claude Code program was not found.", "command": COMMAND}
    home = config.claude_config_dir or config.data_dir / "claude-home"
    home.mkdir(parents=True, exist_ok=True)
    # The process environment was already cleaned of paid-provider variables at startup.
    env = {**os.environ, "CLAUDE_CONFIG_DIR": str(home)}
    subprocess.Popen(  # noqa: S603 - fixed program and arguments, nothing from the request
        [cli, "auth", "login", "--claudeai"],
        env=env,
        cwd=str(home),
        creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0),
    )
    return {"opened": True, "reason": "", "command": COMMAND}
