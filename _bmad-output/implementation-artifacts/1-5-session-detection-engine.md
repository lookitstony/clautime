# Story 1.5: Session Detection Engine

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer using ViberTime**,
I want **the system to detect individual work sessions from parsed data using idle timeouts and attribute them to projects**,
So that **my work time is automatically organized into distinct sessions per project**.

## Acceptance Criteria

1. **Given** parsed session data from the Claude Session File Parser, **When** the session detection engine processes the data, **Then** individual work sessions are detected by identifying activity gaps exceeding the configured idle timeout (default 10 minutes)
2. **And** each detected session is deterministically attributed to a project based on the directory path (FR4)
3. **And** only new or changed session data is processed since the last scan (FR5), tracked via last-processed timestamps
4. **And** detected sessions are stored in the SQLite database via Drizzle ORM (FR6)
5. **And** the `SessionService` in the main process orchestrates parsing -> detection -> storage
6. **And** IPC handlers expose `session:scan` and `session:getAll` methods to the renderer
7. **And** database operations use batch inserts, not individual row inserts (NFR18, NFR20)
8. **And** incremental scan completes in under 5 seconds for up to 50 new sessions (NFR2)
9. **And** the configurable idle timeout value is read from `app_settings` in the database
10. **And** unit tests validate session boundary detection, project attribution, and incremental processing

## Tasks / Subtasks

