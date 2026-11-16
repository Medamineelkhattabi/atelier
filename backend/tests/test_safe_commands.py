"""Which shell commands a project can let the team run without asking (pae.runtime.safe_commands)."""

from __future__ import annotations

from pathlib import Path

import pytest

from pae.runtime.safe_commands import is_safe_command
from pae.tools import base


@pytest.fixture
def app(tmp_path):
    root = tmp_path / "application"
    for folder in ("backend/tests", "frontend/src", "scripts", "backups"):
        (root / folder).mkdir(parents=True)
    (root / "backend" / "app.py").write_text("def score(c):\n    return 1\n")
    (root / "frontend" / "src" / "App.tsx").write_text("export const App = () => null;\n")
    (root / "scripts" / "deployer.sh").write_text("echo deploy\n")
    (root / "scripts" / "backup.conf").write_text("PASSPHRASE=secret\n")
    (root / "backups" / "dump.sql").write_text("INSERT INTO customers VALUES ('Ada');\n")
    (root / ".env").write_text("SHOP_SECRET=secret\n")
    (tmp_path / "outside.txt").write_text("not the project\n")
    saved = base._BLOCKED
    base.set_blocked_paths([root / "backups", root / "scripts" / "backup.conf"])
    yield root.resolve()
    base._BLOCKED = saved


# Commands the Software Engineer really ran on the Accounts screen, and everyday checks.
SAFE = [
    "ls",
    "ls -la backend",
    "pwd",
    "cat backend/app.py",
    "wc -l backend/app.py frontend/src/App.tsx",
    'grep -n "def score(" backend/app.py',
    'grep -n "admin\\|acces\\|\\.btn-small\\b.*{\\|focus-visible" frontend/src/App.tsx',
    "grep -rn score backend",
    "rg -n customer frontend",
    'find backend -name "*.py"',
    "sed -n 85,100p backend/app.py",
    "git status",
    "git log --oneline -5",
    "git diff -U1 frontend/src/App.tsx | head -330",
    "git diff -U1 frontend/src/App.tsx | sed -n 330,760p",
    "cd frontend && npm test",
    "cd frontend && npm run build 2>&1 | tail -20",
    "cd frontend && npm run test:unit",
    "cd frontend && npx tsc --noEmit",
    'cd backend && .venv/Scripts/python -m pytest -m "not network" -q',
    "cd backend && pytest -m 'not network' tests",
    "ruff check backend",
    "echo done",
    'grep -n "x" backend/app.py 2>/dev/null',
]

SAFE += [
    # security scanners that only report
    "npm audit",
    "cd frontend && npm audit --omit=dev",
    "pip-audit -r backend/requirements.txt",
    "bandit -r backend",
    "gitleaks git --redact",
    "gitleaks dir backend --redact",
    "gitleaks dir backend/app.py --redact --no-banner",  # one file: only that file is read
    "bandit backend/app.py -q",
    "gitleaks git --redact --log-opts=-n50",
    # reading the running app (the owner allowed the platform to read Docker)
    "docker compose ps",
    "docker compose ps --all --format json",
    "docker compose logs --since 30m --timestamps backend",
    "docker compose -f docker-compose.yml logs --tail 200 backend",
    "docker logs --tail 100 shop-backend-1",
    "docker ps -a",
    "docker container ls",
]

ASKS = [
    # scanners that would change or write something
    "npm audit fix",
    "pip-audit --fix",
    "bandit -r backend -o report.txt",
    "gitleaks dir . --report-path leaks.json",
    "gitleaks git",  # without --redact it would print the secrets it finds
    "gitleaks dir . --redact",  # the project root holds private folders and .env
    "gitleaks dir --redact",  # no path: the current folder, the project root
    "gitleaks dir .env --redact",
    "gitleaks dir scripts/backup.conf --redact",
    "gitleaks git --redact --log-opts=--output=x.txt",
    "bandit -r .",
    # Docker beyond reading: following never ends, inspect and config print secrets, the rest changes things
    "docker compose logs -f backend",
    "docker compose logs --follow backend",
    "docker logs -tf backend",
    "docker inspect shop-backend-1",
    "docker compose config",
    "docker compose --env-file .env ps",
    "docker compose -f ../other.yml ps",
    "docker compose restart backend",
    "docker compose up -d",
    "docker exec backend cat /etc/passwd",
    "docker build -q backend/",
    # changes, installs, outside contacts, deployment
    "rm -rf backend",
    'git commit -m "x"',
    "git push",
    "docker compose up -d",
    "npm install",
    "cd frontend && npm run test:e2e",
    "curl https://api.example.com",
    "bash scripts/deployer.sh",
    "echo hi > out.txt",
    "sed -i s/a/b/ backend/app.py",
    "sed -n 1w copie.txt backend/app.py",
    "find backend -delete",
    "npx eslint --fix frontend",
    "ruff format backend",
    "git -c core.pager=less log",
    "git diff --output=diff.txt",
    "ls & rm -rf backend",
    "ls\nrm -rf backend",
    # tests that may reach the network
    "cd backend && pytest",
    "python -m pytest backend",
    # private paths and protected files, however they are reached
    "cat .env",
    "cat backups/dump.sql",
    "ls backups",
    "cat scripts/backup.conf",
    "cd scripts && cat backup.conf",
    "cd backups && ls",
    "grep -rn customer .",
    "grep -rn customer",
    'find . -name "*.sql"',
    "cat *",
    "cat {.env,backend/app.py}",
    "grep x < .env",
    "echo $(cat .env)",
    "cat `ls`",
    "cat $HOME/.ssh/id_rsa",
    "cat ~/.ssh/id_rsa",
    "cat ../outside.txt",
    "awk '{print}' backend/app.py",
    'bash -c "ls"',
    "ls | xargs cat",
]


