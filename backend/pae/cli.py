"""Command line: serve, eval, init (project bootstrap), mcp-serve, set-password."""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
import sys


def cmd_serve(args) -> int:
    import uvicorn

    from pae.app import create_app
    from pae.config import load_config

    config = load_config()
    uvicorn.run(
        create_app(config),
        host=args.host or config.host,
        port=args.port or config.port,
        log_level=config.log_level.lower(),
        proxy_headers=False,
        timeout_graceful_shutdown=5,  # live event streams must not block shutdown
    )
    return 0


def cmd_eval(args) -> int:
    from pae.config import load_config
    from pae.evals import EvalRunner, load_suites
    from pae.platform import Platform

    async def main() -> dict:
        platform = Platform(load_config())
        await platform.start()
        try:
            suites, errors = load_suites(platform.config.evals_dir)
            if args.suite not in suites:
                raise SystemExit(f"unknown suite '{args.suite}'. Available: {', '.join(suites) or 'none'} {errors}")
            return await EvalRunner(platform).run_suite(
                suites[args.suite], provider=args.provider, case_ids=args.case or None
            )
        finally:
            await platform.stop()

    result = asyncio.run(main())
    for case in result["results"]:
        mark = "PASS" if case["passed"] else "FAIL"
        print(
            f"{mark}  {case['case']:<40} {case.get('status', '-'):<10} {case['duration_s']:>6}s  "
            f"${case.get('cost_usd') or 0:.4f}"
        )
        for check in case["checks"]:
            if not check["passed"]:
                print(f"        x {check['name']}: {check['detail']}")
    print(json.dumps(result["summary"], indent=2))
    return 0 if result["summary"]["passed"] == result["summary"]["cases"] else 1


def cmd_run(args) -> int:
    """Run one agent through the platform runtime and print its events live.

    The run is stored in the platform database like any other (visible in the UI history).
    """
    from pae.config import load_config
    from pae.db import Run
    from pae.platform import Platform

    limits = {
        k: v
        for k, v in (("max_steps", args.max_steps), ("timeout_s", args.timeout), ("max_cost_usd", args.max_usage_usd))
        if v is not None
    }

    async def main() -> str:
        platform = Platform(load_config())
        await platform.start()
        subscription = platform.manager.bus.subscribe()
        try:
            run_id = await platform.manager.submit(
                task=args.task,
                agent_id=args.agent,
                workspace=args.workspace,
                model=args.model,
                limits=limits or None,
                actor="cli",
            )
            print(f"run {run_id} started")
            while True:
                event = await subscription.queue.get()
                if event["root_run_id"] != run_id:
                    continue
                data = json.dumps(event["data"], ensure_ascii=False, default=str)
                print(f"{event['seq']:>3} {event['source']:<7} {event['type']:<20} {data[:400]}", flush=True)
                if event["type"] in ("run.completed", "run.failed", "run.cancelled") and event["run_id"] == run_id:
                    break
            with platform.db.session() as session:
                run = session.get(Run, run_id)
                print(
                    json.dumps(
                        {
                            "run_id": run.id,
                            "status": run.status,
                            "output": run.output,
                            "error": run.error,
                            "steps": run.steps,
                            "tool_calls": run.tool_calls,
                            "input_tokens": run.input_tokens,
                            "output_tokens": run.output_tokens,
                            "usage_estimate_usd": run.cost_usd,
                        },
                        indent=1,
                        ensure_ascii=False,
                        default=str,
                    )
                )
                return run.status
        finally:
            platform.manager.bus.unsubscribe(subscription)
            await platform.stop()

    return 0 if asyncio.run(main()) == "completed" else 1


def cmd_init(args) -> int:
    from pae.bootstrap import CAPABILITIES, init_project

    if args.list:
        for name, info in CAPABILITIES.items():
            print(f"{name:<16} {info['description']}")
        return 0
    if not args.directory:
        print("usage: pae init <directory> --with cap1,cap2 (see pae init --list)")
        return 2
    capabilities = [c.strip() for c in (args.with_ or "").split(",") if c.strip()]
    try:
        written = init_project(args.directory, capabilities, name=args.name, force=args.force)
    except (ValueError, FileExistsError) as exc:
        print(f"error: {exc}" + (" (use --force to overwrite)" if isinstance(exc, FileExistsError) else ""))
        return 1
    for path in written:
        print(f"  created {path}")
    return 0


