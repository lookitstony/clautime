# FS02: Codex identity and cumulative checkpoint capture

Codex parsing now captures versioned identity evidence before discarding original response payloads. This continues the provider-fixture gate; no shared ledger schema, migration or transport was introduced.

## Identity contract

- The recorded `session_meta.payload.id` supplies the thread namespace. A missing thread ID is not replaced by a filename or a shared root session ID. Upstream defines the root/agent session relationship in [thread-store types](https://github.com/openai/codex/blob/main/codex-rs/thread-store/src/types.rs); the [rollout fixtures](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/common/rollout.rs) show the envelope format.
- Native response item IDs use provider, identity version, thread, item kind and item ID. Fallback response/compaction keys include original timestamp, original payload and preceding activity identity. Known mutable usage/model and source-location metadata are excluded. Payload contents, including tool arguments and call IDs, remain significant.
- Reasoning and compaction records participate in predecessor chains even when the existing local parser only treats them as progress or ignores them. Replayed native IDs retain their first captured ancestry without rewinding the activity chain. Native/fallback/checkpoint golden values pin this initial v1 encoding.
- Forked, referenced or paginated history and multiple session headers remain unclassified until inherited ancestry can be resolved. Missing headers/thread IDs, malformed lines, invalid timestamps and invalid counters also make the stream's evidence unavailable. This prevents partial chains from being presented as complete.

The [upstream response item definition](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs) permits optional native IDs; synthetic `l<number>` IDs used by current local storage never enter the new keys.

## Checkpoints

`codexActivityEvidence.checkpoints` preserves original cumulative counter observations, model context, checkpoint identity, preceding checkpoint identity and the current activity frontier. The checkpoint key uses thread, activity frontier and original timestamp, excluding mutable counters and model. Corrected measurements therefore retain identity while different activity branches stay separate. Repeated observations remain available; the parser does not choose a winning correction or create self-referential predecessor links.

Counter drops are retained verbatim in this evidence. They do not by themselves prove whether the provider reset a counter or corrected usage. Branch-aware delta calculation, conflict selection, complete fork/compaction reconstruction and durable observation storage remain unfinished. The existing local token calculation keeps its prior behavior.

## Verification and limits

Twenty new fixtures cover copied prefixes, line-number shifts, moved paths, different thread namespaces, divergent tails followed by matching payloads, corrected/repeated checkpoints, tool call/output distinctions, reasoning/compaction ancestry, native replays and incomplete/inherited-history guards. Existing Codex parser tests pass alongside these fixtures.

**704 tests across all 54 files passed**, including the twenty new identity/checkpoint cases. Both typechecks, targeted ESLint, formatting and tracked diff whitespace checks passed. New evidence is not persisted or used for live deduplication, session totals, billing or FS01 review fingerprints. Tests use synthetic provider-format logs and disposable databases. No live app launch, deployment, commit, push or external tracker update occurred.
