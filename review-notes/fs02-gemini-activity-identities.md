# FS02: Gemini JSON snapshot identity capture

Gemini's existing JSON parser now captures versioned activity identity evidence before discarding original payloads. This is the next provider-fixture slice after Claude and Codex; no shared ledger schema, migration or transport is introduced.

## Identity contract

- The recorded `sessionId` supplies the conversation namespace. Missing or blank IDs leave evidence unavailable, even though the existing local parser can still use a filename for its own session ID.
- Native message IDs use provider, version, recorded conversation and original message ID. Updated text, embedded tool results, model or token measurements retain that identity.
- Without a native ID, the fingerprint includes the preceding activity identity and canonical original record, including timestamp precision, content, thoughts and tool calls/results. Root-level `id`, `tokens`, `model`, `cwd` and `machine_id` are excluded; paths inside tool arguments remain meaningful. JSON object key order is normalized and array order is preserved.
- Original message-array order determines observed predecessor links before the local parser sorts normalized messages by timestamp. Info/error and other timestamped progress records participate. A null predecessor means the first activity in this snapshot, not proof that no earlier history exists elsewhere.
- Repeated native IDs retain their original observed ancestry without rewinding the chain. Evidence retains each observation in array order. Missing timestamps/types, malformed records or missing fallback content invalidate the entire snapshot's identity evidence, including earlier messages.

The fixture format follows Gemini CLI's [v0.34.0 recorder](https://github.com/google-gemini/gemini-cli/blob/v0.34.0/packages/core/src/services/chatRecordingService.ts). Its native IDs are generated when messages are created, while token blocks and embedded tools may be added afterward. The newer [recorder](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingService.ts) also supports JSONL updates and rewinds; that format is not yet supported by this app's Gemini discovery/parser and is not claimed by this slice.

## Verification and limits

Twenty-two new fixtures cover golden native/fallback encodings, copied prefixes, divergent continuations, moved files, changed metadata, reused IDs in separate conversations, matching content with distinct native IDs, mutable usage/tool results, payload distinctions, repeated observations, progress ancestry, original ordering and incomplete-evidence guards.

**726 tests across all 55 files passed**, including the new identity fixtures and existing Gemini parser tests. Both typechecks, targeted ESLint, formatting and tracked whitespace checks passed.

New evidence is not persisted or consumed for deduplication, session totals, billing or FS01 reconciliation fingerprints. Fallback payload changes cannot be classified as corrections without suitable native evidence. Cross-snapshot rewind/fork reconstruction, JSONL support, nested agent discovery, OpenCode capture, durable observations and the rest of the FS02 gate remain unfinished. Tests use synthetic provider-format logs and disposable databases. No live app launch, deployment, commit, push or external tracker update occurred.
