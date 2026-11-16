"""Provider registry. Policy: subscriptions, never API keys (see pae.subscription).

Providers:
- `claude-code`: the unmodified Claude Code binary, signed in with the owner's Claude subscription.
- `acp:<id>`: any agent that speaks the Agent Client Protocol (Gemini CLI, Codex, GitHub Copilot, Cursor...),
  on its own sign-in (pae.engines, pae.runtime.acp).
- `scripted`: a deterministic test double. It is not a model and makes no network call.

Paid providers (API keys, pay-per-token endpoints) are refused by `resolve`.
"""

from __future__ import annotations

import os
from pathlib import Path

from pae.engines import ACP_PREFIX, Engines
from pae.providers.base import ProviderNotConfigured
from pae.providers.scripted import ScriptedProvider
from pae.subscription import ALLOWED_PROVIDERS, POLICY, SUBSCRIPTION_ENV, paid_env_names

PROVIDER_INFO = {
    "claude-code": "Claude Code on your Claude subscription.",
    "scripted": "Deterministic test provider. Not a model: replays a script, for tests and evals.",
}


class Providers:
    def __init__(self, settings, config_dir_getter, cli_finder, usage_state_getter=lambda: None) -> None:
        self.settings = settings
        self.config_dir = config_dir_getter
        self.cli_finder = cli_finder
        self.usage_state = usage_state_getter
        self.engines = Engines(settings)
        self._chat = {"scripted": ScriptedProvider()}

    def register(self, name: str, provider) -> None:
        """Tests can plug in further test doubles; real providers must pass the policy."""
        if name not in ALLOWED_PROVIDERS:
            raise ProviderNotConfigured(f"provider '{name}' is not allowed by the {POLICY} policy")
        self._chat[name] = provider

    def resolve(self, name: str | None) -> str:
        if not name or name == "default":
            name = self.settings.get("providers.default")
        if name.startswith(ACP_PREFIX):
            engine = self.engines.for_provider(name)
            if engine is None:
                raise ProviderNotConfigured(
                    f"'{name[len(ACP_PREFIX) :]}' is not an agent this platform knows: add it in the setting "
                    "'engines.agents'"
                )
            if engine.executable() is None:
                raise ProviderNotConfigured(
                    f"{engine.name} is not installed on this PC ({engine.command} not found). "
                    f"Install it: {engine.install}. Then sign in once: {engine.sign_in}"
                )
            return name
        if name not in ALLOWED_PROVIDERS:
            raise ProviderNotConfigured(
                f"provider '{name}' is not available: agents run on your own subscriptions (Claude Code, or an ACP "
                "agent such as Gemini CLI or Codex on its own sign-in), never on an API key"
            )
        return name

    def engines_status(self) -> list[dict]:
        """Every agent a team member can run on: Claude Code first, then the ACP agents."""
        claude = self.claude_code_status()
        builtin = {
            "id": "claude-code",
            "provider": "claude-code",
            "name": "Claude Code",
            "builtin": True,
            "installed": bool(claude["cli_path"]),
            "signed_in": claude["configured"],
            "command": "",
            "args": [],
            "install": "",
            "sign_in": "Sign in from Settings with your Claude account.",
            "plan": "Your Claude plan",
            "custom": False,
        }
        return [builtin, *(self.engines.describe(engine) for engine in self.engines.all())]

    def chat(self, name: str):
        if name not in self._chat:
            raise ProviderNotConfigured(f"'{name}' is not a chat provider")
        return self._chat[name]

    def default_model(self, name: str) -> str | None:
        if name == "claude-code":
            return self.settings.get("providers.claude_code.default_model")  # None: the plan's default
        return "scripted" if name == "scripted" else None  # an ACP agent uses the model its own settings choose

    def claude_code_status(self) -> dict:
        """Readiness without reading any credential: only whether one exists, and where."""
        cli = self.cli_finder()
        config_dir = Path(self.config_dir())
        signed_in = (config_dir / ".credentials.json").is_file()
        env_token = bool(os.environ.get(SUBSCRIPTION_ENV))
        paid = paid_env_names()
        usage = self.usage_state() or {}
        if not cli:
            detail, auth = "Claude Code CLI not found.", "none"
        elif paid:
            detail, auth = f"Blocked: paid credential variables present ({', '.join(paid)}).", "blocked"
        elif signed_in:
            detail, auth = "Signed in with your Claude subscription (platform login).", "login"
        elif env_token:
            detail, auth = f"Using the subscription token from the environment ({SUBSCRIPTION_ENV}).", "env_token"
        else:
            detail, auth = (
                (
                    "Not signed in. Run `pae claude-login` once in a terminal and complete Anthropic's "
                    "sign-in with your Claude account."
                ),
                "none",
            )
        if usage.get("blocked_until"):
            detail += f" Usage limit reached until {usage['blocked_until']}."
        return {
            "configured": bool(cli) and auth in ("login", "env_token") and not usage.get("blocked_until"),
            "detail": detail,
            "cli_path": cli,
            "auth": auth,
            "config_dir": str(config_dir),
            "usage": usage,
            "policy": POLICY,
        }

    def status(self) -> list[dict]:
        out = []
        for name in ALLOWED_PROVIDERS:
            state = (
                self.claude_code_status()
                if name == "claude-code"
                else {"configured": True, "detail": "Deterministic test provider (no model)."}
            )
            out.append(
                {
                    "name": name,
                    "description": PROVIDER_INFO[name],
                    "default_model": self.default_model(name),
                    "is_default": self.settings.get("providers.default") == name,
                    **state,
                }
            )
        return out
