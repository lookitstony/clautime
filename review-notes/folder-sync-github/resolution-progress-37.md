Project: https://github.com/users/lookitstony/projects/6

Implement optional folder sync for ClauTime: one person switching computers sequentially, local SQLite on each device, immutable portable changes in a folder managed by Drive/OneDrive or equivalent, and combined tracking plus invoice history.

## Latest progress - September 16, 2026

FS01 / #38 remains **In Progress**. Explicit Keep saved history resolution is now implemented locally, with confirmation, stale-preview rejection, idempotent retries and linked resolution audit records. Scans honor the choice only for the reviewed state; later activity, saved-record or policy changes reopen review. **131 distinct tests**, both typechecks and targeted lint pass. Migration 0028 ran only on disposable fixtures. Replacement mappings and full legacy adoption remain unfinished. No live migration, deployment, real-history export, Stripe mutation, commit or push occurred.

See #38 for scope, evidence and remaining work.

## Initial state - September 15, 2026

Step 0 is **In Progress**. Retention, conservative stable-ID reconciliation, time overrides, retained subagent totals, per-file errors, and local explicit deletion/audit preservation are implemented locally and awaiting rollout. Latest saved verification: **186 distinct tests passed**, both typechecks and targeted lint. Changes remain uncommitted; migrations 0023–0025 have run only against fixtures. Explicit splits, full reconciliation and all sync transport remain unfinished. No live migration, cloud export, deployment or Stripe change has occurred.

## Work breakdown

- [ ] #38 — FS01: Finish local retention, revisioned splits, and reconciliation — In Progress
- [ ] #39 — FS02: Establish canonical activity, shared policy, and project identity — Todo
- [ ] #40 — FS03: Implement durable immutable-batch folder transport — Todo
- [ ] #41 — FS04: Resolve concurrent edits, deletion conflicts, and shared-policy changes — Todo
- [ ] #42 — FS05: Bootstrap shared history and recover missing batches safely — Todo
- [ ] #43 — FS06: Sync invoices and preserve billed-work links across computers — Todo
- [ ] #44 — FS07: Add sync setup/status UI and verify the complete release — Todo

## Delivery rules

- FS01 first, then the FS02 identity/schema gate. Follow ticket dependencies thereafter; UI contract work can overlap, but final release depends on all acceptance gates.
- Local implementation is not a released feature. Link commits/PRs and validation evidence in each ticket; keep this parent open until integrated QA and explicitly approved rollout are recorded. No deadlines or effort estimates have been asserted.
- Preserve unrelated uncommitted diagnostics and date-filter fixes. Fixture/QA work is authorized; production changes require specific approval under the repository owner's instructions.
- No hosted service, multi-user authorization, distributed billing locks, full-transcript sync, or offline PDF archive is added to v1.

## Durable specification

The snapshot below comes from the agreed local `review-notes/folder-sync-plan.md`. Local supporting handoff/test reports are not assumed to be committed or accessible from the default branch. This snapshot and the child acceptance criteria make the plan usable directly from GitHub. The expanded plan and newest implementation have not received a fresh Claude review.

<details>
<summary>Agreed scope, decisions A–H, implementation order and all 20 verification scenarios</summary>

# Optional folder sync for ClauTime

## Intended behavior

ClauTime works locally with sync disabled by default. A user can enable sync, name their computer, and select a folder already synchronized by Google Drive, OneDrive, or another file-sync provider. Another installation joins the same history by selecting that folder. Each installation keeps its own SQLite database and works offline. No hosted ClauTime service or database account is required.

**Solo-first scope:** the user confirmed one person using multiple computers. Stable workspace/device/record IDs and a versioned sync format provide an upgrade path for future expansion. Device identity is provenance, not a future user authorization model. Multi-user accounts, permissions, and simultaneous billing coordination are deferred; they do not block or add infrastructure to this release.

The live SQLite database stays outside the selected folder. ClauTime exchanges immutable change batches, not competing copies of the database. Google Drive for desktop or the user's equivalent transfers those files.

**Imported history belongs to ClauTime. Deleting original logs, moving a project, clearing provider files to free space, or disabling tracking must never delete already-imported history.** This applies with sync enabled or disabled. A missing source file only makes transcript-dependent features unavailable. Unimported work cannot be recovered from a source file that was deleted before ingestion.

## First version scope

