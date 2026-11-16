"""Evaluation system: suites load, the deterministic suite passes on the real runtime,
and the checker catches wrong behaviour (it is not vacuous)."""

from __future__ import annotations

import pytest

from pae.evals import Case, EvalRunner, Suite, check_path, get_path, load_suites

pytestmark = pytest.mark.anyio


async def test_suites_load(platform):
    suites, errors = load_suites(platform.config.evals_dir)
    assert not errors
    assert {"runtime-contracts", "agents-live"} <= set(suites)
    assert suites["agents-live"].live and not suites["runtime-contracts"].live


def test_path_helpers():
    data = {"a": [{"b": "INV-1"}], "n": 3.0}
    assert get_path(data, "a.0.b") == "INV-1" and get_path(data, "a[0].b") == "INV-1"
    assert check_path(3, 3.0) and check_path([1, 2], "len>=2") and check_path("Hello World", "~world")
    assert not check_path(None, "nonempty")


async def test_runtime_contract_suite_passes(platform):
    suites, _ = load_suites(platform.config.evals_dir)
    result = await EvalRunner(platform).run_suite(suites["runtime-contracts"])
    failures = [(r["case"], [c for c in r["checks"] if not c["passed"]]) for r in result["results"] if not r["passed"]]
    assert not failures, failures
    summary = result["summary"]
    assert summary["pass_rate"] == 1.0 and summary["cases"] == len(suites["runtime-contracts"].cases)
    assert {"tool_execution", "approvals", "security", "failure_handling", "delegation"} <= set(summary["by_category"])


async def test_checker_detects_wrong_behaviour(platform):
    suite = Suite(
        id="negative",
        name="negative",
        provider="scripted",
        cases=[
            Case.model_validate(
                {
                    "id": "wrong",
                    "agent": "tester",
                    "task": "x",
                    "script": [{"tool_calls": [{"name": "final_answer", "input": {"answer": "actual"}}]}],
                    "expect": {
                        "output_contains": ["expected-but-missing"],
                        "tools_called": ["fs_read"],
                        "output_paths": {"answer": "something else"},
                    },
                }
            )
        ],
    )
    result = await EvalRunner(platform).run_suite(suite)
    case = result["results"][0]
    assert not case["passed"]
    failed = {c["name"] for c in case["checks"] if not c["passed"]}
    assert {"contains:expected-but-missing", "called:fs_read", "path:answer"} <= failed
    assert result["summary"]["pass_rate"] == 0.0
