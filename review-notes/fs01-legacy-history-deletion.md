# FS01: Retained legacy records and explicit deletion

Local continuation, September 16, 2026. FS01 / #38 remains In Progress. Existing uncommitted work is preserved; no production access, deployment, commit or push.

## Implemented

- Additive migration `0029_session_legacy_records.sql` captures automatic sessions without a detector baseline as immutable legacy snapshots. Each has a stable UUID, format version, original saved session values and per-model input/output/cache counts. Source-less rows are included in preservation. Manual sessions and already anchored automatic sessions are excluded. Existing session IDs, active totals, edits and invoice rows are not rewritten, and no raw events or detector baselines are fabricated.
- Legacy rows added after migration are snapshotted on explicit deletion. The snapshot and deletion commit atomically. A migrated row reuses its original snapshot identity; later user edits stay on the session/revision stream and do not rewrite that original snapshot.
- An automatic session without a baseline can now be deleted when its source path is known. The deletion references its legacy snapshot. Saved start/end times remain audit metadata, not inferred activity anchors. Original rows and invoice references remain intact; deleted rows leave active totals.
- Returning activity from a source with a legacy deletion is held in the review queue regardless of whether it overlaps the saved, possibly edited timestamps. Healthy sources still reconcile. The user can explicitly keep the saved/deleted state for that comparison; new activity later reopens review under the existing decision rules.
- Reset refuses before writes if legacy snapshots exist, including snapshots with no deletion. The delete confirmation explains that returning older activity may need review.

## Verification

**131 distinct passing tests in this continuation**: 82 native service tests and 49 renderer tests. Both typechecks, targeted ESLint and diff checks pass.

- Red regression: `fs01-legacy-deletion-red.json` (the old baseline guard rejected the requested legacy deletion).
- `fs01-legacy-deletion-services.json`: 80 passing service tests.
- `fs01-legacy-deletion-migration.json`: 12 passing retention tests, superseding 11 in the service report.
- `fs01-legacy-deletion-final.json`: 9 passing deletion tests, superseding 8 in the service report.
- `fs01-legacy-deletion-ui.json`: 49 passing detail/split, review-panel and Sessions-page tests.

Tests cover migrated legacy UUIDs and exact saved metadata, all token categories, source-less preservation, manual/anchored exclusion, no fabricated facts, existing invoice snapshots, migration replay, changed user values after migration, real returning source files and database restart, idempotent deletion, atomic rollback, deleted legacy intervals outside their saved times, healthy-file isolation, keep-saved resolution, reset protection and the remaining source-less guard. All migrations ran on disposable fixtures only; external billing/AI services were mocked.

## Remaining scope

Deletion of an unanchored automatic row with no source path is still guarded because this local detector cannot recognize returning activity safely. Legacy splitting and explicit replacement mappings remain unfinished. The snapshot format is local; portable export/adoption, cross-path copied-activity recognition and cross-device identities belong to later identity/sync work. Returning work from a source with a legacy deletion is conservatively held as a whole source until reviewed; no exact range identity is claimed.

Legacy snapshots are non-counting audit data linked to the existing session row. This slice does not enroll all unanchored rows in the review queue, create sync transport or mark full legacy adoption complete. Migration is not deployed to the live database.
