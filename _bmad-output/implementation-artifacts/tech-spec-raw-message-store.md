---
title: 'Raw Message Store for Lossless Session Rebuilds'
slug: 'raw-message-store'
created: '2026-03-07'
status: 'completed'
stepsCompleted: [1, 2, 3, 4]
tech_stack: ['drizzle-orm', 'better-sqlite3', 'electron-vite', 'vitest']
files_to_modify:
  - 'src/main/db/schema/raw-messages.ts'
  - 'src/main/db/schema/scan-state.ts'
  - 'src/main/db/index.ts'
  - 'src/main/db/migrations/0009_*.sql'
  - 'src/main/parsers/session-parser.ts'
  - 'src/main/services/session-service.ts'
  - 'src/main/ipc/session-handlers.ts'
  - 'src/renderer/src/features/settings/SettingsPage.tsx'
  - 'src/preload/index.ts'
  - 'src/shared/types/session.ts'
  - 'src/main/__tests__/session-detector.test.ts'
  - 'src/main/__tests__/session-service.test.ts'
code_patterns:
  - 'Drizzle ORM schema + drizzle-kit generate for migrations'
  - 'Pure detection function: detectSessions(parsed, idleTimeout)'
  - 'IPC: ipcMain.handle + ipcRenderer.invoke with IpcResult<T>'
  - 'Batch inserts in transactions (NFR18, NFR20)'
  - 'Preload bridge: contextBridge.exposeInMainWorld with typed API object'
test_patterns:
  - 'Vitest with // @vitest-environment node for main process'
  - 'session-detector.test.ts for detection logic'
  - 'session-service.test.ts for scan orchestration'
---

# Tech-Spec: Raw Message Store for Lossless Session Rebuilds

**Created:** 2026-03-07
**Revised:** 2026-03-07 (post adversarial reviews — 20 + 14 findings addressed)

## Overview

### Problem Statement

Changing the idle timeout requires a destructive reset+rescan that re-reads JSONL files from disk. When conversations have been compacted via `/compact`, the original messages are gone from the JSONL — resulting in permanent loss of pre-compaction session history. This makes the idle timeout slider a risky operation and prevents accurate historical reporting for long-running projects.

### Solution

Store raw parsed message metadata in the database as a persistent source of truth. Sessions become derived views that can be rebuilt on demand from stored raw data. Changing the idle timeout just re-derives sessions from DB data without any file I/O, eliminating the risk of data loss from compacted JSONL files.

### Scope

**In Scope:**
- `raw_messages` table storing ParsedMessage metadata including subagent messages (no content/body text)
- `progress_events` table storing progress timestamps for tool gap bridging
- Hybrid incremental scan: file-size tracking with compaction-aware fallback to uuid dedup
- Session rebuild from DB raw data (no file re-read needed)
- Migration with backfill: populate raw_messages from existing JSONL files + synthesize records from existing DB sessions for compacted files
- Subagent message AND token collection in raw store for accurate gap bridging and token distribution
- Preserve manual sessions during rebuild (only `auto` sessions get re-derived)
- Preserve user edits to auto sessions (client/project attribution, description) during rebuild
- FK cleanup for `ai_summaries` and `git_commits` during session delete operations

**Out of Scope:**
- Changing the JSONL format or preventing compaction
- Storing message content/body text (keeping storage lean)
- Modifying the live monitor or widget glow logic
- Changes to the session detector algorithm itself (gap limits, tool types, etc.)

## Context for Development

### Codebase Patterns

