"""Deterministic document extraction: PDF, Word, Excel, CSV and text formats."""

from __future__ import annotations

import asyncio
import csv
import html
import io
import json
import re
from pathlib import Path

from pydantic import Field

from pae.tools.base import Args, Tool, ToolContext, ToolError, ToolResult, rel, resolve_path, truncate

TEXT_SUFFIXES = {
    ".txt",
    ".md",
    ".rst",
    ".log",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".py",
    ".ts",
    ".js",
    ".java",
    ".go",
    ".rs",
    ".sql",
    ".ini",
    ".cfg",
}
MAX_BYTES = 50_000_000


def _check(path: Path) -> None:
    if not path.is_file():
        raise ToolError(f"'{path.name}' is not a file")
    if path.stat().st_size > MAX_BYTES:
        raise ToolError(f"'{path.name}' exceeds {MAX_BYTES} bytes")


def extract_text(path: Path, max_chars: int) -> dict:
    _check(path)
    suffix = path.suffix.lower()
    meta: dict = {"format": suffix.lstrip(".")}
    if suffix == ".pdf":
        import pymupdf

        with pymupdf.open(path) as doc:
            meta["pages"] = doc.page_count
            parts = [f"--- page {i + 1} ---\n{page.get_text()}" for i, page in enumerate(doc)]
        text = "\n".join(parts)
    elif suffix == ".docx":
        import docx

        document = docx.Document(str(path))
        parts = [p.text for p in document.paragraphs]
        for t_index, table in enumerate(document.tables):
            parts.append(f"--- table {t_index + 1} ---")
            parts.extend(" | ".join(cell.text.strip() for cell in row.cells) for row in table.rows)
        meta["paragraphs"] = len(document.paragraphs)
        meta["tables"] = len(document.tables)
        text = "\n".join(parts)
    elif suffix in {".xlsx", ".xlsm"}:
        sheets = read_workbook(path, max_rows=2000)
        meta["sheets"] = [s["name"] for s in sheets]
        text = "\n".join(
            f"--- sheet {s['name']} ---\n" + "\n".join(" | ".join(map(str, row)) for row in s["rows"]) for s in sheets
        )
    elif suffix in {".csv", ".tsv"}:
        text = path.read_text(encoding="utf-8-sig", errors="replace")
    elif suffix in {".html", ".htm"}:
        text = html_to_text(path.read_text(encoding="utf-8", errors="replace"))
    elif suffix in TEXT_SUFFIXES or suffix == "":
        text = path.read_text(encoding="utf-8", errors="replace")
    else:
        raise ToolError(f"unsupported document type '{suffix}'")
    meta["characters"] = len(text)
    return {"text": truncate(text, max_chars), "meta": meta}


def read_workbook(path: Path, max_rows: int) -> list[dict]:
    import openpyxl

    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        sheets = []
        for sheet in workbook.worksheets:
            rows = []
            for row in sheet.iter_rows(values_only=True):
                if len(rows) >= max_rows:
                    break
                if any(cell is not None for cell in row):
                    rows.append(["" if cell is None else cell for cell in row])
            sheets.append({"name": sheet.title, "rows": rows})
        return sheets
    finally:
        workbook.close()


def extract_tables(path: Path, max_rows: int) -> list[dict]:
    _check(path)
    suffix = path.suffix.lower()
    if suffix in {".xlsx", ".xlsm"}:
        return [{"source": f"sheet:{s['name']}", "rows": _jsonable(s["rows"])} for s in read_workbook(path, max_rows)]
    if suffix == ".docx":
        import docx

        document = docx.Document(str(path))
        return [
            {"source": f"table:{i + 1}", "rows": [[c.text.strip() for c in row.cells] for row in t.rows][:max_rows]}
            for i, t in enumerate(document.tables)
        ]
    if suffix in {".csv", ".tsv"}:
        delimiter = "\t" if suffix == ".tsv" else ","
        with open(path, encoding="utf-8-sig", errors="replace", newline="") as handle:
            rows = [row for _, row in zip(range(max_rows), csv.reader(handle, delimiter=delimiter), strict=False)]
        return [{"source": "csv", "rows": rows}]
    if suffix == ".pdf":
        import pymupdf

        tables = []
        with pymupdf.open(path) as doc:
            for page_number, page in enumerate(doc, 1):
                for t_index, table in enumerate(page.find_tables().tables, 1):
                    rows = [["" if c is None else str(c) for c in row] for row in table.extract()][:max_rows]
                    tables.append({"source": f"page:{page_number}:table:{t_index}", "rows": rows})
        return tables
    raise ToolError(f"no table extraction for '{suffix}'")


def html_to_text(markup: str) -> str:
    markup = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", markup)
    markup = re.sub(r"(?i)<br\s*/?>|</(p|div|li|h[1-6]|tr)>", "\n", markup)
    text = html.unescape(re.sub(r"<[^>]+>", " ", markup))
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    return re.sub(r"\n\s*\n+", "\n\n", text).strip()


def _jsonable(rows: list[list]) -> list[list]:
    return [[c if isinstance(c, int | float | str | bool) else str(c) for c in row] for row in rows]


class ExtractTextArgs(Args):
    path: str = Field(description="Document in the workspace (pdf, docx, xlsx, csv, html, text)")
    max_chars: int = Field(100_000, ge=1000, le=500_000)


async def doc_extract_text(args: ExtractTextArgs, ctx: ToolContext) -> ToolResult:
    path = resolve_path(ctx.workspace, args.path, must_exist=True)
    result = await asyncio.to_thread(extract_text, path, args.max_chars)
    header = f"[{rel(ctx.workspace, path)}: {json.dumps(result['meta'])}]\n"
    return ToolResult(header + result["text"], {"path": rel(ctx.workspace, path), "meta": result["meta"]})


class ExtractTablesArgs(Args):
    path: str
    max_rows: int = Field(500, ge=1, le=10_000)


async def doc_extract_tables(args: ExtractTablesArgs, ctx: ToolContext) -> ToolResult:
    path = resolve_path(ctx.workspace, args.path, must_exist=True)
    tables = await asyncio.to_thread(extract_tables, path, args.max_rows)
    buffer = io.StringIO()
    json.dump(tables, buffer, ensure_ascii=False, default=str)
    return ToolResult(truncate(buffer.getvalue(), 100_000), {"tables": len(tables)})


TOOLS = [
    Tool(
        "doc_extract_text",
        "Extract the text of a PDF, Word, Excel, CSV, HTML or text document.",
        ExtractTextArgs,
        doc_extract_text,
        "read",
        "allow",
        "documents",
        untrusted_output=True,
        timeout_s=120,
    ),
    Tool(
        "doc_extract_tables",
        "Extract tables (rows of cells) from Excel, Word, CSV or PDF as JSON.",
        ExtractTablesArgs,
        doc_extract_tables,
        "read",
        "allow",
        "documents",
        untrusted_output=True,
        timeout_s=120,
    ),
]
