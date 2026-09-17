# FS01: explicit adoption of source-less legacy history

Local continuation, September 16, 2026. Returning activity with the same provider and known conversation as an active, unanchored legacy session without a source path is now held for review instead of creating duplicate history. Conversation identity proposes a candidate; only an explicit mapping attaches it to the returning log.

## Implemented

- Null and empty saved source paths are supported. Independent conversations and other providers continue importing. Candidates participate in saved comparisons and fingerprints, including revalidation of earlier keep-saved decisions.
- Existing **Map detected activity** pairs each detected interval with a distinct active saved session. Source-less candidates are included, and the confirmation explains that mapping links them to the retained source log.
- Mapping preserves the local ID, creation time, saved times/edits, assignments and invoice references. It snapshots legacy values and model totals, records the source attachment and measured values in a revision, and stores detector baselines/time overrides in the same transaction. Prompt/model/token totals use the explicitly approved detected values.
- Source attachment records assignment intent so normal attribution cannot overwrite saved unassigned or client-only choices. Future appends update the same mapped row; prompt timelines use its detector bounds.
- Source-less split children cannot bypass the existing split guard. Deleted candidates, stale comparisons and unresolved multi-row mappings remain guarded. Detected replacement cannot bypass source-less adoption.
- Matching pending reviews block affected invoice previews; saved invoice lines and existing billed-work exclusions remain intact.
- No new migration: existing legacy snapshots, revisions and reconciliation JSON columns store the additional information.

## Verification

The two initial adoption regressions failed before implementation. **262 distinct tests across ten targeted suites pass**, along with both typechecks, targeted ESLint and the diff whitespace check. The real-file fixture passed after using the existing first-run scan-and-rebuild flow (backfill captures raw messages before initial reconciliation).

Coverage includes null/empty paths, provider/conversation separation, unrelated-source progress, late candidate discovery and keep-saved revalidation, stale mapping rejection, legacy split/deletion guards, rollback at resolution persistence, invoice audit, assignment intent, prompt timings, restart, source removal, provider disabling, restored logs and later appends. UI coverage verifies source-less labeling and explicit source-link confirmation. All databases and source files were disposable fixtures; no production changes, commit or push.

FS01 remains In Progress. Edited-time replacement, explicit split/deletion reconciliation and broader unmatched/unanchored legacy adoption remain open. Rows with no known conversation identity cannot use this workflow. Canonical cross-device identity and folder transport remain later steps.
