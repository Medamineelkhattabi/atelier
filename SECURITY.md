# Security policy

Atelier runs AI agents on your code and your machine, so security reports are welcome and taken seriously.

## Reporting a vulnerability

Please **don't describe a vulnerability in a public issue.** Open an issue titled **"Security contact request"**
with no details, and the author will reply with a private way to send the report. Include in the report:

- what an attacker could do, and what they need first (an account, a malicious file in a project, a web page an
  agent reads...);
- the steps to reproduce it, on the latest `main`;
- the agent involved (Claude Code or an ACP agent), if any.

## Scope

In scope: anything that lets an agent or a web page go around Atelier's permission gate, approvals, project
boundary, private folders or secret redaction, and any weakness in authentication, sessions or the API.

Out of scope: what an agent does entirely inside itself without asking Atelier (that depends on the agent's own
settings), and weaknesses in the agents themselves. Please report those to their vendors.

## Supported versions

The latest `main` is supported. Fixes are made there.
