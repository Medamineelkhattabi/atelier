"""Shell commands a project can let the team run without asking: they only read the project or run its
checks (unit tests, type checks, builds).

Used when the owner turns on "Work without asking" for a project (projects.trust_edits). Conservative
on purpose: anything not recognised here, or that could reach a private path, a protected file
(.env, keys) or the outside, still asks. Assumes private paths are not tracked by git (backups, logs,
certificates are git-ignored in practice).
"""

from __future__ import annotations

import os
import re
import shlex
import time
from pathlib import Path

from pae.tools.base import SKIP_DIRS, blocked_inside, blocked_names, is_blocked, is_protected

SEPARATORS = {"&&", "||", ";", "|"}
OPERATOR_CHARS = set("();<>|&")
READERS = {
    "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "ls", "find", "tree", "du", "stat", "file",
    "diff", "sort", "uniq", "cut", "tr", "sed", "echo", "pwd", "cd", "basename", "dirname", "realpath", "which",
    "true", "jq", "nl", "column",
}  # fmt: skip
RECURSIVE = {"rg", "find", "tree", "du"}  # read everything under the folders they are given (or the current one)
GIT_READ = {"status", "diff", "log", "show", "ls-files", "blame", "rev-parse", "grep"}
NPM_SCRIPTS = {"test", "test:unit", "build", "lint", "typecheck", "type-check", "check"}
NPX_TOOLS = {"tsc", "vitest", "eslint"}
FIND_ACTIONS = {"-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"}
# Docker, read-only: what runs and its logs. Never inspect or config (they print the containers' secrets),
# never follow (it never ends).
DOCKER_READ = {"ps", "logs"}
COMPOSE_READ = {"ps", "logs", "ls", "top", "images"}
DOCKER_FOLLOW = {"-f", "--follow"}
SED_PRINT = re.compile(r"^\s*(\d+|\$)(\s*,\s*(\d+|\$))?\s*p\s*(;\s*(\d+|\$)(\s*,\s*(\d+|\$))?\s*p\s*)*$")
GLOB_CHARS = set("*?[")


def is_safe_command(command: str, workspace: Path, *, checks: bool = True) -> bool:
    """True when every part of `command` only reads the project (outside private paths and protected
    files), reads its running containers, or runs its checks (`checks=False`: reading only, since builds
    and tests write files)."""
    try:
        if not command.strip() or len(command) > 4000 or _expands(command):
            return False
        parts = _split(command.replace("\r", " ").replace("\n", " ; "))
        if parts is None:
            return False
        cwd = workspace.resolve()
        for words in parts:
            cwd = _check(words, cwd, workspace.resolve(), checks)
            if cwd is None:
                return False
        return True
    except (ValueError, OSError):
        return False


def _expands(command: str) -> bool:
    """Shell expansions outside single quotes ($VAR, $(...), `...`, {a,b}): their result cannot be checked."""
    quote = None
    for char in command:
        if quote == "'":
            quote = None if char == "'" else quote
        elif char == "'" and quote is None:
            quote = "'"
        elif char == '"':
            quote = None if quote == '"' else '"'
        elif char in "$`" or (char == "{" and quote is None):
            return True
    return False


def _split(command: str) -> list[list[str]] | None:
    lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    tokens = list(lexer)
    parts: list[list[str]] = [[]]
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if not (set(token) <= OPERATOR_CHARS):
            parts[-1].append(token)  # a word (quoted when it holds operator characters)
        elif token in SEPARATORS:
            parts.append([])
        elif token in (">", ">&", "&>", ">>"):
            following = tokens[i + 1] if i + 1 < len(tokens) else ""
            words = parts[-1]
            op = token
            if op == ">&" and words[-1:] == ["2"] and following == "1":
                words.pop()
            elif op in (">", "&>") and following == "/dev/null":
                if op == ">" and words[-1:] == ["2"]:
                    words.pop()
            else:
                return None  # writing to a file
            i += 1
        else:
            return None  # input redirection, background job or subshell
        i += 1
    if any(not words for words in parts):
        return None
    return parts


