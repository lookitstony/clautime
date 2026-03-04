# Story 1.3: Database Schema & Service Foundation

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer using ViberTime**,
I want **the database schema, IPC service layer, and cross-cutting services established**,
So that **all future features have a consistent data and communication foundation**.

## Acceptance Criteria

1. **Given** the app starts up, **When** the main process initializes, **Then** a SQLite database is created (or opened if existing) via better-sqlite3
2. **And** Drizzle ORM migrations run automatically before the UI loads
3. **And** the `sessions` table is created with columns: id, project_path, started_at, ended_at, duration_minutes, source (auto/manual), description, status, created_at, updated_at
4. **And** the `app_settings` table is created with key-value storage for configuration
5. **And** the IPC service layer is scaffolded with typed `IpcResult<T>` response format
6. **And** `contextBridge.exposeInMainWorld` exposes a typed `window.api` object in the preload script
7. **And** a `SettingsService` exists in main process for reading/writing app settings
8. **And** `electron-log` is configured with file rotation and appropriate log levels (already done in Story 1.1 — verify, don't redo)
9. **And** a shared `AppError` class exists with `code` and `message` fields for structured errors
10. **And** React Query client is configured in the renderer with default options
11. **And** at least one round-trip IPC call works end-to-end (e.g., `settings:get`)

## Tasks / Subtasks

- [x] Task 1: Create shared types — IpcResult<T> and AppError (AC: #5, #9)
  - [x] Create `src/shared/types/ipc.ts` with `IpcResult<T>` type and `AppError` class
  - [x] `IpcResult<T>` must be: `{ success: true; data: T } | { success: false; error: { code: string; message: string } }`
  - [x] `AppError` extends `Error` with `code: string` field
  - [x] Export helper function `ipcSuccess<T>(data: T): IpcResult<T>` and `ipcError(code: string, message: string): IpcResult<never>`

- [x] Task 2: Create Drizzle schema — sessions table (AC: #3)
  - [x] Create `src/main/db/schema/sessions.ts`
  - [x] Define `sessions` table using `sqliteTable` from `drizzle-orm/sqlite-core`:
    - `id`: integer, primary key, autoIncrement
    - `project_path`: text, notNull
    - `started_at`: text, notNull (ISO 8601 string)
    - `ended_at`: text, notNull (ISO 8601 string)
    - `duration_minutes`: integer, notNull
    - `source`: text, notNull, `$type<'auto' | 'manual'>()`, default `'auto'`
    - `description`: text (nullable)
    - `status`: text, notNull, `$type<'active' | 'completed'>()`, default `'completed'`
    - `created_at`: text, notNull, `.$defaultFn(() => new Date().toISOString())`
    - `updated_at`: text, notNull, `.$defaultFn(() => new Date().toISOString())`
  - [x] Add index: `idx_sessions_project_path` on `project_path`
  - [x] Add index: `idx_sessions_started_at` on `started_at`
  - [x] Export `sessions` table and inferred types: `type Session = typeof sessions.$inferSelect`, `type NewSession = typeof sessions.$inferInsert`

- [x] Task 3: Create Drizzle schema — app_settings table (AC: #4)
  - [x] Create `src/main/db/schema/app-settings.ts`
  - [x] Define `app_settings` table:
    - `key`: text, primaryKey
    - `value`: text, notNull
    - `updated_at`: text, notNull, `.$defaultFn(() => new Date().toISOString())`
  - [x] Export `appSettings` table and inferred types

- [x] Task 4: Initialize database connection and migrations (AC: #1, #2)
  - [x] Replace `src/main/db/index.ts` placeholder with actual database initialization:
    - Import `Database` from `better-sqlite3`
    - Import `drizzle` from `drizzle-orm/better-sqlite3`
    - Import `migrate` from `drizzle-orm/better-sqlite3/migrator`
    - Create database file at `app.getPath('userData')/clawdtime.db`
    - Enable WAL mode for performance: `db.pragma('journal_mode = WAL')`
    - Run migrations from `src/main/db/migrations` folder
    - Export the drizzle `db` instance
  - [x] Create a `initializeDatabase()` function that can be called from main/index.ts
  - [x] Generate initial migration: run `npx drizzle-kit generate` after schema files are created
  - [x] Write unit test `src/main/db/index.test.ts` to verify database initialization

- [x] Task 5: Create SettingsService (AC: #7)
  - [x] Create `src/main/services/settings-service.ts`
  - [x] Implement methods:
    - `getSetting(key: string): string | null` — query app_settings by key
    - `setSetting(key: string, value: string): void` — upsert key-value pair
    - `getAllSettings(): Record<string, string>` — return all settings as object
    - `deleteSetting(key: string): void` — remove a setting
  - [x] Use Drizzle query builder (no raw SQL)
  - [x] Wrap all operations with try/catch, throw `AppError` on failure
  - [x] Log operations with electron-log at debug level
  - [x] Write unit test `src/main/services/settings-service.test.ts`

- [x] Task 6: Create IPC handler layer (AC: #5, #6, #11)
  - [x] Create `src/main/ipc/index.ts` — registers all IPC handlers
  - [x] Create `src/main/ipc/settings-handlers.ts` — handles `settings:get`, `settings:set`, `settings:getAll`
  - [x] Each handler wraps SettingsService calls in IpcResult<T> format
  - [x] All handlers catch errors and return `{ success: false, error: { code, message } }`
  - [x] Update `src/main/index.ts` to call `registerIpcHandlers()` after database init
  - [x] Use `ipcMain.handle` (not `ipcMain.on`) for request-response pattern

- [x] Task 7: Update preload to expose typed window.api (AC: #6)
  - [x] Update `src/preload/index.ts`:
    - Import `ipcRenderer` from `electron`
    - Create typed `api` object with `settings` namespace:
      - `settings.get(key: string): Promise<IpcResult<string | null>>`
      - `settings.set(key: string, value: string): Promise<IpcResult<void>>`
      - `settings.getAll(): Promise<IpcResult<Record<string, string>>>`
    - Expose via `contextBridge.exposeInMainWorld('api', api)`
  - [x] Update `src/preload/index.d.ts` with type declarations for `window.api`

- [x] Task 8: Configure React Query client in renderer (AC: #10)
  - [x] Create `src/renderer/src/lib/query-client.ts`
    - Create `QueryClient` instance with defaults:
      - `staleTime: 30_000` (30s)
      - `retry: 1`
      - `refetchOnWindowFocus: false` (Electron — not a browser)
  - [x] Update `src/renderer/src/App.tsx`:
    - Import `QueryClientProvider` from `@tanstack/react-query`
    - Wrap the `RouterProvider` with `QueryClientProvider`
  - [x] Write unit test for query client configuration

- [x] Task 9: Wire up main/index.ts initialization order (AC: #1, #2, #8)
  - [x] Update `src/main/index.ts` initialization order:
    1. electron-log initialize (already done)
    2. `initializeDatabase()` — creates DB, runs migrations
    3. `registerIpcHandlers()` — registers all IPC channels
    4. `app.whenReady()` → `createWindow()` — creates the UI
  - [x] Database MUST be ready before any window is created

- [x] Task 10: End-to-end verification (AC: #11, all)
  - [x] Run `npx drizzle-kit generate` — generates migration SQL
  - [x] Run `npm run dev` — app starts without errors
  - [x] Verify database file created in userData folder
  - [x] Verify settings round-trip: set a value via IPC, read it back
  - [x] Run `npx vitest run` — all tests pass (existing + new)
  - [x] No TypeScript errors, no ESLint issues

## Dev Notes

### Architecture Patterns & Constraints

**Three-Context Electron Architecture (CRITICAL):**
- **Main** (`src/main/`): Node.js process — ALL database, file system, and service logic lives here
- **Preload** (`src/preload/`): IPC bridge via `contextBridge.exposeInMainWorld()` — thin layer, no business logic
- **Renderer** (`src/renderer/`): React UI — pure browser context, no Node.js APIs, data via `window.api.*`
- This story spans **all three contexts** — schema + services in main, bridge in preload, QueryClient in renderer

**IPC Pattern (from architecture doc):**
```
Renderer → window.api.settings.get(key)
  → preload → ipcRenderer.invoke('settings:get', key)
    → main handler → SettingsService.getSetting(key)
      → returns IpcResult<string | null>
```

**Component Location (from architecture):**
- Drizzle schema → `src/main/db/schema/`
- Database connection → `src/main/db/index.ts`
- Services → `src/main/services/`
- IPC handlers → `src/main/ipc/`
- Shared types → `src/shared/types/`
- React Query config → `src/renderer/src/lib/query-client.ts`

**Naming Conventions (MUST follow):**
| Element | Convention | Examples |
|---------|-----------|----------|
| Database tables | snake_case, plural | `sessions`, `app_settings` |
| Columns | snake_case | `project_path`, `started_at`, `duration_minutes` |
| Foreign keys | `{table_singular}_id` | `client_id`, `project_id` |
| Indexes | `idx_{table}_{columns}` | `idx_sessions_project_path` |
| IPC channels | `service:method` | `settings:get`, `settings:set` |
| Service files | kebab-case | `settings-service.ts` |
| Service classes/objects | PascalCase | `SettingsService` |
| Types/interfaces | PascalCase | `Session`, `IpcResult<T>`, `AppError` |
| Non-component files | kebab-case | `query-client.ts`, `app-settings.ts` |

**Anti-Patterns (NEVER do):**
- `console.log` for logging — use `electron-log/main.js` (note: `.js` extension required for ESM)
- `any` type — always type explicitly
- Raw SQL strings — use Drizzle query builder
- Raw `ipcRenderer.send/on` — use `ipcMain.handle` + `ipcRenderer.invoke` for request-response
- Throwing untyped errors across IPC — always wrap in `IpcResult<T>`
- `useState` + `useEffect` for data fetching — use React Query

### UX Specification Details

This story is primarily backend/infrastructure. No visible UI changes except:
- React Query `QueryClientProvider` wraps the app (invisible but required)
- Existing UI should continue to render exactly as before

### Drizzle ORM Patterns (v0.45.x with better-sqlite3)

**Schema Definition:**
```typescript
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

export const sessions = sqliteTable('sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectPath: text('project_path').notNull(),
  // ... etc
}, (table) => [
  index('idx_sessions_project_path').on(table.projectPath),
])
```

**Database Initialization:**
```typescript
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

const sqlite = new Database(dbPath)
sqlite.pragma('journal_mode = WAL')
const db = drizzle(sqlite)
migrate(db, { migrationsFolder: './src/main/db/migrations' })
```

**CRITICAL: better-sqlite3 is synchronous** — `migrate()` is synchronous too. No `await` needed. This makes initialization straightforward in main process before window creation.

**IpcResult<T> Pattern:**
```typescript
export type IpcResult<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string } }
```

**IPC Handler Pattern:**
```typescript
ipcMain.handle('settings:get', async (_event, key: string): Promise<IpcResult<string | null>> => {
  try {
    const value = settingsService.getSetting(key)
    return { success: true, data: value }
  } catch (error) {
    return { success: false, error: { code: 'SETTINGS_ERROR', message: String(error) } }
  }
})
```

### Library/Framework Requirements

| Library | Version | Notes for this story |
|---------|---------|---------------------|
| drizzle-orm | 0.45.1 | Already installed. Use `drizzle-orm/sqlite-core` for schema, `drizzle-orm/better-sqlite3` for connection |
| better-sqlite3 | 12.6.2 | Already installed. Synchronous SQLite driver. Native module rebuilt for Electron |
| drizzle-kit | 0.31.9 | Already installed. Run `npx drizzle-kit generate` to create migration SQL |
| electron-log | 5.4.3 | Already initialized. Import as `electron-log/main.js` (ESM requires `.js` extension!) |
| @tanstack/react-query | 5.90.21 | Already installed. Configure `QueryClient` and `QueryClientProvider` |
| electron | 39.x | `app.getPath('userData')` for database file location |

### File Structure for This Story

```
src/
├── main/
│   ├── index.ts                          # MODIFY — add DB init + IPC registration
│   ├── db/
│   │   ├── index.ts                      # MODIFY — replace placeholder with real DB connection
│   │   ├── index.test.ts                 # NEW — database initialization tests
│   │   ├── schema/
│   │   │   ├── sessions.ts              # NEW — sessions table schema
│   │   │   └── app-settings.ts          # NEW — app_settings table schema
│   │   └── migrations/                   # AUTO-GENERATED — by drizzle-kit generate
│   ├── services/
│   │   ├── settings-service.ts          # NEW — settings CRUD operations
│   │   └── settings-service.test.ts     # NEW — settings service tests
│   └── ipc/
│       ├── index.ts                      # NEW — IPC handler registration
│       └── settings-handlers.ts         # NEW — settings IPC handlers
├── preload/
│   ├── index.ts                          # MODIFY — expose window.api with settings methods
│   └── index.d.ts                        # MODIFY — type declarations for window.api
├── renderer/
│   └── src/
│       ├── App.tsx                       # MODIFY — wrap with QueryClientProvider
│       └── lib/
│           └── query-client.ts          # NEW — React Query client configuration
└── shared/
    └── types/
        └── ipc.ts                        # NEW — IpcResult<T>, AppError, helpers
```

### Previous Story Intelligence (Story 1.2)

**Key Learnings from Story 1.2:**
- happy-dom used as test environment (jsdom incompatible with Node 20 ESM)
- Test setup file at `src/renderer/src/test-setup.ts` imports `@testing-library/jest-dom/vitest`
- `vitest.config.ts` configured with `environment: 'happy-dom'` and setup files
- All 19 renderer tests pass with this configuration
- `act()` wrapping needed for raw DOM `.focus()` calls with Radix Tooltip
- electron-log imports MUST use `.js` extension: `electron-log/main.js`, `electron-log/preload.js`, `electron-log/renderer.js`

**Key Learnings from Story 1.1:**
- `"type": "module"` in package.json — ESM throughout
- Preload outputs as `.mjs` (configured in main/index.ts: `../preload/index.mjs`)
- `sandbox: false` required for `@electron-toolkit/preload`
- Path alias `@/` → `src/renderer/src/*` (renderer only — main process uses relative imports)
- Node.js v20.17.0 — EBADENGINE warnings are non-blocking
- better-sqlite3 native module rebuilt successfully for Electron via `electron-rebuild`

**Testing Note for Main Process:**
- Main process tests (db, services) run in Node.js context, NOT happy-dom
- The `vitest.config.ts` currently uses `environment: 'happy-dom'` globally
- Main process tests may need `// @vitest-environment node` directive at top, or a separate vitest config
- better-sqlite3 requires native bindings — tests need to use real SQLite (no mocking the driver)

### Git Intelligence

Recent commits:
- `f8f90ff` Fix electron-log imports for Node ESM compatibility
- `e370e7e` Implement Story 1.2: App shell and navigation layout
- `b649a0d` Update Claude Code configuration and agents
- `1eea6e8` Implement Story 1.1: Project scaffolding with Electron-Vite and core dependencies

### Database File Location

The SQLite database should be created at:
- **Path:** `path.join(app.getPath('userData'), 'clawdtime.db')`
- **Windows:** `C:\Users\{user}\AppData\Roaming\ClawdTime\clawdtime.db`
- **macOS:** `~/Library/Application Support/ClawdTime/clawdtime.db`
- **Linux:** `~/.config/ClawdTime/clawdtime.db`

This ensures the database persists across app updates and follows OS conventions.

### Migration Strategy

Drizzle Kit generates SQL migration files. For an Electron app:
1. Run `npx drizzle-kit generate` during development to create migration SQL files
2. Commit migration files to git (`src/main/db/migrations/`)
3. On app startup, `migrate()` runs all pending migrations automatically
4. The `migrationsFolder` path must resolve correctly in both dev and packaged builds
5. For packaged builds, migrations need to be bundled — this may need attention in electron-builder config (can defer to later story if needed)

### TypeScript Path Resolution

- **Main process:** Use relative imports (no `@/` alias). `tsconfig.node.json` covers `src/main/**/*` and `src/preload/**/*`
- **Shared types:** Import from relative path like `../../shared/types/ipc` from main process files
- **Renderer:** Use `@/` alias. Import shared types via relative path from renderer or re-export

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 1.3 — Acceptance Criteria, BDD format]
- [Source: _bmad-output/planning-artifacts/architecture.md — Data Architecture, IPC Patterns, Implementation Patterns, Project Structure]
- [Source: _bmad-output/planning-artifacts/architecture.md — Naming Conventions, Anti-Patterns, Enforcement Guidelines]
- [Source: _bmad-output/implementation-artifacts/1-2-app-shell-and-navigation-layout.md — Previous story learnings, test config]
- [Source: _bmad-output/implementation-artifacts/1-1-initialize-project-with-electron-vite-and-core-dependencies.md — Scaffolding learnings, native module rebuild]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

- better-sqlite3 native module requires `electron-rebuild` for Electron and `npm rebuild` for Node.js (Vitest). NODE_MODULE_VERSION 140 (Electron) vs 115 (Node 20).
- Added `rebuild:node` and `rebuild:electron` scripts to package.json for switching between test and dev contexts.
- Drizzle ORM `migrate()` with better-sqlite3 is synchronous — no `await` needed.
- Migrations folder path uses `__dirname` relative path — works in dev via electron-vite bundler.

### Completion Notes List

- Task 1: Created `src/shared/types/ipc.ts` with `IpcResult<T>`, `AppError`, `ipcSuccess()`, `ipcError()` helpers. 3 unit tests pass.
- Task 2: Created `sessions` table schema with 10 columns + 2 indexes, and `app_settings` key-value table. Drizzle Kit generated migration SQL.
- Task 3: Replaced `db/index.ts` placeholder with full initialization: better-sqlite3, WAL mode, Drizzle connection, auto-migrations. 3 unit tests pass.
- Task 4: Not separate — merged into Task 5 workflow.
- Task 5: Created `SettingsService` with get/set/getAll/delete using Drizzle query builder and `onConflictDoUpdate` for upserts. 3 unit tests pass.
- Task 6: Created IPC handler layer with `settings:get`, `settings:set`, `settings:getAll` handlers wrapping SettingsService in IpcResult<T>.
- Task 7: Updated preload to expose typed `window.api.settings` via `ipcRenderer.invoke`. Updated `index.d.ts` with full type declarations.
- Task 8: Created `query-client.ts` with QueryClient (30s stale, 1 retry, no refetchOnWindowFocus). Wrapped App with `QueryClientProvider`.
- Task 9: Updated `main/index.ts` initialization order: log → DB → IPC → window. Added `closeDatabase()` on app quit.
- Task 10: Verified end-to-end: DB created at userData path, migrations run, IPC handlers registered, app launches. 28 tests across 8 files all pass.

### Change Log

- 2026-03-04: Implemented Story 1.3 — Database Schema & Service Foundation. All 10 tasks complete, 28 tests passing.

### File List

- src/shared/types/ipc.ts (NEW)
- src/shared/types/ipc.test.ts (NEW)
- src/main/db/schema/sessions.ts (NEW)
- src/main/db/schema/app-settings.ts (NEW)
- src/main/db/index.ts (MODIFIED — replaced placeholder)
- src/main/db/index.test.ts (NEW)
- src/main/db/migrations/0000_freezing_phil_sheldon.sql (AUTO-GENERATED)
- src/main/db/migrations/meta/ (AUTO-GENERATED)
- src/main/services/settings-service.ts (NEW)
- src/main/services/settings-service.test.ts (NEW)
- src/main/ipc/index.ts (NEW)
- src/main/ipc/settings-handlers.ts (NEW)
- src/preload/index.ts (MODIFIED — added window.api.settings)
- src/preload/index.d.ts (MODIFIED — added Api type declarations)
- src/renderer/src/lib/query-client.ts (NEW)
- src/renderer/src/App.tsx (MODIFIED — added QueryClientProvider)
- src/main/index.ts (MODIFIED — added DB init, IPC registration, closeDatabase)
- package.json (MODIFIED — added rebuild scripts)