- Existing and new session history, normalized activity needed to retain/recalculate time, prompt counts, and per-model token counts.
- Clients, projects, assignments, descriptions, billable flags, manual time entries, and explicit deletions.
- Invoicing from either computer using the combined synced history: saved invoice headers/line items, amounts, currency, provider invoice/customer references, billed-activity links, and last-known statuses. API credentials are entered separately on each computer.
- Source Machine column and filter; friendly machine names backed by permanent device IDs. Copied activity can list multiple observing machines while counting once. Existing imported history is labeled as imported from its initial computer, rather than claiming its historical origin is known.
- Machine-specific project folder mappings. A remote path is informational and never becomes a local scanner target automatically.
- Settings for enable/disable, folder, machine name, Sync Now, and status/errors. Disconnect retains local history.
- API credentials, scanner offsets, local folder mappings, UI preferences, and running timer state remain device-local. The tracking policy and reporting timezone are shared as specified below. A completed manual timer becomes a syncable time entry.
- Full conversation files are outside this first version. Saved invoice data is included; a provider-hosted PDF URL is not a permanent offline PDF archive. Setup must describe this scope: history sync is not a complete computer backup. Existing invoice records and references must remain intact during migration/rescans.

## Decisions after Claude review

### A. Retention and explicit deletion

Ingestion adds or updates captured activity; filesystem cleanup never removes it. Replace provider-disable and excluded-path purges with controls over future local collection (and separate local visibility where needed). Preserve existing sessions, normalized activity, model usage, edits, and invoice references. Removing a source location also leaves the imported history intact.

Only an explicit **Delete from history** action in ClauTime creates a shared deletion record. That action states that it affects all connected computers. It suppresses the selected record/activity from active history and totals and survives later rescans; it does not erase invoice audit snapshots. Deleting a client/project does not cascade into deleting its recorded work. Concurrent edit-versus-delete remains a conflict, not an automatic undelete.

Missing files in the sync folder likewise are not deletion instructions. Missing batches produce an incomplete-sync state and recovery attempts, never deletion of local database records. Retaining local history protects against clearing source logs; a complete copy in the sync folder is still needed to recover from loss of the local database itself.

### B. Shared facts, deterministic session calculation

Use the normalized activity ledger as the shared source of truth. Automatic sessions are derived local views, not independently authored rows competing between computers. Retain the timestamped message/tool/progress facts, model identifiers, and token-usage observations required by the detector; full conversation text is not part of the shared ledger. Source Machine is provenance (the devices that observed an event), not ownership of its time.

The workspace has a versioned tracking policy: idle timeout, reporting timezone, parser/normalization version, and detector version. Initialize it from the first computer's current settings. Joining computers use that policy for the shared history, regardless of their OS timezone. Both computers given the same events and policy must calculate the same intervals and counts. Different branches remain distinguishable during detection and token calculation; do not interleave unrelated branches into a single chronological message stream.

In v1, policy changes require an explicit recalculation preview and compatible software. Recalculation preserves raw facts and invoice snapshots. It cannot silently adopt a receiving computer's defaults. Conflicting policy changes are held for resolution. UI day grouping and date filters for shared history use the workspace timezone too.

### C. Activity identity, tokens, and legacy records

Use provider + conversation/branch lineage + native event ID where the provider supplies a suitable ID. For records without one, capture a versioned fingerprint of the canonical original event (timestamp, type, relevant payload, and predecessor context) before the parser discards information. File paths, machine IDs, current token totals, and the synthetic Codex line number do not define cross-device identity. Exact copied prefixes converge to the same facts; different continuations remain distinct. Arrival order and "first publisher" do not decide identity or ownership.

Keep cumulative token checkpoints and their source-stream ordering separately identifiable; derive deltas along each branch before aggregating unique usage. A later usage observation updates the logical event's measured usage rather than being counted as a second prompt/message. Normalization upgrades must provide explicit identity compatibility/mapping, not mint a second history.

Existing records whose source logs are already gone must be migrated and exported without reparsing. Retain their saved sessions and token/model totals as versioned legacy records when there is insufficient activity to re-derive them. Do not invent content fingerprints from incomplete metadata. An incoming ambiguous legacy duplicate is preserved in a visible reconciliation queue outside active totals until resolved. A clean second installation restores the original exported identities without this ambiguity.

### D. Session continuity and user edits

First fix local rescan/rebuild behavior as a standalone change. Preserve local integer IDs for unambiguously matched sessions; update measured fields in place. Maintain a separate stable mapping from derived session anchors to local IDs. Appending an event or adding usage must not replace an existing row's identity.

