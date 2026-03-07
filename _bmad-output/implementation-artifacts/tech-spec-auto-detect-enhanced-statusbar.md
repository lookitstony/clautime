---
title: 'Auto-Detect Projects & Enhanced Status Bar'
slug: 'auto-detect-enhanced-statusbar'
created: '2026-03-07'
status: 'completed'
stepsCompleted: [1, 2, 3, 4]
tech_stack: ['Electron 39', 'React 19', 'TypeScript', 'Drizzle ORM', 'better-sqlite3', 'TanStack Query v5', 'Tailwind CSS v4', 'Zustand 5']
files_to_modify:
  - 'src/main/services/client-project-service.ts'
  - 'src/main/services/file-watcher-service.ts'
  - 'src/renderer/src/components/shared/StatusBar.tsx'
code_patterns:
  - 'IPC: ipcMain.handle + ipcRenderer.invoke with IpcResult<T>'
  - 'DB: Drizzle ORM insert/select/update with transactions'
  - 'Renderer hooks: TanStack Query for async data, Zustand for UI state'
  - 'Path encoding: encodeProjectPath/decodeProjectPath for .claude/projects/ dir names'
  - 'normalizePath for case-insensitive Windows path comparison'
test_patterns:
  - 'Vitest with happy-dom for renderer tests'
  - 'Vitest with node environment for main process tests'
  - 'In-memory SQLite for service tests (better-sqlite3 :memory:)'
---

# Tech-Spec: Auto-Detect Projects & Enhanced Status Bar

**Created:** 2026-03-07

## Overview

### Problem Statement

Active Claude projects don't appear on the Live screen until a user manually creates a project entry and assigns it to a client. This creates friction -- users must configure projects before they can monitor them. Additionally, the bottom status bar only shows "N sessions today" on the left side, ignoring the today/total toggle on the right, and doesn't display other useful stats like prompts, tokens, and commits.

### Solution

1. **Auto-detect projects**: Create a reserved "Unassigned" client on first run. During session scan or live monitor activity detection, auto-create project entries under "Unassigned" for any detected `~/.claude/projects/` directories not yet registered in the DB. These projects immediately appear on the Live screen since `getProjectLiveStatuses()` already queries all projects.

2. **Enhanced status bar**: The left side of the status bar shows stats (sessions, prompts, tokens, commits) that toggle between today and all-time in sync with the time display toggle on the right side.

### Scope

**In Scope:**
- Auto-create "Unassigned" client (seeded on app startup if not present)
- Auto-create projects under "Unassigned" when JSONL activity is detected for unregistered paths
- Status bar: show sessions, prompts, tokens, commits -- toggling between today and all-time synced with the time toggle
- Use existing `TodayStats` for today data and `useSessionStats` for all-time data

**Out of Scope:**
- Changing `projects.clientId` to nullable (not needed -- Unassigned client approach)
- Auto-detecting project/client names from git config or package.json (uses `getProjectName()` from path)
- Modifying the Projects/Clients management UI pages
- Preventing deletion of the "Unassigned" client (can be a future hardening)

## Context for Development

### Codebase Patterns

- **Auto-create client pattern**: `clientProjectService.createClient()` auto-assigns the next unused color from `CLIENT_COLORS`. For the "Unassigned" client, we should use a neutral gray color.
- **Project creation**: `clientProjectService.createProject()` requires `clientId`, `name`, `directoryPath`. It normalizes the path and checks client exists.
- **Session attribution**: After scan, `clientProjectService.attributeSessions()` matches unattributed sessions (null `projectId`) to projects by `directoryPath`. Auto-created projects will immediately be attributed.
- **File watcher flow**: `_handleNewProject()` in `file-watcher-service.ts` already detects new `.claude/projects/` directories and notifies the renderer. This is the ideal place to auto-create the DB project entry.
- **Live monitor**: `getProjectLiveStatuses()` queries all projects via `leftJoin(clients)`, matches JSONL timestamps by `encodeProjectPath()`. Auto-created projects will appear automatically.
- **Status bar**: Currently uses `useTodayStats()` for left side (sessions count) and `useSessionStats()` for right side (all-time hours). The `showAllTime` toggle state controls the right side only.
- **TodayStats**: Already has `totalSessions`, `totalPrompts`, `totalTokens`, `totalCommits` -- all today's data.
- **SessionStats**: Has `totalSessions`, `totalPrompts`, `totalTokens`, `commitSessions` (count of sessions with commits, not total commits), `humanHours`, `totalHours`.

### Files to Reference

