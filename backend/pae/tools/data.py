"""Deterministic data tools: profiling, read-only SQL over files, JSON Schema validation."""

from __future__ import annotations

import asyncio
import csv
import json
import sqlite3
import statistics
from pathlib import Path
from typing import Any

import jsonschema
from pydantic import ConfigDict, Field

from pae.tools.base import Args, Tool, ToolContext, ToolError, ToolResult, resolve_path, truncate
from pae.tools.documents import read_workbook

MAX_ROWS = 200_000


def load_table(path: Path) -> tuple[list[str], list[list[Any]]]:
    suffix = path.suffix.lower()
    if suffix in {".csv", ".tsv"}:
        with open(path, encoding="utf-8-sig", errors="replace", newline="") as handle:
            reader = csv.reader(handle, delimiter="\t" if suffix == ".tsv" else ",")
            header = next(reader, [])
            rows = [row for _, row in zip(range(MAX_ROWS), reader, strict=False)]
        return [h.strip() or f"col{i + 1}" for i, h in enumerate(header)], [[_coerce(v) for v in r] for r in rows]
    if suffix in {".json", ".jsonl"}:
        text = path.read_text(encoding="utf-8")
        records = (
            [json.loads(line) for line in text.splitlines() if line.strip()] if suffix == ".jsonl" else json.loads(text)
        )
        if isinstance(records, dict):
            records = next((v for v in records.values() if isinstance(v, list)), [records])
        if not isinstance(records, list) or not all(isinstance(r, dict) for r in records):
            raise ToolError("JSON must be a list of objects (or an object containing one)")
        columns: list[str] = []
        for record in records:
            columns.extend(k for k in record if k not in columns)
        return columns, [[_scalar(r.get(c)) for c in columns] for r in records[:MAX_ROWS]]
    if suffix in {".xlsx", ".xlsm"}:
        sheet = read_workbook(path, MAX_ROWS)[0]
        if not sheet["rows"]:
            return [], []
        header = [str(h).strip() or f"col{i + 1}" for i, h in enumerate(sheet["rows"][0])]
        return header, [list(r) + [None] * (len(header) - len(r)) for r in sheet["rows"][1:]]
    raise ToolError(f"unsupported data file '{suffix}' (csv, tsv, json, jsonl, xlsx)")


def _coerce(value: str) -> Any:
    text = value.strip()
    if text == "":
        return None
    for cast in (int, float):
        try:
            return cast(text)
        except ValueError:
            continue
    return text


def _scalar(value: Any) -> Any:
    return json.dumps(value) if isinstance(value, dict | list) else value


def profile(columns: list[str], rows: list[list[Any]]) -> dict:
    result = {"rows": len(rows), "columns": []}
    for index, name in enumerate(columns):
        values = [r[index] if index < len(r) else None for r in rows]
        present = [v for v in values if v is not None and v != ""]
        numeric = [v for v in present if isinstance(v, int | float) and not isinstance(v, bool)]
        column = {
            "name": name,
            "type": "number" if present and len(numeric) == len(present) else ("text" if present else "empty"),
            "missing": len(values) - len(present),
            "distinct": len({str(v) for v in present}),
            "examples": [str(v)[:60] for v in present[:3]],
        }
        if numeric:
            column.update(min=min(numeric), max=max(numeric), mean=round(statistics.fmean(numeric), 6))
        result["columns"].append(column)
    return result


class ProfileArgs(Args):
    path: str = Field(description="csv, tsv, json, jsonl or xlsx file in the workspace")


async def data_profile(args: ProfileArgs, ctx: ToolContext) -> ToolResult:
    path = resolve_path(ctx.workspace, args.path, must_exist=True)
    columns, rows = await asyncio.to_thread(load_table, path)
    report = profile(columns, rows)
    return ToolResult(json.dumps(report, ensure_ascii=False, default=str), report)


class QueryArgs(Args):
    path: str = Field(description="Data file loaded as the table `data`")
    sql: str = Field(description="A single read-only SELECT over the table `data`")
    max_rows: int = Field(200, ge=1, le=5000)


