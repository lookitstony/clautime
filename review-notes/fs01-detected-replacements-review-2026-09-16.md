# Detected replacement code review

Status: **P2 fixed locally** after the review. Session commit reads now follow replacement and split predecessors, filter inherited commits by project and detector activity bounds with the existing five-minute buffer, and preserve original commit audit links. Both summary fallback and generation use that lookup. Mapping/replacement refresh cached commit lists and summaries. Permanent regressions cover split/merge lineage, restart, reassignment, later explicit splits, saved-time edits, deduplication and summary context. **240 tests across ten suites**, both typechecks, targeted lint and the diff whitespace check pass. No new migration, live change, commit or push.

Scope: latest split/merge replacement slice, migration 0032, active-history filtering, billing lineage, confirmation UI and downstream session consumers. All verification used disposable local fixtures. No production changes or implementation fixes were made during this review.

## Finding

**P2: Preserve applicable Git commit context for replacement successors.** `src/main/services/session-reconciliation.ts:470` creates new active session IDs for split/merge replacements and retains the predecessors. Existing `git_commits.session_id` values remain attached to the predecessors, while `gitService.getCommitsForSession` only queries the requested session ID. Correlation does not repair this because the original IDs still exist and it only assigns uncorrelated commits. Consequently, accepting detected intervals makes the new sessions' Git Commits panels and commit-based description fallback empty, even for commits clearly inside a successor's interval. Read applicable predecessor commit context through the replacement lineage (or an equivalent association) while preserving original audit links.

Reproduction: import 10:00–10:25 with a commit at 10:02 attached to that session, reduce the idle timeout to produce 10:00–10:05 and 10:20–10:25, then accept replacement and rerun commit correlation. `getCommitsForSession` for the first child returns `[]` instead of the existing commit.

The original failing fixture source is saved in `fs01-detected-replacements-review-repro-2026-09-16.txt`. It reproduced the issue before the fix; permanent passing regressions now live in `src/main/services/session-split.test.ts`. The temporary source test was removed after verification.

## Verification

- Existing ten targeted suites: **238 tests passed**.
- Both node and renderer typechecks passed before adding the temporary fixture.
- Focused Git-context regression: failed, expected the existing commit ID and received an empty array.
- Diff whitespace check passed.

No other actionable finding was confirmed in this review. Documented limitations around conflicting edits, explicit splits/deletions and unanchored legacy activity remain unchanged.