| File | Purpose |
| ---- | ------- |
| `src/main/services/client-project-service.ts` | Client/Project CRUD, `createClient()`, `createProject()`, `attributeSessions()`, `findProjectByDirectory()` |
| `src/main/services/file-watcher-service.ts` | Watches `~/.claude/projects/`, `_handleNewProject()` detects new dirs, `_runIncrementalScan()` triggers scan + attribute |
| `src/main/db/schema/clients.ts` | `clients` table: id, name, color, billableRate, isActive |
| `src/main/db/schema/projects.ts` | `projects` table: id, clientId (NOT NULL FK), name, directoryPath (unique), isBillable, isActive |
| `src/shared/types/client-project.ts` | `Client`, `Project`, `NewProject`, `NewClient` interfaces |
| `src/shared/types/live.ts` | `TodayStats` interface (totalSessions, totalPrompts, totalTokens, totalCommits) |
| `src/shared/paths.ts` | `getProjectName()` -- extracts last path segment as project name |
| `src/renderer/src/components/shared/StatusBar.tsx` | Bottom status bar: left=sessions text, right=time toggle |
| `src/renderer/src/features/sessions/use-sessions.ts` | `useSessionStats()` -- all-time stats: totalSessions, totalPrompts, totalTokens, commitSessions |
| `src/renderer/src/features/live/use-live.ts` | `useTodayStats()` hook -- fetches TodayStats from main process |
| `src/main/services/session-detector.ts` | `encodeProjectPath()`, `decodeProjectPath()` -- .claude dir name encoding |

### Technical Decisions

- **"Unassigned" client approach**: Create a reserved client named "Unassigned" with a neutral gray color instead of making `clientId` nullable. This avoids a schema migration, null checks, and type changes across the codebase. The client is auto-seeded on app startup.
- **Auto-create in file-watcher**: `_handleNewProject()` already detects new project dirs. Extend it to auto-create the project entry under "Unassigned" instead of just notifying the renderer. Also seed existing unregistered projects on startup scan.
- **`getOrCreateUnassignedClient()`**: Add a helper to `clientProjectService` that returns the "Unassigned" client, creating it if needed. Uses Drizzle select-or-insert pattern for idempotency.
- **`autoCreateProject()`**: Add a helper to `clientProjectService` that creates a project under "Unassigned" for a given directory path, skipping if already exists (unique constraint on `directoryPath`).
- **Status bar toggle sync**: The `showAllTime` state already exists in `StatusBar.tsx`. Extend it to control the left side stats too. Today mode uses `TodayStats`, all-time mode uses `SessionStats`.
- **All-time commits**: `SessionStats.commitSessions` counts sessions with commits (not total commits). Show `commitSessions` labeled as "commits" in all-time mode -- close enough.
- **Format tokens**: Display tokens in compact format (e.g., "1.2M", "45K") using a simple formatter.

## Implementation Plan

### Tasks

- [x] Task 1: Add `getOrCreateUnassignedClient()` to client-project-service
  - File: `src/main/services/client-project-service.ts`
  - Action: Add a new method `getOrCreateUnassignedClient(): Client` that:
    1. Queries `clients` table for a client named `"Unassigned"`
    2. If found, returns it
    3. If not found, inserts a new client with `name: "Unassigned"`, `color: "#6b7280"` (Tailwind gray-500), `isActive: true`
    4. Returns the created/found client
  - Notes: Uses direct DB operations (not `createClient()`) to avoid color auto-assignment. The UNIQUE constraint on `clients.name` ensures idempotency even under concurrent calls.

- [x] Task 2: Add `autoCreateProject()` to client-project-service
  - File: `src/main/services/client-project-service.ts`
  - Action: Add a new method `autoCreateProject(directoryPath: string): Project | null` that:
    1. Calls `findProjectByDirectory(directoryPath)` -- if exists, return null (already registered)
    2. Calls `getOrCreateUnassignedClient()` to get the Unassigned client ID
    3. Derives project name from `getProjectName(directoryPath)` (import from `../../shared/paths`)
    4. Inserts into `projects` table with `clientId`, `name`, `directoryPath` (normalized), `isBillable: false`
    5. Returns the created project
  - Notes: `isBillable: false` since unassigned projects shouldn't default to billable. Wraps insert in try/catch for UNIQUE constraint race conditions (return null on conflict).

- [x] Task 3: Auto-create projects on startup scan
  - File: `src/main/services/file-watcher-service.ts`
  - Action: In `_runStartupScan()`, after `sessionService.scanSessions()` and before `clientProjectService.attributeSessions()`:
    1. Read all directories from `~/.claude/projects/` (same readdir as in `start()`)
    2. For each directory, call `decodeProjectPath(dirName)` to get the filesystem path
    3. Call `clientProjectService.autoCreateProject(decodedPath)` for each
    4. Log count of newly created projects
  - Notes: This catches all existing Claude project directories that haven't been manually registered yet. Must import `autoCreateProject` and `getProjectName`.

- [x] Task 4: Auto-create project on new directory detection
  - File: `src/main/services/file-watcher-service.ts`
  - Action: In `_handleNewProject(dirName)`, replace the current "notify only" behavior:
    1. Call `clientProjectService.autoCreateProject(decodedPath)`
    2. If a project was created (non-null return), log it
    3. Keep the existing `_sendToRenderer('watcher:newProject', ...)` notification (renderer may want to show a toast)
  - Notes: The existing `_runIncrementalScan` already calls `attributeSessions()` after scan, which will link new sessions to the newly created project.

