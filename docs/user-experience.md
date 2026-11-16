# User experience

The interface is written for someone who knows nothing about agents, runs, graphs or
providers. This page records the product decisions so later changes keep them.

## Navigation

| Place | What it is for |
|---|---|
| **Home** (`/`) | "What would you like to accomplish?": describe a goal, pick or create a project, start. Below: what needs you, what is in progress, recent work |
| **Live Workspace** (`/workspace/<task>`) | Follow one task: the Coordinator's plan to check first, who works on what, what each received from another, approvals, the final result, "What next?" to continue it, a plain activity feed. "Detailed map" is the technical graph |
| **My Work** (`/work`) | Everything you asked for, searchable, filtered by plain statuses |
| **Approvals** (`/approvals`) | Sensitive actions in plain words ("Technical Writer wants to create the file ..."), with what approving changes |
| **My AI Team** (`/team`) | Short cards: name, one line, "Only reads" / "Can make changes" / "Asks first", Ask. The profile (`/team/<id>`) has when it helps, what it can do, what it will not do, who it works with |
| **My Projects** (`/projects`) | Separate folders, notes for the team, passwords, and per project "Work without asking" (file edits, reading and tests) and "Watch the app" (Windows alert and a read-only diagnosis when the running app breaks) |
| **Tools & Connections** (`/tools`) | What the team can use, the rule for each (ask first, allow, block), connections (MCP) |
| **Settings** (`/settings`) | Claude subscription (with a sign-in button), account (your name, "Approve actions automatically", password), passwords and keys, usage, advanced options |

Advanced screens stay reachable but out of the way: technical task details (`/runs/<id>`), a team
member's advanced settings (`/team/<id>/settings`). Removed from the interface (the backend keeps
them): quality checks, the manual team launchers, project starter files, labels and descriptions,
the Claude Code `.mcp.json` panel and access tokens. Former addresses redirect (`/agents` → `/team`,
`/history` → `/work`, `/evals` and `/team/checks` → `/team`, `/runs/new` → `/`).

## Vocabulary

`frontend/src/lib/plain.ts` is the single source of the words shown to the owner:
**task** (what you ask; a root run), **step** (one team member's part; a plan task),
**team member** (an agent, always by name: Researcher, Coordinator...), **approval**,
**project**. Statuses are plain ("Working", "Needs your approval", "Couldn't finish",
"Stopped"). Actions needing approval are described from their real tool and arguments.
Technical words appear only under "Technical details" or "Advanced".

Team member names, "useful when" and responsibilities come from `agents/*.toml`
(`name`, `when_to_use`, `responsibility`, `boundaries`), so they are the same in the UI and
in what the Coordinator reads when choosing who does what.

## Decisions made for the owner

- In a code project (a Git repository, or a folder with a build or dependency file) a request goes straight to
  the Software Engineer: one session, like Claude Code, no Coordinator and no plan (owner's decision, 2026-11-14:
  the team route took far longer than Claude Code for one change). Elsewhere a request goes to the Coordinator,
  which splits it among specialists; a suggested activity goes straight to the one team member it needs. The owner can change this ("Change" on Home), but
  never has to.
- The Coordinator's plan is checked before anything starts: numbered steps, "Start the plan" or
  "Change it" with what should change (the Coordinator then proposes a revised plan).
- A finished task can be continued ("What next?" → Continue): a new task in the same project that
  links back ("Follows: …") and is marked "follow-up" in the lists.
- Screens stay light: a short title, at most one line under it, essentials on cards; longer
  explanations sit behind a "?" (keyboard accessible) or a collapsed "Details" / "Technical details".
- Lists show the owner's own work; runs started by quality checks are kept apart (`origin`).
- Claude sign-in: the "Connect my Claude subscription" button opens Anthropic's own sign-in in
  a window on this computer (Windows desktop, platform on the loopback address). Elsewhere it
  shows the one command to run. The platform never sees the credential.
- Nothing is invented: steps, hand-offs, results and the activity feed come from recorded
  runs and events; nothing moves when nothing happens.
- Results are shown formatted (headings, tables, lists) from the team members' Markdown, never as raw
  symbols and never as raw HTML (`frontend/src/lib/markdown.tsx`).
- Screens are light by default. Settings › Appearance (and the switch at the bottom of the menu) offers
  light, dark or the computer's setting, kept in the browser; `public/theme.js` applies it before the
  page draws, without weakening the Content-Security-Policy.

## Verified journeys

`backend/tests/test_e2e_journeys.py` drives the built interface in Chromium against a real
server: understanding Home, discovering the team, creating a project, starting a task,
checking the plan (and sending one back with what should change), following it, inspecting results,
approving and rejecting, the detailed map, continuing a finished task, finding past work, pause and
stop, project wizard, old addresses; and a phone journey with a check that
no screen scrolls sideways at 390 px. The AI model is replaced by the labelled scripted test
double; everything else is real.
