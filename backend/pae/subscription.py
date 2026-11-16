"""AI access policy: subscriptions, never API keys.

Every model call the platform makes goes through an agent signed in with the owner's own plan: the unmodified
Claude Code binary on the owner's claude.ai subscription (Anthropic's own login flow), or an ACP agent on its own
sign-in (pae.engines). The platform never asks for, stores or passes an API key. This module removes every route
by which Claude Code could bill somewhere else, checks each Claude Code session's credential source before any work
happens, and removes AI vendors' API keys from the environment of every other agent.

References (Claude Code docs, checked 2026-11-11):
- Authentication precedence: cloud-provider variables, ANTHROPIC_AUTH_TOKEN,
  ANTHROPIC_API_KEY (always used by `claude -p` when present), apiKeyHelper,
  CLAUDE_CODE_OAUTH_TOKEN, Anthropic profiles, then the /login subscription credential.
- `--bare` never reads OAuth credentials, so the platform never uses it.
- Usage credits (pay-as-you-go beyond plan limits) apply automatically to Claude Code
  when enabled on the account; Claude Code reports them as "overage" rate-limit state.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from datetime import UTC, datetime

log = logging.getLogger("pae.subscription")

POLICY = "subscription-only"
# Built-in providers; ACP agents ("acp:<id>", pae.engines) are allowed too, each on its own sign-in.
ALLOWED_PROVIDERS = ("claude-code", "scripted")  # scripted is a test double: no model, no network
# AI vendors' API keys and paid endpoints: an agent started by the platform never sees them, so it runs on its
# own sign-in or not at all.
_AGENT_KEY_ENV = re.compile(
    r"^(ANTHROPIC_.*|CLAUDE_CODE_USE_.*|OPENAI_.*|AZURE_OPENAI_.*|GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_.*"
    r"|VERTEXAI_.*|MISTRAL_API_KEY|GROQ_API_KEY|DEEPSEEK_API_KEY|OPENROUTER_API_KEY|XAI_API_KEY|TOGETHER_API_KEY"
    r"|FIREWORKS_API_KEY|DASHSCOPE_API_KEY|MOONSHOT_API_KEY|CURSOR_API_KEY|COHERE_API_KEY|PERPLEXITY_API_KEY"
    r"|AWS_BEARER_TOKEN_BEDROCK|.*_LLM_API_KEY)$",
    re.IGNORECASE,
)


def is_allowed_provider(name: str | None) -> bool:
    return bool(name) and (name in ALLOWED_PROVIDERS or name.startswith("acp:"))


def agent_environment(environ: dict | None = None) -> tuple[dict, list[str]]:
    """The environment for an ACP agent: this process's, without any AI vendor's API key."""
    environ = dict(os.environ if environ is None else environ)
    removed = sorted(name for name in environ if _AGENT_KEY_ENV.match(name))
    for name in removed:
        environ.pop(name)
    return environ, removed


# Any of these would make Claude Code authenticate with something other than the
# subscription login (API key, bearer token, cloud provider, Anthropic profile or
# federation, custom endpoint). They are removed from the platform process.
_PAID_ENV = re.compile(
    r"^(ANTHROPIC_.*|CLAUDE_CODE_USE_.*|AWS_BEARER_TOKEN_BEDROCK|CLOUD_ML_REGION|VERTEX_REGION_.*"
    r"|CLAUDE_CODE_SKIP_.*_AUTH|CLAUDE_CODE_API_KEY_HELPER_TTL_MS)$",
    re.IGNORECASE,
)
# The subscription's own long-lived token (`claude setup-token`) may be provided by the
# owner in the environment. The platform passes it through untouched; it never stores it.
SUBSCRIPTION_ENV = "CLAUDE_CODE_OAUTH_TOKEN"
FORBIDDEN_SECRET = re.compile(
    r"^(ANTHROPIC_.*|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_.*|AZURE_OPENAI_.*|GEMINI_API_KEY|MISTRAL_API_KEY|GROQ_API_KEY"
    r"|DEEPSEEK_API_KEY|OPENROUTER_API_KEY|XAI_API_KEY|TOGETHER_API_KEY|FIREWORKS_API_KEY|DASHSCOPE_API_KEY"
    r"|MOONSHOT_API_KEY|CURSOR_API_KEY|COHERE_API_KEY|PERPLEXITY_API_KEY|.*_API_KEY_FOR_LLM)$"
)


class PolicyViolation(Exception):
    """A model call would not be covered by the subscription."""


def paid_env_names(environ: dict | None = None) -> list[str]:
    environ = os.environ if environ is None else environ
    return sorted(name for name in environ if _PAID_ENV.match(name))


def scrub_environment() -> list[str]:
    """Remove paid-credential variables from this process (and so from every child)."""
    removed = paid_env_names()
    for name in removed:
        os.environ.pop(name, None)
    if removed:
        log.warning("Subscription-only policy: removed %s from the environment.", ", ".join(removed))
    return removed


def assert_clean_environment() -> None:
    """Called right before a Claude Code session starts."""
    leftover = scrub_environment()
    if paid_env_names():
        raise PolicyViolation(f"paid credential variables could not be removed: {', '.join(leftover)}")


def check_credential_source(api_key_source: str | None) -> None:
    """Claude Code reports `apiKeySource` in its init message: "none" means a claude.ai
    login (subscription). Anything else is an API key, helper or managed key: refuse."""
    if api_key_source not in (None, "none"):
        raise PolicyViolation(
            f"Claude Code is authenticated with '{api_key_source}', which bills the Anthropic API. "
            "The platform only runs on your Claude subscription; the session was stopped before any work."
        )


@dataclass
class UsageSignal:
    action: str  # "ok" | "warn" | "stop_limit" | "stop_overage"
    message: str
    resets_at: datetime | None = None
    window: str | None = None
    utilization: float | None = None
    overage_status: str | None = None  # Claude Code's report on pay-as-you-go usage; None = not reported


def classify_rate_limit(info) -> UsageSignal:
    """Interpret Claude Code's rate-limit state (Agent SDK RateLimitInfo or a raw dict)."""

    def field(name):
        return info.get(name) if isinstance(info, dict) else getattr(info, name, None)

    status, window = field("status"), field("rate_limit_type")
    overage = field("overage_status")
    resets = field("resets_at")
    resets_at = datetime.fromtimestamp(resets, UTC) if isinstance(resets, int | float) else None
    utilization = field("utilization")
    if window == "overage" or (status == "rejected" and overage in ("allowed", "allowed_warning")):
        return UsageSignal(
            "stop_overage",
            "the plan limit is reached and further usage would be paid usage credits; the run was stopped",
            resets_at,
            window,
            utilization,
            overage,
        )
    if status == "rejected":
        return UsageSignal(
            "stop_limit",
            f"the subscription's {window or 'usage'} limit is reached",
            resets_at,
            window,
            utilization,
            overage,
        )
    if status == "allowed_warning":
        return UsageSignal(
            "warn", f"approaching the subscription's {window or 'usage'} limit", resets_at, window, utilization, overage
        )
    return UsageSignal("ok", "", resets_at, window, utilization, overage)