@pytest.mark.parametrize("command", SAFE)
def test_reading_and_checking_the_project_goes_ahead(app, command):
    assert is_safe_command(command, app), command


@pytest.mark.parametrize("command", ASKS)
def test_anything_else_still_asks(app, command):
    assert not is_safe_command(command, app), command


def test_absolute_paths_inside_the_project_are_fine(app):
    assert is_safe_command(f'cd {app.as_posix()}/frontend && grep -n "App" src/App.tsx', app)
    assert not is_safe_command(f"cat {(app.parent / 'outside.txt').as_posix()}", app)


@pytest.mark.anyio
async def test_only_a_trusting_project_runs_safe_commands_without_asking(app, platform):
    from pae.runtime.claude_code import builtin_permission

    class Ctx:
        project_trust_edits = True
        workspace = Path(app)
        manager = platform.manager
        options: dict = {}

        class agent:
            claude_code_tools = ["Bash"]
            permissions: dict = {}

    assert builtin_permission(Ctx, "Bash", {"command": "cd frontend && npm test"}) == ("allow", "project")
    assert builtin_permission(Ctx, "Bash", {"command": "git push"})[0] == "ask"
    Ctx.project_trust_edits = False
    assert builtin_permission(Ctx, "Bash", {"command": "cd frontend && npm test"})[0] == "ask"


@pytest.mark.anyio
async def test_a_read_only_task_reads_and_changes_nothing_even_in_a_trusting_project(app, platform):
    from pae.runtime.claude_code import builtin_permission
    from pae.runtime.gate import resolve_permission

    class Ctx:
        project_trust_edits = True
        workspace = Path(app)
        manager = platform.manager
        options = {"read_only": True}

        class agent:
            claude_code_tools = ["Read", "Grep", "Edit", "Bash"]
            permissions: dict = {}

    def decide(tool, **tool_input):
        return builtin_permission(Ctx, tool, tool_input)[0]

    assert decide("Read", file_path="backend/app.py") == "allow"
    assert decide("Bash", command="docker compose logs --since 30m backend") == "allow"
    assert decide("Bash", command="git diff") == "allow"
    # Nobody is there to approve: what would change something is refused, not asked.
    assert decide("Edit", file_path="backend/app.py", old_string="1", new_string="2") == "deny"
    assert decide("Bash", command="cd frontend && npm run build") == "deny", "a build writes files"
    assert decide("Bash", command="docker compose restart backend") == "deny"
    assert decide("Bash", command="bash scripts/deployer.sh") == "deny"

    write = platform.manager.tools.get("fs_write")
    assert resolve_permission(write, {}, Ctx, None)[0] == "deny"


# Auto-approve mode (like Claude Code's bypass mode): these still ask, with the reason the owner sees.
STILL_ASKS = {
    "git push origin main": "pushes",
    "cd backend && git push": "pushes",
    "bash scripts/deployer.sh": "deploys",
    "./scripts/deployer.sh --retour": "deploys",
    "npm run deploy": "deploys",
    "docker compose restart backend": "changes the running app",
    "docker compose -f docker-compose.yml up -d --build": "changes the running app",
    "docker stop shop-backend-1": "changes the running app",
    "docker compose config": "secrets",
    "docker inspect shop-backend-1": "secrets",
    "ssh deploy@vps": "another machine",
    "curl -X POST https://example.org/hook -d @data.json": "sends data outside",
    "npm install -g typescript": "changes this PC",
    "schtasks /create /tn x /tr y": "changes this PC",
    "cat /c/Users/someone/notes.txt": "outside the project",
    "rm -rf ../other-project": "outside the project",
    "cat backups/dump.sql": "private folder",
    "cat .env": "secret file",
}
RUNS_IN_AUTO = [
    "rm backend/app.py",
    "npm install",
    "pip install -e .",
    "git commit -m 'fix'",
    "git log --grep push",
    "grep -rn deploy scripts",
    "cat docs/deployment.md",
    "curl https://pypi.org/simple/requests/",
    "docker compose logs --since 30m backend",
    "python -m pytest",
    "ls 2>/dev/null",
    'python muter.py "$(pwd)/backend" 2>&1 | tail -25',  # the project's own folder, written as a variable
]


