# {{project_name}}: working rules for Claude Code

What this project is, in two sentences. Where the main code lives.

## Commands
- Install: `...`
- Test: `...` (run before claiming a change works)
- Lint: `...`

## Conventions
- Follow the patterns already in the code before inventing new ones.
- Small, focused changes; one concern per commit.
- New behaviour comes with tests.

## Hard rules
- Never read, print or commit secrets. Keys come from environment variables; `.env` files stay untracked.
- Ask before: installing dependencies, destructive file or Git operations, anything that calls paid APIs or external services.
- Report test results as they are, failures included.