- Drizzle ORM with better-sqlite3, sequential migrations (currently 0000-0008, next is 0009)
- Session detection is a pure function: `detectSessions(parsed, idleTimeout) -> DetectedSession[]`
- Current scan flow: `discover -> filterChanged -> parse -> detect -> store`
- New scan flow: `discover -> filterChanged -> parse -> **store raw** -> detect from parsed data -> store sessions`
- Rebuild flow (idle timeout change): `read raw from DB -> reconstruct ParsedSessionData -> detect -> replace auto sessions`
- `scanState` table tracks file mtime for incremental scanning (adding file size tracking)
- `ParsedMessage` is already lean — no content, just metadata (~200 bytes per message)
- Subagent tokens collected via `collectSubagentTokens()` reading `{sessionId}/subagents/*.jsonl`
- IPC pattern: `ipcMain.handle` + `ipcRenderer.invoke` with `IpcResult<T>` wrapper
- Preload bridge: `contextBridge.exposeInMainWorld('api', { sessions: { ... } })` — check `src/preload/index.ts` for exact pattern
- Manual sessions have `source: 'manual'`, auto-detected have `source: 'auto'`
- `ai_summaries` table has FK to `sessions.id` — must delete summaries before deleting sessions
- `git_commits` table has nullable FK `sessionId` to `sessions.id` — must set to null before deleting sessions

### Files to Reference

| File | Purpose |
| ---- | ------- |
| `src/main/parsers/types.ts` | `ParsedMessage`, `ParsedSessionData`, `TokenUsage` types |
| `src/main/parsers/session-parser.ts` | JSONL parsing, file discovery, `collectSubagentTokens()` |
| `src/main/services/session-detector.ts` | Pure session detection with gap bridging, `buildDetectedSession()` uses `subagentTokenUsage` |
| `src/main/services/session-service.ts` | Scan orchestration, `filterChangedFiles()`, FK cleanup pattern in `scanSessions()` lines 73-98 |
| `src/main/db/schema/sessions.ts` | Sessions table schema |
| `src/main/db/schema/scan-state.ts` | Scan state tracking schema |
| `src/main/db/schema/ai-summaries.ts` | AI summaries with FK to sessions |
| `src/main/db/schema/git-commits.ts` | Git commits with nullable FK to sessions |
| `src/main/db/index.ts` | DB initialization, schema imports, migration runner |
| `src/main/ipc/session-handlers.ts` | IPC handlers — note FK cleanup gap in `session:reset` (pre-existing bug to fix) |
| `src/renderer/src/features/settings/SettingsPage.tsx` | Settings UI with idle timeout slider |
| `src/preload/index.ts` | Preload bridge — typed API surface for renderer |

### Technical Decisions

- **Idle timeout changes rebuild from DB only** — no file I/O, instant
- **Hybrid scan**: track file size (not byte offset) for compaction detection. Full re-read with dedup for changed files initially; partial-read optimization deferred.
- **Store ALL subagent messages** in `raw_messages` with `isSubagent=1` — not just progress events. This enables accurate `subagentTokenUsage` reconstruction during rebuild without file I/O.
- **Merge subagent progress timestamps** into the main `progressTimestamps` array when reconstructing `ParsedSessionData` — no changes needed to `detectSessions()`.
- **Synthesize raw records** from existing DB sessions during migration to preserve compacted history
- **Dedup strategy**: Partial unique index on `(sourceFile, uuid) WHERE uuid IS NOT NULL` for messages with uuid (SQLite NULL uniqueness gotcha: standard UNIQUE treats each NULL as distinct). For null-uuid messages: application-level check on `(sourceFile, timestamp, type, parentUuid)`. Progress events: unique index on `(sourceFile, timestamp, isSubagent)`.
- **Preserve user edits during rebuild**: before deleting auto sessions, capture `{claudeSessionId, startedAt} -> {projectId, clientId, description}` map, then re-apply after inserting new sessions
- **Scan/rebuild mutex**: use a simple `_scanInProgress` flag to prevent concurrent scan+rebuild operations
- **`claudeSessionId` column** on `raw_messages` — this is the Claude conversation ID from JSONL, NOT the DB `sessions.id` FK. Named explicitly to avoid confusion.
- **`progress_events` has no `sessionId`** — progress events in JSONL don't carry a sessionId. Derive from sourceFile when needed.

## Implementation Plan

### Tasks

