"""Contracts of the 15 built-in agents: responsibility, boundaries, tools, permissions,
output envelope, incomplete-task reporting, and a scripted run of each one through the
real runtime (the scripted provider stands in for the model)."""

from __future__ import annotations

import jsonschema
import pytest

from pae.runtime.native import build_system_prompt

from conftest import call, wait_for

pytestmark = pytest.mark.anyio

AGENTS = [
    "architecture",
    "automation",
    "code-review",
    "data",
    "debugging",
    "deployment",
    "document-processing",
    "documentation",
    "evaluator",
    "orchestrator",
    "planning",
    "research",
    "security",
    "software-engineering",
    "testing",
]
READ_ONLY = {"research", "planning", "code-review", "document-processing", "evaluator", "orchestrator", "architecture"}

ENVELOPE = {"status": "complete", "summary": "done", "issues": []}
SAMPLES = {
    "architecture": {
        **ENVELOPE,
        "options": [{"name": "Queue", "how": "a job table", "pros": ["simple"], "cons": ["polling"]}],
        "recommendation": "Queue",
        "plan": ["add the table", "move the totals to it"],
        "decisions_for_owner": [],
    },
    "security": {
        **ENVELOPE,
        "verdict": "block",
        "scope": ["backend/app/routes/export.py"],
        "findings": [
            {
                "severity": "high",
                "category": "access control",
                "file": "backend/app/routes/export.py",
                "line": 12,
                "issue": "no role check on the export route",
                "exploit": "any logged-in recruiter calls GET /export and downloads every candidate",
                "fix": "require the admin role, as the other admin routes do",
            }
        ],
        "checked": ["routes: role checks", "queries: parameterised"],
    },
    "deployment": {
        **ENVELOPE,
        "deployed": True,
        "checks_before": [{"check": "no import running", "result": "none since 10:02", "passed": True}],
        "steps": ["scripts/deployer.sh"],
        "checks_after": [{"check": "services healthy", "result": "3/3", "passed": True}],
        "rollback": "scripts/deployer.sh --retour",
    },
    "automation": {
        **ENVELOPE,
        "actions": [{"action": "GET", "target": "https://api.example.org", "status": "done"}],
        "result": "synced",
    },
    "code-review": {
        **ENVELOPE,
        "scope": ["app.py"],
        "verdict": "request_changes",
        "findings": [
            {
                "severity": "high",
                "category": "security",
                "file": "app.py",
                "line": 4,
                "issue": "SQL injection",
                "evidence": "f-string query",
                "recommendation": "parameterize",
            }
        ],
    },
    "data": {
        **ENVELOPE,
        "findings": [{"statement": "north total", "value": 15, "evidence": "SUM query"}],
        "quality_issues": [],
    },
    "debugging": {
        **ENVELOPE,
        "reproduced": True,
        "root_cause": "off-by-one in loop",
        "evidence": ["test output"],
        "fix_summary": "use <=",
        "files_changed": ["calc.py"],
        "verification": "pytest: 3 passed",
    },
    "document-processing": {**ENVELOPE, "documents": [{"path": "inv.csv", "fields": {"total": "10"}, "issues": []}]},
    "documentation": {**ENVELOPE, "files_written": ["docs/a.md"], "sources_read": ["a.py"]},
    "evaluator": {
        "status": "complete",
        "passed": True,
        "score": 1.0,
        "criteria": [{"criterion": "mentions billing", "met": True, "note": "line 1"}],
        "reasoning": "ok",
    },
    "orchestrator": {
        **ENVELOPE,
        "steps": [{"task_id": "t1", "agent": "research", "task": "x", "status": "completed"}],
        "result": "answer",
        "validation": [{"what": "change", "by": "testing", "outcome": "passed"}],
    },
    "planning": {
        **ENVELOPE,
        "objective": "x",
        "assumptions": [],
        "tasks": [
            {"id": "t1", "title": "Do it", "done_when": "tests pass", "depends_on": [], "suggested_agent": "testing"}
        ],
        "risks": [],
        "open_questions": [],
    },
    "research": {
        **ENVELOPE,
        "findings": [{"claim": "c", "evidence": "e", "source_ids": ["s1"]}],
        "sources": [{"id": "s1", "location": "README.md:1"}],
        "open_questions": [],
    },
    "software-engineering": {
        **ENVELOPE,
        "files_changed": ["a.py"],
        "verification": {"command": "pytest", "result": "3 passed", "passed": True},
        "follow_ups": [],
    },
    "testing": {
        **ENVELOPE,
        "runs": [{"command": "pytest", "passed": 3, "failed": 0}],
        "failures": [],
        "coverage_gaps": [],
        "files_written": [],
    },
}


@pytest.fixture
async def agents(platform):
    return {d.id: (d, meta) for d, meta in platform.registry.list() if d.id in AGENTS}


async def test_all_fifteen_agents_load_without_problems(platform, agents):
    assert sorted(agents) == AGENTS
    assert not platform.registry.load_errors
    for agent_id, (definition, meta) in agents.items():
        assert meta["problems"] == [], agent_id
        assert definition.version.startswith("2."), agent_id


