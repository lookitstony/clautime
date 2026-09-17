# Step 0 combined code review — 2026-09-15

**Subsequent status:** the three accepted findings below have been fixed locally and verified with regression tests. See [folder-sync-step0-review-fixes.md](folder-sync-step0-review-fixes.md). The review below records the implementation before those fixes.

**Verdict: request changes. Two high-priority correctness defects and one medium-priority failure-isolation issue are confirmed.** Review only; no application-source fixes were made.

Claude completed a medium-depth source review successfully after the first sandboxed attempt failed with ConnectionRefused. The retry had no permission denials. Its full response is in [folder-sync-step0-claude-review.md](folder-sync-step0-claude-review.md). Claude encountered the temporary reproduction tests while reading the repository, so its agreement is not a fully blind second opinion. Codex ran those tests against disposable fixture databases and real temporary logs.

## Accepted findings

1. **High: explicit time edits can be overwritten after measurements catch up.** At `src/main/services/session-service.ts:1269` and `:1307`, moving the baseline to every new measurement eventually makes an edited value look unedited. A 5-minute session edited to 20 minutes survives a measurement of 20, then becomes 25 on the next append. Reproduction: `expected 25 to be 20`. Persist explicit per-field edit intent/revisions rather than inferring ownership from equality with a changing measurement.

2. **High: deleting a subagent log reduces retained token/model totals on incremental scan.** At `src/main/services/session-service.ts:382`, only currently discovered subagent paths are included; retained raw rows for a deleted subagent file are omitted. The new reconciler then writes the smaller measurements at `:1275` and replaces model usage at `:1325`. A main/subagent pair totaling 200 input tokens drops to 100 after deleting only the subagent log and appending a prompt to the main log. Raw subagent activity still exists in SQLite. Include all retained child streams for each selected main source. The selection defect predates this patch, but leaves this slice's claimed source-deletion retention incomplete.

3. **Medium: an unresolved file blocks unrelated files in the same scan/rebuild.** The batch-wide transactions at `src/main/services/session-service.ts:390` and `:506` abort on the per-file throws at `:1216` / `:1251`. A mismatched legacy file A prevents healthy new file B from becoming a session. Isolate per-file failures and checkpoints, commit independent results, and surface the unresolved set. This extends the already documented scan-blocking limitation: no policy change is needed, and background watcher errors are logged rather than presented as an actionable reconciliation state. Claude rated this high; medium reflects that captured raw facts remain available and project-filtered scans can still isolate other projects.

All three correct-behavior assertions fail in the focused reproduction run. Evidence: [folder-sync-step0-review-repros.json](folder-sync-step0-review-repros.json); saved test source: [folder-sync-step0-review-repros.ts](folder-sync-step0-review-repros.ts). These are new coverage beyond the previously passing implementation tests. The temporary runnable copy under `src/main/services` was removed after saving identical evidence.

## Other Claude findings and suggested fixes

- **Explicit splits:** a real additional trigger for finding 3, but revisioned split preservation and rejection of ambiguous reconciliation were explicitly unfinished. Track it under that existing work and failure isolation rather than reporting it as a separate newly discovered defect. Merely marking split products manual would allow the original automatic interval to be reinserted and double-counted; do not adopt that shortcut.
- **Legacy active-session freezing:** acknowledged implementation limitation, including unedited rows without a trustworthy baseline. Claude's proposed automatic forward-extension adoption can overwrite a historical time edit. Keep the requirement for trustworthy adoption or explicit resolution.
- **Filtered/failed-file checkpoints:** the unconditional loop over `filesToProcess` is already in HEAD. This remains a pre-existing ingestion/retry concern, not a new regression introduced here. It is not included in the three confirmed findings for this slice.
- **Foreign-key cascade warning is incorrect in this environment.** A new in-memory connection through the installed Electron/better-sqlite3 binary reported `foreign_keys = 1`; deleting the parent removed the child with `ON DELETE CASCADE` (`childRowsAfterDelete = 0`). No extra pragma was applied in that check.
- **Claude's suggested baseline fix is insufficient as written.** Writing `updates` into the baseline also makes the saved edit equal to that baseline; it does not preserve edit ownership. Use durable edit intent, consistent with decision D.

Known unfinished transport/tombstone/canonical-identity work was not counted as a new review finding. The original tracked source diff was compared against the snapshot taken at review start and was unchanged. No live database, installed app, cloud folder, or Stripe data was read or changed.
