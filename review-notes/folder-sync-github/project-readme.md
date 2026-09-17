# ClauTime folder sync

Optional synced-folder history for one person switching computers sequentially. Each computer keeps SQLite local; immutable changes carry tracking, edits, deletions, project identities and saved invoice/billed-work history. API credentials stay local.

[Parent issue and full agreed specification](https://github.com/lookitstony/clautime/issues/37)

## Work order

- [FS01: Finish local retention, revisioned splits, and reconciliation](https://github.com/lookitstony/clautime/issues/38) — In Progress
- [FS02: Establish canonical activity, shared policy, and project identity](https://github.com/lookitstony/clautime/issues/39) — Todo
- [FS03: Implement durable immutable-batch folder transport](https://github.com/lookitstony/clautime/issues/40) — Todo
- [FS04: Resolve concurrent edits, deletion conflicts, and shared-policy changes](https://github.com/lookitstony/clautime/issues/41) — Todo
- [FS05: Bootstrap shared history and recover missing batches safely](https://github.com/lookitstony/clautime/issues/42) — Todo
- [FS06: Sync invoices and preserve billed-work links across computers](https://github.com/lookitstony/clautime/issues/43) — Todo
- [FS07: Add sync setup/status UI and verify the complete release](https://github.com/lookitstony/clautime/issues/44) — Todo

FS01 finishes Step 0. FS02 is the identity/schema gate, then FS03 transport. FS04 resolves revision conflicts; FS05 adds recovery; FS06 completes shared invoicing. FS07 owns setup/status UI and all 20 end-to-end acceptance scenarios. Dependencies are linked in each ticket; UI contract work may overlap implementation.

## Current state

FS01 is In Progress: retention, stable one-to-one rescans, time overrides, subagent totals, failure isolation and local history deletion are implemented locally, awaiting rollout. 186 distinct tests, both typechecks and targeted lint passed. Explicit splits and full reconciliation remain unfinished. The local changes are uncommitted; no live migration or sync transport exists. Other tickets are Todo. No task is marked Done.

Record implementation and test/QA evidence separately from deployment. Keep the parent open through integrated verification and explicitly approved rollout. Existing uncommitted work must be preserved. Production migrations, deployment, real-history cloud export and external Stripe mutations require the owner's specific confirmation. No code push or production change is part of this project setup.