def _check(words: list[str], cwd: Path, root: Path, checks: bool = True) -> Path | None:
    """The current folder after this simple command, or None when it is not safe."""
    while words and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[0]):  # VAR=value prefixes
        words = words[1:]
    if not words:
        return None
    name = Path(words[0]).name.lower().removesuffix(".exe").removesuffix(".cmd")
    args = words[1:]
    if name == "cd":
        if len(args) != 1:
            return None
        target = _resolve(args[0], cwd)
        return target if _inside(target, root) and target.is_dir() and not is_blocked(target) else None
    if name == "git":
        ok = bool(args) and args[0] in GIT_READ and not any(a.startswith(("--output", "--ext-diff")) for a in args)
        return cwd if ok and _paths_ok(args[1:], cwd, root, recursive=False) else None
    if name in {"docker", "docker-compose"}:
        return cwd if _docker_read(name, args, cwd, root) else None
    if _security_scan(name, args):
        # bandit, osv-scanner and gitleaks on a folder read every file under it; gitleaks on git reads the history
        # (private paths are not tracked), pip-audit and npm audit read one dependency file.
        history = name == "gitleaks" and (args[0] == "git" or (args[0] == "detect" and "--no-git" not in args))
        recursive = name in ("bandit", "gitleaks", "osv-scanner") and not history
        named = args[1:] if name == "gitleaks" else args  # "dir", "git", "detect" are not paths
        # Given one file, a scanner reads that file, not the folder around it (grep -r would).
        return cwd if _paths_ok(named, cwd, root, recursive=recursive, folder_by_default=False) else None
    if checks and _is_check(name, args):
        return cwd
    if name not in READERS or not _reader_ok(name, args):
        return None
    recursive = name in RECURSIVE or (name in {"grep", "egrep", "fgrep"} and _grep_recursive(args))
    recursive = recursive or (name == "ls" and any(a.startswith("-") and "R" in a for a in args))
    return cwd if _paths_ok(args, cwd, root, recursive) else None


def _is_check(name: str, args: list[str]) -> bool:
    """Unit tests, type checks, linters and builds of the project itself."""
    if name == "npm":
        return args[:1] in (["test"], ["t"]) or (len(args) >= 2 and args[0] == "run" and args[1] in NPM_SCRIPTS)
    if name == "npx":
        return bool(args) and args[0] in NPX_TOOLS and "--fix" not in args
    if name in {"python", "python3", "py"} and args[:1] == ["-m"]:
        name, args = (args[1] if len(args) > 1 else ""), args[2:]
    if name == "pytest":
        # Only with a "-m 'not ...'" selection: some projects mark tests that really reach the network.
        selections = [args[i + 1] for i, a in enumerate(args[:-1]) if a == "-m"]
        return any(s.strip().startswith("not ") for s in selections)
    if name == "ruff":
        return args[:1] in (["check"], ["format"]) and ("--check" in args or args[0] == "check") and "--fix" not in args
    return name == "mypy"


def _docker_read(name: str, args: list[str], cwd: Path, root: Path) -> bool:
    """`docker ps`, `docker logs`, `docker compose ps|logs|ls|top|images`: they only show what runs."""
    if name == "docker" and args[:1] == ["container"]:
        args = args[1:]
        args = ["ps", *args[1:]] if args[:1] == ["ls"] else args
    if name == "docker" and args[:1] != ["compose"]:
        return bool(args) and args[0] in DOCKER_READ and not (args[0] == "logs" and _follows(args[1:]))
    rest = list(args[1:] if name == "docker" else args)
    while rest and rest[0].startswith("-"):  # compose options come before its command
        option = rest.pop(0)
        if option not in ("-f", "--file", "-p", "--project-name", "--project-directory") or not rest:
            return False  # --env-file and the others: not needed to look, and could read secrets
        value = rest.pop(0)
        if option not in ("-p", "--project-name") and not _paths_ok([value], cwd, root, recursive=False):
            return False
    return bool(rest) and rest[0] in COMPOSE_READ and not (rest[0] == "logs" and _follows(rest[1:]))


