# FS01: explicit replacement value choices

Local continuation, September 16, 2026. History reviews can now resolve detected merges whose saved assignments, descriptions, billable choices or status differ. **Use detected intervals** requires selecting a saved session for each conflicting interval. The selected session supplies its complete set of saved values; measured times, prompts and tokens still come from retained activity.

## Behavior

- Comparison snapshots list eligible, active predecessors and their saved values. Candidates must overlap the detected interval using detector baselines and share its provider/conversation. The backend recomputes this eligibility when confirming.
- Each conflicting interval requires an explicit choice. Missing, duplicate, malformed, unrelated and stale choices fail before any history changes. The existing fingerprint, busy-state, edited-time, legacy, split and deletion guards still apply.
- All predecessor rows and revisions remain in audit history. The replacement resolution records the selected session IDs alongside the comparison. Existing invoice lines and billed-range exclusions survive selecting a different client/project.
- Confirmation is disabled until all required choices are made. Refreshing the comparison disables both choices and confirmation; cancellation clears selections. Presentation mode hides descriptions and project/client details.
- Older stored comparisons remain readable. Recheck retained activity populates their choices; the backend still rejects an unresolved conflict without them.
- No database migration is needed: the additional preview and decision fields use existing JSON columns.

## Verification

The initial new regression failed before implementation. **250 tests across ten targeted suites pass**, along with both typechecks, targeted ESLint and the diff whitespace check. New coverage includes choice validation, invoice exclusions after reassignment, restart and later appends, non-billable/project selection through IPC, atomic rollback on resolution failure, stale/cancelled forms and presentation-mode masking.

All database work used disposable fixtures. No live app/database, Stripe or cloud-folder changes; no commit or push.

FS01 remains In Progress. Edited-time replacement, explicit split/deletion reconciliation, unmatched or unanchored legacy adoption and identity-free deletion still need resolution workflows. This choice carries one saved session's complete values into an interval; it does not combine individual fields from different sessions. Canonical identities and sync transport remain later steps.
