# FS01: Stale kept-approval review fix

Fixed the P2 finding in `fs01-keep-saved-code-review.md` locally. No live database, deployment or external billing operation was used.

## Change

`sessionService.getReconciliationCases()` now revalidates previously resolved kept comparisons against current saved rows, edit intent, retained activity, detector output and policy before returning the queue. It does not depend on source-file discovery. Changed comparisons reopen transactionally with a fresh preview and fingerprint; accepted resolution audit records and session data remain intact. Unchanged approvals perform no writes. Only resolved cases with keep decisions are revalidated; pending comparisons keep their last-check snapshot until an explicit recheck or scan refreshes them.

Invoice line-item generation uses this revalidating entry point before selecting billable work. This catches session edits and bulk client/project assignment changes even without a scan. Ordinary scans, including the no-changed-files path, read the refreshed queue and report pending reviews. Missing, disabled or excluded source files cannot leave a stale kept approval silently usable for invoice previews.

No migration or frontend change was required. Existing prepared-draft/provider-operation limitations remain outside this fix. Revalidation reads retained facts for kept sources, so its cost depends on the amount of kept history; broader performance QA remains part of FS01/release verification.

## Verification

- Red regression: `fs01-stale-approval-red.json` reproduces invoice generation succeeding when it should reject.
- `fs01-stale-approval-services.json`: 75 service tests pass.
- `fs01-stale-approval-final.json`: 68 tests pass, including the expanded 26 split/reconciliation/billing tests and 42 client/project tests; overlaps the prior report.
- **120 distinct passing targeted tests**, both typechecks, targeted ESLint and diff check pass. No renderer code changed; this count excludes prior renderer runs.

New regressions cover stale edited time blocked before any scan, approval audit preservation, deliberate reapproval restoring invoice eligibility, review-list and ordinary-scan policy revalidation without source files, bulk project reassignment, and unaffected-client eligibility. Existing source-removal/restart, unchanged approvals, split/deletion audit, legacy migration and invoice-exclusion tests also pass.

The P2 finding is fixed. FS01 remains In Progress for explicit replacement mappings and full legacy adoption. All existing uncommitted work is preserved; nothing committed or pushed.
