# Folder sync: QA and release handoff

Local implementation includes tracking history, automatic client/project matching with prompts for unmatched local folders on join, conflict review, recovery snapshots, machine provenance, and sequential invoicing across computers. This is not deployed. No production database, real sync folder, Stripe account or customer was changed.

## Local evidence

- Claude's medium-depth follow-up on the final checkout guard reported **no actionable findings**, `folder-sync-checkout-guard-claude-result.json`. No code changed after the 71-pass regression below. Local setup review is complete; external QA remains outstanding.

- Final September 28 Claude setup review: fixed silent replacement of an existing checkout when choosing a different folder after a manual project match. Folderless identity matching remains covered. **71 passed, zero failed, one existing skip** in `folder-sync-final-review-regression.json`; renderer typechecking and targeted lint passed. See `folder-sync-final-review.md`. Not installed.

- Latest September 28 follow-up: setup snapshots wait until client/project export is complete, then resume after source-record repair; assigning a checkout or confirming its absence preserves a manual folderless project match. **69 passed, zero failed, one existing Windows symlink privilege skip** in `folder-sync-rereview-fixes-regression.json`; both re-review reproductions pass. Targeted lint passed. See `folder-sync-rereview-fixes.md`. Changes remain local and are not installed.

- September 28 review fixes supersede the automatic-create behavior below: empty folders wait/recheck automatically and offer "Start new history here"; detected histories still join automatically. Initial joins require a fully restored snapshot and a fresh delivery check before applying identities. Manual match cancellation, switching, occupied folders and temporary delivery pauses are covered. **65 passed, zero failed, one existing Windows symlink privilege skip** in `folder-sync-setup-fixes-final.json`. Both typechecks, build and targeted lint passed. Claude's follow-up findings were addressed; detailed evidence is in `folder-sync-setup-fixes.md`. No installed app or live data changed.

- September 28 setup correction: removed Create/Join controls, history name/timezone setup fields and per-record confirmation. One folder picker now discovers existing history; multiple histories still require a selection. Matching uses unique client names and unique project names within the matched client. Unknown project folders are selected locally or marked absent; remaining ClauTime-discovered projects become new shared projects. No arbitrary disk scan was added. Folder choices are checked against the current review and applied atomically; invalid or occupied folders roll back. Final validation: **1,730 passed, zero failed, one skipped**, with zero failed suites in `folder-sync-simple-join-full.json`. The Windows symlink privilege skip is unchanged. Build (including both type checks) and lint on all changed source/test files passed. No application launch, production data changes, commit, push or deployment.

- Final full regression: **1,721 passed, zero failed, one skipped** in `fs08-full-verified.json` (271 reported suites). The skipped file-symlink scenario requires Windows Developer Mode or elevated symlink privileges. All 81 focused billing tests also passed in `fs08-billing-final.json`.
- Financial ordering, frozen activity anchors, pending operations and refresh: 90 passed in `fs08-invoice-ordering-reviewed.json`.
- Durable provider retries: 74 passed in `fs08-provider-retry-reviewed.json`. A rejection after an earlier lost response stays uncertain; each explicit write disables hidden SDK retries.
- Transport including incomplete snapshot delivery: 29 passed in `fs08-transport-reviewed.json`; final transport/performance run: 16 passed in `fs08-performance-final-tests.json`.
- Restored legacy splits and preserved audit: 99 passed in `fs07-legacy-resplit.json`; manual lifecycle/conflict/identity matching: 30 passed in `fs07-manual-lifecycle-reviewed.json`.
- Timezone runs: 313 passed under America/Los_Angeles; 154 passed under Asia/Tokyo (`fs07-canonical-pacific.json`, `fs07-canonical-tokyo.json`).
- Final type checks and Electron/Vite build passed (`fs08-build-final.log`). Lint passed with zero errors and 5,383 warnings, mostly existing formatting warnings (`fs08-lint-final.log`).
- Hidden Electron renderer smoke: connected/disconnected Settings rendered without console errors. Uses only the browser demo with HTTP blocked and a workspace-local QA profile. `fs08-renderer-smoke.json` and `fs08-settings-*.png`. The application main process and live database were never loaded.
- Large manual history: 5,000 saved entries exported in 31.2 s, restored on a blank database in 21.2 s, unchanged scan in 1.02 s; folder size 2,473,433 bytes. Machine-dependent timings, including original batches and a recovery snapshot. Repeated scans added no records or bytes. `fs07-history-performance-5000.json`.
- Claude reviewed design, implementation, identity joins, transport, manual lifecycle and financial safety. The final financial source audit reported no P1/P2 findings in its reviewed scope (`folder-sync-claude-final-billing-audit-result.json`). Root subsequently tightened the reviewed unknown-invoice case: every retry waits for missing billing lineage, tested in `fs08-delayed-invoice-guard.json`. Root also fixed partially restored billed splits: arrival of one fragment's mapping does not release overlapping unmapped fragments in other projects. Both fixes are covered by `fs08-billing-final.json`. The final targeted Claude review found a local-only compatibility issue; it was fixed by limiting the missing-lineage hold to configured workspaces (including paused sync). See `fs08-final-review-resolution.md`.