Edits and explicit session splits are separate revisioned records referencing their activity anchors/ranges. Rescans do not overwrite them. If late events, policy changes, or a split/merge change the derived boundaries, keep predecessor mappings and preserve referenced historical rows as non-counting audit records. Carry edits to the new intervals only when their scope is unambiguous; otherwise flag them for review. Existing invoices continue to refer to their original local rows and saved amounts, not newly recalculated sessions. This mapping is tested before introducing transport.

### E. Projects and concurrent edits

Clients/projects receive permanent sync UUIDs. Move project locations into a per-device path mapping so the same project can be at different paths, and remote projects can exist without any local path. Users link a local repository to an existing shared project during setup. Names are suggestions, not automatic identity; ambiguous matches require selection.

Project settings expose **Change folder on this computer**. After moving or renaming a repository, the user selects its new location for the same project UUID; the project name can be edited independently. Changing the location preserves all history, assignments, rates, and invoice references and does not change another computer's mapping. Keep historical source paths as provenance without permanently claiming a vacated path if a different project later occupies it. If a mapped folder disappears, offer to locate it; do not delete its project/history or assume an unrelated newly discovered folder is its replacement. Support explicitly linking already-discovered unassigned activity at the new location to the existing project, with duplicate detection.

Each user change carries a unique change ID and the field revisions it was based on. A causally later edit replaces the version it explicitly supersedes; changes to different fields merge. Concurrent changes to the same field retain both alternatives and the last common value in the active view until resolved. A resolution names both revisions so it converges on every computer. No wall-clock or last-writer-wins shortcut discards concurrent work. Unresolved conflicts are visible and block invoice generation for the affected records rather than silently choosing billable values.

### F. Workspace and writer identity

Setup distinguishes Create shared history from Join existing history. Each workspace lives under its own random UUID directory with an immutable creation record. Concurrent offline creation yields two identifiable workspaces, not an accidental merge; joining selects one explicitly if multiple exist.

Device registration is stored outside the portable database. Each app launch also creates a fresh random writer epoch, with its own sequence and immutable batch IDs. Pending committed changes keep their original change IDs on retry. Consequently, even cloned installations cannot overwrite one another's new batch files, and replayed pre-clone changes remain duplicates. Restores/new-machine setup register a new device; duplicated historical machine labels can be corrected without changing activity identity. Do not rely solely on comparing sequence counters to detect a clone.

### G. Delivery, missing files, and recovery

Each batch identifies workspace, writer epoch, sequence, protocol, dependencies, and checksum. A local atomic rename is only publication on that computer; receivers still validate complete contents because the file-sync provider may deliver a partial file. Duplicate files with different names are recognized by batch ID. Malformed/unsupported data is not applied or treated as an instruction to delete anything.

Apply independent complete batches even when another writer has a gap; defer only operations whose actual dependencies are missing. Retry from the folder and surviving devices' retained outbox/batch copies. Keep the gap visible; elapsed time never makes it safe to skip. Produce versioned recovery snapshots containing the logical records, revisions, deletion records, legacy records, and an exact coverage frontier of included changes. A snapshot can satisfy a missing dependency only when it proves that dependency is covered. Never discard unpublished local work during recovery.

Do not prune batch history in v1. Snapshot frequency and storage growth are measured in QA before enabling real history. An incompatible protocol/normalization/policy version pauses sync with Update required while ordinary local capture continues. It does not skip unknown changes and claim the history is complete. A blank installation must restore using the folder's snapshot and remaining batches alone.

### H. Invoicing on either computer; credentials remain local

The user explicitly requires invoicing from either computer, including sessions recorded on every synced machine. Invoice generation defaults to all machines in the selected client/project/date/billable scope; a Source Machine filter on the Sessions screen must not silently limit an invoice. Preserve the existing overlap-merging/rate policy while deduplicating copied activity. Show each machine's latest imported coverage so an unavailable or behind machine is not presented as fully up to date. Known missing dependencies or unresolved billing conflicts block the affected invoice operation.

Synchronize saved invoice data, immutable line snapshots, canonical billed-activity/range references, and last-known provider status observations. Portable links use stable identities, not comma-separated local session row numbers; keep local compatibility mappings for existing invoices. A rescan, time-policy change, folder rename, session deletion, or machine loss must not recalculate an issued invoice or make its already-billed activity look unbilled. Local invoice hiding/removal is separate from voiding it in Stripe and does not erase the billed-work audit trail. Credit/void/rebilling decisions remain explicit.

