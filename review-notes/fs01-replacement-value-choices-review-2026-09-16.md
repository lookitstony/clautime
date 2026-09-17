# Replacement value choices: code review

Status: **P2 fixed locally** after this review. Confirmed replacement choices now record assignment intent in the successor's existing revision history. Automatic attribution skips those sessions and their split/replacement descendants, including explicitly unassigned and client-only values. Ordinary new sessions and description-only edits still receive automatic attribution. Two permanent regressions reproduce the original failure and now pass, covering restart, new activity and later descendants; existing resolution rollback coverage verifies atomic persistence. **252 tests across ten suites** and both typechecks pass. No new migration, live change, commit or push.

Scope: the latest explicit replacement-choice workflow, preview eligibility, IPC/preload plumbing, confirmation UI, audit persistence and downstream attribution/billing behavior. Verification used disposable local fixtures. No implementation fixes or production changes were made.

## Finding

**P2: Preserve explicitly selected unassigned/client-only values during automatic attribution.** `src/main/services/session-reconciliation.ts:488` copies the selected project/client into the successor, but nothing distinguishes an explicitly selected null project from an unassigned new session. Normal scan/rebuild IPC and the file watcher subsequently call `clientProjectService.attributeSessions()`. Its null-project path (`client-project-service.ts:496`) overwrites both fields with the project and client matching the source path. A confirmed resolution therefore silently changes on the next scan, potentially moving work to a different billing client. Persist the assignment intent and have automatic attribution respect it.

Original reproduction: create two intervals with different assignments, increase the timeout to merge them, then choose the predecessor with no project and either no client or a different explicit client. Immediately after replacement, the chosen values are correct. Rebuild and run ordinary attribution: both cases changed to the path-matched project/client before the fix. Source fixture is archived in `fs01-replacement-value-choices-review-repro-2026-09-16.txt`; permanent passing regressions now live in `src/main/services/session-split.test.ts`. The temporary test was removed after verification.

## Verification

- Existing ten targeted suites: **250 tests passed**.
- Both node and renderer typechecks passed after removing the temporary reproduction fixture.
- Two focused attribution regressions failed as described above.
- Diff whitespace check passed.

No other actionable finding was confirmed in this slice. Documented limitations for edited times, explicit split/deletion reconciliation and unmatched legacy activity remain unchanged.
