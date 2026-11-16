"""Project bootstrap: rendering, dependency resolution, JSON merge, no overwrite, and the
generated project's own tests (guard hook, Python smoke test) actually pass."""

from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

from pae.bootstrap import CAPABILITIES, init_project, resolve


def test_resolve_adds_dependencies_in_order():
    assert resolve(["hooks"]) == ["claude", "hooks"]
    assert resolve(["python", "ci"]) == ["base", "python", "ci"]
    with pytest.raises(ValueError, match="unknown capability"):
        resolve(["nope"])


def test_every_capability_has_a_template_folder():
    from pae.bootstrap import TEMPLATES

    for name in CAPABILITIES:
        assert (TEMPLATES / name).is_dir(), name


def test_full_bootstrap(tmp_path):
    target = tmp_path / "My Service"
    written = init_project(target, list(CAPABILITIES), name="My Service")
    assert "src/my_service/__init__.py" in written and "tests/test_smoke.py" in written
    assert (target / "README.md").read_text().startswith("# My Service")
    assert "{{" not in (target / "tests" / "test_smoke.py").read_text()

    settings = json.loads((target / ".claude" / "settings.json").read_text())
    assert "Read(./.env)" in settings["permissions"]["deny"]
    assert settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"].endswith('guard.py"')

    with pytest.raises(FileExistsError, match="refusing to overwrite"):
        init_project(target, ["base"])

    guard = subprocess.run([sys.executable, ".claude/hooks/test_guard.py"], cwd=target, capture_output=True, text=True)
    assert guard.returncode == 0, guard.stderr

    smoke = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests"],
        cwd=target,
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONPATH": str(target / "src")},
    )
    assert smoke.returncode == 0, smoke.stdout + smoke.stderr


def test_guard_hook_decisions():
    import importlib.util

    from pae.bootstrap import TEMPLATES

    spec = importlib.util.spec_from_file_location("guard", TEMPLATES / "hooks" / ".claude" / "hooks" / "guard.py")
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    assert guard.check({"tool_name": "Read", "tool_input": {"file_path": "app/.env"}})
    assert guard.check({"tool_name": "Read", "tool_input": {"file_path": ".env.example"}}) is None
    assert guard.check({"tool_name": "Bash", "tool_input": {"command": "rm -rf /"}})
    assert guard.check({"tool_name": "Bash", "tool_input": {"command": "ls -la"}}) is None
