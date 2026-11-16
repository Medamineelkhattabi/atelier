"""Subscription-only policy: no component can reach paid model access."""

from __future__ import annotations

import os

import pytest

from pae.providers.base import ProviderNotConfigured
from pae.subscription import (
    ALLOWED_PROVIDERS,
    PolicyViolation,
    check_credential_source,
    classify_rate_limit,
    paid_env_names,
    scrub_environment,
)

pytestmark = pytest.mark.anyio


def test_paid_credential_variables_are_scrubbed(monkeypatch):
    paid = {
        "ANTHROPIC_API_KEY": "k",
        "ANTHROPIC_AUTH_TOKEN": "t",
        "ANTHROPIC_BASE_URL": "https://proxy",
        "ANTHROPIC_PROFILE": "p",
        "CLAUDE_CODE_USE_BEDROCK": "1",
        "CLAUDE_CODE_USE_VERTEX": "1",
        "CLAUDE_CODE_USE_FOUNDRY": "1",
        "AWS_BEARER_TOKEN_BEDROCK": "b",
        "ANTHROPIC_FEDERATION_RULE_ID": "f",
    }
    for name, value in paid.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "subscription-token")  # the subscription's own token
    monkeypatch.setenv("PATH_KEEP_TEST", "x")
    removed = scrub_environment()
    assert set(paid) <= set(removed)
    assert not paid_env_names()
    assert os.environ["CLAUDE_CODE_OAUTH_TOKEN"] == "subscription-token"
    assert os.environ["PATH_KEEP_TEST"] == "x"


def test_only_a_subscription_login_is_accepted():
    check_credential_source("none")
    check_credential_source(None)
    for source in ("ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key", "ANTHROPIC_AUTH_TOKEN"):
        with pytest.raises(PolicyViolation, match="subscription"):
            check_credential_source(source)


@pytest.mark.parametrize(
    ("info", "action"),
    [
        ({"status": "allowed", "rate_limit_type": "five_hour"}, "ok"),
        ({"status": "allowed_warning", "rate_limit_type": "seven_day", "utilization": 0.9}, "warn"),
        ({"status": "rejected", "rate_limit_type": "five_hour", "resets_at": 4_102_444_800}, "stop_limit"),
        ({"status": "allowed", "rate_limit_type": "overage"}, "stop_overage"),
        ({"status": "rejected", "rate_limit_type": "seven_day", "overage_status": "allowed"}, "stop_overage"),
    ],
)
def test_rate_limit_classification(info, action):
    assert classify_rate_limit(info).action == action


async def test_platform_refuses_paid_paths(platform):
    assert ALLOWED_PROVIDERS == ("claude-code", "scripted")
    with pytest.raises(ProviderNotConfigured, match="subscription"):
        platform.providers.resolve("anthropic")
    with pytest.raises(ProviderNotConfigured):
        platform.providers.register("anthropic", object())
    for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"):
        with pytest.raises(ValueError, match="subscription"):
            platform.secrets.set(name, "x" * 20, "owner")
    from pae.settings_store import DEFAULTS

    assert not [k for k in DEFAULTS if "anthropic" in k or "openai" in k or "pricing" in k or "api_key" in k]
    status = platform.providers.claude_code_status()
    assert status["policy"] == "subscription-only" and status["auth"] in ("none", "login", "env_token")
    assert status["config_dir"].endswith("claude-home")


async def test_no_agent_definition_names_a_paid_provider(platform):
    for definition, _meta in platform.registry.list():
        assert definition.provider in ("default", "claude-code", "scripted"), definition.id
    assert platform.settings.get("providers.default") in ALLOWED_PROVIDERS


def test_sign_in_window_runs_only_anthropics_login_with_the_platform_home(config, monkeypatch):
    import dataclasses

    from pae import claude_signin

    calls = []
    monkeypatch.setattr(claude_signin.os, "name", "nt")
    monkeypatch.setattr("pae.runtime.claude_code.find_cli", lambda path=None: "C:/claude/claude.exe")
    monkeypatch.setattr(claude_signin.subprocess, "Popen", lambda args, **kw: calls.append((args, kw)))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    result = claude_signin.open_sign_in_window(config)
    assert result["opened"] is True and len(calls) == 1
    args, kwargs = calls[0]
    assert args == ["C:/claude/claude.exe", "auth", "login", "--claudeai"]
    assert kwargs["env"]["CLAUDE_CONFIG_DIR"] == str(config.claude_config_dir or config.data_dir / "claude-home")
    assert "ANTHROPIC_API_KEY" not in kwargs["env"]

    remote = dataclasses.replace(config, host="0.0.0.0")
    refused = claude_signin.open_sign_in_window(remote)
    assert refused["opened"] is False and refused["command"] == "pae claude-login" and len(calls) == 1
    monkeypatch.setattr(claude_signin.os, "name", "posix")
    assert claude_signin.open_sign_in_window(config)["opened"] is False
