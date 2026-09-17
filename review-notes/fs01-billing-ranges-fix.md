# FS01 billing range review fix — September 16, 2026

Fixed the two reproduced billing failures locally. Session IDs no longer exclude an entire growing session: invoice previews subtract immutable billed wall-clock ranges within the saved client/project bucket or split lineage. Existing overlap-merging and rounding remain in use for the remaining intervals.

Generated ranges travel through the editable preview and invoice IPC into the saved billing references. Activity arriving while a preview is open remains eligible. Splitting, hiding an invoice, and subsequent captures do not widen earlier references; test/live references remain separate.

Migration `0030_session_billing_ranges.sql` adds frozen ranges to local billing references. Older invoices have no exact interval snapshots, so migration conservatively adopts the currently saved session bounds once. It cannot recover which portion of pre-upgrade growth was previously billed. Saved invoice amounts and line items are unchanged. Cross-device canonical activity identities remain later sync work.

Verification: the two original reproductions failed before the fix. Seven targeted suites now pass **132 tests**, including growth during preview, repeated invoicing, overlap union with multiple remaining gaps, project/test-mode boundaries, splits, invoice hiding, legacy migration and database reopen. Both TypeScript typechecks, targeted ESLint, and `git diff --check` pass.

All databases were isolated fixtures, and external billing/AI services were mocked. No live database, Stripe operation, installed app, commit or push was changed. Existing uncommitted work remains intact.