- [x] Task 1: Create `raw_messages` and `progress_events` schema
  - File: `src/main/db/schema/raw-messages.ts` (NEW)
  - Action: Define two Drizzle tables:
    - `raw_messages`:
      - `id`: integer, primary key, auto increment
      - `sourceFile`: text, not null — full path to the JSONL file this message came from
      - `claudeSessionId`: text — the Claude conversation ID from JSONL (NOT a FK to sessions table)
      - `type`: text, not null — 'user', 'assistant', 'system'
      - `timestamp`: text, not null — ISO timestamp from JSONL
      - `cwd`: text, nullable — working directory from JSONL message
      - `gitBranch`: text, nullable
      - `model`: text, nullable — e.g. 'claude-sonnet-4-5-20250514'
      - `inputTokens`: integer, default 0
      - `outputTokens`: integer, default 0
      - `cacheCreationInputTokens`: integer, default 0
      - `cacheReadInputTokens`: integer, default 0
      - `uuid`: text, nullable — message uuid from JSONL
      - `parentUuid`: text, nullable
      - `isToolResult`: integer (0/1), default 0
      - `hasToolUse`: integer (0/1), default 0
      - `toolNames`: text, nullable — JSON array string, e.g. '["Read","Edit"]'
      - `isSubagent`: integer (0/1), default 0 — 1 if from a subagent JSONL file
      - `projectPathEncoded`: text — encoded project dir name from file path (e.g. 'C--apps-ClawdTime')
      - `createdAt`: text, not null, default now
    - `progress_events`:
      - `id`: integer, primary key, auto increment
      - `sourceFile`: text, not null
      - `timestamp`: text, not null
      - `isSubagent`: integer (0/1), default 0
    - Indexes:
      - `raw_messages(source_file, timestamp)` — for grouped queries during rebuild
      - `raw_messages(claude_session_id)` — for lookups by conversation
      - Partial unique index on `raw_messages(source_file, uuid) WHERE uuid IS NOT NULL` — SQLite treats each NULL as distinct in UNIQUE constraints, so a standard `UNIQUE(source_file, uuid)` would NOT prevent duplicate null-uuid rows. Use a partial index via raw SQL in migration: `CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_messages_source_uuid ON raw_messages(source_file, uuid) WHERE uuid IS NOT NULL;`
      - `progress_events(source_file, timestamp)` — for grouped queries during rebuild
      - Unique index on `progress_events(source_file, timestamp, is_subagent)` — prevents duplicate progress events on re-read/backfill

- [x] Task 2: Add `lastFileSize` to `scan_state` schema
  - File: `src/main/db/schema/scan-state.ts`
  - Action: Add `lastFileSize` integer column (default 0) to track file size for compaction detection (file size shrinks = compaction happened)
  - Note: Named `lastFileSize` not `lastByteOffset` — it stores the file size after the last complete scan, not a read cursor position

- [x] Task 3: Register new schema in DB initialization
  - File: `src/main/db/index.ts`
  - Action: Import `raw-messages.ts` schema (`rawMessages`, `progressEvents`) and add to the `schema` object

- [x] Task 4: Generate and verify migration 0009
  - Action: Run `npx drizzle-kit generate` to create migration SQL
  - Verify: Migration creates `raw_messages` table, `progress_events` table, adds `last_file_size` column to `scan_state`
  - Note: If migration partially fails on user databases, the app should log the error and continue (tables may already exist from a retry). Drizzle's migrator tracks applied migrations in a journal, so partial failures on the DDL level are the main risk.

- [x] Task 5: Update parser to collect subagent messages and progress timestamps
  - File: `src/main/parsers/session-parser.ts`
  - Action: Rename `collectSubagentTokens()` to `collectSubagentData()`. In addition to token usage, also:
    1. Extract all `ParsedMessage` records from subagent JSONL files (same `extractMessage()` logic as main file)
    2. Extract progress event timestamps from subagent JSONL files
    3. Return `{ tokenUsage: TokenUsage, messages: ParsedMessage[], progressTimestamps: string[] }`
  - File: `src/main/parsers/types.ts`
  - Action: Add to `ParsedSessionData`:
    - `subagentMessages: ParsedMessage[]` — messages from subagent JSONL files
    - `subagentProgressTimestamps: string[]` — progress events from subagent JSONL files
  - Note: The `subagentProgressTimestamps` are merged into the main `progressTimestamps` array when reconstructing `ParsedSessionData` during rebuild. The session detector's `hasProgressActivity()` works on the merged array — no detector changes needed.

