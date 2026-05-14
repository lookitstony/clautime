---
argument-hint: [description of issue]
description: Troubleshoot and fix an issue — assess, fix, verify, commit
---

# Fix Workflow

You are fixing: **$1**

## Phase 1: Assess Current State

Run these in parallel:
```bash
git status
git diff
npm run test
npm run typecheck
```

Identify the problem category:
- Build errors (TypeScript, missing imports)
- Test failures
- Runtime bugs (logic errors, missing handlers)
- UI issues (rendering, styling, state)

## Phase 2: Fix in Priority Order

1. **Build errors** — Fix TypeScript errors, missing imports, type mismatches
2. **Test failures** — Fix broken tests or the code they test
3. **Runtime bugs** — Fix logic errors, missing error handling, incorrect behavior
4. **UI issues** — Fix rendering, styling, state management

Read `.claude/agents/clautime-developer.md` for coding standards.

For each fix:
- Identify root cause before changing code
- Make minimal, targeted changes
- Verify the fix doesn't break other things

## Phase 3: Verify

Run in sequence:
```bash
npm run typecheck
npm run test
```

If still failing, repeat Phase 2.

## Phase 4: Commit

1. Stage specific changed files
2. Commit with message: `Fix [description of what was fixed]`
3. Report what was done and what was fixed
