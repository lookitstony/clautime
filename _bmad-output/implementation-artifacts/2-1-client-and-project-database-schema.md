# Story 2.1: Client & Project Database Schema

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer using ViberTime**,
I want **database tables for clients and projects with directory mappings**,
So that **session data can be associated with billable client/project records**.

## Acceptance Criteria

1. **Given** the app starts up, **When** Drizzle migrations run, **Then** a `clients` table is created with columns: id (integer PK autoIncrement), name (text notNull unique), color (text notNull from 8-color palette), is_active (integer notNull default 1), created_at (text notNull), updated_at (text notNull)
2. **And** a `projects` table is created with columns: id (integer PK autoIncrement), client_id (integer notNull FK→clients.id), name (text notNull), directory_path (text notNull unique), is_billable (integer notNull default 1), is_active (integer notNull default 1), created_at (text notNull), updated_at (text notNull)
3. **And** the `sessions` table gains a nullable `project_id` (integer FK→projects.id) and `client_id` (integer FK→clients.id) column
4. **And** a `ClientProjectService` exists in the main process with CRUD operations for clients and projects
5. **And** IPC handlers expose `client:getAll`, `client:create`, `client:update`, `client:delete`, `project:getAll`, `project:create`, `project:update`, `project:delete`
6. **And** directory-to-project mapping logic is implemented: given a session's directory path, find the matching project record (exact match or longest-prefix match)
7. **And** unit tests validate all CRUD operations and directory mapping logic
8. **And** shared TypeScript types are created for Client, Project, and related DTOs
9. **And** preload bridge exposes typed `window.api.clients.*` and `window.api.projects.*` methods
10. **And** React Query hooks are created for client and project data fetching/mutations

## Tasks / Subtasks

