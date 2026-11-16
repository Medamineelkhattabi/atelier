---
name: adr
description: Write an architecture decision record in docs/decisions when a significant technical decision is made or changed (choosing a library, a data store, an API shape, a deployment approach).
---

# Writing an architecture decision record

1. List `docs/decisions/` and take the next number (4 digits, e.g. `0007-...md`).
2. File name: `NNNN-short-kebab-title.md`.
3. Content, short and factual:
   - `# N. Title`
   - `- Status: proposed | accepted | superseded by NNNN`
   - `- Date: YYYY-MM-DD`
   - `## Context`: the forces at play, constraints, what triggered the decision.
   - `## Options considered`: 2-4 options with their main trade-off each.
   - `## Decision`: the choice, in one paragraph.
   - `## Consequences`: what becomes easier, what becomes harder, follow-ups.
4. Never rewrite an accepted record: write a new one that supersedes it and update the old one's status line only.
