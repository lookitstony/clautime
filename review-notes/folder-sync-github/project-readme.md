# ClauTime folder sync

Optional shared history for one person switching computers sequentially. Each computer keeps SQLite local; immutable changes will carry tracking, edits, deletions, project identities and saved invoice/billed-work history. Credentials remain local.

[Parent issue and full agreed specification](https://github.com/lookitstony/clautime/issues/37)

## Current status - September 27, 2026

FS01's local prerequisite gate is complete with documented guarded limits. FS02 is the active identity/schema gate. Actual Drive/OneDrive transport, cross-device convergence/recovery, shared invoicing and complete sync UI/QA remain unfinished. Nothing is released.

- [x] [#38](https://github.com/lookitstony/clautime/issues/38) - FS01: local retention, revisions and reconciliation - **Done (local prerequisite gate; guarded limits documented)**
- [ ] [#39](https://github.com/lookitstony/clautime/issues/39) - FS02: canonical activity, shared policy and project identity - **In Progress**
- [ ] [#40](https://github.com/lookitstony/clautime/issues/40) - FS03: durable immutable-batch folder transport - Todo
- [ ] [#41](https://github.com/lookitstony/clautime/issues/41) - FS04: concurrent edits, deletion conflicts and policy convergence - Todo
- [ ] [#42](https://github.com/lookitstony/clautime/issues/42) - FS05: bootstrap and missing-batch recovery - Todo
- [ ] [#43](https://github.com/lookitstony/clautime/issues/43) - FS06: shared invoice history and billed-work links - Todo
- [ ] [#44](https://github.com/lookitstony/clautime/issues/44) - FS07: sync UI, complete QA and approved rollout - Todo (local folder controls already implemented under FS02)

## Verified local work

FS02 includes durable provider identity/observation capture, client/project UUIDs, per-device folder registration/setup and scanner/UI integration, remembered folder disconnections, machine observation/import attribution, manual-entry UUIDs/provenance/split lineage, a validated reporting-policy detector tested across three host timezones, and initial policy persistence/adoption with supplied-recording previews. Policy setup/full-history previews/apply/reporting integration, shared ledger/billing, provider and legacy/provenance work remains open; see [#39](https://github.com/lookitstony/clautime/issues/39) for exact scope.

Latest FS02 slice: read-only captured-ledger policy previews now calculate unambiguous linear Claude conversations, deduplicate copies and retain explicit unresolved results for corrections, incomplete/forked ancestry and unsupported providers. Three independent full-schema databases under different host timezones produce identical previews; query-only checks preserve edited automatic sessions and invoice/billed-work snapshots. Full-history reconciliation, broader provider/branch coverage and policy application remain unfinished. See #39 for exact scope.

Latest FS02 slice (September 27): read-only saved-history comparison now inventories all saved/audit/manual/legacy work and invoice/billed references alongside ledger calculations. Unambiguous one-to-one measurements show preserved time overrides; missing coverage, splits/merges and protected history remain under review. 28 new tests include byte-for-byte query-only preservation and fixes for ambiguous timestamps and review protection after source-path changes. Policy application and complete canonical provider/mapping coverage remain unfinished. See #39 for scope.

Latest FS02 slice (September 27): saved-history previews now bind retained facts, policies, saved revisions/audit history and invoice/billed references to a versioned fingerprint. Read-only rechecks reject stale results, including changed unresolved observations; exact source copies and new observers leave unchanged calculations valid. 32 new tests cover these boundaries, query-only preservation and caller-transaction rollback. Explicit canonical mapping and protected policy application remain unfinished; #39 records the limits.

Latest FS02 slice (September 27): canonical policy intervals now carry exact event/observation coverage and clipped message-pair continuity. Before/after relationships use shared event evidence, fixing a false midnight-boundary merge; unassigned facts remain visible. Eleven regressions cover these boundaries. Saved-row matches remain measurement-only, and persisted ownership/protected policy application remain unfinished; #39 records the limits.

Latest FS02 slice (September 27): explicit current-policy saved-session activity adoption now persists versioned event coverage and mapping UUIDs after an atomic freshness check. Mapping recognition is conservative; changed evidence/policy requires review, and retries preserve existing identities. Migration 0041 starts empty. Thirty-five regressions verify selection, stale-state rejection, history/invoice preservation and rollback. No app/scanner/UI integration or policy application is enabled; #39 records the remaining gate.

Latest FS02 slice (September 27): adopted-mapping transition previews now relate candidate intervals to retained predecessor mapping IDs/revisions using exact shared event/continuity evidence. They expose splits, merges and incomplete adoption while holding changed/conflicted evidence and protected history for review. A separate receipt binds the proposal; 33 regressions cover transitions, stale-state rejection and unchanged edited/invoiced history. Mapping revisions, accepted decisions and policy application remain unfinished; #39 records the limits.

Latest local verification: **1101 tests across all 71 files passed**, both TypeScript checks, local build, targeted ESLint, formatting and whitespace checks passed. Tests used disposable databases and source files; this is not cross-computer end-to-end sync QA.

The local checkpoint `6f0f656` contains the FS01 foundation and early FS02 identity capture. Later continuations remain uncommitted. Nothing has been pushed or deployed; migrations 0023-0041 have run only on disposable fixtures. No live database migration, real-history cloud export or external Stripe write has occurred.

Implementation/test status is separate from deployment. [#44](https://github.com/lookitstony/clautime/issues/44) owns integrated QA, real Drive transfer using disposable data, validated backup and specifically approved rollout. Keep parent [#37](https://github.com/lookitstony/clautime/issues/37) open through release verification. This tracking update changes no application or production data.