- [x] Task 5: Enhanced status bar -- sync stats with time toggle
  - File: `src/renderer/src/components/shared/StatusBar.tsx`
  - Action: Modify the StatusBar component:
    1. The existing `showAllTime` state toggle already controls the right side time display. Extend it to also control the left side stats.
    2. **Today mode** (default): Show `"{sessions} sessions | {prompts} prompts | {tokens} tokens | {commits} commits"` using `todayStats` data.
    3. **All-time mode**: Show `"{sessions} sessions | {prompts} prompts | {tokens} tokens | {commitSessions} commits"` using `allStats` data.
    4. Add a `formatTokens(n: number): string` helper inline (e.g., `>=1M` -> `"1.2M"`, `>=1K` -> `"45K"`, else raw number).
    5. Move the click handler to wrap the entire footer (both left and right toggle together), so clicking anywhere on the bar toggles between today and all-time.
    6. Update the right side to show `"today"` or `"all time"` label after the hours value (already done, just ensure sync).
  - Notes: Use `text-[var(--text-muted)]` for stat labels, `tabular-nums` for numbers. Separate stats with `" | "` or a middle dot. Keep the offline indicator.

### Acceptance Criteria

- [x] AC1: Given a fresh install with no clients/projects in the DB, when the app starts and `~/.claude/projects/` has directories, then an "Unassigned" client is created and projects are auto-created for each directory.
- [x] AC2: Given the app is running, when a new directory appears in `~/.claude/projects/` (new Claude session in a new project), then a project entry is automatically created under "Unassigned" and appears on the Live page.
- [x] AC3: Given a project already exists in the DB (manually created under a client), when the startup scan runs, then no duplicate project is created for that directory path.
- [x] AC4: Given the "Unassigned" client already exists, when `getOrCreateUnassignedClient()` is called, then it returns the existing client without creating a duplicate.
- [x] AC5: Given the status bar is in "today" mode, when the user views the bottom bar, then they see today's sessions, prompts, tokens, and commits counts alongside today's time.
- [x] AC6: Given the status bar is in "all time" mode, when the user views the bottom bar, then they see all-time sessions, prompts, tokens, and commit-sessions counts alongside all-time hours.
- [x] AC7: Given the status bar, when the user clicks on it, then both the left stats and right time toggle between today and all-time mode together.
- [x] AC8: Given a large token count (e.g., 1,234,567), when displayed in the status bar, then it shows as a compact format (e.g., "1.2M").

## Additional Context

### Dependencies

- No new npm packages needed
- No database migration needed (no schema changes -- just inserting rows)
- `getProjectName()` from `src/shared/paths.ts` is already available in both main and renderer
- `decodeProjectPath()` from `src/main/services/session-detector.ts` already imported in file-watcher-service

### Testing Strategy

**Unit Tests (client-project-service):**
- Test `getOrCreateUnassignedClient()` creates client on first call, returns existing on second call
- Test `autoCreateProject()` creates project with correct fields (name from path, clientId from Unassigned, isBillable=false)
- Test `autoCreateProject()` returns null when project already exists for that path
- Test `autoCreateProject()` handles concurrent calls gracefully (no UNIQUE constraint errors)

**Renderer Tests (StatusBar):**
- Test status bar shows today stats when `showAllTime` is false
- Test status bar shows all-time stats when `showAllTime` is true
- Test clicking the bar toggles between today and all-time
- Test `formatTokens()` formats numbers correctly (raw, K, M)

**Manual Testing:**
1. Delete all clients/projects from DB, restart app -- verify "Unassigned" client and projects auto-created
2. Start a new Claude session in a fresh project directory -- verify it appears on Live page within seconds
3. Click status bar -- verify stats and time toggle together between today and all-time
4. Verify token counts display in compact format

### Notes

- The `clients.name` column has a UNIQUE constraint -- must handle the case where "Unassigned" already exists gracefully
- `projects.directoryPath` also has a UNIQUE constraint -- auto-create must check existence first
- The file-watcher's `_handleNewProject()` currently only notifies the renderer. After this change it will also insert into DB, then notify.
- On startup scan, we should auto-create projects for ALL unregistered dirs found in `~/.claude/projects/`, not just new ones detected at runtime.
- `deleteClient()` cascades: deletes all projects under the client. If user deletes "Unassigned", auto-detected projects will be re-created on next scan. This is acceptable behavior.
- The "Unassigned" client uses gray color `#6b7280` to visually distinguish it from user-created clients.

## Review Notes
- Adversarial review completed
- Findings: 10 total, 5 fixed, 3 skipped (pre-existing/noise), 2 acknowledged (semantic mismatch accepted per spec)
- Resolution approach: auto-fix
- Fixed: F1 (all-time commits always 0), F5 (UNIQUE race in getOrCreateUnassignedClient), F6 (keyboard a11y), F7 (log swallowed UNIQUE), F9 (formatTokens boundary)
- Skipped: F3 (pre-existing decodeProjectPath bug), F4 (pre-existing perf — full session fetch), F8 (pre-existing normalizePath trailing slash)
- Acknowledged: F2 (commitSessions vs totalCommits semantic difference — accepted per spec "close enough")