On a new computer, selecting the sync folder restores tracking and invoice history, including last-known status, without any API key. The user can inspect data and prepare an invoice preview offline. Entering that computer's Stripe key enables authenticated reads and explicit create/send/void operations. Adding an AI key enables the corresponding generation features; it is not needed to read saved invoice descriptions. Never export API keys, encrypted credential blobs, authentication tokens, or a generic copy of all settings. Use an explicit portable-data allowlist.

Scope invoice/customer references by Stripe account and test/live environment. Validate the local key's account/environment before attaching it to synced records. A wrong-account key must not refresh or mutate those records. Keep existing history browseable even with missing, expired, or incorrect credentials. Stripe remains authoritative for payment/provider status; the folder carries a cached observation with provenance and refresh information. Conflicting/stale observations must not overwrite a known final state based on a computer's clock. Retrieve current state before a provider mutation; after a successful read/action, persist the result and its outgoing sync change transactionally. Handle partial payments/amount changes even when the status string has not changed.

Importing folder data never calls Stripe create/finalize/send/void, creates customers, or invokes billable AI work. A user operation is persisted as a durable intent before contacting Stripe, with a stable operation ID, frozen request parameters, and separate retry keys for its steps. Reconcile an uncertain result using the provider ID/operation metadata before retrying. A retry after a crash must not create another invoice, duplicate line items, or resend an email merely because the local result was not saved.

**Confirmed usage assumption:** one person invoices from one computer at a time and switches between computers. Concurrent independent invoice creation is outside v1; no distributed lock, billing-owner assignment, or handoff approval workflow is required. On either computer, import available folder changes, refresh Stripe, and check known billed activity before creating an invoice. Keep durable operation IDs and safe retries to handle crashes, double-clicks, delayed responses, and resuming an existing operation. Existing sync gaps/conflicts remain visible; this design does not claim cross-device mutual exclusion.

