# FS01: preserved splits and local revisions — 2026-09-16

Continues [FS01 / #38](https://github.com/lookitstony/clautime/issues/38). FS01 remains In Progress; no sync transport or live rollout is complete.

## Implemented locally

- Session field edits now create immutable revisions with before/after values, per-session sequence, parent revision and the known activity range. No-op submissions do not create revisions. Unmapped legacy edits keep a null activity anchor instead of inventing one. These are local causal records; cross-device field merging is FS04.
- Explicit splits record their boundary, revision and predecessor/child IDs atomically. Original rows, model usage, summaries and git links remain as non-counting audit history. Nested splits are supported. Children retain provider, billable flag, assignments and descriptions.
- Rescans replay split records before normal reconciliation. Unambiguously growing sources update the same child IDs; child edits and deletions survive reparse, source removal and DB restart. Parent time overrides are inherited even when their saved values equal the current measurements.
- Splits conserve the saved duration and aggregate/per-model/cache token totals. They retain the existing proportional allocation of prompts/tokens; this is an estimate, not event-exact attribution. The UI states that limitation. Raw facts remain retained for the later canonical activity work.
- The session panel now offers Split session, an elapsed-minutes boundary input and time preview, confirmation/cancel, and visible validation/mapping errors. Elapsed offsets avoid choosing a different date for sessions spanning midnight.
- Local billed-work references survive invoice hiding and follow split descendants. New invoice generation excludes already-linked work in the selected test/live mode, including descendants of an invoiced predecessor; billing one child leaves its sibling eligible. Original saved invoice lines/amounts/IDs remain unchanged by splitting. Existing comma-separated links are migrated conservatively; malformed/missing IDs are skipped.
- Reset refuses before any writes when revisions or billed-work audit references exist. Archived predecessors cannot be edited, split again, or deleted through the active session API; operate on active children instead.
- Migration `0026_session_history.sql` adds revision, split and local billing-reference tables. It has run only against disposable fixtures. No existing session/invoice snapshots are rewritten by migration.

## Verification

- A real-file split/restart regression first failed against the previous destructive split implementation: `fs01-split-red.json`.
- **202 distinct tests passed**: session service 35, real-file retention 10, deletion integration 6, split/revision/billing integration 11, clients/projects 42, live monitor 3, detector 45, watcher 3, SessionsPage 16, session hooks 6, scan errors 2, SessionDetailPanel 23.
- Reports: `fs01-split-services.json` (106, before the final reset test), `fs01-split-ui.json` (95), and `fs01-split-final.json` (62 affected service tests, including the final reset test). Overlapping runs count once.
- Tests exercise nested splits, metadata/time/token conservation, parent/child edit intent, deletion of a child, append/restart after source removal, ambiguous policy changes with healthy-file progress, invalid/legacy split rejection, transaction rollback, invoice hiding/test-mode boundaries, unbilled siblings, legacy billing-link migration, and reset rejection before deletion.
- Both TypeScript typechecks, targeted ESLint, and `git diff --check` passed. Native SQLite suites used Electron as Node with `--pool=forks --maxWorkers=1`; dependencies were not rebuilt. Renderer tests exercise split confirmation, validation, cancel and backend rejection. No changed app was launched against live data.

## Remaining FS01 work

- Persistent reconciliation queue plus explicit resolution UI for ambiguous split/merge/policy changes, incomplete legacy history and deletion-boundary crossings. Current behavior retains history and reports per-file errors; it does not resolve these cases automatically.
- Full legacy adoption and policy-driven predecessor mapping. Automatic splitting still requires a detector baseline and a split point inside both the saved and measured intervals.
- The billed-work audit currently conservatively excludes entire linked sessions and descendants. Fine-grained billed activity/range identity, newly appended work on an already-billed interval, Stripe account binding, and explicit credit/void/rebilling resolution belong to the remaining identity/invoicing work. Hiding/voiding a saved invoice is not treated as permission to rebill.
- Historical edits predating this migration are not fabricated as user revisions. Existing time-override flags and legacy snapshots remain available for adoption.
- Fresh review and rollout verification remain outstanding. Existing app report summary/earnings wall-clock policy is unchanged; stored edited duration remains visible in session breakdowns.

All changes remain local and uncommitted. Existing diagnostics and date-filter changes were preserved. No production migration, deployment, real-history export, Stripe call or email was performed.