- [x] Task 1: Add `scan_state` table schema for incremental processing tracking (AC: #3)
  - [x] Create `src/main/db/schema/scan-state.ts` with `scan_state` table:
    - `id`: integer, primaryKey, autoIncrement
    - `filePath`: text('file_path'), notNull, unique
    - `lastModifiedAt`: text('last_modified_at'), notNull (ISO 8601)
    - `lastScannedAt`: text('last_scanned_at'), notNull (ISO 8601)
    - `sessionCount`: integer('session_count'), notNull, default 0
  - [x] Add index: `idx_scan_state_file_path` on `filePath`
  - [x] Export `scanState` table and inferred types
  - [x] Register schema in `src/main/db/index.ts` schema spread

- [x] Task 2: Add `claude_session_id` column to sessions table (AC: #3, #4)
  - [x] Add `claudeSessionId`: text('claude_session_id') to sessions table in `src/main/db/schema/sessions.ts`
  - [x] Add `sourceFile`: text('source_file') to sessions table — tracks which JSONL file produced this session
  - [x] Add index: `idx_sessions_claude_session_id` on `claudeSessionId`
  - [x] Generate new Drizzle migration: `npx drizzle-kit generate`
  - [x] Verify migration runs cleanly on existing database

- [x] Task 3: Create session detection logic — pure functions (AC: #1, #2)
  - [x] Create `src/main/services/session-detector.ts` with pure detection functions (no DB dependency):
    - `detectSessions(parsed: ParsedSessionData, idleTimeoutMinutes: number): DetectedSession[]`
      - Walk sorted messages, detect gaps > `idleTimeoutMinutes` between consecutive timestamps
      - Each continuous segment = one DetectedSession
      - DetectedSession: `{ startedAt: string, endedAt: string, durationMinutes: number, projectPath: string, claudeSessionId: string, sourceFile: string, messageCount: number }`
    - `detectSessionsFromMultiple(parsedSessions: ParsedSessionData[], idleTimeoutMinutes: number): DetectedSession[]`
      - Calls `detectSessions` for each parsed session, flattens results
  - [x] Project attribution logic: `projectPath` = `parsed.projectDirectory` (the cwd from the first message), falling back to decoding `projectPathEncoded`
  - [x] Handle edge cases: single-message sessions (duration = 0), no timestamps, empty message arrays
  - [x] Write thorough unit tests in `src/main/services/session-detector.test.ts`:
    - Normal session detection with clear idle gaps
    - Single-message session
    - No idle gaps (one continuous session)
    - Multiple idle gaps (multiple sessions from one file)
    - Edge case: messages with missing timestamps

- [x] Task 4: Create SessionService — orchestrates parse -> detect -> store (AC: #4, #5, #7, #9)
  - [x] Create `src/main/services/session-service.ts` implementing:
    - `scanSessions(claudeDir?: string): Promise<ScanResult>` — main orchestration method:
      1. Get `claudeDir` (default: `~/.claude` or from app_settings `claude_dir`)
      2. Get `idleTimeoutMinutes` from app_settings (default: 10)
      3. Discover session files via parser
      4. Filter to only new/changed files (compare file mtime against `scan_state` records)
      5. Parse new/changed files via parser
      6. Detect sessions from parsed data
      7. Delete stale auto sessions for re-scanned files (WHERE source='auto' AND sourceFile IN (...))
      8. Batch-insert detected sessions into DB
      9. Update `scan_state` records for processed files
      10. Update `lastScanAt` in app_settings
      11. Return `ScanResult: { newSessions: number, updatedFiles: number, totalFiles: number, durationMs: number }`
    - `getAllSessions(filters?: SessionFilters): Session[]` — query sessions from DB with optional filters:
      - `projectPath?: string`
      - `startDate?: string` (ISO 8601)
      - `endDate?: string` (ISO 8601)
      - `source?: 'auto' | 'manual'`
    - `getSessionById(id: number): Session | null`
  - [x] Use `settingsService.getSetting()` to read idle timeout and claude dir
  - [x] Use Drizzle batch operations for inserts (NFR18, NFR20)
  - [x] Log scan progress with electron-log at info level
  - [x] Write unit tests in `src/main/services/session-service.test.ts`:
    - Full scan cycle (discover -> parse -> detect -> store)
    - Incremental scan (only processes new files)
    - Batch insert verification
    - Filter queries

- [x] Task 5: Create session IPC handlers (AC: #6)
  - [x] Create `src/main/ipc/session-handlers.ts`:
    - `session:scan` — calls `sessionService.scanSessions()`, returns `IpcResult<ScanResult>`
    - `session:getAll` — calls `sessionService.getAllSessions(filters)`, returns `IpcResult<Session[]>`
    - `session:getById` — calls `sessionService.getSessionById(id)`, returns `IpcResult<Session | null>`
  - [x] Each handler wraps service calls with try/catch -> IpcResult<T> pattern (match settings-handlers.ts)
  - [x] Register in `src/main/ipc/index.ts` via `registerSessionHandlers()`

- [x] Task 6: Update preload to expose session API (AC: #6)
  - [x] Add `sessions` namespace to `api` object in `src/preload/index.ts`:
    - `sessions.scan(): Promise<IpcResult<ScanResult>>`
    - `sessions.getAll(filters?: SessionFilters): Promise<IpcResult<Session[]>>`
    - `sessions.getById(id: number): Promise<IpcResult<Session | null>>`
  - [x] Update `src/preload/index.d.ts` with `SessionsApi` interface in the `Api` type

- [x] Task 7: Create shared session types (AC: all)
  - [x] Create `src/shared/types/session.ts` with:
    - `SessionFilters`: `{ projectPath?: string; startDate?: string; endDate?: string; source?: 'auto' | 'manual' }`
    - `ScanResult`: `{ newSessions: number; updatedFiles: number; totalFiles: number; durationMs: number }`
    - Re-export `Session` type from schema for renderer use
  - [x] Ensure types are importable from both main and renderer contexts

- [x] Task 8: End-to-end verification (AC: all)
  - [x] Generate Drizzle migration with `npx drizzle-kit generate`
  - [x] Run `npx vitest run` — all existing + new tests pass
  - [x] Verify scan cycle with real `.claude` directory (manual dev test)
  - [x] Verify incremental scan skips already-processed files
  - [x] No TypeScript errors, no ESLint issues
  - [x] Run `npm run rebuild:node` before tests if needed for better-sqlite3

## Dev Notes

### Architecture Patterns & Constraints

**Three-Context Electron Architecture (CRITICAL):**
- **Main** (`src/main/`): ALL session detection, DB operations, file parsing lives here
- **Preload** (`src/preload/`): Thin IPC bridge — expose `window.api.sessions.*` methods
- **Renderer** (`src/renderer/`): Will consume via React Query in Story 1.6 — NOT this story's scope

**IPC Pattern (follow settings-handlers.ts exactly):**
```
Renderer -> window.api.sessions.scan()
  -> preload -> ipcRenderer.invoke('session:scan')
    -> main handler -> sessionService.scanSessions()
      -> returns IpcResult<ScanResult>
```

**Service Organization:**
- `session-detector.ts` — PURE detection logic (no DB, no IPC, no side effects). Easy to unit test.
- `session-service.ts` — Orchestration layer that calls parser, detector, and DB. Depends on `getDb()`, `settingsService`, `sessionParser`.
- `session-handlers.ts` — IPC bridge only. Thin wrapper around service methods.

**Component Location (from architecture):**
- Session service -> `src/main/services/session-service.ts`
- Session detector -> `src/main/services/session-detector.ts`
- Session handlers -> `src/main/ipc/session-handlers.ts`
- Session types -> `src/shared/types/session.ts`
- Schema changes -> `src/main/db/schema/sessions.ts`, `src/main/db/schema/scan-state.ts`

### Session Detection Algorithm

The core algorithm for `detectSessions()`:

```typescript
function detectSessions(parsed: ParsedSessionData, idleTimeoutMinutes: number): DetectedSession[] {
  const messages = parsed.messages.filter(m => m.timestamp)
  if (messages.length === 0) return []

  const sessions: DetectedSession[] = []
  let segmentStart = 0

  for (let i = 1; i < messages.length; i++) {
    const prevTime = new Date(messages[i - 1].timestamp).getTime()
    const currTime = new Date(messages[i].timestamp).getTime()
    const gapMinutes = (currTime - prevTime) / (1000 * 60)

    if (gapMinutes > idleTimeoutMinutes) {
      // Gap found — create session from segmentStart to i-1
      sessions.push(createDetectedSession(parsed, messages, segmentStart, i - 1))
      segmentStart = i
    }
  }

  // Final segment
  sessions.push(createDetectedSession(parsed, messages, segmentStart, messages.length - 1))
  return sessions
}
```

**Key rules:**
- Messages are already sorted by timestamp from the parser (Story 1.4)
- Gap > `idleTimeoutMinutes` between consecutive messages = session boundary
- Duration = difference between first and last message timestamps in the segment (in minutes, rounded)
- Single-message sessions get `durationMinutes: 0`
- `projectPath` comes from `parsed.projectDirectory` (first message's `cwd`), falling back to decoding `parsed.projectPathEncoded`

### Incremental Processing Strategy

1. **File-level tracking** via `scan_state` table:
   - On scan: `discoverSessionFiles()` gets all JSONL file paths
   - For each file: check `scan_state` record — compare file's current `mtime` against `lastScannedAt`
   - Only parse files where mtime > lastScannedAt OR no scan_state record exists
2. **Stale data cleanup**: Before inserting new sessions from a re-scanned file, delete existing auto-detected sessions for that file:
   ```sql
   DELETE FROM sessions WHERE source = 'auto' AND source_file = ?
   ```
3. **Batch operations**: Accumulate all DetectedSession objects, then insert in one transaction:
   ```typescript
   db.transaction((tx) => {
     // Delete stale sessions for changed files
     // Insert all new sessions
   })
   ```
4. **Global timestamp**: Store `lastScanAt` in app_settings for quick "has anything been scanned?" check

### Project Path Decoding

The `.claude` folder structure encodes project paths in directory names. For example:
- `~/.claude/projects/C--apps-ClawdTime/` encodes `C:\apps\ClawdTime`
- The parser stores this as `projectPathEncoded` and the `cwd` from messages as `projectDirectory`

**Attribution priority:**
1. Use `parsed.projectDirectory` (the actual cwd from messages) — most accurate
2. Fall back to decoding `parsed.projectPathEncoded` if projectDirectory is null

**Decoding logic** (for fallback):
- Replace `--` with path separator (`:` on Unix, `:\` on Windows)
- Replace `-` with path separator (`/` or `\`)
- This is a best-effort decode — may not be 100% accurate for all edge cases

### Naming Conventions (MUST follow)

| Element | Convention | Examples |
|---------|-----------|----------|
| Database tables | snake_case, plural | `scan_state` |
| Columns | snake_case | `file_path`, `last_modified_at` |
| IPC channels | `service:method` | `session:scan`, `session:getAll` |
| Service files | kebab-case | `session-service.ts`, `session-detector.ts` |
| Types/interfaces | PascalCase | `DetectedSession`, `ScanResult`, `SessionFilters` |
| Test files | co-located | `session-detector.test.ts` next to `session-detector.ts` |

### Anti-Patterns (NEVER do)

- `console.log` — use `electron-log/main.js` (note `.js` extension for ESM!)
- `any` type — always type explicitly
- Raw SQL strings — use Drizzle query builder
- Individual inserts in a loop — use batch inserts in a transaction (NFR18)
- `useState` + `useEffect` for data fetching — React Query (but NOT this story's scope)
- Mocking better-sqlite3 — use real SQLite in tests (in-memory or temp file)

### Testing Patterns

**Main process tests need `// @vitest-environment node` directive** at the top of each test file (the global vitest config uses happy-dom for renderer tests).

**electron-log mock pattern (from Story 1.4):**
```typescript
vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
```

**better-sqlite3 tests**: Use real SQLite with in-memory or temp file database. The `npm run rebuild:node` script rebuilds the native module for Node.js (needed for Vitest). `npm run rebuild:electron` for dev mode.

**Session detector tests**: Pure function tests — no DB or mocks needed. Just construct `ParsedSessionData` objects and assert `DetectedSession[]` output.

**Session service tests**: Need DB setup. Create in-memory SQLite, run migrations, then test the full scan cycle. Mock the file system calls (parser) but use real DB.

### Library/Framework Requirements

| Library | Version | Notes for this story |
|---------|---------|---------------------|
| drizzle-orm | 0.45.1 | Batch inserts via `db.insert().values([...]).run()`, transactions via `db.transaction()` |
| better-sqlite3 | 12.6.2 | `npm run rebuild:node` for tests |
| drizzle-kit | 0.31.9 | `npx drizzle-kit generate` for new migration |
| electron-log | 5.4.3 | Import as `electron-log/main.js` |
| vitest | 4.x | `// @vitest-environment node` for main process tests |

### File Structure for This Story

```
src/
├── main/
│   ├── db/
│   │   ├── index.ts                          # MODIFY — add scan-state schema to spread
│   │   ├── schema/
│   │   │   ├── sessions.ts                   # MODIFY — add claudeSessionId, sourceFile columns
│   │   │   └── scan-state.ts                 # NEW — scan_state table for incremental tracking
│   │   └── migrations/                        # AUTO-GENERATED — new migration for schema changes
│   ├── services/
│   │   ├── session-detector.ts               # NEW — pure session detection functions
│   │   ├── session-detector.test.ts          # NEW — detection algorithm tests
│   │   ├── session-service.ts                # NEW — orchestration: parse -> detect -> store
│   │   └── session-service.test.ts           # NEW — integration tests with real DB
│   └── ipc/
│       ├── index.ts                          # MODIFY — register session handlers
│       └── session-handlers.ts               # NEW — session:scan, session:getAll, session:getById
├── preload/
│   ├── index.ts                              # MODIFY — add sessions namespace to api
│   └── index.d.ts                            # MODIFY — add SessionsApi to Api interface
└── shared/
    └── types/
        └── session.ts                        # NEW — SessionFilters, ScanResult, re-export Session
```

### Previous Story Intelligence

**Story 1.4 (Parser) — Key Implementation Details:**
- Parser lives in `src/main/parsers/` — `session-parser.ts`, `types.ts`, `index.ts`
- `parseAllSessions(claudeDir)` returns `ParsedSessionData[]` with messages sorted by timestamp
- `discoverSessionFiles(claudeDir)` returns all JSONL file paths
- Messages filtered to only `user`, `assistant`, `system` types (skips `file-history-snapshot`)
- `ParsedSessionData.projectDirectory` = first message's `cwd` field
- `ParsedSessionData.projectPathEncoded` = encoded project dir name from file path
- Parser batches file processing (default 20 at a time)
- 20 tests all passing

**Story 1.3 (DB/Services) — Patterns to Follow:**
- `getDb()` for database access — throws if not initialized
- `settingsService.getSetting(key)` returns `string | null`
- IPC handlers: `ipcMain.handle('channel:method', async handler)` returning `IpcResult<T>`
- Preload: add methods to `api` object in `contextBridge.exposeInMainWorld`
- `ipcSuccess()` and `ipcError()` helpers from `src/shared/types/ipc.ts`
- `AppError` class for service-level errors with `code` field

**Key Learnings from Previous Stories:**
- electron-log imports MUST use `.js` extension: `electron-log/main.js`
- `// @vitest-environment node` directive at top of main process test files
- better-sqlite3 native module: `npm run rebuild:node` for tests, `npm run rebuild:electron` for dev
- Drizzle `migrate()` is synchronous — no await needed
- ESM project: `"type": "module"` in package.json
- Path alias `@/` only for renderer — main process uses relative imports

### Git Intelligence

Recent commits:
- `d6ff095` Implement Story 1.3: Database schema and service foundation
- `f8f90ff` Fix electron-log imports for Node ESM compatibility
- `e370e7e` Implement Story 1.2: App shell and navigation layout
- `1eea6e8` Implement Story 1.1: Project scaffolding with Electron-Vite and core dependencies

Uncommitted files from Story 1.4:
- `src/main/parsers/index.ts` (NEW)
- `src/main/parsers/session-parser.ts` (NEW)
- `src/main/parsers/session-parser.test.ts` (NEW)
- `src/main/parsers/types.ts` (NEW)

**IMPORTANT:** Story 1.4 parser files are uncommitted but present in the working tree. The dev agent should NOT recreate or modify these files — they are the dependency this story builds upon. Commit Story 1.4 changes first if not already committed.

### File System Access for Incremental Processing

To check file modification times, use Node.js `fs.stat()`:
```typescript
import { stat } from 'node:fs/promises'
const fileStat = await stat(filePath)
const mtime = fileStat.mtime.toISOString()
```

Compare against `scan_state.lastModifiedAt` to determine if file needs re-processing.

### Default Claude Directory

The default `.claude` directory location:
- **Windows:** `C:\Users\{username}\.claude`
- **macOS/Linux:** `~/.claude`

Use `os.homedir()` to resolve: `path.join(os.homedir(), '.claude')`

Allow override via app_settings key `claude_dir`.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 1.5 — Acceptance Criteria, BDD format]
- [Source: _bmad-output/planning-artifacts/architecture.md — Data Architecture, IPC Patterns, Service Organization]
- [Source: _bmad-output/planning-artifacts/architecture.md — Implementation Patterns, Naming Conventions, Anti-Patterns]
- [Source: _bmad-output/planning-artifacts/prd.md — FR1-FR6, NFR1-2, NFR18, NFR20]
- [Source: _bmad-output/implementation-artifacts/1-3-database-schema-and-service-foundation.md — DB patterns, IPC patterns, testing patterns]
- [Source: src/main/parsers/types.ts — ParsedSessionData, ParsedMessage, TokenUsage interfaces]
- [Source: src/main/parsers/session-parser.ts — Parser implementation, discoverSessionFiles, parseSessionFile, parseAllSessions]
- [Source: src/main/db/schema/sessions.ts — Existing sessions table schema]
- [Source: src/main/services/settings-service.ts — SettingsService pattern]
- [Source: src/main/ipc/settings-handlers.ts — IPC handler pattern]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

- Pre-existing TS errors in session-parser.ts (Dirent type mismatch with Node 20) — not introduced by this story
- Added `src/shared/**/*` to tsconfig.node.json include — was missing, caused TS6307 errors for shared types
- Drizzle `and()` requires explicit `SQL[]` type annotation on conditions array to avoid `never[]` inference

### Completion Notes List

- Task 1: Created `scan_state` table schema with id, filePath (unique), lastModifiedAt, lastScannedAt, sessionCount. Index on filePath.
- Task 2: Added `claudeSessionId` and `sourceFile` columns to sessions table. Added index on claudeSessionId. Generated migration `0001_absurd_wrecker.sql`.
- Task 3: Created `session-detector.ts` with pure `detectSessions()` and `detectSessionsFromMultiple()` functions. Walks sorted messages, detects idle gaps > threshold. Includes `resolveProjectPath()` with fallback to `decodeProjectPath()`. 18 unit tests passing.
- Task 4: Created `session-service.ts` with `scanSessions()` (orchestrates discover→filter→parse→detect→store), `getAllSessions()` (with filters), `getSessionById()`. Incremental processing via scan_state table. Batch inserts in transactions. 15 unit tests passing.
- Task 5: Created `session-handlers.ts` with `session:scan`, `session:getAll`, `session:getById` IPC handlers. Registered in `ipc/index.ts`.
- Task 6: Updated preload `index.ts` with `sessions` namespace exposing scan/getAll/getById. Updated `index.d.ts` with `SessionsApi` interface.
- Task 7: Created `src/shared/types/session.ts` with standalone `Session`, `SessionFilters`, `ScanResult`, `DetectedSession` interfaces. No cross-process import issues.
- Task 8: All 81 tests pass (33 new). Migration generates cleanly. TypeScript checks pass (excluding pre-existing parser Dirent issue). Fixed tsconfig.node.json to include shared types.

### Change Log

- 2026-03-04: Implemented Story 1.5 — Session Detection Engine. All 8 tasks complete, 81 tests passing (33 new for this story).

### File List

- src/main/db/schema/scan-state.ts (NEW)
- src/main/db/schema/sessions.ts (MODIFIED — added claudeSessionId, sourceFile, index)
- src/main/db/index.ts (MODIFIED — added scan-state schema)
- src/main/db/migrations/0001_absurd_wrecker.sql (AUTO-GENERATED)
- src/main/db/migrations/meta/_journal.json (AUTO-GENERATED)
- src/main/db/migrations/meta/0001_snapshot.json (AUTO-GENERATED)
- src/main/services/session-detector.ts (NEW)
- src/main/services/session-detector.test.ts (NEW)
- src/main/services/session-service.ts (NEW)
- src/main/services/session-service.test.ts (NEW)
- src/main/ipc/session-handlers.ts (NEW)
- src/main/ipc/index.ts (MODIFIED — registered session handlers)
- src/preload/index.ts (MODIFIED — added sessions namespace)
- src/preload/index.d.ts (MODIFIED — added SessionsApi interface)
- src/shared/types/session.ts (NEW)
- tsconfig.node.json (MODIFIED — added src/shared to include)
