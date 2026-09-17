# FS01: approved detected split/merge replacements

Later continuation: conflicting saved values now support explicit predecessor selection per detected interval. See `fs01-replacement-value-choices.md` for the workflow and 250 passing tests; it supersedes the metadata-conflict limitation below. Edited times, explicit splits/deletions and unmatched legacy activity remain guarded.

Local continuation, September 16, 2026. History reviews now offer **Use detected intervals**, followed by a confirmation describing the new times and activity totals. The backend reconstructs retained activity and verifies the pending comparison fingerprint before applying it in one transaction. Refreshed comparisons disable the open confirmation; failures leave the review visible.

## Implemented

- Migration `0032_session_replacements.sql` adds immutable predecessor/successor links to reconciliation revisions. Replaced sessions, model usage, assignments, invoice references and other audit records remain stored. Central active-history filtering excludes predecessors from totals and new invoice candidates; reviews label them as audit history.
- Replacements use detector baselines to associate overlapping intervals within the same provider and conversation. One-to-many, many-to-one and overlapping combinations are supported when every saved/detected interval is covered and overlapping saved metadata agrees. Unambiguous one-to-one intervals retain their IDs and creation timestamps.
- Every saved row must have a baseline and unedited times. Explicit/inferred overrides, conflicting assignments/descriptions/billable choices, missing predecessor/successor matches, existing explicit splits/deletions and matching source-less deletions block replacement. Those comparisons remain pending. No historical edit is silently discarded.
- New intervals receive measured prompt/model/token/cache values and baselines, with agreed saved metadata. Revisions and linked `replace_saved` resolutions preserve the decision and supersede previous keep-saved choices. Subsequent scans update current rows normally. A later one-to-one mapping can ignore replaced audit predecessors.
- Frozen billed ranges are retained before replacement. Billing follows connected split/replacement history, including multiple predecessors, so reassignment and invoice hiding do not sever earlier billed-work exclusions. Saved invoice amounts and session references are unchanged.

## Verification

Two initial split/merge and rollback regressions failed before implementation. **238 tests across ten targeted suites pass**, along with both typechecks, targeted ESLint and diff whitespace checks.

Tests cover split then merge, repeated resolutions, preserved predecessor rows, growing successor IDs, unaffected IDs, prompt timelines, model/cache totals, active report totals, billing exclusions after reassignment, edited-time and metadata guards, stale/busy confirmations, explicit split/deletion boundaries, rollback at both audit-edge and resolution writes, and existing migration regressions. Real-file fixtures cover missing logs, database restart and later appends, with foreign-key checks. UI tests cover confirmation, cancellation, stale comparison rejection, error masking, query refresh and audit-only predecessors.

All migrations ran on disposable fixtures. No changed app was launched against the live database, and no production, Stripe or cloud-folder state changed. Nothing was committed or pushed.

FS01 remains In Progress. Conflicting edits, explicit split/deletion reconciliation, unmatched or unanchored legacy activity, and identity-free deletion still need resolution workflows. Canonical cross-device identities, shared policy and folder transport remain later steps.
