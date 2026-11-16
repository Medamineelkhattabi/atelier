"""Tools in isolation: workspace boundary, documents, data, web safety, execution, git."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from pae.security import Redactor
from pae.tools import builtin_registry
from pae.tools.base import ToolContext, ToolError, resolve_path

pytestmark = pytest.mark.anyio


class FakeSettings:
    def __init__(self, **values):
        self.values = values

    def get(self, key, default=None):
        return self.values.get(key, default)


@pytest.fixture
def ws(tmp_path) -> Path:
    path = tmp_path / "ws"
    path.mkdir()
    return path


@pytest.fixture
def ctx(ws) -> ToolContext:
    async def emit(*_a, **_k):
        return None

    return ToolContext(
        run_id="r",
        root_run_id="r",
        agent_id="a",
        workspace=ws,
        settings=FakeSettings(**{"http.allowed_domains": ["example.com"]}),
        secrets=lambda name: {"API_TOKEN": "tok-123456789"}.get(name),  # gitleaks:allow (a fake test value)
        redactor=Redactor(),
        emit=emit,
    )


REGISTRY = builtin_registry()


async def run_tool(name: str, ctx: ToolContext, **arguments):
    tool = REGISTRY.get(name)
    return await tool.handler(tool.args_model.model_validate(arguments), ctx)


# ------------------------------------------------------------ workspace boundary


def test_resolve_path_rejects_traversal_and_absolute_escape(ws, tmp_path):
    assert resolve_path(ws, "a/b.txt") == (ws / "a" / "b.txt").resolve()
    for bad in ("../x", "a/../../x", str(tmp_path / "other.txt")):
        with pytest.raises(ToolError, match="outside"):
            resolve_path(ws, bad)


def test_protected_files_are_refused(ws):
    for name in (".env", ".env.local", "server.pem", "id_rsa", "secret.key"):
        with pytest.raises(ToolError, match="protected"):
            resolve_path(ws, name)


def test_symlink_escape_is_refused(ws, tmp_path):
    outside = tmp_path / "outside.txt"
    outside.write_text("secret")
    link = ws / "link.txt"
    try:
        os.symlink(outside, link)
    except OSError:
        pytest.skip("symlinks need extra privileges on this system")
    with pytest.raises(ToolError, match="outside"):
        resolve_path(ws, "link.txt")


# ------------------------------------------------------------ files


async def test_fs_write_read_search_delete(ctx, ws):
    await run_tool("fs_write", ctx, path="src/app.py", content="def main():\n    return 42\n")
    with pytest.raises(ToolError, match="already exists"):
        await run_tool("fs_write", ctx, path="src/app.py", content="x")
    read = await run_tool("fs_read", ctx, path="src/app.py")
    assert "    1  def main():" in read.content
    found = await run_tool("fs_search", ctx, pattern=r"return \d+", glob="*.py")
    assert "src/app.py:2" in found.content
    listing = await run_tool("fs_list", ctx, path=".", recursive=True)
    assert "src/app.py" in listing.content
    with pytest.raises(ToolError, match="non-empty"):
        await run_tool("fs_delete", ctx, path="src")
    await run_tool("fs_delete", ctx, path="src/app.py")
    assert not (ws / "src" / "app.py").exists()
    with pytest.raises(ToolError, match="workspace root"):
        await run_tool("fs_delete", ctx, path=".")


async def test_fs_read_refuses_binary(ctx, ws):
    (ws / "blob.bin").write_bytes(b"\x00\x01\x02" * 10)
    with pytest.raises(ToolError, match="binary"):
        await run_tool("fs_read", ctx, path="blob.bin")


# ------------------------------------------------------------ documents


async def test_extract_docx_xlsx_pdf_csv(ctx, ws):
    import docx
    import openpyxl
    import pymupdf

    document = docx.Document()
    document.add_paragraph("Invoice INV-001")
    table = document.add_table(rows=2, cols=2)
    table.cell(0, 0).text, table.cell(0, 1).text = "Item", "Amount"
    table.cell(1, 0).text, table.cell(1, 1).text = "Widget", "120.50"
    document.save(ws / "invoice.docx")

    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "Sales"
    sheet.append(["region", "amount"])
    sheet.append(["north", 10])
    sheet.append(["south", 32])
    workbook.save(ws / "sales.xlsx")

    pdf = pymupdf.open()
    page = pdf.new_page()
    page.insert_text((72, 72), "Contract number C-778 signed")
    pdf.save(ws / "contract.pdf")
    pdf.close()
    (ws / "people.csv").write_text("name,age\nada,36\nalan,41\n", encoding="utf-8")

    assert "INV-001" in (await run_tool("doc_extract_text", ctx, path="invoice.docx")).content
    assert "Widget | 120.50" in (await run_tool("doc_extract_text", ctx, path="invoice.docx")).content
    assert "south | 32" in (await run_tool("doc_extract_text", ctx, path="sales.xlsx")).content
    assert "C-778" in (await run_tool("doc_extract_text", ctx, path="contract.pdf")).content
    tables = json.loads((await run_tool("doc_extract_tables", ctx, path="invoice.docx")).content)
    assert tables[0]["rows"][1] == ["Widget", "120.50"]
    sheets = json.loads((await run_tool("doc_extract_tables", ctx, path="sales.xlsx")).content)
    assert sheets[0]["rows"][2] == ["south", 32]
    with pytest.raises(ToolError, match="unsupported"):
        (ws / "a.exe").write_bytes(b"MZ")
        await run_tool("doc_extract_text", ctx, path="a.exe")


# ------------------------------------------------------------ data


async def test_data_profile_query_validate(ctx, ws):
    (ws / "orders.csv").write_text("id,customer,amount\n1,acme,100\n2,acme,50.5\n3,globex,\n", encoding="utf-8")
    profile = (await run_tool("data_profile", ctx, path="orders.csv")).data
    amount = next(c for c in profile["columns"] if c["name"] == "amount")
    assert profile["rows"] == 3 and amount["missing"] == 1 and amount["max"] == 100
    result = (
        await run_tool(
            "data_query",
            ctx,
            path="orders.csv",
            sql="SELECT customer, SUM(amount) AS total FROM data GROUP BY customer ORDER BY customer",
        )
    ).data
    assert result["rows"] == [["acme", 150.5], ["globex", None]]
    for statement in (
        "DELETE FROM data",
        "DROP TABLE data",
        "ATTACH DATABASE 'x.db' AS x",
        "INSERT INTO data VALUES (4,'x',1)",
    ):
        with pytest.raises(ToolError, match="rejected"):
            await run_tool("data_query", ctx, path="orders.csv", sql=statement)
    schema = {"type": "object", "required": ["id"], "properties": {"id": {"type": "integer"}}}
    good = await run_tool("data_validate", ctx, schema=schema, data={"id": 1})
    bad = await run_tool("data_validate", ctx, schema=schema, data={"id": "x"})
    assert good.data["valid"] and not bad.data["valid"] and bad.data["errors"][0]["path"] == "id"


async def test_sql_query_is_read_only(ctx, ws):
    import sqlite3

    connection = sqlite3.connect(ws / "app.db")
    connection.execute("CREATE TABLE users (id INTEGER, name TEXT)")
    connection.execute("INSERT INTO users VALUES (1, 'ada')")
    connection.commit()
    connection.close()
    rows = (await run_tool("sql_query", ctx, database="app.db", sql="SELECT name FROM users")).data["rows"]
    assert rows == [["ada"]]
    with pytest.raises(ToolError):
        await run_tool("sql_query", ctx, database="app.db", sql="DELETE FROM users")


# ------------------------------------------------------------ web safety


async def test_ssrf_protection_blocks_local_and_private(ctx):
    for url in (
        "http://127.0.0.1:8600/api/health",
        "http://localhost/",
        "http://10.0.0.5/",
        "http://169.254.169.254/",
        "file:///etc/passwd",
        "ftp://example.com/",
    ):
        with pytest.raises(ToolError):
            await run_tool("web_fetch", ctx, url=url)


async def test_http_permission_depends_on_method_and_domain(ctx):
    tool = REGISTRY.get("http_request")
    get_allowed = tool.args_model.model_validate({"url": "https://example.com/x"})
    post_allowed = tool.args_model.model_validate({"method": "POST", "url": "https://example.com/x"})
    get_other = tool.args_model.model_validate({"url": "https://evil.test/x"})
    assert tool.dynamic_permission(get_allowed, ctx) == "allow"
    assert tool.dynamic_permission(post_allowed, ctx) is None  # falls back to "ask"
    assert tool.dynamic_permission(get_other, ctx) is None


def test_secret_placeholders_are_injected_server_side(ctx):
    from pae.tools.web import inject_secrets

    headers = inject_secrets({"Authorization": "Bearer {{secret:API_TOKEN}}"}, ctx)
    assert headers["Authorization"] == "Bearer tok-123456789"
    with pytest.raises(ToolError, match="not defined"):
        inject_secrets({"X": "{{secret:MISSING}}"}, ctx)


# ------------------------------------------------------------ execution


async def test_shell_run_minimal_env_and_timeout(ctx, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "should-not-leak-000")
    command = "set" if os.name == "nt" else "env"
    result = await run_tool("shell_run", ctx, command=command)
    assert result.data["exit_code"] == 0 and "should-not-leak-000" not in result.content
    assert "PAE_SANDBOXED" in result.content
    slow = "ping -n 30 127.0.0.1 >NUL" if os.name == "nt" else "sleep 30"
    timed = await run_tool("shell_run", ctx, command=slow, timeout_s=1)
    assert timed.data["timed_out"] and timed.is_error


async def test_code_run_python(ctx):
    result = await run_tool("code_run_python", ctx, code="print(sum(range(10)))")
    assert "45" in result.content and result.data["exit_code"] == 0
    failing = await run_tool("code_run_python", ctx, code="raise SystemExit(3)")
    assert failing.is_error and failing.data["exit_code"] == 3


# ------------------------------------------------------------ git


async def test_git_tools(ctx, ws):
    if subprocess.run(["git", "--version"], capture_output=True).returncode != 0:
        pytest.skip("git not installed")
    with pytest.raises(ToolError, match="not a git repository"):
        await run_tool("git_status", ctx)
    for args in (
        ["init", "-q", "-b", "main"],
        ["config", "user.email", "t@example.com"],
        ["config", "user.name", "Test"],
    ):
        subprocess.run(["git", "-C", str(ws), *args], check=True)
    (ws / "a.txt").write_text("one\n")
    assert "a.txt" in (await run_tool("git_status", ctx)).content
    await run_tool("git_commit", ctx, message="first commit")
    assert "first commit" in (await run_tool("git_log", ctx)).content
    (ws / "a.txt").write_text("two\n")
    assert "+two" in (await run_tool("git_diff", ctx)).content
    with pytest.raises(ToolError, match="invalid ref"):
        await run_tool("git_diff", ctx, ref="--output=/tmp/x")
