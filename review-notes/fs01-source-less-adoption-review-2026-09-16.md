# Source-less adoption: code review

Status: **Both P2 findings fixed locally.** Candidate checks now consult preserved source-less legacy snapshots after adoption, so other matching logs stay under review even if discovered later or the adopted row is deleted. Comparisons/fingerprints retain the adopted row, and mapping/replacement cannot move it to another source implicitly. Keep-saved approval remains available for that exact comparison. Invoice blocking reloads saved comparison IDs as well as source-linked rows, preserving both current and original assignment/date coverage. Four permanent regressions failed before the fixes and now pass; they include restart, appends, deletion, late copies, reassignment and unrelated billing scopes. **266 tests across ten suites**, both typechecks, targeted lint and whitespace checks pass. No new migration, live change, commit or push.

Scope: latest source-less candidate detection, explicit mapping, fingerprints, UI confirmation and downstream reconciliation/invoice behavior. All verification used disposable local fixtures. No implementation fixes or production changes were made.

## Findings

1. **P2: Adopting one source silently releases other pending sources for the same legacy row.** `src/main/services/session-legacy.ts:23` restricts candidates to rows with no source path/baseline. Mapping source A assigns both to the saved row (`session-reconciliation.ts:342`). If A and B were both held for the same conversation, the next rebuild no longer sees a candidate for B and imports its activity as a new session, resolving B's pending review without approval. An identical-copy fixture goes from one active session to two. Preserve the known association/ambiguity for other pending sources after adoption; confirming A must not authorize B.

2. **P2: Reassignment bypasses invoice blocking for a pending source-less candidate.** `src/main/services/invoice-service.ts:119` reloads current saved rows only by the review's source path. The new source-less candidate has no such path, so after moving it from client A to B the check sees only client A in the stored preview. Generating for B succeeds while the review remains pending. A fixture generated a 1,000-cent line instead of rejecting. Reload the candidate IDs from the saved comparison as well as source-linked rows, retaining the original snapshot for conservative blocking.

The original failing fixtures are archived in `fs01-source-less-adoption-review-repro-2026-09-16.txt`. Permanent passing regressions now live in `src/main/services/session-split.test.ts`. The temporary source test was removed after verification.

## Verification

- Existing ten targeted suites: **262 tests passed**.
- Both node and renderer typechecks passed.
- The two focused regression fixtures failed as described above.
- Diff whitespace check passed.

No other actionable finding was confirmed in this slice. Existing guards for identity-free legacy records and explicit split/deletion reconciliation remain documented limitations.
