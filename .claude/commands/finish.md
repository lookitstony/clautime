---
description: Final gate — verify build + tests pass, push to remote
---

# Finish Workflow

## Phase 1: Catch Uncommitted Work

```bash
git status
```

If there are uncommitted changes:
1. Show the user what's uncommitted
2. Ask if they want to commit or discard

## Phase 2: Pre-flight Verification

Run in parallel:
```bash
npm run typecheck
npm run test
```

If either fails, report the errors and stop. Do not push broken code.

## Phase 3: Push

```bash
git push origin master
```

Report success with:
- What was pushed (commit range)
- Any warnings from the push