Technical references checked during planning: [Stripe invoice retrieval](https://docs.stripe.com/api/invoices/retrieve) and [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests). Idempotency keys may be removed after at least 24 hours, so durable operation records and result reconciliation remain necessary.

## Implementation order

### 0. Fix local retention and rescan reconciliation

Step 0 is partially implemented locally (see FS01 and the current-state note above). Finish decisions A and D, including revisioned splits and reconciliation, before transport. Preserve the existing fixture-tested retention and one-to-one rescan behavior.

### 1. Establish canonical activity, policy, and project identity

Implement decisions B, C, and E. Validate each provider's native IDs/fingerprint rules and token checkpoints using real-format fixtures, including copied/divergent conversations, before finalizing the sync schema. Preserve identities across upgrades. Prove identical results on two independent databases with different OS timezones. No decision to discard ambiguous history is left to the implementation.

Keep automatic measurements separate from user edits. If a rebuild splits/merges intervals and an edit cannot be mapped unambiguously, preserve it for review rather than silently dropping it. Imported activity must survive local rescans, missing source files, and local provider-disable/exclusion cleanup.

### 2. Build the folder transport

- Assign workspace, device, and per-launch writer identities according to decision F.
- Store a durable outgoing queue in the same SQLite transaction as each syncable change.
- Write compressed, versioned batches under separate writer directories with unique batch IDs. Publish completed files using a temporary file and final rename; include integrity checks and validate contents before importing.
- Import each batch and record its receipt in one transaction. Duplicates do nothing. Out-of-order batches and missing dependencies wait and retry. Importing a change does not publish it again.
- Treat filesystem notifications as hints; also reconcile the folder on startup and periodically. Missing/unavailable files never imply record deletion.
- Use explicit deletion records so deleted sessions do not return after a rescan or a late/offline computer reconnects.
- Keep original batches for the first release and implement the coverage-aware recovery snapshots in decision G. Do not prune history until snapshot recovery and offline-device handling are proven.

### 3. Define convergence and recovery

Use record revisions and parent revisions to distinguish new edits from conflicts; computer clocks do not decide which edit wins. Merge independent field edits. Keep conflicting same-field edits and edit-versus-delete conflicts for explicit resolution. Never silently overwrite a newer edit with an old arriving file.

Bootstrap through a consistent local snapshot exported as sync records, followed by queued changes made during export. Joining with an existing local history merges identities and asks for ambiguous project matches; it does not overwrite either database. Rebuild a blank installation from the shared folder without needing the original computer.

Workspace and protocol versions prevent incompatible apps or unrelated folders from silently mixing data. Only allowlisted data changes are imported; folder contents cannot invoke Stripe actions, run commands, or alter credentials.

### 4. Add the UI

Integrate the setup controls into Settings and add machine provenance to Sessions. Display pending changes, the last completed folder export/import, errors, and conflicts. Do not equate a file written locally with a confirmed cloud upload. Another device's imported-batch receipt can confirm delivery there; cloud-only durability is unknown without provider integration.

All-project Human Hours continue merging overlapping intervals across machines; token totals count unique activity. Project totals retain the existing project grouping rules. Store timestamps as UTC; day grouping and date presets for shared history use its reporting timezone. A copied event observed on two computers counts once even if both Source Machine filters match it.

### 5. Integrate shared invoicing

Implement decision H with saved invoice migration, portable billed-activity links, account/environment matching, status reconciliation, durable provider-operation intents, and explicit-action boundaries. Test entirely with mocked Stripe and then a separately approved test account/environment. Verify normal sequential invoicing while switching machines. Do not ship the first sync release as tracking-only: invoice history and sequential invoicing from either computer are now part of the required scope.

## Required verification

Use two independent test databases and separate folders with a simulated file-transfer layer. Prove:

1. Desktop activity appears on laptop and back, including original history and per-model token totals.
2. Both machines work offline and later converge without duplicate sessions or tokens.
3. Duplicate/reordered batches, partial files, transfer retries, process crashes, and restarts lose no committed changes.
4. Copied transcripts, resumed conversations, compaction, overlapping agents, and different project paths are handled correctly.
5. Rescans and changed idle thresholds preserve manual edits, billable flags, and invoice references; remote history survives local cleanup.
6. Conflicting edits/deletions, clock skew, a cloned database, and a long-offline machine do not silently destroy or resurrect records.
7. A new installation restores the agreed sync scope using only the folder.
8. With sync disabled or the folder unavailable, ordinary local tracking remains functional.
9. After a complete import, delete the original Claude/Codex/provider files, restart, rescan, rebuild, and sync. Both databases retain the same time/token totals and edits. Transcript-dependent features report unavailable source text without losing history.
10. Delete source logs before first enabling sync: migrate the existing database, export it, and recover its retained legacy history and model totals onto a blank installation.
11. Turn off a provider, remove a local folder mapping, or add an exclusion on B: neither A nor B loses already-imported history.
12. Explicitly delete history, then rescan a surviving source copy and reconnect an offline computer: the deletion stays effective; a concurrent edit becomes a visible conflict rather than an automatic undelete.
13. Different OS timezones with identical workspace policy produce identical sessions, daily totals, and token usage. Policy changes preserve edits and invoice references.
14. Start exact cloned databases offline: unique writer epochs prevent file collisions, pre-clone history deduplicates, and both new continuations survive.
15. Remove a batch: independent later work still imports, dependent work remains visibly incomplete, and a snapshot recovers it only with verified coverage. Test simultaneous workspace creation and newer unsupported protocol versions too.
16. Move or rename a repository, update its mapping, and scan both old and new logs: the project UUID, prior time/token totals, rates, assignments, and invoice references remain intact; new work joins the same project without duplicates. The other computer's mapping is unchanged. Reusing the vacated path for an unrelated project does not attach its work to the old project automatically.
17. Restore a blank machine without keys: it shows combined session/token history and saved invoices/statuses. Add the matching local Stripe key, refresh, and invoice previously unbilled work from both machines. A wrong-account/test-mode key cannot operate on the synced invoices. Inspect exported files to confirm credentials and encrypted credential blobs are absent.
18. Import an invoice/create/send/status change repeatedly: no provider write or AI request occurs. Simulate Stripe success followed by a crash before local persistence, restart/retry from either computer, and recover the original result without duplicate invoices, line items, or automated resending.
19. Create an invoice on A, sync, then switch to B: B shows the invoice and its billed-work links and can invoice new work without re-billing the old activity. Test delayed folder delivery, double-clicks/retries of the same operation, retry beyond the provider's idempotency retention window, stale status observations, and amount changes with unchanged status. Concurrent independent invoice creation is outside the confirmed v1 usage assumption.
20. Rescan, split/merge, rename folders, and delete source logs after invoicing: saved invoice amounts and billed-activity exclusions remain stable on both machines. Hiding an invoice locally or receiving old records cannot silently make billed work eligible again.

Then test a real transfer through Google Drive using disposable QA data. Assess storage growth and import performance before exporting the user's history.

## Live rollout

Prepare migrations, implementation, and verification locally/with QA data first. Take and validate a consistent recoverable backup before any live migration. Under the user's production-access rule, deploying the build, migrating the live database, or exporting real history into a cloud-synced folder requires an explanation of the exact changes followed by explicit approval. Planning and isolated implementation do not require that approval.


</details>
