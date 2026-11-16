"""The AI agents a team member can run on.

Claude Code is built in (pae.runtime.claude_code). Every other agent is reached through the Agent Client
Protocol (ACP, https://agentclientprotocol.com), the open standard that Gemini CLI, Codex, GitHub Copilot, Cursor,
goose, OpenCode, Qwen Code, Mistral Vibe and many more speak (pae.runtime.acp). A team member's `provider` names
its agent: "claude-code", or "acp:<id>" for one of these.

Each agent runs on its own sign-in, the owner's own plan with that vendor. The platform never asks for, stores or
passes an API key (pae.subscription), and it never installs an agent: the owner does, once, with the command shown.
The owner can add any other ACP agent, or change how one is started, with the setting "engines.agents":
{"<id>": {"name": "...", "command": "...", "args": ["..."]}}.
"""

from __future__ import annotations

import re
import shutil
from dataclasses import asdict, dataclass
from pathlib import Path

ACP_PREFIX = "acp:"
ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,40}$")


@dataclass(frozen=True)
class Engine:
    id: str
    name: str
    command: str  # the executable, found on the PATH (or an absolute path)
    args: tuple[str, ...] = ()
    install: str = ""  # how the owner installs it
    sign_in: str = ""  # how the owner signs in once
    plan: str = ""  # what it runs on
    custom: bool = False

    @property
    def provider(self) -> str:
        return ACP_PREFIX + self.id

    def command_line(self) -> str:
        return " ".join([self.command, *self.args])

    def executable(self) -> str | None:
        """The program to start, or None when it is not installed on this PC."""
        path = Path(self.command)
        if path.is_absolute():
            return str(path) if path.is_file() else None
        return shutil.which(self.command)


# Launch commands from the ACP registry (cdn.agentclientprotocol.com/registry/v1/latest/registry.json, read
# 2026-11-16), for an agent installed on the PC. An agent's own docs are the reference for its sign-in.
CATALOG: tuple[Engine, ...] = (
    Engine(
        "gemini",
        "Gemini CLI",
        "gemini",
        ("--acp",),
        install="npm install -g @google/gemini-cli",
        sign_in="Run `gemini` once and choose Sign in with Google.",
        plan="Your Google account",
    ),
    Engine(
        "codex",
        "Codex",
        "codex-acp",
        (),
        install="npm install -g @agentclientprotocol/codex-acp",
        sign_in="Run `codex login` once with your ChatGPT account.",
        plan="Your ChatGPT plan",
    ),
    Engine(
        "copilot",
        "GitHub Copilot",
        "copilot",
        ("--acp",),
        install="npm install -g @github/copilot",
        sign_in="Run `copilot` once and type /login.",
        plan="Your GitHub Copilot plan",
    ),
    Engine(
        "cursor",
        "Cursor",
        "cursor-agent",
        ("acp",),
        install="Install the Cursor CLI: see cursor.com/cli",
        sign_in="Run `cursor-agent login` once.",
        plan="Your Cursor plan",
    ),
    Engine(
        "goose",
        "goose",
        "goose",
        ("acp",),
        install="Install goose: see block.github.io/goose",
        sign_in="Run `goose configure` once.",
        plan="The provider you chose in goose",
    ),
    Engine(
        "opencode",
        "OpenCode",
        "opencode",
        ("acp",),
        install="npm install -g opencode-ai",
        sign_in="Run `opencode auth login` once.",
        plan="The provider you chose in OpenCode",
    ),
    Engine(
        "qwen",
        "Qwen Code",
        "qwen",
        ("--acp",),
        install="npm install -g @qwen-code/qwen-code",
        sign_in="Run `qwen` once and sign in.",
        plan="Your Qwen account",
    ),
    Engine(
        "mistral-vibe",
        "Mistral Vibe",
        "vibe-acp",
        (),
        install="Install Mistral Vibe: see github.com/mistralai/mistral-vibe",
        sign_in="Run `vibe` once and sign in.",
        plan="Your Mistral account",
    ),
)


@dataclass
class Engines:
    """The catalog, with the owner's own agents and changes (setting "engines.agents") on top."""

    settings: object

    def all(self) -> list[Engine]:
        found = {engine.id: engine for engine in CATALOG}
        for engine_id, spec in (self.settings.get("engines.agents") or {}).items():
            engine = _custom(engine_id, spec, found.get(engine_id))
            if engine is not None:
                found[engine_id] = engine
        return list(found.values())

    def get(self, engine_id: str) -> Engine | None:
        return next((engine for engine in self.all() if engine.id == engine_id), None)

    def for_provider(self, provider: str | None) -> Engine | None:
        if not provider or not provider.startswith(ACP_PREFIX):
            return None
        return self.get(provider[len(ACP_PREFIX) :])

    def describe(self, engine: Engine) -> dict:
        data = asdict(engine)
        data.update(
            {
                "provider": engine.provider,
                "args": list(engine.args),
                "command": engine.command_line(),
                "installed": engine.executable() is not None,
                "builtin": False,
            }
        )
        return data


SPEC_KEYS = {"name", "command", "args", "install", "sign_in", "plan"}


def engines_problem(value) -> str | None:
    """Why the setting "engines.agents" cannot be saved, or None. It holds no environment: an agent started by the
    platform gets no API key, whatever the setting says."""
    if not isinstance(value, dict):
        return "must be an object of agents"
    known = {engine.id for engine in CATALOG}
    for engine_id, spec in value.items():
        if not ID.match(str(engine_id)):
            return f"'{engine_id}' is not a valid id (lowercase letters, digits, . _ -)"
        if not isinstance(spec, dict):
            return f"'{engine_id}' must be an object"
        unknown = set(spec) - SPEC_KEYS
        if unknown:
            return f"'{engine_id}' has unknown fields: {', '.join(sorted(unknown))}"
        if engine_id not in known and not str(spec.get("command") or "").strip():
            return f"'{engine_id}' needs the command that starts it"
        args = spec.get("args", [])
        if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
            return f"'{engine_id}': args must be a list of strings"
    return None


def _custom(engine_id: str, spec, base: Engine | None) -> Engine | None:
    """An agent the owner added, or a catalog agent the owner starts another way (for example through npx)."""
    if not isinstance(spec, dict) or not ID.match(str(engine_id)):
        return None
    command = str(spec.get("command") or (base.command if base else "")).strip()
    if not command:
        return None
    args = spec.get("args", list(base.args) if base else [])
    if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
        return None
    return Engine(
        id=engine_id,
        name=str(spec.get("name") or (base.name if base else engine_id)),
        command=command,
        args=tuple(args),
        install=str(spec.get("install") or (base.install if base else "")),
        sign_in=str(spec.get("sign_in") or (base.sign_in if base else "See the agent's own documentation.")),
        plan=str(spec.get("plan") or (base.plan if base else "The agent's own sign-in")),
        custom=base is None,
    )