def _security_scan(name: str, args: list[str]) -> bool:
    """Read-only security scanners, when installed: they report, never fix or write a report file."""
    writes = any(a in ("fix", "--fix", "-o", "--output", "--force") or a.startswith("--output=") for a in args)
    if name == "npm":
        return args[:1] == ["audit"] and not writes
    if name in ("pip-audit", "bandit"):
        return not writes
    if name == "gitleaks":
        # Only with --redact: a secret it finds is shown masked, never copied into the task's history.
        report = any(a.startswith(("--report-path", "-r")) for a in args)
        redacted = any(a == "--redact" or a.startswith("--redact=") for a in args)
        git_output = any("--output" in a or "--ext-diff" in a for a in args)  # through --log-opts
        return args[:1] in (["git"], ["detect"], ["dir"]) and redacted and not report and not git_output
    return name == "osv-scanner" and args[:1] != ["fix"] and not writes


def _follows(args: list[str]) -> bool:
    return any(a in DOCKER_FOLLOW or a.startswith("--follow") or re.match(r"^-[a-zA-Z]*f[a-zA-Z]*$", a) for a in args)


def _reader_ok(name: str, args: list[str]) -> bool:
    if name == "sed":
        scripts = [a for a in args if not a.startswith("-")]
        return (
            "-n" in args
            and not any(a.startswith(("-i", "--in-place")) for a in args)
            and bool(scripts)
            and bool(SED_PRINT.match(scripts[0]))
        )
    if name == "find":
        return not any(a in FIND_ACTIONS for a in args)
    if name == "rg":
        return not any(a.startswith("--pre") for a in args)
    if name in {"sort", "tree"}:
        return not any(a == "-o" or a.startswith("--output") for a in args)
    if name == "uniq":
        return len([a for a in args if not a.startswith("-")]) <= 1
    return True


def _grep_recursive(args: list[str]) -> bool:
    return any(
        a in ("--recursive", "--dereference-recursive") or (re.match(r"^-[A-Za-z]+$", a) and set(a) & {"r", "R"})
        for a in args
    )


def _paths_ok(args: list[str], cwd: Path, root: Path, recursive: bool, folder_by_default: bool = True) -> bool:
    """Every argument naming something on disk must stay in the project, outside private paths and
    protected files; a recursive read must not start above them. Non-paths (patterns) are ignored.
    `folder_by_default`: a recursive reader given no folder reads the current one (grep -r pattern); False for
    commands that then read only the files they were given."""
    named = [a for a in args if not a.startswith("-")]
    private_names = blocked_names()
    targets: list[Path] = []
    for arg in named:
        parts = arg.replace("\\", "/").split("/")
        # "~", "..", or a private path's name: the current folder may not be the one assumed here.
        if arg.startswith("~") or ".." in parts or any(os.path.normcase(p) in private_names for p in parts if p):
            return False
        if set(arg) & GLOB_CHARS:
            matches = _glob(arg, cwd)
            if matches is None:
                return False
            targets += matches
        else:
            target = _resolve(arg, cwd)
            if target.exists():
                targets.append(target)
    if recursive and not (targets if not folder_by_default else any(t.is_dir() for t in targets)):
        targets.append(cwd)  # with no folder given, these read the current one
    for target in targets:
        if not _inside(target, root) or is_blocked(target) or is_protected(target):
            return False
        if recursive and target.is_dir() and (blocked_inside(target) or _protected_inside(target)):
            return False
    return True


def _glob(pattern: str, cwd: Path) -> list[Path] | None:
    base = Path(pattern)
    if base.is_absolute() or ".." in pattern.replace("\\", "/").split("/"):
        return None
    try:
        return list(cwd.glob(pattern))[:2000]
    except (ValueError, NotImplementedError):
        return None


def _resolve(arg: str, cwd: Path) -> Path:
    path = Path(arg)
    return (path if path.is_absolute() else cwd / path).resolve()


def _inside(target: Path, root: Path) -> bool:
    return target == root or target.is_relative_to(root)


_PROTECTED_CACHE: dict[str, tuple[float, bool]] = {}


def _protected_inside(folder: Path, limit: int = 50_000) -> bool:
    """True when a protected file (.env, keys...) lies under `folder` (dependency folders excluded),
    or when the folder is too big to check."""
    key = os.path.normcase(str(folder))
    cached = _PROTECTED_CACHE.get(key)
    if cached and time.monotonic() - cached[0] < 60:
        return cached[1]
    found, seen = False, 0
    for _dir, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        seen += len(files) + len(dirs)
        if seen > limit or any(is_protected(Path(f)) for f in files):
            found = True
            break
    _PROTECTED_CACHE[key] = (time.monotonic(), found)
    return found
