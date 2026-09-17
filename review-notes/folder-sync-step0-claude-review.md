## Verdict

**Do not consider the Step 0 slice done.** The retention/purge removal, backfill de-fabrication, migration wiring and settings copy are sound and correctly scoped. But the reconciliation core has three defects that lose or freeze data in ordinary, non-exotic flows (edit-then-append, deleted subagent log, one bad file), and all three are invisible in the current test set. These are regressions in the implemented slice, not the known-missing features (tombstones, revisioned splits, canonical identity, transport).

I found an untracked `src/main/services/session-step0-review-repros.test.ts` containing three repro tests that match findings 1–3; I read it as input but did not run anything, so I can't confirm its pass/fail state.

---

### 1. HIGH — A user's time edit is silently overwritten once the detector catches up
`src/main/services/session-service.ts:1307-1310`

The baseline is upserted to `measured` **unconditionally**, even when `updates` deliberately froze the session's times. The "edited" marker (`previous.endedAt !== baseline.endedAt`) is therefore destroyed on the very scan that honours it.

Repro: session detected `10:00–10:05` (baseline `10:05`). User edits `endedAt` to `10:20`. Log grows to `10:20` → row correctly stays `10:20`, but baseline is rewritten to `10:20`. Log grows to `10:25` → now `previous.endedAt === baseline.endedAt`, so the edit is replaced by `10:25`/`durationMinutes 25`. This violates decision D and plan item 5, and directly contradicts `session-service.test.ts:340-362`, which only ever rebuilds once.

Minimal fix: advance each baseline field only when that field was actually adopted into the row — e.g. build the derivation values from `updates` (`startedAt: updates.startedAt`, etc.) rather than from `measured`, so frozen fields keep their stale baseline and stay frozen.

### 2. HIGH — Deleting a subagent log shrinks a session's tokens and rewrites its model usage
`src/main/services/session-service.ts:380-385`, applied at `1274-1276` and `1311-1327`

The incremental `subFiles` list comes from the *current parse's* `fileOffsets`. `collectSubagentData` (`src/main/parsers/session-parser.ts:287-332`) only reports offsets for subagent files still on disk, so once a subagent file is removed, `reconstructParsedFromRaw` never loads its retained `raw_messages`, `subagentTokenUsage` becomes 0, and `buildDetectedSession` (`session-detector.ts:377-397`) returns smaller totals. Because the row has a baseline, the legacy guard at `1234-1254` is skipped, so `inputTokens`/`outputTokens` are overwritten downward and `sessionModelUsage` is deleted and reinserted without the subagent model.

Repro: main log + one subagent log (main 100/50, subagent 100/75) → session `inputTokens 200`. Delete the subagent file, append one line to the main log, scan → `inputTokens` drops to 100 and the subagent's model row disappears. This is exactly the "delete the provider files, rescan, totals unchanged" requirement (plan items 9, 11).

Minimal fix: in `reconstructParsedFromRaw`, when a filter is supplied, also select `raw_messages` rows with `isSubagent = 1` whose `sourceFile` starts with each main file's `join(dirname(file), sessionId, 'subagents')`, instead of relying on the parse's offsets.

### 3. HIGH — One unreconcilable file blocks every other file, silently
`src/main/services/session-service.ts:390-442` and `506`; throws at `1215-1219` / `1251-1253`

`reconcileDetectedSessions` throws out of the single batch transaction. That rolls back **all** files' session inserts/updates *and* every `scan_state` checkpoint, not just the offending file's. `byFile` iterates in detection order, so a mismatch on an alphabetically early file starves everything after it. Raw messages are already committed (`storeRawMessages(..., false)`), so nothing is lost, but no new session is ever created until the mismatch is resolved — and `file-watcher-service.ts:109-112` / `217-223` catch and log the error, so the background path shows the user nothing at all. `last_scan_at` also never advances, and every file is re-parsed from its stale offset on each subsequent scan.

Repro: one legacy row with `inputTokens 1000` over a truncated transcript, plus a second, healthy file with new activity. The healthy file's session is never created; every later scan fails the same way.

Minimal fix: wrap each `sourceFile` group in its own nested transaction (savepoint), collect per-file failures, advance `scan_state` only for files that reconciled, and return/surface the failed set rather than throwing from the whole batch.

### 4. MEDIUM — `splitSession` now permanently poisons scanning for its file
`src/main/services/session-service.ts:775-857` (reachable via `src/main/ipc/session-handlers.ts:190`)

Split deletes the original and inserts two rows with `source: 'auto'` and the same `sourceFile`. The next detection for that file yields one interval matching both rows → `rows.length > 1` → permanent ambiguity error. Under finding 3 this blocks the whole scan, forever, with no UI path to recover. Previously the destructive rebuild simply replaced the rows. The step-0 note says split "retains its previous semantics"; it does not.

Minimal fix: until revisioned splits exist, mark split products as non-auto (or record them in `session_derivations` as explicit split anchors) so reconciliation does not treat them as competing auto rows; at minimum, combine with finding 3 so one file cannot stall the rest.

### 5. MEDIUM — A legacy row whose transcript grew before first adoption is frozen forever
`src/main/services/session-service.ts:1261-1310`

On first adoption (`!baseline`) the row keeps its saved times but the baseline is written as `measured`. If the transcript grew at all between the last pre-upgrade scan and the first post-upgrade scan — i.e. the currently active session — `previous.endedAt !== baseline.endedAt` on every later scan, so duration is pinned to the pre-upgrade value while `promptCount`/tokens keep growing. The result is an internally inconsistent row, not merely a conservative one. The notes anticipate freezing, but not for unedited, actively-growing rows.

Minimal fix: on first adoption, treat a pure forward extension (`d.startedAt === previous.startedAt && d.endedAt >= previous.endedAt`) as adoptable — write the times and `baseline = measured`; otherwise freeze and leave the baseline at the saved values. *Uncertain:* this would overwrite a legacy edit that only shortened `endedAt`; the alternative is an explicit review flag, which needs the queue that is out of Step 0 scope.

### 6. LOW — Checkpoints advance past content that was never collected; declared cascade never fires
`src/main/services/session-service.ts:419-441`; `src/main/db/index.ts:69`

Files skipped by `isExcludedProjectPath` (`372`) or returning `null` from the parser still get `lastFileSize` set to the full stat size, so re-including the folder later never recovers the skipped span (only a shrink triggers a re-read). Separately, `foreign_keys` is never enabled, so the `ON DELETE CASCADE` in `0023_session_derivations.sql:2` does nothing and `deleteSession`/`splitSession` leak orphan derivation rows. Harmless today (`sessions.id` is `AUTOINCREMENT`, so no id reuse), but the migration's stated guarantee is not in force.

Minimal fix: skip the `scan_state` write for filtered/failed files; add `sqlite.pragma('foreign_keys = ON')` or delete `session_derivations` explicitly alongside the other FK cleanups.

---

**Not reviewed / out of scope as instructed:** the `sessionEndCondition` midnight work, `SessionsPage`, and the `main/index.ts`/`main.tsx` diagnostics. I traced the midnight-clip path through reconciliation anyway and found no matching defect there — the clipped second fragment correctly fails `overlaps` and inserts as a new row.
