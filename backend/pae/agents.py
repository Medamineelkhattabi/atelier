"""Agent and team definitions: loading, validation, overrides and versioning.

File definitions (agents/*.toml, agents/teams/*.toml) are the reusable,
version-controlled source. The database stores the enabled flag, owner
overrides, and agents or teams created in the UI ("custom").
"""

from __future__ import annotations

import hashlib
import json
import tomllib
from collections.abc import Container
from pathlib import Path
from typing import Any, Literal

import jsonschema
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from pae.db import AgentRecord, Database, TeamRecord

PROVIDERS = ("default", "claude-code", "scripted")
CLAUDE_CODE_TOOLS = {"Read", "Glob", "Grep", "Edit", "Write", "Bash", "WebFetch", "WebSearch", "TodoWrite"}
OVERRIDABLE = {"provider", "model", "effort", "limits", "permissions", "tools", "instructions"}


class AgentDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[a-z][a-z0-9-]{1,62}$")
    name: str
    version: str = "1.0.0"
    description: str
    purpose: str = ""
    responsibility: str = ""  # one sentence: what this agent is accountable for
    boundaries: list[str] = Field(default_factory=list)  # what it does not do, and who does
    works_with: list[str] = Field(default_factory=list)  # agents it typically hands off to or receives from
    when_to_use: list[str] = Field(default_factory=list)  # plain-language situations where this agent helps
    capabilities: list[str] = Field(default_factory=list)
    # "default", "claude-code", "scripted", or "acp:<id>": an agent reached through the Agent Client Protocol.
    provider: str = Field(default="default", pattern=r"^(default|claude-code|scripted|acp:[a-z0-9][a-z0-9._-]{0,40})$")
    model: str | None = None
    effort: Literal["low", "medium", "high", "xhigh", "max"] | None = None
    instructions: str
    tools: list[str] = Field(default_factory=list)
    claude_code_tools: list[str] = Field(default_factory=list)
    # Every run of this agent is read-only, whatever it is asked: edits and commands that change anything are refused
    # by the platform (Bash only runs read-only commands), so it never waits for an approval.
    read_only: bool = False
    delegates: list[str] = Field(default_factory=list)
    permissions: dict[str, Literal["allow", "ask", "deny"]] = Field(default_factory=dict)
    limits: dict[str, float | int] = Field(default_factory=dict)
    output_schema: dict | None = None
    input_hint: str = ""
    tags: list[str] = Field(default_factory=list)

    @field_validator("output_schema", mode="before")
    @classmethod
    def _parse_schema(cls, value: Any) -> Any:
        if isinstance(value, str):
            value = json.loads(value)
        if value is not None:
            jsonschema.validators.validator_for(value).check_schema(value)
        return value

    @field_validator("claude_code_tools")
    @classmethod
    def _cc_tools(cls, value: list[str]) -> list[str]:
        unknown = set(value) - CLAUDE_CODE_TOOLS
        if unknown:
            raise ValueError(f"unknown Claude Code tools: {sorted(unknown)}")
        return value


class TeamMember(BaseModel):
    model_config = ConfigDict(extra="forbid")
    agent: str
    responsibility: str = ""


class TeamDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[a-z][a-z0-9-]{1,62}$")
    name: str
    description: str = ""
    version: str = "1.0.0"
    mode: Literal["sequential", "parallel", "orchestrated"]
    members: list[TeamMember] = Field(min_length=1)
    orchestrator: str | None = None
    consolidator: str | None = None


def revision(data: dict) -> str:
    return hashlib.sha256(json.dumps(data, sort_keys=True, default=str).encode()).hexdigest()[:8]