- [x] Task 1: Create shared types for clients and projects (AC: #8)
  - [x] Create `src/shared/types/client-project.ts` with interfaces:
    - `Client`: id, name, color, isActive, createdAt, updatedAt
    - `NewClient`: name, color (optional — auto-assign from palette)
    - `UpdateClient`: name?, color?, isActive?
    - `Project`: id, clientId, name, directoryPath, isBillable, isActive, createdAt, updatedAt
    - `NewProject`: clientId, name, directoryPath, isBillable (optional, default true)
    - `UpdateProject`: name?, directoryPath?, isBillable?, isActive?, clientId?
  - [x] Export `CLIENT_COLORS` constant array matching the 8 project colors from `format.ts` (`var(--project-1)` through `var(--project-8)`)

- [x] Task 2: Create Drizzle schema — clients table (AC: #1)
  - [x] Create `src/main/db/schema/clients.ts`
  - [x] Define `clients` table using `sqliteTable`:
    - `id`: integer, primaryKey, autoIncrement
    - `name`: text, notNull, unique
    - `color`: text, notNull (one of 8 CSS variable references)
    - `is_active`: integer, notNull, default 1 (SQLite boolean)
    - `created_at`: text, notNull, `.$defaultFn(() => new Date().toISOString())`
    - `updated_at`: text, notNull, `.$defaultFn(() => new Date().toISOString())`
  - [x] Add index: `idx_clients_name` on `name`
  - [x] Export `clients` table and inferred types

- [x] Task 3: Create Drizzle schema — projects table (AC: #2)
  - [x] Create `src/main/db/schema/projects.ts`
  - [x] Define `projects` table using `sqliteTable`:
    - `id`: integer, primaryKey, autoIncrement
    - `client_id`: integer, notNull (FK to clients.id — use `.references(() => clients.id)`)
    - `name`: text, notNull
    - `directory_path`: text, notNull, unique
    - `is_billable`: integer, notNull, default 1 (SQLite boolean)
    - `is_active`: integer, notNull, default 1
    - `created_at`: text, notNull, `.$defaultFn(() => new Date().toISOString())`
    - `updated_at`: text, notNull, `.$defaultFn(() => new Date().toISOString())`
  - [x] Add indexes: `idx_projects_client_id` on `client_id`, `idx_projects_directory_path` on `directory_path`
  - [x] Export `projects` table and inferred types

- [x] Task 4: Add FK columns to sessions table (AC: #3)
  - [x] Edit `src/main/db/schema/sessions.ts`:
    - Add `projectId`: integer('project_id') (nullable, FK→projects.id)
    - Add `clientId`: integer('client_id') (nullable, FK→clients.id)
    - Add index `idx_sessions_client_id` on `clientId`
    - Add index `idx_sessions_project_id` on `projectId`
  - [x] Update `Session` interface in `src/shared/types/session.ts` to include `projectId: number | null` and `clientId: number | null`
  - [x] Generate new Drizzle migration via `npx drizzle-kit generate`

- [x] Task 5: Register new schemas in database initialization (AC: #1, #2)
  - [x] Edit `src/main/db/index.ts`:
    - Import `* as clientsSchema from './schema/clients'`
    - Import `* as projectsSchema from './schema/projects'`
    - Add to schema spread: `{ ...sessionsSchema, ...appSettingsSchema, ...scanStateSchema, ...clientsSchema, ...projectsSchema }`

- [x] Task 6: Create ClientProjectService (AC: #4, #6)
  - [x] Create `src/main/services/client-project-service.ts`
  - [x] Implement client CRUD:
    - `getClients(): Client[]` — select all from clients, ordered by name
    - `getClientById(id: number): Client | null`
    - `createClient(data: NewClient): Client` — insert, auto-assign next available color if not provided
    - `updateClient(id: number, data: UpdateClient): Client` — update with `updatedAt = now`
    - `deleteClient(id: number): void` — delete client and cascade nullify sessions' clientId
  - [x] Implement project CRUD:
    - `getProjects(clientId?: number): Project[]` — select all or by clientId
    - `getProjectById(id: number): Project | null`
    - `createProject(data: NewProject): Project`
    - `updateProject(id: number, data: UpdateProject): Project`
    - `deleteProject(id: number): void` — cascade nullify sessions' projectId + clientId
  - [x] Implement directory mapping:
    - `findProjectByDirectory(directoryPath: string): Project | null` — normalize path, exact match on `directory_path`. Use case-insensitive comparison on Windows.
    - `attributeSessions(): number` — scan all sessions with null projectId, attempt to match by `projectPath` → `directory_path`, return count of newly attributed sessions
  - [x] Use Drizzle query builder (no raw SQL), follow existing service patterns (see `settings-service.ts`, `session-service.ts`)

- [x] Task 7: Create IPC handlers (AC: #5)
  - [x] Create `src/main/ipc/client-project-handlers.ts`
  - [x] Register handlers with `ipcMain.handle()`, following the `IpcResult<T>` pattern:
    - `client:getAll` → `clientProjectService.getClients()`
    - `client:create` → accepts `NewClient`, returns created `Client`
    - `client:update` → accepts `{ id, data: UpdateClient }`, returns updated `Client`
    - `client:delete` → accepts `id`, returns void
    - `project:getAll` → accepts optional `clientId` filter, returns `Project[]`
    - `project:create` → accepts `NewProject`, returns created `Project`
    - `project:update` → accepts `{ id, data: UpdateProject }`, returns updated `Project`
    - `project:delete` → accepts `id`, returns void
    - `project:attributeSessions` → calls `attributeSessions()`, returns count
  - [x] Register in `src/main/ipc/index.ts` alongside existing handlers

- [x] Task 8: Update preload bridge (AC: #9)
  - [x] Edit `src/preload/index.ts`:
    - Add `clients` namespace with: `getAll`, `create`, `update`, `delete`
    - Add `projects` namespace with: `getAll`, `create`, `update`, `delete`, `attributeSessions`
  - [x] Edit `src/preload/index.d.ts` with matching type declarations

- [x] Task 9: Create React Query hooks (AC: #10)
  - [x] Create `src/renderer/src/features/clients/use-clients.ts`:
    - `useClients()` — query `['clients']`, fetches `window.api.clients.getAll()`
    - `useCreateClient()` — mutation, invalidates `['clients']`
    - `useUpdateClient()` — mutation, invalidates `['clients']`
    - `useDeleteClient()` — mutation, invalidates `['clients']`
  - [x] Create `src/renderer/src/features/clients/use-projects.ts`:
    - `useProjects(clientId?)` — query `['projects', clientId]`, fetches `window.api.projects.getAll(clientId)`
    - `useCreateProject()` — mutation, invalidates `['projects']`
    - `useUpdateProject()` — mutation, invalidates `['projects']`
    - `useDeleteProject()` — mutation, invalidates `['projects']`
    - `useAttributeSessions()` — mutation, invalidates `['sessions', 'projects']`

- [x] Task 10: Write unit tests (AC: #7)
  - [x] Create `src/main/services/client-project-service.test.ts`:
    - Test CRUD for clients (create, read, update, delete)
    - Test CRUD for projects
    - Test unique constraint on client name
    - Test unique constraint on project directory_path
    - Test directory mapping: exact match, case-insensitive on Windows, no match returns null
    - Test attributeSessions: matches unassigned sessions, skips already-attributed
    - Test cascade behavior: deleting client nullifies session references
    - Test auto-color assignment for clients
  - [x] Create `src/renderer/src/features/clients/use-clients.test.ts`:
    - Test hooks return data, handle loading/error states
  - [x] Create `src/renderer/src/features/clients/use-projects.test.ts`:
    - Test hooks return data, handle loading/error states
  - [x] Follow mock patterns from existing tests (e.g., `session-service.test.ts`, `session-handlers.test.ts`)

## Dev Notes

### Architecture Patterns (from existing codebase)

- **DB Schema**: Use `sqliteTable` from `drizzle-orm/sqlite-core`. Booleans are integers (0/1) in SQLite. Timestamps are ISO 8601 text strings with `$defaultFn`. See `sessions.ts` for canonical example.
- **Services**: Exported as plain object literals (not classes), e.g. `export const clientProjectService = { ... }`. See `settings-service.ts` and `session-service.ts`.
- **IPC**: Each domain gets its own handler file in `src/main/ipc/`. Use `ipcSuccess()` and `ipcError()` from `src/shared/types/ipc.ts`. Handler registration function called from `src/main/ipc/index.ts`.
- **Preload**: `contextBridge.exposeInMainWorld('api', { ... })` in `src/preload/index.ts`. Type declarations in `src/preload/index.d.ts`.
- **React Query hooks**: Follow `use-sessions.ts` pattern. Use `useQuery` for reads, `useMutation` for writes with `queryClient.invalidateQueries()`.
- **electron-log**: Import as `import log from 'electron-log/main.js'` (`.js` extension required for ESM)
- **Path normalization**: Uppercase drive letter + backslashes on Windows. See `normalizePath()` in `session-detector.ts`.

### Project Structure Notes

- New schema files: `src/main/db/schema/clients.ts`, `src/main/db/schema/projects.ts`
- New service: `src/main/services/client-project-service.ts`
- New IPC handlers: `src/main/ipc/client-project-handlers.ts`
- New hooks directory: `src/renderer/src/features/clients/`
- Modified: `src/main/db/schema/sessions.ts`, `src/main/db/index.ts`, `src/main/ipc/index.ts`, `src/preload/index.ts`, `src/preload/index.d.ts`, `src/shared/types/session.ts`

### Migration Strategy

- Adding nullable FK columns (`project_id`, `client_id`) to the existing `sessions` table is non-breaking — existing rows get NULL values
- Generate migration AFTER all schema changes are made: `npx drizzle-kit generate`
- Drizzle auto-runs migrations on app startup via `migrate()` in `src/main/db/index.ts`

### Testing Notes

- Main process tests use `// @vitest-environment node` directive
- Mock `electron-log/main.js` with: `vi.mock('electron-log/main.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))`
- In-memory SQLite for service tests (see existing test patterns)
- Renderer hooks tests use `happy-dom` environment and mock `window.api`

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic 2, Story 2.1]
- [Source: _bmad-output/planning-artifacts/architecture.md#Data Layer, IPC Service Layer]
- [Source: src/main/db/schema/sessions.ts — existing schema pattern]
- [Source: src/main/services/settings-service.ts — service pattern]
- [Source: src/main/ipc/session-handlers.ts — IPC handler pattern]
- [Source: src/preload/index.ts — preload bridge pattern]
- [Source: src/renderer/src/features/sessions/use-sessions.ts — React Query hook pattern]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

- Fixed pre-existing test failure in session-service.test.ts: test expected 10-minute default idle timeout but it was changed to 15 minutes in Story 1.7 work

### Completion Notes List

- Created shared types (Client, NewClient, UpdateClient, Project, NewProject, UpdateProject, CLIENT_COLORS) in `src/shared/types/client-project.ts`
- Created `clients` Drizzle schema with id, name (unique), color, is_active, timestamps, and name index
- Created `projects` Drizzle schema with id, client_id (FK), name, directory_path (unique), is_billable, is_active, timestamps, client_id and directory_path indexes
- Added nullable `project_id` and `client_id` FK columns to sessions table with indexes
- Updated shared Session type with projectId/clientId fields
- Generated Drizzle migration `0002_fat_morph.sql` for new tables and session columns
- Registered new schemas in `src/main/db/index.ts`
- Implemented `ClientProjectService` with full CRUD for clients and projects, auto-color assignment, path normalization, directory mapping (`findProjectByDirectory`), and session attribution (`attributeSessions`)
- Created IPC handlers for all client/project operations plus `project:attributeSessions`
- Updated preload bridge with `clients` and `projects` namespaces and type declarations
- Created React Query hooks: `useClients`, `useCreateClient`, `useUpdateClient`, `useDeleteClient`, `useProjects`, `useCreateProject`, `useUpdateProject`, `useDeleteProject`, `useAttributeSessions`
- Wrote 32 service tests covering all CRUD, unique constraints, directory mapping, session attribution, and cascade behavior
- Wrote 5 client hook tests and 7 project hook tests covering data fetching and mutations
- Fixed pre-existing test: updated idle timeout test from 10→15 minutes to match actual default
- All 188 tests pass with 0 regressions

### Change Log

- 2026-03-04: Implemented Story 2.1 — Client & Project database schema, service, IPC, preload, hooks, and tests

### File List

New files:
- src/shared/types/client-project.ts
- src/main/db/schema/clients.ts
- src/main/db/schema/projects.ts
- src/main/db/migrations/0002_fat_morph.sql
- src/main/db/migrations/meta/0002_snapshot.json
- src/main/services/client-project-service.ts
- src/main/services/client-project-service.test.ts
- src/main/ipc/client-project-handlers.ts
- src/renderer/src/features/clients/use-clients.ts
- src/renderer/src/features/clients/use-clients.test.ts
- src/renderer/src/features/clients/use-projects.ts
- src/renderer/src/features/clients/use-projects.test.ts

Modified files:
- src/main/db/schema/sessions.ts (added projectId, clientId FK columns + indexes)
- src/main/db/index.ts (registered clients/projects schemas)
- src/main/ipc/index.ts (registered client-project handlers)
- src/shared/types/session.ts (added projectId, clientId to Session interface)
- src/preload/index.ts (added clients/projects API namespaces)
- src/preload/index.d.ts (added ClientsApi, ProjectsApi interfaces)
- src/main/services/session-service.test.ts (fixed idle timeout test: 10→15 minutes)
- _bmad-output/implementation-artifacts/sprint-status.yaml (epic-2: in-progress, story: review)
