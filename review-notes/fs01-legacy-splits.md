# FS01: splitting retained legacy sessions

Local continuation, September 16, 2026. Legacy automatic sessions can now be split using their saved values, including sessions whose original file path is unavailable. The original remains non-counting audit history; nested children retain assignments, provider, descriptions, billable flags, saved duration, prompts, and all token categories. Allocation remains proportional and conserves totals.

Parent and child legacy snapshots receive stable identities inside the split transaction. Existing snapshots are reused without rewriting their original values. Split revisions link to the parent's legacy snapshot through migration `0031_session_legacy_splits.sql`; no activity facts or detector baselines are fabricated. Manual and already mapped automatic splits keep their existing behavior.

When activity returns at a known source path with a legacy split, the whole source is held for review. Matching saved timestamps are not proof of an activity mapping. Independent sources still reconcile. The existing keep-saved decision works, and later activity/edits reopen review. Child deletion remains supported when a source identity is known. Source-less deletion and explicit replacement mappings remain unfinished, as do later canonical-identity and transport steps; FS01 stays In Progress.

Verification: five new cases failed against the previous split guard. Eight targeted suites now pass **155 tests**; both typechecks, targeted ESLint and `git diff --check` pass. Tests cover nested splits, complete token/time conservation, stable snapshot reuse after edits, original invoice preservation and billed exclusions, rollback of snapshots/children/usage/revisions, migration replay, missing source identity, real returning logs, source deletion, database restart, child edits/deletions, keep-saved reopening and healthy-source isolation. The previous billing-range regressions also remain passing.

All migrations and file operations used disposable fixtures. No live database, installed app, Stripe operation, commit or push changed.
