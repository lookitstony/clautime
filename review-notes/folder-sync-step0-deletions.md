# Step 0: local history deletion — 2026-09-15

This continues the local Step 0 implementation. It does not complete Step 0 or introduce sync transport.

## Implemented

- Migration `0025_session_deletions.sql` adds durable deletion intent with a UUID, original local session ID, source/tool/conversation identity, detector time range, and creation timestamp. It does not rewrite existing sessions.
- Explicit **Delete from history** is available for manual and automatic sessions with confirmation. It preserves the original session row, measurements, model usage, summaries, git links, and saved invoice lines/amounts. Repeating the deletion is idempotent.
- Automatic deletion uses the saved detector baseline, independent of user-edited times. Legacy automatic rows without that mapping cannot yet be deleted; the error requests a rescan and mapping resolution instead of guessing a range.
- Active session queries, token totals, time breakdowns, reports, live totals, AI context, attribution, and new invoice generation exclude deleted rows. Existing invoice snapshots and billed row IDs remain intact. Deleted rows cannot be edited or split through the session API.
- Rescans suppress detected intervals contained in the deleted activity range, including children produced by a shorter idle policy. Independent later intervals in the same source still import. A growing or merged interval that crosses a deletion boundary produces a visible per-file reconciliation error; independent files continue.
- Existing git correlations survive; new correlations do not target deleted sessions.
- Reset rejects before any writes when deletion records exist. It must not silently erase tombstones or partially clear audit data. A fully redesigned reset workflow remains out of scope for this slice.
- The renderer refreshes session/live totals after deletion and displays rejected deletion errors without closing the session.

## Verification

- A real-file regression first failed on the old destructive delete behavior (`folder-sync-deletion-red.json`).
- 186 distinct tests passed: session service 35, real-file retention 9, deletion integration 6, client/project 42, live monitor 3, detector 45, watcher 3, SessionsPage 16, session hooks 6, scan errors 2, SessionDetailPanel 19.
- Reports: `folder-sync-deletion-services.json` and `folder-sync-deletion-ui.json`; final affected-suite reruns are in `folder-sync-deletion-final-services.json` (50) and `folder-sync-deletion-final-ui.json` (19). Count overlapping runs only once.
- Fixtures exercise actual source reparse, source removal and DB restart, invoice amounts and saved references, deleted-time overrides, healthy later intervals, crossing boundaries, policy splits, mutation guards, and reset rejection before writes.
- Both TypeScript typechecks and targeted ESLint passed. Native SQLite tests ran through Electron as Node with `--pool=forks --maxWorkers=1`; the dependency was not rebuilt.

## Remaining Step 0 work

- Revisioned edits and explicit split records; predecessor mappings and invoice-safe non-counting historical rows for recalculated intervals.
- A dedicated reconciliation queue and resolution UI, including boundary changes crossing deleted ranges and legacy adoption with incomplete activity.
- Deletion identity is still local source/conversation/range identity. Copied or renamed logs and cross-device deletion convergence require Step 1 canonical activity/project identities and subsequent transport. The confirmation does not claim that unimplemented sync is active.
- Existing explicit splits are still destructive. Reset without tombstones retains its old semantics. These are not ready for a sync rollout.

All migrations ran only on disposable fixtures. No live database, installed app, cloud folder, Stripe state, or production deployment changed. Existing uncommitted work was preserved. No commit/push and no fresh Claude review in this continuation.