- [x] Task 6: Add raw message storage to session service
  - File: `src/main/services/session-service.ts`
  - Action: Create `storeRawMessages(parsed: ParsedSessionData[])` method that:
    1. For each parsed file, inserts main messages into `raw_messages` with `isSubagent=0`
    2. Inserts subagent messages (from `parsed.subagentMessages`) into `raw_messages` with `isSubagent=1`. Each subagent message's `sourceFile` is set to the subagent's own JSONL file path (not the main file) to avoid uuid collisions in the partial unique index. The subagent file path must be carried through from `collectSubagentData()` — add a `sourceFile: string` field to each returned subagent `ParsedMessage`.
    3. Inserts main progress timestamps into `progress_events` with `isSubagent=0`
    4. Inserts subagent progress timestamps (from `parsed.subagentProgressTimestamps`) into `progress_events` with `isSubagent=1`
    5. Sets `projectPathEncoded` from `parsed.projectPathEncoded` on each raw message
    6. Dedup logic:
       - For rows with uuid: leverages the partial unique index — `INSERT ... ON CONFLICT DO NOTHING` via raw SQL (Drizzle's `onConflictDoNothing` works with the partial index). If uuid is non-null and `(source_file, uuid)` already exists, the row is silently skipped.
       - For rows without uuid: check `(sourceFile, timestamp, type, parentUuid)` before inserting. If all four match an existing row, skip. Note: multiple null-uuid messages CAN legitimately share the same timestamp+type (e.g. rapid system messages). The `parentUuid` disambiguates most cases; for the rare remainder, accept potential duplicates — they have negligible impact on session detection since they carry no tokens.
       - For progress_events: use `INSERT ... ON CONFLICT(source_file, timestamp, is_subagent) DO NOTHING` via the unique index — prevents duplicates on re-read without needing delete-before-reinsert.
    7. Updates `scanState.lastFileSize` with current file size after processing
  - Action: Call `storeRawMessages()` in `scanSessions()` between parse and detect steps
  - Note: Use batch inserts in a transaction for performance (existing pattern in codebase)

- [x] Task 7: Add compaction detection to file filtering
  - File: `src/main/services/session-service.ts`
  - Action: Update `filterChangedFiles()` to:
    1. Read `lastFileSize` from `scanState` for each file
    2. If current file size < `lastFileSize` → compaction detected → still include in `files` list (will be full-read with dedup)
    3. Return type remains `{ files: string[]; mtimes: Map<string, string> }` — compacted files are handled transparently by the dedup in `storeRawMessages()` (existing raw_messages prevent duplicates via uuid/timestamp dedup)
  - Note: Initial implementation does full-file re-read for all changed files. The dedup layer handles compaction transparently. Partial-read byte-offset optimization is a future enhancement if needed for performance.

- [x] Task 8: Add `rebuildSessionsFromRaw()` method
  - File: `src/main/services/session-service.ts`
  - Action: Create method that:
    1. Acquires `_scanInProgress` mutex (simple boolean flag). If already true, throw error "Scan/rebuild already in progress"
    2. Reads idle timeout from settings
    3. Queries all `raw_messages` grouped by `sourceFile`, ordered by timestamp
    4. Queries all `progress_events` grouped by `sourceFile`, ordered by timestamp
    5. Reconstructs `ParsedSessionData[]` from DB records. **Reconstruction details:**
       - `sessionId`: use `claudeSessionId` from first message in the group, or derive from sourceFile basename
       - `sourceFile`: the group key
       - `projectPathEncoded`: from `raw_messages.projectPathEncoded` (first non-null in group)
       - `projectDirectory`: from `raw_messages.cwd` (first non-null in group)
       - `messages`: map raw_messages rows (where `isSubagent=0`) back to `ParsedMessage[]` — reconstruct `usage: TokenUsage | null` from the four token columns (null if all zero), `toolNames` from JSON.parse of stored text
       - `progressTimestamps`: merge `progress_events` where `isSubagent=0` AND `isSubagent=1` into a single sorted array (subagent progress merged for gap bridging — no detector changes needed)
       - `firstTimestamp` / `lastTimestamp`: from min/max of message timestamps
       - `totalTokenUsage`: aggregate from `raw_messages` where `isSubagent=0`
       - `subagentTokenUsage`: aggregate from `raw_messages` where `isSubagent=1`
       - `subagentMessages`: map `raw_messages` rows where `isSubagent=1` back to `ParsedMessage[]`
       - `subagentProgressTimestamps`: from `progress_events` where `isSubagent=1`
       - `models`: distinct `model` values from `raw_messages` in group (filter nulls)
       - `messageCount`: count of `raw_messages` in group
       - `summary`: null (summaries are not stored in raw_messages — acceptable loss, summaries are in `ai_summaries` table)
    6. Calls `detectSessionsFromMultiple(parsedSessions, idleTimeout)` — reuses existing pure function unchanged
    7. **Preserve user edits**: Before deleting auto sessions, build a map of `{claudeSessionId + startedAt} -> {projectId, clientId, description}` from existing auto sessions that have non-null projectId, clientId, or description
    8. In a transaction:
       - Delete `ai_summaries` where sessionId in auto session IDs being deleted
       - Set `git_commits.sessionId = null` where sessionId in auto session IDs being deleted
       - Delete all `source: 'auto'` sessions
       - Insert newly detected sessions
       - Re-apply preserved edits: for each new session, look up `{claudeSessionId + startedAt}` in the map and restore projectId/clientId/description if found
    9. Re-runs `clientProjectService.attributeSessions()` (for sessions without preserved attribution) and `gitService.correlateCommitsWithSessions()`
    10. Releases `_scanInProgress` mutex (in finally block)
  - Returns: `ScanResult` with rebuilt session count

- [x] Task 9: Add migration backfill logic
  - File: `src/main/services/session-service.ts`
  - Action: Create `backfillRawMessages()` method that:
    1. Checks if `raw_messages` table is empty (count query)
    2. If empty, runs a full JSONL scan: discover all files, parse each, call `storeRawMessages()` for each — stores messages but does NOT re-detect sessions
    3. After JSONL backfill, checks existing DB `auto` sessions for sourceFiles that have no matching raw_messages (these are compacted files where the original JSONL content is gone). For each such session, synthesizes minimal raw message records:
       - One `user` type message at `startedAt` with token counts split proportionally (70% input on user, 30% on assistant as rough estimate)
       - One `assistant` type message at `endedAt` with remaining tokens
       - Sets `claudeSessionId` from `session.claudeSessionId`, `sourceFile` from `session.sourceFile`
       - Sets `projectPathEncoded` derived from sourceFile path
       - For split sessions (multiple DB sessions sharing the same sourceFile): synthesize records for EACH session individually using their own `startedAt`/`endedAt` and token counts. Add a 1-second offset to the assistant message timestamp (`endedAt + 1s * index`) to prevent timestamp collisions in the dedup check. These synthetic records are coarser than real data but preserve each split session's boundaries during rebuild.
    4. After storing raw messages (step 2) and synthesizing records (step 3), update `scanState.lastFileSize` for every processed file so the next incremental scan doesn't re-process them
    5. Call from the first `scanSessions()` invocation: at the top of `scanSessions()`, check if `raw_messages` is empty and if so run `backfillRawMessages()` before proceeding with the normal scan flow
  - Notes: Synthetic records lack uuid/toolNames/model but preserve time boundaries and token counts so sessions can be derived from them. This is acceptable since they represent compacted history where the original data is already lost.

- [x] Task 10: Add IPC handler for session rebuild + fix FK cleanup bugs
  - File: `src/main/ipc/session-handlers.ts`
  - Action:
    1. Add `session:rebuild` handler that calls `sessionService.rebuildSessionsFromRaw()` and returns the result
    3. Add `session:scanAndRebuild` handler that calls `sessionService.scanSessions()` then `sessionService.rebuildSessionsFromRaw()` sequentially under one mutex — used by Settings UI when changing idle timeout to ensure raw_messages are current before rebuild
    2. Update existing `session:reset` handler to properly clean up ALL related data in correct order:
       - Delete `ai_summaries` (all)
       - Set `git_commits.sessionId = null` (all)
       - Delete `sessions` (all)
       - Delete `raw_messages` (all)
       - Delete `progress_events` (all)
       - Delete `scanState` (all)
       - This fixes a pre-existing FK cleanup bug where reset only deleted sessions and scanState
  - File: `src/main/services/session-service.ts`
  - Action: Fix FK cleanup in existing `deleteSession()` and `splitSession()` methods:
    - `deleteSession(id)`: Before deleting the session, delete `ai_summaries` where `sessionId = id` and set `git_commits.sessionId = null` where `sessionId = id`. Currently these methods delete/split sessions without FK cleanup, causing orphaned ai_summaries rows and potential FK constraint errors.
    - `splitSession(id, splitAt)`: When the original session is deleted (replaced by two new sessions), apply same FK cleanup before the delete. The ai_summaries for the original session should be deleted (they'll be regenerated for the new sessions on demand). Git commits should be unlinked (they'll be re-correlated).

- [x] Task 11: Update Settings UI to use rebuild instead of reset+rescan
  - File: `src/renderer/src/features/settings/SettingsPage.tsx`
  - Action: Change `saveIdleTimeoutAndRescan`:
    1. Save the idle timeout setting
    2. Call `window.api.sessions.scanAndRebuild()` — a single IPC endpoint that scans for new JSONL data then rebuilds sessions under one mutex, avoiding race conditions
    3. Update button label from "Save & Rescan" to "Save & Rebuild"
    4. Update toast success message to "Idle timeout saved — sessions rebuilt"
    5. Update toast error message to "Failed to save and rebuild"
  - Action: Update "Reset & Rescan" confirm dialog description to: "This will delete ALL data including raw message history and re-import from scratch. Any history from compacted conversations will be permanently lost. This cannot be undone."
  - File: `src/preload/index.ts`
  - Action: Add to the `sessions` section of the API bridge (follow existing pattern):
    - `rebuild: () => ipcRenderer.invoke('session:rebuild')`
    - `scanAndRebuild: () => ipcRenderer.invoke('session:scanAndRebuild')`

- [x] Task 12: Add scan/rebuild mutex to scanSessions
  - File: `src/main/services/session-service.ts`
  - Action: Add `_scanInProgress: boolean` field to `sessionService` object (default false). Wrap `scanSessions()` and `rebuildSessionsFromRaw()` with mutex:
    - At start: if `_scanInProgress` is true, log warning and return early with zero-result `ScanResult`
    - Set `_scanInProgress = true` at start
    - Set `_scanInProgress = false` in finally block
  - This prevents concurrent scan+rebuild operations from corrupting data

- [x] Task 13: Update `getPromptTimings()` to use DB (bonus)
  - File: `src/main/services/session-service.ts`
  - Action: Refactor `getPromptTimings()` to query `raw_messages` table instead of re-parsing the JSONL file:
    1. Get session by ID to find `sourceFile`, `startedAt`, `endedAt`
    2. Query `raw_messages` where `sourceFile` matches and timestamp is between `startedAt` and `endedAt`, ordered by timestamp
    3. Build prompt/response pairs from the results (same logic as current implementation but from DB rows instead of ParsedMessage objects)
    4. Falls back to JSONL file parsing if no raw_messages found for this sourceFile (backward compat during migration window)

### Acceptance Criteria

- [ ] AC 1: Given a fresh install, when the app starts and runs initial scan, then raw_messages and progress_events tables are populated with message metadata from all discovered JSONL files including subagent files
- [ ] AC 2: Given raw_messages are populated, when the user changes idle timeout and clicks "Save & Rebuild", then sessions are re-derived from DB raw data without reading any JSONL files, and the new idle timeout is reflected in session boundaries
- [ ] AC 3: Given a JSONL file has been compacted (file size shrinks), when the next incremental scan runs, then the scanner detects the size change and re-reads the file with dedup, preserving existing raw_messages that are no longer in the file
- [ ] AC 4: Given existing sessions in the DB from compacted JSONL files, when the migration backfill runs, then synthetic raw_message records are created from those sessions so they survive future rebuilds
- [ ] AC 5: Given the user clicks "Save & Rebuild", when rebuild completes, then manual sessions (source='manual') are untouched and only auto sessions are re-derived
- [ ] AC 6: Given the user has edited auto sessions (set client, project, description), when "Save & Rebuild" runs, then those edits are preserved on the rebuilt sessions that match by claudeSessionId + startedAt
- [ ] AC 7: Given the user clicks "Reset & Rescan", when confirmed, then ALL data is cleared (sessions, raw_messages, progress_events, scan_state, ai_summaries unlinked, git_commits unlinked) and a fresh full scan is performed
- [ ] AC 8: Given a project with subagent JSONL files, when scanning, then subagent messages and progress timestamps are stored in raw_messages/progress_events with isSubagent=1, and subagent tokens are accurately reflected in rebuilt sessions
- [ ] AC 9: Given raw_messages exist for a session, when getPromptTimings() is called, then prompt timings are returned from DB data without re-reading the JSONL file
- [ ] AC 10: Given a scan is in progress, when rebuild is triggered (or vice versa), then the second operation returns early without corrupting data

## Additional Context

### Dependencies

- No new npm packages required — uses existing Drizzle ORM + better-sqlite3
- Depends on existing `detectSessions()` / `detectSessionsFromMultiple()` pure functions (unchanged)
- Depends on existing `clientProjectService.attributeSessions()` and `gitService.correlateCommitsWithSessions()` for post-rebuild attribution

### Testing Strategy

**Unit Tests (Vitest, `// @vitest-environment node`):**
- `raw-message-store.test.ts`: Test storeRawMessages() with dedup behavior — insert same messages twice, verify no duplicates. Test both uuid-bearing and null-uuid dedup paths. Test subagent message storage with isSubagent=1.
- `session-rebuild.test.ts`: Test rebuildSessionsFromRaw() — populate raw_messages, rebuild with different idle timeouts, verify session boundaries change. Verify manual sessions preserved. Verify user edits (projectId, clientId, description) preserved on matching rebuilt sessions. Verify FK cleanup (ai_summaries deleted, git_commits unlinked) before session delete.
- `compaction-detection.test.ts`: Test filterChangedFiles() compaction detection — file size shrinks still includes file in changed list.
- `backfill.test.ts`: Test backfillRawMessages() — verify synthetic records created from existing sessions for missing sourceFiles. Verify split sessions (same sourceFile) each get synthetic records with offset timestamps to avoid collisions.
- `scan-mutex.test.ts`: Test that concurrent scan/rebuild operations are safely rejected.

**Existing Test Updates:**
- `src/main/__tests__/session-detector.test.ts`: Update `ParsedSessionData` test fixtures to include new `subagentMessages: []` and `subagentProgressTimestamps: []` fields (Task 5 adds these to the type). Without this update, existing tests will fail with TypeScript errors.
- `src/main/__tests__/session-service.test.ts`: Update test fixtures similarly. Add test cases for `storeRawMessages()`, `rebuildSessionsFromRaw()`, and `backfillRawMessages()` (or put these in the new test files listed above).

**Manual Testing:**
- Change idle timeout slider -> click "Save & Rebuild" -> verify sessions update without losing history or client/project attributions
- Run `/compact` on a conversation -> verify next scan detects compaction and preserves raw data
- Verify "Reset & Rescan" still works as nuclear option (clears everything including raw_messages)
- Check that subagent-heavy projects (with Agent tool calls) maintain accurate session boundaries and token counts after rebuild
- Verify edited auto sessions (client, description changes) survive a rebuild

### Notes

- Storage estimate: ~200 bytes per raw message, ~50 bytes per progress event. Progress events can be high-volume (long builds produce hundreds per minute) but are still small. 100K raw messages + 200K progress events = ~30MB. Negligible for SQLite.
- Compaction detection: if current file size < stored `lastFileSize`, file was rewritten. The file is re-read fully but dedup prevents duplicate raw_messages.
- Manual sessions (`source: 'manual'`) are never touched during rebuild — only `auto` sessions are re-derived.
- User edits to auto sessions (projectId, clientId, description) are preserved during rebuild by capturing a map before delete and re-applying after insert. Match key is `claudeSessionId + startedAt` which uniquely identifies a session across rebuilds with the same idle timeout. If idle timeout changes cause session boundary shifts, some edits may not re-apply (startedAt changed) — this is an acceptable edge case documented in the UI toast.
- Initial implementation does full-file re-read for changed files with dedup. Byte-offset partial-read is a future optimization if scan performance becomes a concern.
- The backfill synthetic records (Task 9) are intentionally minimal — they preserve time boundaries and tokens but lack tool details. Split sessions sharing a sourceFile each get their own synthetic records with 1-second timestamp offsets to avoid collisions.
- `summary` field from `ParsedSessionData` is not stored in raw_messages — AI summaries are already in the `ai_summaries` table. During rebuild, `summary` is set to null on reconstructed `ParsedSessionData`, which is acceptable since the session detector does not use it.
- `getPromptTimings()` DB refactor (Task 13) is a bonus — it improves UX for compacted sessions where the JSONL no longer has the original prompts.

### Adversarial Review Findings Addressed

All 20 findings from adversarial review have been addressed:
- F1 (Critical): Reconstruction fully specified in Task 8 step 5
- F2, F8, F20 (High): Subagent messages stored in raw_messages; subagentTokenUsage reconstructed from DB
- F3 (High): Subagent progress merged into main progressTimestamps during rebuild; no detector changes
- F4 (High): Dedup key expanded to `(sourceFile, timestamp, type, parentUuid)` for null-uuid rows
- F5 (High): Column renamed to `claudeSessionId` with explicit documentation
- F6, F9 (High/Medium): FK cleanup for ai_summaries and git_commits specified in Task 8 step 8 and Task 10
- F7 (High): User edits preserved via capture-and-reapply map in Task 8 steps 7-8
- F10, F11 (Medium): Scan/rebuild mutex added as Task 12; progress_events has no sessionId
- F12 (Low): Renamed to `lastFileSize`
- F13 (Medium): filterChangedFiles return type unchanged; compaction handled transparently by dedup
- F14, F16 (Medium): Preload bridge specified explicitly in Task 11; session:reset FK cleanup in Task 10
- F15 (Medium): Migration failure note added to Task 4
- F17 (Low): Migration numbering confirmed as 0009
- F18 (Low): Storage estimate updated to include progress_events
- F19 (Low): claudeSessionId kept for efficient grouping queries (faster than parsing sourceFile basename)

### Second Adversarial Review Findings Addressed

14 findings from second adversarial review addressed:
- F1 (Critical): Nullable uuid UNIQUE constraint — SQLite treats each NULL as distinct. Fixed with partial unique index: `WHERE uuid IS NOT NULL`. Standard `UNIQUE(source_file, uuid)` would silently allow duplicate null-uuid rows.
- F2 (High): Null-uuid dedup ambiguity — accepted that rare same-second/same-type/same-parentUuid collisions are possible but have negligible impact on session detection (no tokens on system messages).
- F3 (High): `deleteSession()` missing FK cleanup — added ai_summaries delete + git_commits unlink before session delete in Task 10.
- F4 (High): `splitSession()` missing FK cleanup — added same FK cleanup before original session delete in Task 10.
- F5 (High): Backfill split sessions — changed from "skip" to "synthesize with 1-second offset timestamps" so each split session gets preserved during rebuild.
- F6 (Medium): Scan-then-rebuild ordering — Task 11 now runs incremental scan before rebuild to ensure raw_messages are current.
- F7 (Medium): Progress events dedup — added unique index on `(source_file, timestamp, is_subagent)` and ON CONFLICT DO NOTHING.
- F8 (Medium): AI summaries blown away during rebuild — **accepted as expected behavior** per Tony: "as far as AI summaries being blown away, I think that's expected as sessions are changing." Summaries regenerate on demand.
- F9-F11 (Low-Medium): Various minor clarifications incorporated into task descriptions.
- F12 (Medium): Existing test files need ParsedSessionData field updates — added to files_to_modify list and testing strategy.
- F13 (Medium): Inconsistent scan boundaries after timeout change — scan runs first to capture latest JSONL data, then rebuild re-derives sessions.
- F14 (Low): Test fixture updates documented in testing strategy.
