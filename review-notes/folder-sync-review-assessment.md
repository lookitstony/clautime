# Assessment of Claude's folder-sync plan review

Claude completed the requested medium-depth, read-only review on September 15, 2026. The run succeeded without tool permission denials. Its full output is preserved in [folder-sync-claude-review.md](folder-sync-claude-review.md). The plan itself has not been revised by this review.

## Agreed findings

The verdict is **decisions needed before implementation**. The review identifies seven findings (four high, two medium, one low). The source confirms that rescans replace session rows, Codex message IDs use line indices, raw-message identity includes source paths, detection uses local midnight, and invoices reference local integer session IDs.

Before migrations, specify:

- Ownership and versioning of measured sessions, including timezone and idle-policy changes.
- Stable activity/session identity and edit-preserving reconciliation, including copied transcripts and divergent continuations.
- The separation between explicit user deletion and local cleanup/exclusion/provider settings.
- Stable project identity with per-device paths and explicit handling of ambiguous mappings.
- Exact recovery, protocol-version, and cloned-writer behavior.

## Recommendations that need correction or further design

These are my assessments, not additional findings attributed to Claude:

- **“First publisher” ownership is insufficient offline.** Both devices can believe they published copied events first. Define a deterministic reconciliation rule that deduplicates shared activity after reconnection while retaining distinct tails; receipt order cannot decide ownership.
- **Lamport last-writer-wins does not preserve concurrent edits.** Ordering two offline edits deterministically still discards one. Keep the plan's explicit conflict preservation unless the user knowingly chooses a different policy. Automatically making edit-versus-delete an undelete can resurrect intentionally deleted history.
- **Sequence comparison alone cannot detect all clones.** An exact clone started offline has the same local counter on both machines. Keep installation identity outside the portable database and handle restore/clone registration before publishing; also account for restoring that identity store itself.
- **Age alone cannot make a missing batch safe to skip.** A recovery snapshot must demonstrate which changes/revisions it covers. Retain a visible unresolved gap if no complete recovery source exists; do not claim convergence or recovery based only on elapsed days.
- **Project-name equality is not sufficient identity.** Two unrelated repositories may share a name. Ask for an ambiguous path-to-project association rather than automatically linking on a name match.

No sync implementation, live migration, or data export was performed. The next plan revision should resolve these choices before implementation, rather than copying all of the review's proposed shortcuts.

## Subsequent plan revision

The user then clarified that deleting source files to free space must retain imported database history. The plan has since been revised with decisions A–G covering retention, a canonical activity ledger and shared tracking policy, identity/legacy handling, session reconciliation, explicit conflict resolution, project mapping, writer epochs, and coverage-aware recovery. This supersedes the plan version reviewed above. The revised design still requires the stated provider-fixture and reconciliation tests; it has not yet received another Claude review.
