# Atelier

**Your AI team, your rules.**

Atelier is a workshop for AI agents that runs on your own machine. You say what you want in plain words. The right
specialist does the work in your project folder, a security engineer reviews every code change, and nothing risky
happens without your OK.

It works with the agents you already have. Atelier drives **Claude Code, Gemini CLI, Codex, GitHub Copilot, Cursor,
goose, OpenCode, Qwen Code, Mistral Vibe**, and any other agent that speaks the open
[Agent Client Protocol](https://agentclientprotocol.com). You choose the agent for each team member, and each one runs
on its own sign-in. **Atelier never asks for an API key.**

---

## Why Atelier

| | |
|---|---|
| **Ask once, get the right expert** | Type a goal on Home. In a code project it goes straight to the Software Engineer, working like a Claude Code session in your repo. For bigger goals the Coordinator splits the work among the team in a plan you approve before anything starts. |
| **Every change gets a second pair of eyes** | A read-only Security Engineer reviews each code change and gives a verdict: *nothing blocks*, *passed with warnings*, or *blocks the change* in red, with the file, the line, how it could be exploited and the fix. "Fix what blocks" sends it straight back to the engineer. |
| **You stay in charge** | Every action an agent asks for passes one permission gate, whichever agent it is. Private folders and secret files stay closed. Edits and commands wait in Approvals, or run on their own once you turn on auto mode. Even then, deploys, `git push`, publishing and anything that sends data off your machine still ask, unless you say otherwise. |
| **Any agent, no API keys, no surprise bills** | Run the Software Engineer on Claude Code, the Researcher on Gemini CLI and the Tester on Codex if you like. Every agent uses your own plan with its vendor. Atelier starts each agent without its vendor's API keys, and stops a Claude run instead of spending paid usage credits. |
| **Watch it work** | The Live Workspace shows who works on what, the hand-offs, the approvals and the result as it happens, plus a detailed map for experts. Every event, tool call and output is kept, so you can search it later. |
| **Local-first** | Your machine, your folders, one SQLite file. Your projects stay where they are, and Atelier keeps each project's files, secrets and history apart. |

## How it works

```
                ┌──────────────── Home: "What would you like to accomplish?" ────────────────┐
                │                                                                             │
       code project: straight to                                         bigger goal: the Coordinator
       the Software Engineer                                             writes a plan ─► you approve it
                │                                                                             │
                └──► Researcher · Architect · Software Engineer · Tester · Debugger · Writer · Deployer …
                                                      │
                     each one runs on Claude Code, or on any ACP agent: Gemini CLI, Codex, Copilot, Cursor …
                                                      │
                     one permission & approval gate ──┴──► your project folder (private paths stay closed)
                                                      │
                                Security Engineer reviews every code change ──► verdict, findings, fix
```

## The team

| Member | What it does |
|---|---|
| **Coordinator** | Splits your request among the right members, passes each one what it needs, and combines their results. |
| **Software Engineer** | Builds or changes features in your code, following its style, and checks the change with tests. |
| **Security Engineer** | Checks that a change can't be used to break in, leak data or take over the app. It only reads. |
| **Architect** | Decides how something should be built before the code is written, and explains the choice. |
| **Debugger** | Finds out why something is broken, proves the cause, and applies the smallest fix that works. |
| **Tester** | Runs the tests, explains each failure, and adds the tests that are missing. |
| **Code Reviewer** | Finds real bugs and security problems, with the proof and a fix for each one. |
| **Deployer** | Puts a new version in service: it checks first, deploys after your OK, and confirms it works. |
| **Researcher** | Finds answers in documents and trusted web pages, and cites every fact. |
| **Planner** | Turns a goal into clear steps, says who does each one, and lists the risks. |
| **Technical Writer** | Writes READMEs, guides and notes, based only on what the code and documents really say. |
| **Data Analyst** | Analyses spreadsheets and data files with exact numbers, and points out data problems. |
| **Document Specialist** | Pulls fields out of PDF, Word and Excel files exactly as written. |
| **Automation Specialist** | Moves data between files and online services, and asks before every outside change. |
| **Grader** | Scores an answer against a checklist and explains every point. |

You can edit any member, give it other tools or rules, or create your own, either in the interface or as a TOML file.

## Agents it runs on

| Agent | Runs on | Install it |
|---|---|---|
| Claude Code | Your Claude plan | Built in: sign in once from Settings |
| Gemini CLI | Your Google account | `npm install -g @google/gemini-cli` |
| Codex | Your ChatGPT plan | `npm install -g @agentclientprotocol/codex-acp` |
| GitHub Copilot | Your Copilot plan | `npm install -g @github/copilot` |
| Cursor | Your Cursor plan | [cursor.com/cli](https://cursor.com/cli) |
| goose | The provider you set in goose | [block.github.io/goose](https://block.github.io/goose) |
| OpenCode | The provider you set in OpenCode | `npm install -g opencode-ai` |
| Qwen Code | Your Qwen account | `npm install -g @qwen-code/qwen-code` |
| Mistral Vibe | Your Mistral account | [github.com/mistralai/mistral-vibe](https://github.com/mistralai/mistral-vibe) |
| Any other ACP agent | Its own sign-in | Add it in Settings (`engines.agents`) with the command that starts it |

Tools & Connections shows which agents are installed and how to sign in to each. You pick a member's agent on its
page, under **Runs on**. The Coordinator stays on Claude Code, because its planning tools only work there today.

## Quick start

Prerequisites: Python 3.12, Node.js 22+, Git, and at least one agent above.

```bash
cd backend
python -m venv .venv
.venv/Scripts/python -m pip install -c requirements.lock -e ".[dev]"   # .venv/bin/python on macOS and Linux
cd ../frontend
npm ci
npm run build
cd ../backend
.venv/Scripts/pae serve
```

Open http://127.0.0.1:8600 and create your account with the one-time setup token printed in the log. Then sign Claude
Code in from Settings, or install another agent, add a project folder and say what you want.

You can also run it with Docker (`docker compose up -d --build`). See [docs/operations.md](docs/operations.md) for
Docker, starting at logon, backups and the security scanners.

## Honest status

Atelier is tested hard, and it says what it hasn't proven yet. The suites cover the permission gate, approvals,
plans, recovery after a crash, project isolation, secret redaction, prompt-injection cases and full browser journeys.
They use labelled test doubles, so a test never spends a subscription. The scripted ACP agent in
`backend/tests/fake_acp_agent.py` is one of them.

Claude Code is used for real work. The other ACP agents have been tested against the protocol, but none has run live
yet. [docs/STATUS.md](docs/STATUS.md) lists every capability with its evidence and its gaps.

## Documentation

- [Architecture](docs/01-architecture.md): the design decisions and the reasons for them
- [AI access](docs/subscription-architecture.md): subscriptions, never API keys, and how each agent signs in
- [Agent Workspace](docs/agent-workspace.md): plans, hand-offs, approvals and the live view
- [User experience](docs/user-experience.md): the screens and the plain-language vocabulary
- [Extending](docs/extending.md): new team members, tools, MCP servers and agents
- [Operations](docs/operations.md): running, Docker, logon start, backups
- [Status](docs/STATUS.md): what is verified, with evidence

## Licence

Atelier is proprietary software, all rights reserved. The source is public so you can read and evaluate it, but you
need a licence from the author to use, copy, modify or distribute it. See [LICENSE](LICENSE). To ask for a commercial
licence, open an issue on this repository.

Each agent you connect is used under its own vendor's terms. Claude, Gemini, Codex, Copilot, Cursor and the other
names here belong to their owners. Atelier is not affiliated with or endorsed by any of them.
