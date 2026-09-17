# FS01: explicit one-to-one activity mapping

Local continuation, September 16, 2026. History reviews now offer **Map detected activity** when every saved row is active and the saved/detected counts match. The user must select a distinct saved session for each detected interval and confirm the displayed comparison. Nothing is paired automatically. Refreshed comparisons reset pending selections; backend fingerprints reject stale confirmations.

Mapping preserves local IDs, saved times, assignments, descriptions, billable flags, creation timestamps and invoice references. It updates prompt/model/token/cache measurements from retained activity and establishes detector baselines. Explicit and inferred time overrides remain pinned; later scans can update unedited measurements normally. Original legacy snapshots are retained, and full before/after values plus the selected mapping are recorded in session revisions and linked reconciliation resolutions.

One transaction covers snapshots, revisions, measurements, baselines, overrides and resolution. Invalid/incomplete/duplicate pairings, foreign session IDs, changed provider or known conversation identity, busy scans, and sources with split/deletion history are rejected. A mapping can explicitly supersede a prior keep-saved decision; new incompatible boundaries still reopen review. Existing saved invoice rows are unchanged.

Verification: three initial integration regressions failed before implementation. **167 tests across eight targeted suites pass**, including backend and renderer coverage. A final strengthened token/cache fixture passed the 44-test split/mapping suite. Both typechecks, targeted ESLint and diff checks passed. Checks cover stale comparisons, rollback, original snapshots, invoice eligibility, reordered pairings, restart, subsequent scans/policy changes, boundary guards, explicit UI selection, cancellation, refreshed selection reset and presentation-mode masking. All database work used fixtures and billing/AI services were mocked.

No new SQL migration is needed: existing revision/action text and comparison JSON store the additional audit records. Nothing was deployed, committed or pushed; no live database or external billing state changed.

FS01 remains In Progress. Many-to-one/one-to-many replacements with predecessor audit mappings, resolution across existing splits/deletions, source-less deletion and full legacy adoption remain open. Canonical cross-device identities, shared policy and folder transport are still later steps.
