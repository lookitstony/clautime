---
description: Run parallel code review + security audit on recent changes
---

# Review Workflow

## Phase 1: Identify Changes

```bash
git diff HEAD~1
```

If no recent commit, use `git diff` for unstaged changes.

## Phase 2: Parallel Review

Launch these agents in parallel:

1. **Code Reviewer** — Read `.claude/agents/clautime-code-reviewer.md` for role instructions. Review all changed files for quality, correctness, and best practices.

2. **Security Reviewer** — Read `.claude/agents/clautime-security.md` for role instructions. Audit all changed files for security vulnerabilities.

## Phase 3: Report

Combine findings from both reviews into a single report:

```
## Review Summary
- Code Review: X blocking, Y concerns, Z nits
- Security Audit: X critical, Y high, Z medium

## Findings
[Combined findings grouped by file]

## Verdict
[Overall recommendation]
```

If there are BLOCKING or CRITICAL findings, list them prominently at the top.