@pytest.mark.parametrize("command", sorted(STILL_ASKS))
def test_auto_mode_still_asks_before_acting_beyond_the_project(app, command):
    from pae.runtime.auto_approve import still_asks

    reason = still_asks(command, app)
    assert reason and STILL_ASKS[command] in reason, (command, reason)


@pytest.mark.parametrize("command", RUNS_IN_AUTO)
def test_auto_mode_runs_everything_else(app, command):
    from pae.runtime.auto_approve import still_asks

    assert still_asks(command, app) is None, command


@pytest.mark.anyio
async def test_auto_mode_approves_what_would_ask_and_keeps_every_refusal(app, platform):
    from pae.runtime.claude_code import builtin_permission
    from pae.runtime.gate import resolve_permission

    class Ctx:
        project_trust_edits = False
        workspace = Path(app)
        manager = platform.manager
        options: dict = {}

        class agent:
            claude_code_tools = ["Read", "Edit", "Bash", "WebFetch"]
            permissions: dict = {}

    def decide(tool, **tool_input):
        return builtin_permission(Ctx, tool, tool_input)

    base.set_blocked_paths([app / "backups", app / "scripts" / "backup.conf"])  # the platform reset them
    assert decide("Bash", command="rm backend/app.py")[0] == "ask", "the default mode asks"
    assert decide("Bash", command="cat .env")[0] == "ask", "the owner sees each command and decides"
    platform.settings.set("permissions.mode", "auto")
    assert decide("Bash", command="rm backend/app.py") == ("allow", "auto-approve (owner's choice)")
    assert decide("Edit", file_path="backend/app.py", old_string="1", new_string="2")[0] == "allow"
    assert decide("WebFetch", url="https://docs.python.org")[0] == "allow"
    pushed = decide("Bash", command="git push")
    assert pushed[0] == "ask" and "pushes code" in pushed[1]
    # Refusals never change: secrets, private paths, outside the project, read-only tasks.
    assert decide("Read", file_path=".env")[0] == "deny"
    assert decide("Read", file_path="backups/dump.sql")[0] == "deny"
    assert decide("Read", file_path="../outside.txt")[0] == "deny"
    # Commands too: nobody approves one by one, so a private folder or a secret file is refused at once.
    for command in ("cat .env", "git check-ignore -v backups/x.py", "cp scripts/backup.conf /tmp/x"):
        refused = decide("Bash", command=command)
        assert refused[0] == "deny" and "closed" in refused[1], (command, refused)
    Ctx.options = {"read_only": True}
    assert decide("Edit", file_path="backend/app.py", old_string="1", new_string="2")[0] == "deny"
    Ctx.options = {}
    platform.settings.set("permissions.mode", "all")  # the owner approves everything
    assert decide("Bash", command="git push") == ("allow", "auto-approve everything (owner's choice)")
    assert decide("Bash", command="bash scripts/deployer.sh")[0] == "allow"
    assert decide("Bash", command="cat /c/Users/someone/notes.txt")[0] == "allow"
    assert decide("Read", file_path=".env")[0] == "deny", "refusals never change"
    assert decide("Read", file_path="backups/dump.sql")[0] == "deny"
    for command in ("cat .env", 'type "backups\\dump.sql"', "grep -r KEY scripts/backup.conf"):
        assert decide("Bash", command=command)[0] == "deny", command
    shell = platform.manager.tools.get("shell_run")
    assert resolve_permission(shell, {"command": "cat .env"}, Ctx, None)[0] == "deny"
    Ctx.options = {"read_only": True}
    assert decide("Edit", file_path="backend/app.py", old_string="1", new_string="2")[0] == "deny"
    platform.settings.set("permissions.mode", "auto")
    Ctx.options = {"quality_check": True}
    assert decide("Bash", command="rm backend/app.py")[0] == "ask", "quality checks test the approvals themselves"
    Ctx.options = {}
    # The owner's own "ask" rule still asks.
    platform.settings.set("permissions.tools", {"claude_code.Bash": "ask"})
    assert decide("Bash", command="ls")[0] == "ask"
    platform.settings.set("permissions.tools", {})

    tools = platform.manager.tools
    assert resolve_permission(tools.get("fs_write"), {"path": "a.txt"}, Ctx, None)[0] == "allow"
    assert resolve_permission(tools.get("agent_run_plan"), {}, Ctx, None)[0] == "allow", "plans start at once"
    assert resolve_permission(tools.get("email_send"), {}, Ctx, None)[0] == "ask"
    assert resolve_permission(tools.get("webhook_send"), {}, Ctx, None)[0] == "ask"
    assert resolve_permission(tools.get("shell_run"), {"command": "bash scripts/deployer.sh"}, Ctx, None)[0] == "ask"
