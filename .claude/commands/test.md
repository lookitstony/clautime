---
description: Run all ClauTime tests via Vitest
---

Run the full test suite:

```bash
npm run test
```

If tests fail:

1. Report which tests failed with file paths and error messages
2. Analyze the root cause — is it a test bug or a code bug?
3. If better-sqlite3 native module errors occur, run `npm run rebuild:node` first then rerun tests

Report the test results — total passed, failed, and skipped.
