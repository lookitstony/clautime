# Step 0 review fixes — 2026-09-15

All three accepted findings in `folder-sync-step0-review-assessment.md` are fixed locally. Application installation, live databases and cloud folders were not touched. Existing uncommitted work remains intact.

## Changes

1. **Durable time overrides.** Migration `0024_session_time_overrides.sql` adds local per-field override flags. Session edits and flags commit together; later detector measurements cannot erase the flags by catching up to the edited value. Existing baseline differences are migrated conservatively. Submitting unchanged time fields alongside a description does not freeze automatic time. Legacy adoption still preserves uncertain saved times; this is not the future revisioned/shared edit system.
2. **Retained subagent activity.** Incremental reconstruction includes captured child streams using the parent conversation's retained identity and directory boundary. It no longer relies solely on currently present child files or parser offsets. Model and cache-token totals remain available after child-log deletion.
3. **Per-file reconciliation.** Healthy sources commit sessions and main/subagent checkpoints independently. An unresolved source rolls back only its own transaction and remains retryable. Scan results list unresolved files and count only committed results. Both manual scans and background watcher events display an ongoing warning while refreshing committed work. Settings rescans keep the pending state on partial results and check the IPC success envelope before claiming completion. The full reconciliation queue and resolution workflow remain future Step 0 work.

## Verification

**183 distinct tests passed**, plus both TypeScript typechecks, targeted ESLint, and `git diff --check`.

- Session service: 35 (`folder-sync-fixes-service-forks.json`).
- Real-file retention/reconciliation: 8 (`folder-sync-fixes-retention-final.json`).
- Client/project service: 42 (`folder-sync-fixes-db-2.json`).
- Session parser: 26 (`folder-sync-fixes-db-3.json`).
- Detector, watcher, session UI/hooks, and partial-scan warnings: 72 (`folder-sync-fixes-ui-tests.json`).

The review's three reproductions now live in the permanent retention test suite. Added checks cover a database restart after measurements catch up, upgrading an existing detector baseline, unchanged time fields, deleted child logs with a distinct model, per-file offsets and repeated failures across restart, combined scan/rebuild behavior, background error delivery, and keeping partial scans pending.

Some combined Electron/Vitest thread runs terminated with native exit `0xC0000409`, including one teardown after all 35 service assertions passed. The affected service suite and final retention suite completed cleanly through Electron as Node with `--pool=forks --maxWorkers=1`. Other database suites passed individually with threads; renderer/pure suites ran through the installed Node runtime. The shared native dependency was not rebuilt.

No fresh Claude review was requested or performed after these fixes. The earlier review artifacts retain the original findings and evidence. Step 0's full split/merge audit mapping, revisioned edits, deletion tombstones, and broader legacy resolution are still unfinished; no sync transport was added.