def cmd_mcp_serve(args) -> int:
    from pae.mcp_server import serve

    serve(args.url, args.token_env)
    return 0


def _claude(args_list: list[str]) -> int:
    """Run the platform's Claude Code binary with the platform's Claude home, in this terminal.

    Sign-in happens entirely in Anthropic's own flow (browser + this terminal); the platform
    never sees, reads or stores the credential. `--claudeai` forces the subscription login.
    """
    import subprocess

    from pae.config import load_config
    from pae.runtime.claude_code import find_cli
    from pae.subscription import scrub_environment

    config = load_config()
    removed = scrub_environment()
    if removed:
        print(f"Removed from this process's environment (paid credentials): {', '.join(removed)}")
    cli = find_cli(config.claude_code_path)
    if not cli:
        print("Claude Code CLI not found (it ships with the claude-agent-sdk package).")
        return 1
    home = config.claude_config_dir or config.data_dir / "claude-home"
    home.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "CLAUDE_CONFIG_DIR": str(home)}
    print(f"Claude Code home for platform sessions: {home}")
    return subprocess.call([cli, *args_list], env=env)


def cmd_claude_login(args) -> int:
    return _claude(["auth", "login", "--claudeai"])


def cmd_claude_status(args) -> int:
    return _claude(["auth", "status", "--text"])


def cmd_set_password(args) -> int:
    from pae.config import load_config
    from pae.db import AuthSession, Database, User
    from pae.migrations_runner import upgrade
    from pae.security import hash_password

    config = load_config()
    upgrade(config.database_url)
    db = Database(config.database_url)
    password = getpass.getpass("New password (min 10 characters): ")
    with db.session() as session:
        user = session.query(User).filter_by(username=args.username).first()
        if user is None:
            user = User(username=args.username, password_hash=hash_password(password))
            session.add(user)
            print(f"created owner '{args.username}'")
        else:
            user.password_hash = hash_password(password)
            session.query(AuthSession).filter(AuthSession.user_id == user.id).delete()
            print(f"password updated for '{args.username}'; existing sessions signed out")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pae", description="Atelier: your AI team, your rules")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="run the API and web interface")
    serve.add_argument("--host")
    serve.add_argument("--port", type=int)
    serve.set_defaults(func=cmd_serve)

    ev = sub.add_parser("eval", help="run an evaluation suite")
    ev.add_argument("suite")
    ev.add_argument("--provider", help="override the provider for every case")
    ev.add_argument("--case", action="append", help="run only this case (repeatable)")
    ev.set_defaults(func=cmd_eval)

    run = sub.add_parser("run", help="run one agent through the platform runtime and print its events")
    run.add_argument("agent")
    run.add_argument("task")
    run.add_argument("--workspace")
    run.add_argument("--model", help="model alias for this run (default: your plan's default)")
    run.add_argument("--max-steps", type=int)
    run.add_argument("--timeout", type=int, help="seconds")
    run.add_argument("--max-usage-usd", type=float, help="usage budget (API-equivalent estimate, not billed)")
    run.set_defaults(func=cmd_run)

    init = sub.add_parser("init", help="bootstrap a new project with selected capabilities")
    init.add_argument("directory", nargs="?")
    init.add_argument("--with", dest="with_", help="comma-separated capabilities")
    init.add_argument("--name")
    init.add_argument("--force", action="store_true", help="overwrite existing files")
    init.add_argument("--list", action="store_true", help="list available capabilities")
    init.set_defaults(func=cmd_init)

    mcp = sub.add_parser("mcp-serve", help="expose platform agents as an MCP server (stdio) for Claude Code")
    mcp.add_argument("--url", default="http://127.0.0.1:8600")
    mcp.add_argument("--token-env", default="PAE_API_TOKEN")
    mcp.set_defaults(func=cmd_mcp_serve)

    login = sub.add_parser("claude-login", help="sign the platform's Claude Code in to your Claude subscription")
    login.set_defaults(func=cmd_claude_login)
    status = sub.add_parser("claude-status", help="show the platform's Claude Code sign-in status")
    status.set_defaults(func=cmd_claude_status)

    pw = sub.add_parser("set-password", help="create the owner or reset its password")
    pw.add_argument("username")
    pw.set_defaults(func=cmd_set_password)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
