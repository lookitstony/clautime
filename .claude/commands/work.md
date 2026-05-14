---
argument-hint: [description of work]
description: Full implementation workflow — analyze, implement, test, review, commit
---

# Work Implementation Workflow

You are implementing work described by: **$1**

## Phase 1: Analysis (Parallel)

Launch two agents in parallel:

1. **BA Agent** — Read `.claude/agents/clautime-ba.md` for role instructions. Analyze the work description and identify:
   - What user story this fulfills
   - Acceptance criteria
   - Edge cases to handle
   - Affected features/pages

2. **Architect Agent** — Read `.claude/agents/clautime-architect.md` for role instructions. Analyze the work description and identify:
   - Which files need changes
   - Architecture approach
   - Database changes needed
   - IPC changes needed
   - Risks or concerns

Wait for both agents. Synthesize their findings into a brief implementation plan. Present the plan to the user before proceeding.

## Phase 2: Implementation

Read `.claude/agents/clautime-developer.md` for coding standards and patterns.

Implement the changes following the developer agent's checklist:
- Follow existing patterns exactly
- Use IpcResult for all IPC
- Services as singleton objects
- TanStack Query for server state
- Tailwind v4 for styling

## Phase 3: Tests

Launch a **QA Agent** — Read `.claude/agents/clautime-qa.md` for role instructions.
- Write tests for new service methods
- Write tests for new components if applicable
- Run `npm run test` and fix any failures

## Phase 4: Review (Parallel)

Launch these review agents in parallel:

1. **Code Reviewer** — Read `.claude/agents/clautime-code-reviewer.md`. Review all changed files.
2. **Security Reviewer** — Read `.claude/agents/clautime-security.md`. Audit changed files for vulnerabilities.

Wait for both. Collect all findings.

## Phase 5: Fix Findings

Fix any 🔴 BLOCKING or 🔴 CRITICAL findings from the reviews. 🟡 items are at your discretion. 🟢 NITs can be skipped.

## Phase 6: Commit

1. Run `npm run test` to verify everything passes
2. Stage changed files (specific files, not `git add -A`)
3. Commit with a descriptive imperative message summarizing the work
4. Report what was done
