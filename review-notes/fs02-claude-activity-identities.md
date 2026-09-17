# FS02: Claude identity capture and fixture gate

The user selected finishing FS01 acceptance checks and moving to canonical identities. FS01's local acceptance gate is satisfied through the implemented resolution workflows and documented guards; this does not authorize deployment or remove those guards. FS02 starts with Claude parser evidence before finalizing a shared ledger schema.

## Implemented

Review correction: fallback inputs also include a nonempty provider `message.id`, preventing distinct provider responses with otherwise identical fields from colliding. Content remains part of the fingerprint because one provider response may supply different blocks. Native keys and fallback keys without that field are unchanged. This corrects the unpublished v1 parser contract before persistence/ledger adoption; no saved identity migration is needed. Two new permanent regressions bring the latest targeted verification to **64 tests across three suites**, with both typechecks, lint and formatting passing.

`claude-activity-identity.ts` adds versioned event keys to parsed Claude messages, including subagents, before their original payloads are discarded. Native keys hash provider, identity version, recorded conversation ID and native UUID. Parent UUIDs become references in the same namespace. Unknown parents stay distinct from explicit roots. Usage/model corrections do not mint another event identity.

Without a native UUID, eligible records hash their original timestamp, type, role, subtype, content, recorded predecessor and recorded agent ID. Object key order is canonicalized; array order and payload values remain significant. Original timestamp spelling and precision are retained, so differently represented timestamps are not promised to converge without a native ID. Fallback timestamps must carry an explicit timezone. Source paths, cwd, machine metadata, local git branches, usage/model measurements and line numbers do not enter the key. Paths inside message/tool payload content remain meaningful payload, not a source-location identifier.

Fallback requires a recorded conversation, explicit predecessor/root, valid timestamp and original content. Subagent fallback also requires a recorded agent ID; its filename is not a substitute. Incomplete evidence returns no identity. The provider can still parse the record for existing local behavior.

Fixtures cover copied prefixes, divergent tails, corrections, nested payload key ordering, content/predecessor distinctions, native compaction boundary IDs, overlapping agents, renamed files, full/incremental parity, timestamp precision and incomplete evidence. Native and fallback golden values pin the v1 encoding.

## Boundaries / next identity work

This is parser evidence, not active deduplication. Existing raw-message persistence, local totals and FS01 comparison fingerprints keep their current behavior; the new field is not yet persisted or consumed by the detector. No existing row is assigned a fabricated fallback fingerprint. No sync schema or migration was added.

Remaining FS02 work includes Codex/Gemini/OpenCode adapters and fixtures, cumulative checkpoint identities/deltas, complete branch reconstruction (including compaction semantics), durable identity/observation storage, compatibility mappings, two-database/timezone convergence, legacy export identities and project/device mappings. Progress events still use the existing timestamp-only representation. These gaps must be addressed before transport relies on the identity contract.

## Verification

**682 tests across all 53 files passed**, including 19 new identity fixtures. Both typechecks, targeted ESLint and tracked diff whitespace checks passed. Tests use generated JSONL fixtures and disposable databases; no private transcript, live database, deployment, commit, push or external tracking state was changed.
