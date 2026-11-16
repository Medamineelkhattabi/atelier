---
name: pre-merge
description: Final checklist before merging a branch or opening a pull request. Use when the user says the work is done, asks to open a PR, or asks whether something is ready to merge.
---

# Pre-merge checklist

Run each step and report its real result; stop at the first failure and say what it is.

1. `git status`: no unintended files (secrets, build output, local settings).
2. Lint and type checks with the project's commands (see CLAUDE.md).
3. The full test suite. Paste the summary line.
4. `git diff <base>...HEAD`: read it once more for leftover debug code, TODOs, commented-out code, and changes unrelated to the goal.
5. Docs: README/CHANGELOG/decision records updated if behaviour or setup changed.
6. Summarize for the PR description: what changed, why, how it was verified, risks.
