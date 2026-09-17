# FS01 acceptance checkpoint

Local implementation and fixture audit only. GitHub status remains In Progress; no live database, deployment, commit or push was changed.

## Fix found during acceptance checks

After adopting a source-less legacy session from log A, a pending matching log B retained only the original session in its comparison. Splitting or replacing that session and reassigning a descendant could bypass B's invoice block. Descendant edits were also absent from B's approval fingerprint, allowing an outdated keep-saved decision to survive.

Review comparisons, fingerprints and invoice checks now follow split/replacement descendants, including nested splits and deleted audit rows. The traversal is shared with existing assignment-intent inheritance. Two regression fixtures reproduced the billing bypass before the fix and now cover pending billing scopes, refreshed previews, stale confirmation rejection, approval reopening after restart, and deletion. Unrelated clients and dates remain available.

## Acceptance coverage and remaining limits

| FS01 requirement | Local evidence / limits |
| --- | --- |
| Revisioned edits and explicit splits | `session-split.test.ts` and `session-retention.test.ts` cover causal revisions, nested splits, time overrides, growth and restart. Incompatible changed boundaries preserve saved history for review. |
| Predecessors and invoice audit | Split/replacement links retain non-counting predecessors. Fixtures cover invoice snapshots, frozen billed ranges, growing sessions, reassignment and inherited commit context. |
| Visible reconciliation and resolution | Backend and `HistoryReviewPanel.test.tsx` cover queue persistence, explicit Keep saved history, one-to-one mapping, compatible detected replacements and conflicting metadata choices. Edited-time replacements and changed explicit split/deletion boundaries still cannot adopt detected alternatives; Keep saved history is their available resolution. |
| Legacy totals and removal retention | Legacy snapshots preserve saved model/time totals without inventing events. Real-file retention and client/project tests cover source removal, exclusions, disabled tracking, deletion and restart. Known source-less conversation matches support explicit adoption; identity-free history remains preserved without guessed matching. |
| Durable deletion and safe reset | Deletion/reparse/restart, legacy deletion, crossing-boundary review, invoice audit and reset refusal are covered. Identity-free automatic history deletion and destructive resets remain guarded. |
| Regression coverage | Full-suite verification includes parser/detector, retention, date filtering, billing, migration and renderer cases. See verification below. |

This checkpoint does not mark every desired resolution path implemented. Keep the guarded cases explicit rather than interpreting preserved history as permission to replace or delete it. Canonical cross-device identities, shared policy, project mappings and transport remain later work; no sync schema is finalized here.

## Verification

- Full suite: **655 tests across 52 files passed**, including both new regressions.
- `npm run build`: both typechecks and main/preload/renderer builds passed. Vite reported mixed static/dynamic import warnings for settings/session services.
- Targeted ESLint and tracked diff whitespace checks passed.
- All database verification used disposable fixtures under Electron's Node runtime. The built app was not launched.
