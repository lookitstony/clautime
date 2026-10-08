# FS01: Persistent local reconciliation reviews

Continuation of FS01 / #38, September 16, 2026. Implemented locally; no deployment or live database access. Preserve all existing uncommitted retention, split, billing, date-filter and diagnostic changes.

## Implemented

- Additive migration `0027_session_reconciliation.sql` stores the last failed comparison per source: saved intervals (including explicitly labeled deleted/split audit rows), detector intervals, prompt/token/model/cache counts, timeout, reason and timestamps. Alternatives are snapshots outside active session totals.
- Normal scans and rebuilds persist expected reconciliation failures after the affected source transaction rolls back. Healthy sources and checkpoints still commit. Repeated failures update one pending case; a successful source transaction records resolution atomically. Resolved rows remain stored and later failures reopen them.
- A source producing no detector intervals still gets checked against retained sessions; an empty detector result cannot silently resolve a mismatch.
- The Sessions page loads the persisted queue independently of current filters and scan notifications. Expand a source to compare saved and detected values. Paths and path-bearing errors are masked in presentation mode.
- Recheck uses only the selected source's retained facts and current idle timeout. Restoring a compatible timeout can resolve a case without changing session IDs or user edits. Busy scans and missing retained facts produce visible errors and leave the review intact. This IPC action does not discover files, invoke Git scans, contact Stripe or invoke AI.
- Invoice **line-item generation/preview** rejects unresolved sources in the selected client/project/date scope before generating descriptions. It considers current rows, retained audit rows and last comparison assignments, including crossing-deletion cases with no active rows. Other clients/projects/dates remain eligible. A successful reconciliation removes this block.
- Reset refuses before writes when any reconciliation record is retained, including resolved audit records.

## Verification

Disposable SQLite fixtures only, including actual file parsing and a closed/reopened file database. Stripe and AI mocked; no changed app launched.

- Red regression: `fs01-reconciliation-red.json` (two failures for the missing persistent queue API).
- `fs01-reconciliation-services.json`: 66 passing tests across retention, session service, deletion and split/billing suites.
- `fs01-reconciliation-final.json`: 16 passing split/billing tests, including two additional final regressions; supersedes the 14 split tests in the preceding report.
- `fs01-reconciliation-ui.json`: 53 passing tests across the review panel, Sessions page, detail/split panel, session hooks and scan-error handling.
- **121 distinct passing tests this continuation** (68 service + 53 renderer), both typechecks, targeted ESLint and diff checks. Earlier unaffected suites are documented in `fs01-splits-and-revisions.md`; they are not counted as fresh runs here.

Covered restart persistence, repeated failure deduplication, healthy-file checkpoints, provider-disabled scans retaining reviews, policy recovery and reopening, source-specific rechecks, busy/missing-fact rejection, empty detector output, audit/reset preservation, deleted-boundary invoice blocking, unrelated client/project/date eligibility, restored invoice eligibility, comparison rendering, UI retry/failure/success and presentation masking. Migrations 0023 through 0027 ran only against fixtures. Prior migration tests were adjusted to replay the new migration in the disposable upgrade fixtures.

## Remaining FS01 work

This is a persistent review queue and safe recheck workflow, **not full ambiguous-history resolution**. There is no dismiss/accept-replacement operation. Explicit many-to-many mapping decisions, preservation/adoption of legacy records with insufficient facts, and revisioned decisions for policy/deletion conflicts remain required. A legacy source with no reconstructable facts is retained but is not automatically enrolled in this comparison queue; that is part of legacy adoption. Do not mark the combined queue/resolution acceptance checkbox complete.

The queue retains the latest failed comparison and its resolution timestamp, not an append-only series of user resolution decisions. Snapshots show values at last comparison; existing session edits remain available through ordinary session editing. Detected previews are before explicit splits/deletions and may differ from active totals. Billing scope is deliberately conservative within an affected source/date; exact canonical ranges and checks around Stripe creation/retries belong to FS06. This slice does not claim to block manually entered Stripe invoices or revalidate already prepared drafts. Shared policy previews, canonical identities, transport and cross-device invoice sync remain later tickets.

FS01 remains In Progress. No fresh Claude review, commit, push, live migration, cloud export, deployment or Stripe mutation in this continuation.