@pytest.mark.parametrize("agent_id", AGENTS)
async def test_agent_has_a_precise_contract(agents, agent_id):
    definition, _ = agents[agent_id]
    assert len(definition.responsibility) >= 30, "a precise one-sentence responsibility"
    assert definition.boundaries, "explicit boundaries"
    assert definition.input_hint and definition.capabilities
    assert len(definition.when_to_use) >= 2, "plain situations where it helps"
    assert "agent" not in definition.name.lower(), "a plain role name, not a technical label"
    assert set(definition.works_with) <= set(AGENTS) - {agent_id}
    schema = definition.output_schema
    assert schema and "status" in schema["required"], "every agent reports complete/partial/blocked"
    assert "complete" in schema["properties"]["status"]["enum"]
    assert "blocked" in schema["properties"]["status"]["enum"]
    if agent_id != "evaluator":
        assert {"summary", "issues"} <= set(schema["required"]), "gaps are reported in issues"
        assert "When you cannot finish" in definition.instructions, "incomplete-task handling is defined"


@pytest.mark.parametrize("agent_id", AGENTS)
async def test_agent_output_contract_accepts_a_real_report_and_rejects_a_bare_one(agents, agent_id):
    schema = agents[agent_id][0].output_schema
    validator = jsonschema.validators.validator_for(schema)(schema)
    validator.validate(SAMPLES[agent_id])
    assert list(validator.iter_errors({"summary": "done"})), "a report without the contract is rejected"
    if "partial" in schema["properties"]["status"]["enum"]:
        validator.validate({**SAMPLES[agent_id], "status": "partial", "issues": ["part of the input was unreadable"]})


@pytest.mark.parametrize("agent_id", sorted(READ_ONLY))
async def test_read_only_agents_cannot_change_anything(platform, agents, agent_id):
    definition, _ = agents[agent_id]
    risky = [t for t in definition.tools if platform.manager.tools.get(t).risk in ("write", "execute", "destructive")]
    assert risky == [], f"{agent_id} must stay read-only"
    external = [t for t in definition.tools if platform.manager.tools.get(t).risk == "external"]
    assert external in ([], ["web_fetch"]), "at most GET-only web reads, gated by approval outside allowed domains"
    assert not set(definition.claude_code_tools) & {"Edit", "Write", "Bash"}


async def test_agents_that_write_or_act_say_approval_is_needed(platform, agents):
    for agent_id, (definition, _) in agents.items():
        acts = any(platform.manager.tools.get(t).risk != "read" for t in definition.tools)
        if acts:
            assert "approval" in definition.instructions.lower(), agent_id


async def test_agents_are_specialists_not_copies(agents):
    toolsets = {tuple(sorted(d.tools)) for d, _ in agents.values() if d.tools}
    assert len(toolsets) >= 10, "agents have tool sets that match their jobs"
    assert len({d.responsibility for d, _ in agents.values()}) == len(AGENTS)
    assert len({d.instructions for d, _ in agents.values()}) == len(AGENTS)


async def test_orchestrator_coordinates_only_through_the_runtime(agents):
    orchestrator, _ = agents["orchestrator"]
    assert set(orchestrator.tools) == {"agent_list", "agent_run_plan"}, "every hand-out goes through a checked plan"
    assert orchestrator.delegates == ["*"]
    for phrase in (
        "agent_run_plan",
        "depends_on",
        "If one agent can do it",
        "Never invent a result",
        "checks your plan",
    ):
        assert phrase in orchestrator.instructions
    assert agents["planning"][0].output_schema["properties"]["tasks"]["items"]["required"][-1] == "suggested_agent"
    assert agents["evaluator"][0].tools == []


async def test_system_prompt_carries_the_reporting_contract(platform, agents):
    class Ctx:
        agent = agents["research"][0]
        project_context = "Use British English."
        options = {"role": "Gather the facts"}

    prompt = build_system_prompt(Ctx())
    assert "## Reporting contract (every agent)" in prompt and "<untrusted_data" in prompt
    assert "## Project context (from the owner)\nUse British English." in prompt
    assert prompt.index("Reporting contract") < prompt.index("Project context")


@pytest.mark.parametrize("agent_id", AGENTS)
async def test_each_agent_runs_end_to_end_on_the_scripted_provider(platform, agent_id):
    run_id = await platform.manager.submit(
        task=f"Scripted contract check for {agent_id}.",
        agent_id=agent_id,
        provider="scripted",
        options={"provider_options": {"script": [call("final_answer", **SAMPLES[agent_id])]}},
    )
    run = await wait_for(platform, run_id)
    assert run["status"] == "completed", run["error"]
    assert run["output"] == SAMPLES[agent_id]


async def test_technical_writer_can_return_the_document_itself(agents):
    definition, _ = agents["documentation"]
    schema = definition.output_schema
    validator = jsonschema.validators.validator_for(schema)(schema)
    validator.validate({**SAMPLES["documentation"], "files_written": [], "content": "# Guide\n\nText."})
    assert "content" in definition.instructions and "never put the document in `summary`" in definition.instructions


async def test_the_security_engineer_is_read_only_whatever_it_is_asked(platform, agents):
    definition, _ = agents["security"]
    assert definition.read_only and "Bash" in definition.claude_code_tools, "it runs read-only checks, nothing else"
    assert not set(definition.claude_code_tools) & {"Edit", "Write"}
    run_id = await platform.manager.submit(
        task="check the change",
        agent_id="security",
        provider="scripted",
        options={"provider_options": {"script": [call("final_answer", **SAMPLES["security"])]}},
    )
    await wait_for(platform, run_id)
    from pae.db import Run

    with platform.db.session() as session:
        run = session.get(Run, run_id)
        assert platform.manager._context(run, None).options["read_only"] is True, "the platform enforces it"
