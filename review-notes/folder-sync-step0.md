# Step 0 initial implementation — 2026-09-15

This is the first local implementation slice, not completion of Step 0 and not ready for live rollout. The agreed plan remains authoritative.

September 16: `fs01-splits-and-revisions.md` supersedes the old split-method limitations below. Local field revisions and explicit split mappings/audit preservation are implemented, with 202 passing tests. Policy-driven/ambiguous reconciliation and full legacy adoption remain unfinished.

Latest continuation: local history-deletion tombstones and audit preservation are implemented. See `folder-sync-step0-deletions.md` for behavior, 186 passing tests, and limitations. Explicit splits and full reconciliation remain unfinished.

Subsequent review fixes are documented in `folder-sync-step0-review-fixes.md`: durable time overrides, retained subagent streams, and per-file failure isolation. The current verification total is 183 distinct passing tests, both typechecks, and targeted lint. The verification below records the initial slice.

## Implemented

- Scans no longer purge sessions when providers are disabled or paths excluded. These settings gate future collection. Existing project visibility settings remain separate.
- Rebuilds derive from retained activity regardless of current collection settings. Sessions with no reconstructable activity remain intact, including legacy model totals, manual entries, edits, and invoice references.
- Backfill no longer fabricates messages and token allocations for missing legacy transcripts.
- Incremental scans and rebuilds share conservative one-to-one reconciliation. Matching sessions retain integer IDs, creation timestamps, assignments, descriptions, billable flags, summaries, and git/invoice links. Measured prompts, tokens, and model usage update in place.
- Local migration `0023_session_derivations.sql` stores detector time baselines separately from user-edited session times. New rows can grow without losing edits. The migration adds a table only; it does not rewrite existing history.
- Existing rows without baselines retain saved time fields on first adoption. A smaller legacy reconstruction, missing saved model usage, changed anchor, or ambiguous split/merge raises a reconciliation error instead of deleting or replacing history. This is conservative: legacy times that cannot be proven unedited may stay frozen.
- Ambiguous reconciliation rolls back the affected file's session transaction and main/subagent scan offsets; independent files still commit. Captured raw activity remains available for retry. Results report unresolved sources and the renderer warns on manual/background partial scans. No dedicated reconciliation queue is implemented yet.
- Settings copy now states that disabling collection preserves imported history.

## Verification

- Regression tests first reproduced six failures in the original destructive implementation.
- Seven relevant suites passed 171 tests, including detector, parser, client/project, session service, real-file retention, SessionsPage, and session hooks. Results: `folder-sync-step0-tests.json`.
- A final additional incomplete-legacy regression was added; the final two service suites pass 37 tests. Results: `folder-sync-step0-final-tests.json`. Together these cover 172 distinct passing tests.
- Real filesystem fixtures exercise growing JSONL logs, corrected usage for an existing UUID, exclusion of new activity, actual source-file deletion, closing/reopening an isolated SQLite database, disabling a provider, and rebuilding. Time, prompts, per-model/cache tokens, edits, and row IDs survive.
- Service tests preserve saved invoice line amounts/IDs, summaries, git links, legacy totals and edited time fields; ambiguous policy splits/merges fail without replacing saved sessions.
- Both TypeScript typechecks and targeted ESLint passed. Database tests ran through Electron as Node with `--pool=threads`; broader run used `--maxWorkers=2`. The shared better-sqlite3 binary was not rebuilt.

## Still required before completing Step 0

1. Revisioned edits and explicit split records referencing activity anchors/ranges; predecessor mappings and non-counting audit rows for changed boundaries, plus a visible resolution workflow. Current code rejects ambiguous changes for the affected file rather than completing their recalculation. Other files continue scanning.
2. Local history-deletion tombstones and rescan suppression are now implemented; see `folder-sync-step0-deletions.md`. Canonical cross-device identities and resolving boundaries that cross deletion ranges remain required. Explicit splits still do not preserve invoice audit rows. Reset is blocked when tombstones exist; otherwise it retains its previous semantics.
3. Full legacy adoption/reconciliation, including historical edits without reliable baselines and partial source logs. The new table is a local detector baseline, not the canonical cross-device activity identity required by Step 1.
4. Broader migration/legacy fixtures and split/merge/invoice audit acceptance tests once those workflows exist. The three findings from the subsequent Codex + Claude review were fixed locally; see `folder-sync-step0-review-fixes.md` for evidence and remaining limits.

No live database, installed app, cloud folder, or Stripe data was changed. Nothing was committed or pushed. Existing uncommitted date-filter fixes and diagnostics were preserved.
