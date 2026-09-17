# Folder sync GitHub tracking — 2026-09-15

- Project: [ClauTime - Folder Sync](https://github.com/users/lookitstony/projects/6)
- Parent issue and durable specification: [#37 — Folder Sync](https://github.com/lookitstony/clautime/issues/37)
- Repository: `lookitstony/clautime` (public); project visibility is private, matching the owner's existing projects. Repository issues retain repository visibility.

| Ticket | Scope | Status at creation | Dependencies |
| --- | --- | --- | --- |
| [FS01 / #38](https://github.com/lookitstony/clautime/issues/38) | Finish local retention, revisioned splits and reconciliation | In Progress | None |
| [FS02 / #39](https://github.com/lookitstony/clautime/issues/39) | Canonical activity, shared policy and project identity | Todo | #38 |
| [FS03 / #40](https://github.com/lookitstony/clautime/issues/40) | Durable immutable-batch folder transport | Todo | #38, #39 |
| [FS04 / #41](https://github.com/lookitstony/clautime/issues/41) | Concurrent edits, deletion conflicts and policy changes | Todo | #38–#40 |
| [FS05 / #42](https://github.com/lookitstony/clautime/issues/42) | Bootstrap and missing-batch recovery | Todo | #39–#41 |
| [FS06 / #43](https://github.com/lookitstony/clautime/issues/43) | Invoices and portable billed-work links | Todo | #38–#42 |
| [FS07 / #44](https://github.com/lookitstony/clautime/issues/44) | Setup/status UI, integration tests and approved rollout | Todo | #38–#43 |

All seven tickets are native sub-issues of #37, are labeled enhancement, and include scoped acceptance criteria. Dependencies are explicit issue links in ticket bodies. The parent contains the agreed design decisions and all 20 verification scenarios; it does not rely on local files being available on the default branch.

The current local implementation and 186-test verification are recorded as partial Step 0 work awaiting rollout. No ticket is marked Done. FS01 and the parent are In Progress; all other work is Todo. Source notes remain `folder-sync-plan.md`, `folder-sync-handoff.md`, and `folder-sync-step0-deletions.md`.

Project setup changed only tracking metadata and these local tracking notes. No source changes, commits, pushes, deployments, database migrations, cloud history exports, or Stripe operations were performed in this task. GitHub workflow inspection confirmed CI runs on master push/PR and release on version-tag push; issue creation does not trigger either workflow.

Prepared issue bodies, IDs, scripts and verification output are saved under `review-notes/folder-sync-github/`. Follow the current GitHub issue state for subsequent progress.
