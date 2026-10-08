Parent: #37

Project: https://github.com/users/lookitstony/projects/6

Status at creation: **In Progress**. Dependencies: None; this is the first implementation gate.

Deleting source files or recalculating sessions must preserve imported work, edits, and invoice history. Complete Step 0 before introducing sync transport.

### Progress - September 16, 2026

FS01 / #38 remains **In Progress**. The persistent local reconciliation queue, saved-versus-detected comparison UI, retained-activity rechecks and affected invoice-preview blocking are now implemented locally. **121 distinct tests in this continuation**, both typechecks and targeted lint passed. Explicit ambiguous replacement mappings and full legacy adoption remain unfinished. Migration 0027 ran only on disposable fixtures. No sync transport, live migration, deployment or Stripe mutation occurred. Changes remain uncommitted.

This builds on the local retention, edit revisions, replayable explicit splits, split UI and billed-work audit links already implemented. Reviews retain saved history and hold alternatives outside totals, survive restart, and resolve only when the affected source reconciles successfully. A source-specific recheck uses retained facts and the current timeout; missing facts or a busy scan leave the review pending. Invoice line-item generation blocks the affected client/project/date scope, including deleted-history boundaries. Unrelated work remains eligible.

The combined queue/resolution acceptance item remains unchecked: no accept-replacement/dismiss operation exists. Full legacy adoption and policy-driven many-to-many mappings remain open. Billing checks are conservative within an affected source/date; canonical ranges, prepared draft revalidation and Stripe operation checks belong to FS06. No fresh Claude review in this continuation.

Local evidence: `review-notes/fs01-reconciliation-queue.md`, `fs01-reconciliation-services.json`, `fs01-reconciliation-ui.json`, `fs01-reconciliation-final.json`. Prior split evidence: `fs01-splits-and-revisions.md`. These local files are not assumed to exist on the default branch.

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
