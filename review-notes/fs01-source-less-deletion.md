# FS01: deleting legacy history without a source path

Local continuation, September 16, 2026. Automatic legacy rows with no source path can now be explicitly deleted when they retain a nonblank conversation ID. The existing snapshot and deletion transaction preserves original saved values, per-model/cache totals and invoice references. Null and empty paths are supported. No activity events or detector anchors are fabricated, and rows with neither a usable path nor conversation ID remain guarded.

Returning activity with the same provider and conversation ID is held for review regardless of its file path or timestamps. Conversation identity identifies a possible match only; the implementation does not guess which interval was deleted. Independent conversations and other providers continue reconciling. The existing review UI includes the source-less deleted row as audit history. Its client/project context participates in invoice blocking, and one-to-one mapping cannot bypass the deletion.

Comparison fingerprints include these matching deleted rows, so a newly added deletion invalidates pending confirmations and previously kept comparisons. Keep saved history can retain the deletion for the current comparison; added activity or another file path requires review again.

## Verification

Four initial regressions failed against the old source-path guard. All **179 tests across eight targeted suites**, both typechecks, targeted ESLint and diff whitespace checks now pass. Coverage includes:

- Null/empty paths, blank identity rejection, idempotent deletion, preserved token/cache and invoice audit records, and transactional rollback.
- Provider/conversation separation, unrelated-source progress, review previews, affected invoice blocking, stale keep/mapping rejection and revalidation after another deletion.
- Migration of source-less legacy snapshots, database restart, real returning JSONL files, source removal, retained-activity rebuilds, a second file path and appended activity after keep-saved resolution.

No SQL migration was needed. All database operations used disposable fixtures; external billing/AI services were mocked. No live database, installed application, cloud folder or Stripe state changed. Nothing was committed or pushed.

FS01 remains In Progress. Identity-free legacy deletion, split/merge replacement mappings, resolution across existing split/deletion history and full legacy adoption remain unfinished. Canonical cross-device identity and folder transport remain later steps.
