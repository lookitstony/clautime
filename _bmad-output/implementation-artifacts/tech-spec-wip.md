---
title: 'Raw Message Store for Lossless Session Rebuilds'
slug: 'raw-message-store'
created: '2026-03-07'
status: 'in-progress'
stepsCompleted: [1]
tech_stack: ['drizzle-orm', 'better-sqlite3', 'electron-vite']
files_to_modify: []
code_patterns: []
test_patterns: []
---

# Tech-Spec: Raw Message Store for Lossless Session Rebuilds

**Created:** 2026-03-07

## Overview

### Problem Statement

Changing the idle timeout requires a destructive reset+rescan that re-reads JSONL files from disk. When conversations have been compacted via `/compact`, the original messages are gone from the JSONL — resulting in permanent loss of pre-compaction session history. This makes the idle timeout slider a risky operation and prevents accurate historical reporting for long-running projects.

### Solution

Store raw parsed message metadata in the database as a persistent source of truth. Sessions become derived views that can be rebuilt on demand from stored raw data. Changing the idle timeout just re-derives sessions from DB data without any file I/O, eliminating the risk of data loss from compacted JSONL files.

### Scope

**In Scope:**
- `raw_messages` table storing ParsedMessage metadata (no content/body text)
- `progress_events` table storing progress timestamps for tool gap bridging
- Hybrid incremental scan: byte-offset tracking with compaction-aware fallback to uuid dedup
- Session rebuild from DB raw data (no file re-read needed)
- Migration with backfill: populate raw_messages from existing JSONL files + synthesize records from existing DB sessions for compacted files
- Subagent message collection (progress timestamps for accurate gap bridging)
- Preserve manual sessions during rebuild (only `auto` sessions get re-derived)

**Out of Scope:**
- Changing the JSONL format or preventing compaction
- Storing message content/body text (keeping storage lean)
- Modifying the live monitor or widget glow logic
- Changes to the session detector algorithm itself (gap limits, tool types, etc.)

## Context for Development

### Codebase Patterns

- Drizzle ORM with better-sqlite3, sequential migrations (currently 0000-0008)
- Session detection is a pure function: `detectSessions(parsed, idleTimeout) -> DetectedSession[]`
- Current scan flow: `discover -> filterChanged -> parse -> detect -> store`
- `scanState` table tracks file mtime for incremental scanning
- `ParsedMessage` is already lean — no content, just metadata (~200 bytes per message)
- Subagent tokens collected via `collectSubagentTokens()` reading `{sessionId}/subagents/*.jsonl`
- IPC pattern: `ipcMain.handle` + `ipcRenderer.invoke` with `IpcResult<T>` wrapper
- Manual sessions have `source: 'manual'`, auto-detected have `source: 'auto'`

### Files to Reference

| File | Purpose |
| ---- | ------- |
| `src/main/parsers/types.ts` | `ParsedMessage`, `ParsedSessionData`, `TokenUsage` types |
| `src/main/parsers/session-parser.ts` | JSONL parsing, file discovery, subagent token collection |
| `src/main/services/session-detector.ts` | Pure session detection logic with gap bridging |
| `src/main/services/session-service.ts` | Scan orchestration: discover -> parse -> detect -> store |
| `src/main/db/schema/sessions.ts` | Current sessions table schema |
| `src/main/db/schema/scan-state.ts` | Current scan state tracking schema |
| `src/main/ipc/session-handlers.ts` | IPC handlers including `session:reset` |
| `src/renderer/src/features/settings/SettingsPage.tsx` | Settings UI with idle timeout + Reset & Rescan |

### Technical Decisions

- Idle timeout changes should be instant (rebuild from DB, no file I/O)
- Hybrid scan: byte offset for fast incremental, uuid dedup fallback on compaction detection (file size shrinks)
- Store subagent progress events alongside main messages for precise gap bridging
- Synthesize raw records from existing DB sessions during migration to preserve compacted history

## Implementation Plan

### Tasks

_To be completed in Step 2/3_

### Acceptance Criteria

_To be completed in Step 2/3_

## Additional Context

### Dependencies

- No new npm packages required — uses existing Drizzle ORM + better-sqlite3

### Testing Strategy

_To be completed in Step 2/3_

### Notes

- Storage estimate: ~200 bytes per raw message. 100K messages = ~20MB. Negligible for SQLite.
- Compaction detection: if file size < stored byte offset, file was rewritten — use full re-read with dedup.
- Manual sessions (`source: 'manual'`) are never touched during rebuild — only `auto` sessions are re-derived.
