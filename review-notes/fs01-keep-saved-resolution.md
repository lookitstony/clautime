# FS01: Explicit keep-saved resolution

September 16, 2026 continuation. Local implementation only; preserve all prior uncommitted changes. FS01 / #38 remains In Progress.

## Implemented

- The persistent review queue now offers **Keep saved history**, followed by an explicit confirmation. This selects the saved session values, existing splits and deletions for the reviewed comparison. Detected alternatives remain outside active totals; existing invoice line-item generation may use the retained saved history again.
- Additive migration `0028_session_reconciliation_resolutions.sql` adds a nullable comparison fingerprint and an append-only resolution table. Choices have UUIDs, per-source sequence numbers, parent decision IDs, comparison snapshots and timestamps. This is local revision history; portable identity and cross-device resolution remain later work.
- SHA-256 fingerprints bind approvals to full saved session rows, detector baselines, time-override flags, model usage, splits, deletions, reconstructed main/subagent facts, detector output, idle timeout and local timezone. No transcript content or credentials are exported. These are local comparison fingerprints, not canonical cross-device event identities.
- Approval recomputes the comparison inside the same synchronous SQLite transaction that appends the decision and resolves the queue. Changed saved metadata, changed facts even with equal totals, changed policy, migrated previews without fingerprints and concurrent scans reject approval. Retry of an already accepted unchanged comparison is idempotent. A failed queue update rolls back the decision.
- Scans and rebuilds honor a keep decision only for the same reviewed state. On a subsequent scan, changed activity, saved records or policy reopen review before ordinary reconciliation can replace saved history, even when a new policy would otherwise allow one-to-one matching. Healthy sources still commit. Unchanged retained facts survive source removal, reparse and database restart; successful scans advance checkpoints normally.
- The renderer pins confirmation to the displayed fingerprint. A background comparison refresh cannot silently switch the pending approval. UI cancellation performs no mutation; stale or busy rejections remain visible. Older comparisons require Recheck to obtain a current fingerprint.

## Verification

**131 distinct tests pass** in this continuation: 74 native service tests (`fs01-resolution-services.json`) and 57 renderer tests (`fs01-resolution-ui.json`). The final 10 review-panel tests also passed after removing an unsupported test-query option (`fs01-resolution-ui-final.json`; overlap, not additional tests). Both typechecks, targeted ESLint and diff checks pass. Initial failing regression is `fs01-resolution-red.json`.

Covered retained legacy aggregates; decision deduplication and parent chains; growth reopening; stale metadata/policy/fact rejection; an equal-total event identity correction; policy recovery that must still honor prior keep intent; busy-scan rejection; transaction rollback; missing source and reopened file database; scan checkpoint advancement; explicit splits/deletions and unchanged invoice/billed-work references; migration of pending comparisons; explicit UI confirmation/cancel, stale rejection and a comparison update while confirming. Existing retention, deletion, date-filter, split UI and scan notification tests were rerun.

Only disposable databases and source fixtures were used. Migrations 0023 through 0028 ran on fixtures. Stripe/AI were mocked; the changed app was not launched. No production database, cloud export, deployment, commit or push occurred. No fresh Claude review was requested or performed.

## Scope still open

This is an explicit decision to keep one reviewed saved state, not a replacement-mapping workflow. New work in that source is held pending another review when detected by a later scan. Reopening due to saved edits or policy changes likewise occurs on scan/rebuild; this slice does not add a general billing-time revalidation of prepared drafts or external provider operations. The confirmation states the limited decision scope.

Replacing ambiguous intervals, carrying scoped edits onto replacement intervals, full legacy adoption with absent facts, and safe deletion/splitting of unanchored legacy rows remain unfinished. Keeping a legacy comparison does not fabricate a detector baseline or enable those operations. Sources with no reconstructable facts are still preserved but not automatically enrolled in this queue. Source-level keep choices may hold more activity than a future canonical range decision would. The combined FS01 queue/resolution acceptance item stays unchecked until the full workflow exists. Canonical identities, shared policy, transport and portable invoicing remain later tickets.