_ALLOWED_ACTIONS = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION}


def _authorizer(action, *_args):
    return sqlite3.SQLITE_OK if action in _ALLOWED_ACTIONS else sqlite3.SQLITE_DENY


def run_query(columns: list[str], rows: list[list[Any]], sql: str, max_rows: int) -> dict:
    connection = sqlite3.connect(":memory:")
    try:
        quoted = ", ".join('"' + c.replace('"', '""') + '"' for c in columns)
        connection.execute(f"CREATE TABLE data ({quoted})")  # noqa: S608 - identifiers quoted
        placeholders = ", ".join("?" for _ in columns)
        connection.executemany(
            f"INSERT INTO data VALUES ({placeholders})",  # noqa: S608
            [list(r)[: len(columns)] + [None] * (len(columns) - len(r)) for r in rows],
        )
        connection.set_authorizer(_authorizer)
        try:
            cursor = connection.execute(sql)
        except sqlite3.DatabaseError as exc:
            raise ToolError(f"query rejected: {exc}") from exc
        names = [d[0] for d in cursor.description or []]
        fetched = cursor.fetchmany(max_rows + 1)
        return {"columns": names, "rows": [list(r) for r in fetched[:max_rows]], "truncated": len(fetched) > max_rows}
    finally:
        connection.close()


async def data_query(args: QueryArgs, ctx: ToolContext) -> ToolResult:
    path = resolve_path(ctx.workspace, args.path, must_exist=True)
    columns, rows = await asyncio.to_thread(load_table, path)
    result = await asyncio.to_thread(run_query, columns, rows, args.sql, args.max_rows)
    return ToolResult(truncate(json.dumps(result, ensure_ascii=False, default=str), 100_000), result)


class ValidateArgs(Args):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    schema_: dict | None = Field(None, alias="schema", description="JSON Schema (inline)")
    schema_path: str | None = Field(None, description="JSON Schema file in the workspace")
    data: Any = Field(None, description="The data to validate (inline)")
    data_path: str | None = Field(None, description="JSON file in the workspace to validate")


async def data_validate(args: ValidateArgs, ctx: ToolContext) -> ToolResult:
    schema = args.schema_
    if args.schema_path:
        schema = json.loads(resolve_path(ctx.workspace, args.schema_path, must_exist=True).read_text("utf-8"))
    if schema is None:
        raise ToolError("provide 'schema' or 'schema_path'")
    data = args.data
    if args.data_path:
        data = json.loads(resolve_path(ctx.workspace, args.data_path, must_exist=True).read_text("utf-8"))
    try:
        validator_cls = jsonschema.validators.validator_for(schema)
        validator_cls.check_schema(schema)
    except jsonschema.SchemaError as exc:
        raise ToolError(f"invalid schema: {exc.message}") from exc
    errors = [
        {"path": "/".join(map(str, e.absolute_path)) or "(root)", "message": e.message}
        for e in validator_cls(schema).iter_errors(data)
    ][:100]
    summary = {"valid": not errors, "errors": errors}
    text = "valid" if not errors else "invalid:\n" + "\n".join(f"- {e['path']}: {e['message']}" for e in errors)
    return ToolResult(text, summary)


TOOLS = [
    Tool(
        "data_profile",
        "Profile a tabular file: columns, types, missing values, distinct counts, numeric stats.",
        ProfileArgs,
        data_profile,
        "read",
        "allow",
        "data",
        timeout_s=120,
    ),
    Tool(
        "data_query",
        "Run a read-only SQL SELECT over a csv/json/xlsx file loaded as table `data`.",
        QueryArgs,
        data_query,
        "read",
        "allow",
        "data",
        timeout_s=120,
    ),
    Tool(
        "data_validate",
        "Validate JSON data against a JSON Schema and list every violation.",
        ValidateArgs,
        data_validate,
        "read",
        "allow",
        "data",
    ),
]
