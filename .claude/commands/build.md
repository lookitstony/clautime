---
description: Build ClauTime — runs typecheck + electron-vite bundle
---

Run the full build for ClauTime:

```bash
npm run build
```

This runs `typecheck` (both node + web) then `electron-vite build`.

If the build fails:

1. Check TypeScript errors first — run `npm run typecheck:node` and `npm run typecheck:web` separately to isolate
2. Fix type errors before re-running build
3. If native module issues, run `npm run rebuild:electron`

Report the build result — success or failure with error details.
