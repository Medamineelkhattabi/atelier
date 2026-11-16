# Changelog

## 2026-11-16: first public release

**Any agent, no API keys**
- Team members can run on any agent that speaks the Agent Client Protocol: Gemini CLI, Codex, GitHub Copilot,
  Cursor, goose, OpenCode, Qwen Code, Mistral Vibe, or one you add in Settings. Claude Code stays built in.
- Each agent runs on its own sign-in. Atelier starts it without its vendor's API keys, and the secret store refuses
  AI vendors' model keys.
- An agent's permission requests and file access go through the same gate as Claude Code's tools: the project
  boundary, private folders, secret files, approvals and auto mode.
- To choose an agent, use **Runs on** on a member's page. Tools & Connections lists the agents, whether each is
  installed, and how to install it and sign in.

**The team**
- 15 specialists: Coordinator, Software Engineer, Security Engineer, Architect, Debugger, Tester, Code Reviewer,
  Deployer, Researcher, Planner, Technical Writer, Data Analyst, Document Specialist, Automation Specialist and
  Grader.
- Direct mode: in a code project, a request goes straight to the Software Engineer, which works like a Claude Code
  session and continues that session for follow-ups.
- Plans you approve before work starts, with dependencies, parallel steps, hand-offs, retries, pause and stop.

**Safety**
- One permission and approval gate, with an Approvals inbox, and an auto mode whose exceptions (deploys, pushes,
  publishing, data leaving your machine) you choose.
- An automatic security review of every code change, with a verdict, findings with file and line, and
  **Fix what blocks**.
- Encrypted, write-only secrets, redacted everywhere. An audit log. Project folders, secrets and events kept apart.

**Everyday use**
- Home, Live Workspace with the detailed map, My Work, Approvals, My AI Team, My Projects, Tools & Connections and
  Settings, all in plain language, in light and dark, and at phone width.
- An app watcher with Windows notifications and a read-only diagnosis when something breaks.
- Starts at Windows logon. A Docker image is available.
