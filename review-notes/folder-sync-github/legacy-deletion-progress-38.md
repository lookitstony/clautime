Parent: #37

Project: https://github.com/users/lookitstony/projects/6

Status at creation: **In Progress**. Dependencies: None; this is the first implementation gate.

Deleting source files or recalculating sessions must preserve imported work, edits, and invoice history. Complete Step 0 before introducing sync transport.

### Review fix - stale kept approvals

Fixed the P2 review finding locally: reading the reconciliation queue and generating invoice line items now revalidate kept approvals against current saved history, retained facts and policy, even when source files are unchanged or missing. Ordinary scans report reopened reviews with no changed files. Session edits and bulk project reassignment cannot leave stale approval silently usable for invoice previews. Accepted audit decisions and unrelated-client billing remain intact. **120 distinct targeted tests**, both typechecks and lint pass. Evidence: `review-notes/fs01-stale-approval-fix.md`, `fs01-stale-approval-services.json`, `fs01-stale-approval-final.json`. No new migration, frontend change, live access, commit or push. FS01 remains In Progress for replacement mappings and legacy adoption.

### Legacy history preservation and deletion

Implemented locally: migration 0029 preserves unanchored automatic sessions as immutable legacy snapshots with stable UUIDs, saved metadata and full per-model/cache totals. Explicit deletion now works when the legacy source path is known, links to that snapshot, and retains the original row and invoice audit. Returning activity from that source is held for review without inferring boundaries from edited timestamps; healthy files continue. Snapshot/deletion writes are atomic and reset protects retained snapshots. **131 distinct tests in this continuation**, both typechecks and lint pass. Migration ran only on disposable fixtures, including real source-file/restart and invoice-audit checks. Evidence: `review-notes/fs01-legacy-history-deletion.md`, `fs01-legacy-deletion-services.json`, `fs01-legacy-deletion-migration.json`, `fs01-legacy-deletion-final.json`, `fs01-legacy-deletion-ui.json`.

FS01 remains In Progress: explicit replacement mappings, legacy splitting, source-less deletion and full portable adoption remain open. This is local preservation and deletion, not completed sync/identity work. Existing changes remain uncommitted; no live migration, deployment or external billing action.

### Progress - September 16, 2026

FS01 / #38 remains **In Progress**. Explicit Keep saved history resolution is now implemented locally, with confirmation, stale-preview rejection, idempotent retries and linked resolution audit records. Scans honor the choice only for the reviewed state; later activity, saved-record or policy changes reopen review. **131 distinct tests**, both typechecks and targeted lint pass. Migration 0028 ran only on disposable fixtures. Replacement mappings and full legacy adoption remain unfinished. No live migration, deployment, real-history export, Stripe mutation, commit or push occurred.

This builds on the persistent comparison queue, per-source rechecks, invoice-preview guard, local retention, edit revisions, replayable splits and billed-work audit links. Keeping a comparison preserves saved totals, splits, deletions, invoice snapshots and billed exclusions; alternatives stay outside totals. A changed preview or a busy scan cannot be approved. Old comparison rows require recheck after migration. Sources with no reconstructable facts still need legacy adoption.

The combined queue/resolution acceptance item remains unchecked: there is no accept-replacement mapping workflow yet. A keep decision can hold new source activity pending review on subsequent scans; it does not fabricate legacy activity anchors. Canonical ranges, prepared-draft validation and Stripe operation checks remain later work. No fresh Claude review in this continuation.

Local evidence: `review-notes/fs01-keep-saved-resolution.md`, `fs01-resolution-services.json`, `fs01-resolution-ui.json`, `fs01-resolution-ui-final.json`. Previous queue evidence: `fs01-reconciliation-queue.md`. These local files are not assumed to be on the default branch.

### Initial local state - September 15, 2026

Implemented locally, awaiting rollout: retention after source removal/provider disable/exclusion; stable IDs for one-to-one rescans; durable time overrides; retained subagent totals; per-file error isolation; explicit local history-deletion records and audit preservation. Latest local verification: 186 distinct tests, both typechecks, targeted lint. Migrations 0023–0025 ran only on fixtures. Changes are uncommitted; no live migration or deployment. No fresh Claude review after the latest fixes/deletion slice.

### Acceptance

- [x] Store user edits and explicit splits as revisioned records attached to activity anchors/ranges; rescans preserve their intent.
- [ ] Map split/merged/recalculated intervals to predecessors and retain original invoice-referenced rows as non-counting audit records. Preserve invoice amounts and billed-work exclusions.
- [ ] Provide a visible reconciliation queue and resolution workflow for ambiguous mappings, partial legacy logs, missing baselines, and new intervals crossing deletion boundaries.
- [ ] Preserve saved legacy time/model totals without inventing source events. Removing clients/projects or local source mappings cannot cascade into erasing recorded work.
- [ ] Keep explicit deletion effective through reparse/restart, with safe deletion/reset semantics. Current guards (unmapped legacy deletion and reset with tombstones) are documented until a safe workflow replaces them.
- [ ] Add split/merge, legacy migration, edited-time, deletion-range, and invoice-audit fixtures; recheck existing retention/date-filter tests and both typechecks.

Entry points: `src/main/services/session-service.ts`, session derivation/deletion schemas, session handlers/detail UI. Local handoff: `review-notes/folder-sync-handoff.md`; latest evidence: `review-notes/folder-sync-step0-deletions.md`. These files are currently local/uncommitted, so this issue records the execution requirements independently.

Plan coverage: decisions A/D; verification 5, 9–12, 20 (local prerequisite).