## Acceptance coverage map

Numbers refer to `folder-sync-plan.md`.

| Cases | Main regression evidence |
| --- | --- |
| 1-4: copies, offline work, ordering, crashes, provider identities | folder-sync-activity-records/store/runner/files; canonical-activity/codex/opencode; activity-evidence |
| 5-6: edits, billing, causality, clock skew and deletion conflicts | folder-sync-session-records/overlay/projection; folder-sync-manual-lifecycle; folder-sync-legacy-edits; folder-sync-revisions |
| 7-8: blank restore, paused transfers and unavailable folder | folder-sync-coordinator/snapshots/bootstrap; activity-evidence; session-service |
| 9-12: removed source logs, retention, exclusions and explicit deletion | folder-sync-bootstrap/legacy-records/history-records; session-retention/reconciliation/service/split |
| 13-14: reporting timezone, cloned databases and writer epochs | canonical-history-operations; workspace-policy; folder-sync-activity-records/bootstrap/store; explicit timezone runs above |
| 15: batch gaps, snapshots, unsupported formats | folder-sync-files/runner/snapshots/coordinator/protocol |
| 16: device-local folders and explicit project identity | local-project-integration; folder-sync-join-review/directory-local/builtin-client; client-project-service |
| 17-19: keyless history, account scope, retry, sequential billing | folder-sync-invoice-records; stripe-operation-service; provider-operation-store; invoice-preflight; invoice-stripe-import |
| 20: billed anchors survive append, split, reassignment and restore | invoice-portable-billing; session-split; session-billing; invoice-handlers |

These are automated local scenarios, not evidence of real Google Drive delivery or a real Stripe test-account run.

## Reproducing local checks

From `C:\apps\ClawdTime`, run `npm run build` (includes both TypeScript checks) and `npm run lint`. Native SQLite tests use the installed Electron runtime rather than rebuilding the dependency for another Node ABI:

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& .\node_modules\electron\dist\electron.exe .\node_modules\vitest\vitest.mjs run --pool=forks --maxWorkers=1 --testTimeout=15000 --reporter=json --outputFile=review-notes/qa-regression.json
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

Use a fresh report filename for each run and inspect the JSON `success`, `numFailedTests` and `numFailedTestSuites`; Electron can return exit code zero even when a test fails. Keep source files unchanged during a full run because transformed module caches can otherwise mix revisions. These checks use disposable fixtures. Do not run `npm run app`, `start` or `dev` against the everyday profile for QA.

## External QA still required

No disposable second computer/Drive/Stripe test setup has been identified in this session. Run this with two separate QA Windows users or clean VMs; do not launch this build against the everyday ClauTime profile. No live data or credentials are needed.

1. Install the reviewed build into both isolated QA environments. Create fake clients, projects and short synthetic provider logs/manual entries. Record time/token totals. Select a disposable Google Drive folder on A, then select the same folder on B. Verify that creation/join is detected automatically, unique client/project names match automatically, and only unmatched shared project folders need a choice. Map renamed local projects and verify that other discovered local projects are added automatically. Verify identical combined totals while local folder paths differ.
2. Disconnect one computer from Drive. Edit independent fields and conflicting fields, split/delete the same entry, then reconnect. Resolve the displayed conflicts. Confirm the agreed totals and invoice exclusions on both computers, and verify that local publication is never described as confirmed cloud delivery.
3. Wait for Drive to finish. Start a third blank QA profile with no keys; join using only the folder. Verify activity/model totals, edits, client/project identities, saved invoices and billed-work exclusions. Remove synthetic source logs and repeat restart/rescan/rebuild.
4. After explicit approval of the specific Stripe test actions, enter a test-mode key only in local credential storage. Use an owned QA email address. Create a draft for fake work on A, sync, switch to B, refresh and bill only new work. Test wrong-account keys, delayed folder delivery, repeated attempts, and a cancelled or uncertain operation. Sending a test invoice email is a separate explicit action; never use a real customer.
5. Verify the Drive folder contains only the allowed compressed records/manifests, not the database, keys, transcript text or local source paths. Retain the original batches; do not prune.

## Missing billing records

A connected workspace keeps billing blocked if an invoice's operation records are permanently missing. Recover them from the original database, a backup or retained batches. Stripe metadata alone cannot prove which activity was billed; waiting or voiding the invoice does not release that safety hold. Installations that never configured sync continue to support local-only invoicing.

## Production gate

The user's production rule requires a specific confirmation before deployment, a live migration, or real-history export. Prepare and verify a consistent recoverable backup before changing the live database. The proposed production change must identify the build, database, exact sync-folder destination and expected exported data; ask "This will change production" and wait for approval of that scope. No such rollout is authorized by this handoff.