class AgentRegistry:
    def __init__(self, db: Database, agents_dir: Path, known_tools: Container[str] | None = None) -> None:
        self.db = db
        self.agents_dir = agents_dir
        self.known_tools = known_tools  # a live view: MCP tools appear and disappear at runtime
        self.file_agents: dict[str, AgentDefinition] = {}
        self.file_teams: dict[str, TeamDefinition] = {}
        self.load_errors: dict[str, str] = {}
        self.reload()

    # ------------------------------------------------------------ loading

    def reload(self) -> None:
        self.file_agents, self.file_teams, self.load_errors = {}, {}, {}
        if self.agents_dir.is_dir():
            for path in sorted(self.agents_dir.glob("*.toml")):
                self._load(path, AgentDefinition, self.file_agents)
            for path in sorted((self.agents_dir / "teams").glob("*.toml")):
                self._load(path, TeamDefinition, self.file_teams)
        with self.db.session() as session:
            for agent_id in self.file_agents:
                if session.get(AgentRecord, agent_id) is None:
                    session.add(AgentRecord(id=agent_id, source="file", overrides={}, enabled=True))
            for team_id in self.file_teams:
                if session.get(TeamRecord, team_id) is None:
                    session.add(TeamRecord(id=team_id, source="file", enabled=True))

    def _load(self, path: Path, model, target: dict) -> None:
        try:
            definition = model.model_validate(tomllib.loads(path.read_text(encoding="utf-8")))
        except (tomllib.TOMLDecodeError, ValidationError, ValueError) as exc:
            self.load_errors[path.name] = str(exc)
            return
        if definition.id in target:
            self.load_errors[path.name] = f"duplicate id '{definition.id}'"
            return
        target[definition.id] = definition

    # ------------------------------------------------------------ agents

    def problems(self, definition: AgentDefinition) -> list[str]:
        issues = []
        if self.known_tools is not None:
            missing = [t for t in definition.tools if t not in self.known_tools]
            if missing:
                issues.append(f"unknown tools: {', '.join(missing)}")
        return issues

    def effective(self, record: AgentRecord) -> tuple[AgentDefinition, dict] | None:
        if record.source == "file":
            base = self.file_agents.get(record.id)
            if base is None:
                return None
            data = base.model_dump()
            data.update({k: v for k, v in (record.overrides or {}).items() if k in OVERRIDABLE})
        else:
            data = dict(record.definition or {})
        try:
            definition = AgentDefinition.model_validate(data)
        except ValidationError:
            return None
        meta = {
            "source": record.source,
            "enabled": record.enabled,
            "overrides": record.overrides or {},
            "revision": revision(definition.model_dump()),
            "updated_at": record.updated_at.isoformat() if record.updated_at else None,
            "problems": self.problems(definition),
        }
        return definition, meta

    def list(self) -> list[tuple[AgentDefinition, dict]]:
        with self.db.session() as session:
            records = session.query(AgentRecord).order_by(AgentRecord.id).all()
        return [result for record in records if (result := self.effective(record))]

    def get(self, agent_id: str) -> tuple[AgentDefinition, dict] | None:
        with self.db.session() as session:
            record = session.get(AgentRecord, agent_id)
        return self.effective(record) if record else None

    def set_enabled(self, agent_id: str, enabled: bool) -> None:
        with self.db.session() as session:
            record = session.get(AgentRecord, agent_id)
            if record is None:
                raise KeyError(agent_id)
            record.enabled = enabled

    def update_overrides(self, agent_id: str, overrides: dict) -> None:
        unknown = set(overrides) - OVERRIDABLE
        if unknown:
            raise ValueError(f"cannot override: {sorted(unknown)}")
        with self.db.session() as session:
            record = session.get(AgentRecord, agent_id)
            if record is None:
                raise KeyError(agent_id)
            if record.source == "custom":
                merged = {**(record.definition or {}), **overrides}
                AgentDefinition.model_validate(merged)
                record.definition = merged
            else:
                merged = {**(record.overrides or {}), **overrides}
                merged = {k: v for k, v in merged.items() if v is not None}
                base = self.file_agents[agent_id].model_dump()
                AgentDefinition.model_validate({**base, **merged})
                record.overrides = merged

    def reset_overrides(self, agent_id: str) -> None:
        with self.db.session() as session:
            record = session.get(AgentRecord, agent_id)
            if record is None or record.source != "file":
                raise KeyError(agent_id)
            record.overrides = {}

    def save_custom(self, data: dict, *, create: bool) -> AgentDefinition:
        definition = AgentDefinition.model_validate(data)
        with self.db.session() as session:
            record = session.get(AgentRecord, definition.id)
            if create:
                if record is not None or definition.id in self.file_agents:
                    raise ValueError(f"agent '{definition.id}' already exists")
                session.add(
                    AgentRecord(
                        id=definition.id,
                        source="custom",
                        definition=definition.model_dump(),
                        overrides={},
                        enabled=True,
                    )
                )
            else:
                if record is None or record.source != "custom":
                    raise KeyError(definition.id)
                record.definition = definition.model_dump()
        return definition

    def delete_custom(self, agent_id: str) -> None:
        with self.db.session() as session:
            record = session.get(AgentRecord, agent_id)
            if record is None or record.source != "custom":
                raise KeyError(agent_id)
            session.delete(record)

    # ------------------------------------------------------------ teams

    def list_teams(self) -> list[tuple[TeamDefinition, dict]]:
        with self.db.session() as session:
            records = session.query(TeamRecord).order_by(TeamRecord.id).all()
        out = []
        for record in records:
            definition = (
                self.file_teams.get(record.id)
                if record.source == "file"
                else (TeamDefinition.model_validate(record.definition) if record.definition else None)
            )
            if definition:
                out.append((definition, {"source": record.source, "enabled": record.enabled}))
        return out

    def get_team(self, team_id: str) -> TeamDefinition | None:
        return next((t for t, _ in self.list_teams() if t.id == team_id), None)

    def save_team(self, data: dict) -> TeamDefinition:
        team = TeamDefinition.model_validate(data)
        if team.id in self.file_teams:
            raise ValueError(f"team '{team.id}' is defined in a file")
        with self.db.session() as session:
            record = session.get(TeamRecord, team.id)
            if record is None:
                session.add(TeamRecord(id=team.id, source="custom", definition=team.model_dump(), enabled=True))
            else:
                record.definition = team.model_dump()
        return team

    def delete_team(self, team_id: str) -> None:
        with self.db.session() as session:
            record = session.get(TeamRecord, team_id)
            if record is None or record.source != "custom":
                raise KeyError(team_id)
            session.delete(record)

    @staticmethod
    def to_toml(definition: AgentDefinition) -> str:
        """Export a definition as TOML so a UI-created agent can move into the repository."""
        data = definition.model_dump(exclude_none=True)
        lines = []
        tables = {}
        for key, value in data.items():
            if isinstance(value, dict):
                if key == "output_schema":
                    lines.append(f"output_schema = '''\n{json.dumps(value, indent=2)}\n'''")
                elif value:
                    tables[key] = value
            elif isinstance(value, str) and "\n" in value:
                lines.append(f"{key} = '''\n{value.strip()}\n'''")
            else:
                lines.append(f"{key} = {json.dumps(value)}")
        for name, table in tables.items():
            lines.append(f"\n[{name}]")
            lines.extend(f"{k} = {json.dumps(v)}" for k, v in table.items())
        return "\n".join(lines) + "\n"
