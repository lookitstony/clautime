# Keep-saved resolution code review

Status: the P2 finding below is now fixed locally. See `fs01-stale-approval-fix.md` for implementation and 120 distinct passing targeted tests. The original reproduction is retained below as review evidence.

Reviewed the latest local resolution implementation, its queue/schema/IPC/UI, scan/rebuild data flow, invoice-preview guard and tests. No application fixes or production access. Earlier uncommitted work is preserved. No Claude review performed in this turn.

## Finding: P2 - Kept comparisons are not invalidated by ordinary scans without changed source files

`retainedResolutionCount` checks the accepted fingerprint only inside the per-source reconciliation loop. `scanSessions` returns early when no files need processing; it also never processes missing/disabled/excluded sources. Session edits do not reopen the persisted case. The queue reader and invoice guard trust `resolved_at` without revalidating the decision.

Reproduced with a disposable SQLite database and mocked providers/Stripe/AI:

1. Capture a ten-minute automatic session and assign a client with a $100/hour rate.
2. Change the idle timeout to trigger a comparison and explicitly keep the saved history.
3. Change that session's duration/end to two hours after approving the comparison.
4. Run an ordinary scan with the source unavailable. The scan succeeds, the queue stays empty, and invoice preview generates a $200 line.
5. Run a full retained-activity rebuild. The same state immediately reopens review and invoice generation now rejects with `SESSION_RECONCILIATION_REQUIRED`.

This is more than a brief delay until the next scan: unchanged or missing source files can leave the approval stale indefinitely across ordinary scans. The resolution workflow promises changed saved records require another review, and its billing gate should not depend on whether a physical transcript happened to change.

Suggested fix: invalidate affected kept comparisons on saved-history/policy changes, or revalidate their fingerprints before presenting them as resolved/using them for billing. An ordinary scan must account for retained kept sources even when their physical files are unchanged or gone. Preserve the accepted decision as audit history.

Evidence: `fs01-resolution-review-probe.json` (one passing probe asserting the observed defect), `fs01-resolution-review-probe.txt` (repro source using the existing fixture harness). The temporary executable test file was removed after verification; application source and existing tests are unchanged. The probe asserts current behavior, not desired fixed behavior.

No additional confirmed findings in this review scope. Full replacement mappings, legacy adoption and provider-operation/draft validation remain documented unfinished work rather than new findings here.
