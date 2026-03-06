---
title: 'Live Dashboard with System Tray & Prompt Alerts'
slug: 'live-dashboard-tray-alerts'
created: '2026-03-05'
status: 'completed'
stepsCompleted: [1, 2, 3, 4]
tech_stack: [electron-39, react-19, typescript, better-sqlite3, drizzle-0.45, tanstack-query-v5, zustand-5, tailwind-v4, electron-log-5, vitest-4]
files_to_modify:
  - src/main/index.ts
  - src/main/ipc/index.ts
  - src/main/ipc/live-handlers.ts (new)
  - src/main/services/session-service.ts
  - src/main/services/live-monitor-service.ts (new)
  - src/main/services/tray-service.ts (new)
  - src/main/db/schema/project-alert-config.ts (new)
  - src/main/db/index.ts
  - src/preload/index.ts
  - src/preload/index.d.ts
  - src/renderer/src/App.tsx
  - src/renderer/src/features/live/LivePage.tsx (new)
  - src/renderer/src/features/live/LiveStatsBar.tsx (new)
  - src/renderer/src/features/live/ProjectWatchList.tsx (new)
  - src/renderer/src/features/live/ManualTimerDialog.tsx (new)
  - src/renderer/src/features/live/use-live.ts (new)
  - src/renderer/src/stores/use-live-store.ts (new)
  - src/shared/types/live.ts (new)
code_patterns:
  - 'IPC: ipcMain.handle + ipcRenderer.invoke with IpcResult<T> wrapper'
  - 'Services: singleton objects, use getDb(), throw AppError on failures'
  - 'Preload: contextBridge.exposeInMainWorld, typed in index.d.ts'
  - 'Pages: TanStack Query hooks for data, Zustand for UI state'
  - 'Stats: StatCard components in responsive grid with CSS vars'
  - 'DB: Drizzle ORM with sequential migrations (0000-0007), schema registered in src/main/db/index.ts'
  - 'Bidirectional IPC: ipcRenderer.on for main->renderer events (updater pattern)'
  - 'Build: asarUnpack for resources/**, NOT extraResources'
test_patterns:
  - 'Vitest with happy-dom for renderer, node env for main process'
  - 'Tests colocated with source files (*.test.ts alongside *.ts)'
---

# Tech-Spec: Live Dashboard with System Tray & Prompt Alerts

**Created:** 2026-03-05

## Overview

### Problem Statement

Developers actively working across multiple AI projects have no real-time awareness of their session activity or prompt response cadence. The current app is retrospective -- you scan and review after the fact. There's no way to stay on top of active work or get nudged when you're letting a prompt sit too long. Additionally, non-AI manual work (QA testing, documentation, meetings) has no quick way to be tracked inline -- you have to go to the Sessions page and create a manual block after the fact.

### Solution

Build the Live screen as a today-only dashboard with aggregated stats (human hours, agent hours, sessions, prompts, tokens) and a flat project list with watch toggles. A background polling loop (30-60s) reads today's session files to detect the latest prompt timestamps. Watched projects trigger desktop notifications (with configurable per-project sounds) when 75% of the idle timeout elapses without a human response. The app gains a system tray icon -- closing the window minimizes to tray, keeping the monitor alive. Right-click tray to fully quit. Each project card also has a Start/Stop manual timer for tracking non-AI work with enforced description logging.

### Scope

**In Scope:**

- Live page replacing the current empty state at `/`
- Today-only aggregated stat cards (human hours, agent hours, sessions, prompts, tokens)
- Flat project list with eye-toggle to watch/unwatch projects
- Background polling loop (main process) scanning today's session files only
- Desktop notifications at 75% idle timeout for watched projects
- Per-project alert sound selection with bundled defaults + custom MP3/WAV path option
- "Silent" notification option (visual notification, no sound)
- Sound preferences persist per-project in DB across sessions
- Watch state persists per-project in DB (via `alertEnabled` column in `project_alert_config`)
- System tray icon with context menu (Show / Quit)
- Minimize-to-tray on window close (keep polling alive)
- Manual timer Start/Stop on project cards with description enforcement
- Only one manual timer can run at a time (sequential manual work)

**Out of Scope:**

- Session drill-down from Live screen (that's the Sessions page)
- Historical data on Live screen (today only)
- Tray icon badge/counter
- Custom per-project alert thresholds (uses global idle timeout setting)
- Mobile/push notifications
- Multiple concurrent manual timers

## Context for Development

### Codebase Patterns

**IPC Pattern:**
- All IPC uses `ipcMain.handle` + `ipcRenderer.invoke` with `IpcResult<T>` wrapper
- Success: `ipcSuccess(data)`, Error: `ipcError(code, message)`
- Bidirectional events use `ipcRenderer.on` for main->renderer push (see updater pattern)
- Handlers registered in `src/main/ipc/index.ts` via `registerIpcHandlers()`
- IMPORTANT: `ipcRenderer.on` listeners must be cleaned up on component unmount to prevent listener stacking. Use a `removeListener` cleanup pattern.

**Service Pattern:**
- Singleton service objects in `src/main/services/`
- Use `getDb()` for database access, throw `AppError` for known errors
- Service calls are thin; IPC handlers catch and wrap errors

**Renderer Pattern:**
- TanStack Query v5 hooks for server state, Zustand for UI state
- Pages use flex column layout with StatsBar at top, scrollable content below
- StatCard is a local (unexported) function component in `StatsBar.tsx` -- must create own StatCard in LiveStatsBar or extract to shared
- CSS variables for theming: `var(--background-elevated)`, `var(--accent)`, `var(--text-muted)`, etc.
- Loading states use Skeleton components matching real card dimensions

**Database Pattern:**
- Drizzle ORM with better-sqlite3, migrations auto-run on startup
- Sequential migration files (0000-0007), next would be 0008
- Schema is NOT registered via a barrel `schema/index.ts` -- instead each schema is imported individually in `src/main/db/index.ts` as `import * as fooSchema from './schema/foo'` and spread into a `schema` object
- Migration filenames are auto-generated by `npx drizzle-kit generate` with random slugs (e.g., `0007_mysterious_caretaker.sql`) -- do NOT hardcode migration filenames
- Settings stored as key-value pairs in `app_settings` table
- Projects table has `id`, `clientId`, `name`, `directoryPath`, `isBillable`, `isActive`

**Session File Format:**
- JSONL files in `~/.claude/projects/{encoded-project-name}/{uuid}.jsonl`
- Files named by UUID, NOT by date -- cannot filter by filename
- Must use `fs.stat().mtime` to identify files modified today
- Each line is a JSON object with `type`, `timestamp`, `sessionId`, `message`, etc.
- Parser filters to `user`/`assistant`/`system` messages only
- `ParsedMessage.isToolResult` distinguishes human prompts from tool results

**Scan Architecture:**
- `discoverSessionFiles()` finds all `.jsonl` in projects directory
- `filterChangedFiles()` compares mtime against `scan_state` table
- `parseSessionFile()` reads JSONL, extracts messages with timestamps
- `detectSessions()` splits by idle gaps, counts prompts/tokens per segment
- Existing scan is incremental -- only re-parses files modified since last scan

**Existing Manual Session Creation:**
- `session:create` IPC handler already exists for creating manual sessions
- Takes `projectPath`, `startedAt`, `endedAt`, `durationMinutes`, `description`, `projectId`, `clientId`
- IMPORTANT: `projectPath` is required -- must be looked up from the project's `directoryPath` column when creating manual sessions from the Live page
- Sets `source: 'manual'` automatically

**Build & Packaging:**
- `electron-builder.yml` uses `asarUnpack: resources/**` -- files remain accessible via `__dirname`-relative paths in both dev and prod
- Do NOT use `extraResources` -- that's a different mechanism. The existing `asarUnpack` pattern means resources are at `path.join(__dirname, '../../resources/')` consistently
- No changes needed to `electron-builder.yml` since `resources/**` is already unpacked

**Human Hours Algorithm (must be consistent with Sessions page):**
- Located in `src/renderer/src/features/sessions/use-sessions.ts` as `computeHumanMinutes()`
- Merges overlapping time intervals: sort by start, extend current interval if overlap, flush on gap
- Returns wall-clock minutes (parallel sessions counted once)
- This algorithm must be duplicated in the main process `live-monitor-service.ts` for `getTodayStats()` to maintain consistency

### Files to Reference

| File | Purpose |
| ---- | ------- |
| `src/main/index.ts` | App lifecycle, window creation, init chain |
| `src/main/ipc/index.ts` | IPC handler registration hub |
| `src/main/ipc/session-handlers.ts` | Session scan/CRUD IPC handlers, `session:create` reference |
| `src/main/services/session-service.ts` | Session scan orchestration, DB operations |
| `src/main/services/session-detector.ts` | Idle-gap session detection algorithm |
| `src/main/services/settings-service.ts` | Key-value settings CRUD |
| `src/main/services/updater-service.ts` | Bidirectional IPC event pattern reference |
| `src/main/parsers/session-parser.ts` | JSONL file parser, message extraction |
| `src/main/parsers/types.ts` | ParsedSessionData, ParsedMessage types |
| `src/main/db/schema/sessions.ts` | Sessions table schema |
| `src/main/db/schema/projects.ts` | Projects table schema (directoryPath) |
| `src/main/db/schema/app-settings.ts` | Key-value settings table |
| `src/main/db/index.ts` | DB initialization, schema registration, getDb(), closeDatabase() |
| `src/preload/index.ts` | API bridge to renderer |
| `src/preload/index.d.ts` | Window.api type declarations |
| `src/shared/types/ipc.ts` | IpcResult, ipcSuccess, ipcError, AppError |
| `src/shared/paths.ts` | Claude dir discovery, path encoding/decoding |
| `src/renderer/src/App.tsx` | Router config, root layout |
| `src/renderer/src/features/sessions/StatsBar.tsx` | Stat card visual pattern (StatCard is NOT exported) |
| `src/renderer/src/features/sessions/use-sessions.ts` | TanStack Query hooks pattern + `computeHumanMinutes()` algorithm |
| `src/renderer/src/features/sessions/ManualBlockForm.tsx` | Existing manual time entry form |
| `src/renderer/src/stores/use-ui-store.ts` | Zustand store pattern |
| `src/renderer/src/stores/use-filter-store.ts` | Filter store with toSessionFilters() |
| `src/renderer/src/components/shared/StatusBar.tsx` | Network indicator pattern |
| `src/renderer/src/components/shared/ActivityBar.tsx` | Nav items, Live route at `/` |
| `src/renderer/src/lib/format.ts` | formatDuration, formatCompactNumber, etc. |
| `electron-builder.yml` | Build config -- asarUnpack: resources/** |

### Technical Decisions

**Polling approach:** Reuse existing `sessionService.scanSessions()` with a today-only filter. The scan is already incremental (skips unchanged files via `scan_state`), so polling every 30-60s is cheap. Add a lightweight `getLatestPromptTimestamps()` method that reads the last few messages from today's active files to detect "waiting for human response" state.

**Alert sound storage:** Add a `project_alert_config` table (migration 0008) with columns: `projectId` (FK, unique), `alertSound` (text, default 'default'), `isWatching` (integer/boolean, default false). The `alertSound` value is either a bundled sound name (e.g., 'chime', 'bell', 'ping'), 'silent' (notification only, no sound), or an absolute path to a custom audio file. Watch state is persisted here too so it survives restarts.

**Tray implementation:** Use Electron's `Tray` class in a new `tray-service.ts`. Initialize after window creation. On window close, hide instead of destroy. Tray context menu: Show Window / Quit. On tray icon click (Windows/Linux): toggle window visibility.

**Close-to-tray lifecycle (CRITICAL):**
```
// In src/main/index.ts:
let isQuitting = false
let mainWindow: BrowserWindow | null = null

app.on('before-quit', () => { isQuitting = true })

// In createWindow():
mainWindow.on('close', (e) => {
  if (!isQuitting) {
    e.preventDefault()
    mainWindow.hide()
  }
  // If isQuitting is true, do NOT preventDefault -- let the window close normally
})

// Tray "Quit" action:
app.quit()  // This triggers 'before-quit' first, setting isQuitting = true
```
Without this exact flow, the app becomes unkillable.

**Audio playback:** Bundle `.wav` files (not `.mp3`) for default sounds. Windows `SoundPlayer` only supports `.wav`. For cross-platform:
- **Windows:** `powershell -c "(New-Object Media.SoundPlayer 'path.wav').PlaySync()"` -- note: only `.wav` supported. For custom `.mp3` files, use `powershell -c "Add-Type -AssemblyName PresentationCore; $p = [System.Windows.Media.MediaPlayer]::new(); $p.Open([Uri]::new('path')); $p.Play(); Start-Sleep -Seconds 3"`
- **macOS:** `afplay path` (supports both `.wav` and `.mp3`)
- **Linux:** `aplay path.wav` or `mpv --no-video path.mp3`
- Spawn with `{ detached: true, stdio: 'ignore' }` so playback doesn't block the main process
- Use `shell.beep()` as fallback if spawn fails

**JSONL tail-reading for prompt timestamps:** Do NOT read entire JSONL files every 15s. Instead:
- Use `fs.open()` + `fs.read()` to read only the last ~8KB of each file (enough for several messages)
- Split by newlines, parse each JSON line, find the last `user` message where `isToolResult !== true`
- Cache the result with file mtime -- only re-read if mtime changed since last check
- This keeps I/O minimal even with large files

**Live page data flow:** The Live page uses TanStack Query with `refetchInterval: 30000` to poll the main process for today's stats. The main process computes today-only aggregates from the sessions table. A separate IPC channel provides "last prompt time per project" for the alert system.

**Alert monitoring runs in main process:** A `setInterval` in the monitor service checks watched projects every 15s against the latest prompt timestamps. When threshold exceeded, fires `Notification` + plays sound. Tracks "already alerted" state to avoid repeat notifications for the same prompt gap.

**Manual timer:** Timer state lives in a Zustand store (persisted to localStorage so it survives page navigation). On Start: prompt for description (optional). On Stop: dialog re-appears with previous description pre-filled; if no description was entered at start, description becomes required -- cannot stop without it. Discard button available to throw away the time block. Only one timer runs at a time. When stopped with description, calls existing `session:create` IPC with `source: 'manual'`, `startedAt`, `endedAt`, computed `durationMinutes`, description, `projectId`, `clientId`, and `projectPath` (looked up from project's `directoryPath`).

**Stale timer recovery:** On app startup / Live page mount, check if persisted timer's `startedAt` is more than 24 hours old. If so, show a recovery dialog: "A timer from {date} was still running. Save it or discard?" This prevents ghost timers from crashes.

## Implementation Plan

### Tasks

#### Phase 1: Shared Types & Database

- [x] Task 1: Create shared live types
  - File: `src/shared/types/live.ts` (new)
  - Action: Define interfaces:
    - `TodayStats` { humanHours: string, agentHours: string, totalSessions: number, totalPrompts: number, totalTokens: number }
    - `ProjectLiveStatus` { projectId: number, projectName: string, projectPath: string, clientName: string | null, clientId: number | null, lastPromptAt: string | null, isWatching: boolean, alertSound: string }
    - `ProjectAlertConfig` { projectId: number, alertSound: string, isWatching: boolean }
    - `ManualTimerState` { projectId: number, projectName: string, projectPath: string, clientId: number | null, clientName: string | null, startedAt: string, description: string | null }
  - Notes: `projectPath` is required on both `ProjectLiveStatus` and `ManualTimerState` because `session:create` requires it

- [x] Task 2: Create project_alert_config DB schema
  - File: `src/main/db/schema/project-alert-config.ts` (new)
  - Action: Define Drizzle table `projectAlertConfig` with columns: `id` (integer PK auto), `projectId` (integer FK to projects, unique), `alertSound` (text, default 'default'), `isWatching` (integer, default 0 -- SQLite boolean). Add index on `projectId`.
  - Notes: Follow pattern from `src/main/db/schema/app-settings.ts`. The `isWatching` column replaces the in-memory Set -- watch state persists across restarts.

- [x] Task 3: Register schema and generate migration
  - File: `src/main/db/index.ts` (modify)
  - Action: Add `import * as projectAlertConfigSchema from './schema/project-alert-config'` and spread `...projectAlertConfigSchema` into the `schema` object (following the existing pattern on lines 7-23). Then run `npx drizzle-kit generate` to auto-generate the migration SQL file. Do NOT hardcode the migration filename -- Drizzle generates it with a random slug (e.g., `0008_something.sql`).
  - Notes: The migration auto-runs on app startup via `migrate()` already in this file.

#### Phase 2: Main Process Services

- [x] Task 4: Create live monitor service
  - File: `src/main/services/live-monitor-service.ts` (new)
  - Action: Create singleton `liveMonitorService` with methods:
    - `getTodayStats()`: Query sessions table for today's sessions (WHERE `startedAt >= todayMidnightISO`). Compute aggregates:
      - `agentHours`: sum of `durationMinutes`, formatted via `formatDuration`-style logic
      - `humanHours`: merge overlapping intervals using the same algorithm as `computeHumanMinutes()` in `use-sessions.ts` (sort intervals by start, extend on overlap, flush on gap, return wall-clock minutes)
      - `totalSessions`: count
      - `totalPrompts`: sum of `promptCount`
      - `totalTokens`: sum of `inputTokens + outputTokens`
    - `getProjectLiveStatuses()`: For each project with sessions today, return project info (join projects + clients tables) + last prompt timestamp + watch/sound config from `projectAlertConfig` table. Projects WITHOUT today sessions but WITH `isWatching=true` in config should still appear (so you can watch a project before it has activity).
    - `getLatestPromptTimestamps()`: For each project with today activity, read only the LAST ~8KB of the most recently modified JSONL file using `fs.open()` + `fs.read()` with a position offset from EOF. Split by newlines, parse JSON, find the last `type: 'user'` message where `isToolResult !== true`. Cache results keyed by `filePath:mtime` to avoid re-reading unchanged files. Return `Map<string, string>` of projectPath -> lastHumanPromptAt ISO string.
    - `startMonitoring(intervalMs: number)`: Start `setInterval` that calls `getLatestPromptTimestamps()`, then for each watched project (from DB `isWatching=true`), compute elapsed = now - lastHumanPromptAt. If elapsed >= idleTimeout * 0.75 and `alertedGaps.get(projectId) !== lastHumanPromptAt`, fire notification + play sound + set `alertedGaps.set(projectId, lastHumanPromptAt)`.
    - `stopMonitoring()`: Clear the interval.
    - `setWatching(projectId, enabled)`: Upsert `project_alert_config` row with `isWatching` = enabled.
    - `getAlertConfig(projectId)`: Read from DB, return defaults if no row exists.
    - `setAlertConfig(projectId, alertSound)`: Upsert to DB.
    - `playSound(soundName)`: Resolve sound file path. If 'silent', do nothing. If 'default'/'chime'/'bell'/etc., resolve from `resources/sounds/`. If absolute path, use directly. Spawn platform audio command (see Technical Decisions) with `{ detached: true, stdio: 'ignore' }`. Catch spawn errors and fall back to `shell.beep()`.
    - Internal state: `alertedGaps: Map<number, string>` (projectId -> lastAlertedPromptTimestamp), `promptTimestampCache: Map<string, { mtime: number, lastPromptAt: string }>`.
  - Notes: Read `idle_timeout_minutes` from `settingsService.getSetting()`. Use `Notification` from electron for desktop notifications. Resolve bundled sounds via `path.join(__dirname, '../../resources/sounds/')` -- this works for both dev and prod because `asarUnpack: resources/**` is configured.

- [x] Task 5: Create tray service
  - File: `src/main/services/tray-service.ts` (new)
  - Action: Create singleton `trayService` with methods:
    - `initialize(mainWindow: BrowserWindow)`: Create `Tray` with icon from `resources/tray-icon.png` using `nativeImage.createFromPath(path.join(__dirname, '../../resources/tray-icon.png'))`. Set tooltip "ClawdTime". Build context menu via `Menu.buildFromTemplate()`: "Show ClawdTime" (click: `mainWindow.show(); mainWindow.focus()`), separator, "Quit" (click: `app.quit()`). Set context menu on tray. On tray `click` event (Windows/Linux): `mainWindow.isVisible() ? mainWindow.hide() : (mainWindow.show(), mainWindow.focus())`. Store mainWindow reference.
    - `destroy()`: Call `tray.destroy()` if tray exists.
  - Notes: On macOS, tray click opens context menu by default. Windows needs explicit `click` handler. Must handle case where `mainWindow` was destroyed (check `mainWindow.isDestroyed()`).

- [x] Task 6: Integrate tray and monitor into app lifecycle
  - File: `src/main/index.ts` (modify)
  - Action: This is the most critical task -- follow exactly:
    1. Add module-level state: `let mainWindow: BrowserWindow | null = null` and `let isQuitting = false`
    2. Add `app.on('before-quit', () => { isQuitting = true })` before `app.whenReady()`
    3. Modify `createWindow()` to assign to module-level `mainWindow` instead of local const
    4. After `mainWindow.on('ready-to-show', ...)`, add close intercept:
       ```typescript
       mainWindow.on('close', (e) => {
         if (!isQuitting && mainWindow) {
           e.preventDefault()
           mainWindow.hide()
         }
       })
       ```
    5. After `createWindow()` call in `app.whenReady()`, add:
       ```typescript
       trayService.initialize(mainWindow!)
       liveMonitorService.startMonitoring(15000)
       ```
    6. In `app.on('activate', ...)`, instead of creating a new window when none exist, check if `mainWindow` exists and show it: `if (mainWindow) { mainWindow.show() } else { createWindow() }`
    7. In `app.on('will-quit', ...)`, add: `liveMonitorService.stopMonitoring()` and `trayService.destroy()`
    8. Change `window-all-closed` handler: remove the `app.quit()` call on non-macOS. The app should NOT quit when windows close -- it lives in the tray. Quitting happens only via tray menu or Cmd+Q/Alt+F4 (which trigger `before-quit`).
  - Notes: The `isQuitting` flag is CRITICAL. Without checking it before `preventDefault()`, the app becomes unkillable. The `before-quit` event fires before `close`, so the flag is set in time.

#### Phase 3: IPC Layer

- [x] Task 7: Create live IPC handlers
  - File: `src/main/ipc/live-handlers.ts` (new)
  - Action: Create `registerLiveHandlers()` with handlers:
    - `live:getTodayStats` -> `liveMonitorService.getTodayStats()` (returns `TodayStats`)
    - `live:getProjectStatuses` -> `liveMonitorService.getProjectLiveStatuses()` (returns `ProjectLiveStatus[]`)
    - `live:setWatching` (projectId: number, enabled: boolean) -> `liveMonitorService.setWatching(projectId, enabled)`
    - `live:getAlertConfig` (projectId: number) -> `liveMonitorService.getAlertConfig(projectId)` (returns `ProjectAlertConfig`)
    - `live:setAlertConfig` (projectId: number, alertSound: string) -> `liveMonitorService.setAlertConfig(projectId, alertSound)`
    - `live:getAvailableSounds` -> Read `resources/sounds/` directory via `fs.readdirSync()`, filter to `.wav`/`.mp3` extensions, return array of `{ name: string, filename: string }` (name = filename without extension, capitalized)
    - `live:selectCustomSound` -> `dialog.showOpenDialog({ filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg'] }], properties: ['openFile'] })`. Validate selected file exists and is < 10MB. Return path or null if cancelled.
  - Notes: Follow pattern from `src/main/ipc/settings-handlers.ts`. All handlers wrapped in try/catch with ipcSuccess/ipcError.

- [x] Task 8: Register live handlers
  - File: `src/main/ipc/index.ts` (modify)
  - Action: Import `registerLiveHandlers` from `./live-handlers` and call it in `registerIpcHandlers()`.

- [x] Task 9: Expose live API in preload
  - File: `src/preload/index.ts` (modify)
  - Action: Add `live` namespace to the `api` object with methods:
    - `getTodayStats: () => ipcRenderer.invoke('live:getTodayStats')`
    - `getProjectStatuses: () => ipcRenderer.invoke('live:getProjectStatuses')`
    - `setWatching: (projectId: number, enabled: boolean) => ipcRenderer.invoke('live:setWatching', projectId, enabled)`
    - `getAlertConfig: (projectId: number) => ipcRenderer.invoke('live:getAlertConfig', projectId)`
    - `setAlertConfig: (projectId: number, alertSound: string) => ipcRenderer.invoke('live:setAlertConfig', projectId, alertSound)`
    - `getAvailableSounds: () => ipcRenderer.invoke('live:getAvailableSounds')`
    - `selectCustomSound: () => ipcRenderer.invoke('live:selectCustomSound')`
  - Notes: Follow exact pattern from existing API namespaces. Type all return values as `Promise<IpcResult<T>>`.

- [x] Task 10: Add live API types to preload declarations
  - File: `src/preload/index.d.ts` (modify)
  - Action: Add import for `TodayStats`, `ProjectLiveStatus`, `ProjectAlertConfig` from `../shared/types/live`. Add `LiveApi` interface:
    ```typescript
    interface LiveApi {
      getTodayStats(): Promise<IpcResult<TodayStats>>
      getProjectStatuses(): Promise<IpcResult<ProjectLiveStatus[]>>
      setWatching(projectId: number, enabled: boolean): Promise<IpcResult<void>>
      getAlertConfig(projectId: number): Promise<IpcResult<ProjectAlertConfig>>
      setAlertConfig(projectId: number, alertSound: string): Promise<IpcResult<void>>
      getAvailableSounds(): Promise<IpcResult<{ name: string; filename: string }[]>>
      selectCustomSound(): Promise<IpcResult<string | null>>
    }
    ```
    Add `live: LiveApi` to `Api` interface.

#### Phase 4: Renderer - Live Page

- [x] Task 11: Create live data hooks
  - File: `src/renderer/src/features/live/use-live.ts` (new)
  - Action: Create TanStack Query hooks:
    - `useTodayStats()`: queryKey `['live', 'stats']`, calls `window.api.live.getTodayStats()`, `refetchInterval: 30000` (30s polling). Unwrap IpcResult.
    - `useProjectStatuses()`: queryKey `['live', 'statuses']`, calls `window.api.live.getProjectStatuses()`, `refetchInterval: 30000`. Unwrap IpcResult.
    - `useSetWatching()`: useMutation, calls `window.api.live.setWatching()`, on success invalidates `['live', 'statuses']`
    - `useAlertConfig(projectId)`: queryKey `['live', 'alertConfig', projectId]`, calls `window.api.live.getAlertConfig(projectId)`
    - `useSetAlertConfig()`: useMutation, on success invalidates `['live', 'alertConfig']` and `['live', 'statuses']`
    - `useAvailableSounds()`: queryKey `['live', 'sounds']`, calls `window.api.live.getAvailableSounds()`, staleTime: Infinity (sounds list doesn't change)
    - `useSelectCustomSound()`: useMutation wrapping `window.api.live.selectCustomSound()`
  - Notes: Follow pattern from `src/renderer/src/features/sessions/use-sessions.ts`. All hooks unwrap `IpcResult` and throw on `!result.success`.

- [x] Task 12: Create live store for manual timer
  - File: `src/renderer/src/stores/use-live-store.ts` (new)
  - Action: Create Zustand store with `persist` middleware (key: `'live-timer-store'`):
    - State: `activeTimer: ManualTimerState | null`
    - Actions:
      - `startTimer(projectId, projectName, projectPath, clientId, clientName, description?)`: Sets `activeTimer` with `startedAt: new Date().toISOString()`. Throws if `activeTimer` is already set.
      - `stopTimer()`: Returns current `activeTimer` data and sets `activeTimer` to null.
      - `updateDescription(desc: string)`: Updates `activeTimer.description`.
      - `discardTimer()`: Sets `activeTimer` to null.
      - `isStale()`: Returns true if `activeTimer` exists and `startedAt` is more than 24 hours ago.
    - Persist: Only persist `activeTimer` field. Timer elapsed time is computed in components via `Date.now() - Date.parse(activeTimer.startedAt)`.
  - Notes: On Live page mount, check `isStale()` and show recovery dialog if true.

- [x] Task 13: Create LiveStatsBar component
  - File: `src/renderer/src/features/live/LiveStatsBar.tsx` (new)
  - Action: Create own `StatCard` component (copy the pattern from `StatsBar.tsx` lines 21-36 -- it's a simple Card with label + value). Do NOT import from StatsBar since it's not exported. Display 5 cards in responsive grid `repeat(auto-fit, minmax(140px, 1fr))`:
    - Human Hours (accent=true)
    - Agent Hours
    - Sessions
    - Prompts
    - Tokens (formatted with `formatCompactNumber`)
  - Accept `TodayStats | undefined` and `isLoading: boolean` as props. Show skeleton cards when loading.
  - Notes: Same CSS variable theming as existing StatsBar.

- [x] Task 14: Create ProjectWatchList component
  - File: `src/renderer/src/features/live/ProjectWatchList.tsx` (new)
  - Action: Render flat list of projects. Each row is a `Card` showing:
    - Left: Project color dot (`getProjectColor(projectPath)`) + Project name (bold) + Client name (muted, smaller)
    - Center: Time since last prompt (compute from `lastPromptAt` -- e.g., "3m ago", "12m ago", "idle" if null). Use `formatRelativeTime` or inline calculation.
    - Right controls:
      - Eye icon toggle (`Eye`/`EyeOff` from lucide-react) -- calls `useSetWatching` mutation
      - Sound selector: shadcn `Select` with options: "Silent", then bundled sounds from `useAvailableSounds()`, then "Custom..." option. On "Custom..." selection, call `useSelectCustomSound()` then `useSetAlertConfig()`. Only visible when project is watched.
      - Timer button: `Play`/`Square` icon from lucide-react. `Play` when no timer running on this project. `Square` (stop) when timer is active on this project. Disabled (greyed) if a timer is running on a DIFFERENT project. Clicking opens ManualTimerDialog.
    - If a timer is running on this project, show elapsed time badge (updating every second via `useEffect` + `setInterval`).
  - Notes: Accept `ProjectLiveStatus[]` as prop. Use `useLiveStore` for timer state.

- [x] Task 15: Create ManualTimerDialog component
  - File: `src/renderer/src/features/live/ManualTimerDialog.tsx` (new)
  - Action: shadcn `Dialog` with two modes controlled by `mode: 'start' | 'stop'` prop:
    - **Start mode**: Dialog title "Start Timer". Shows project name. Text input for description (optional, placeholder: "What are you working on?"). "Start" button. On submit: calls `liveStore.startTimer(projectId, projectName, projectPath, clientId, clientName, description || null)`, closes dialog.
    - **Stop mode**: Dialog title "Stop Timer". Shows project name + elapsed time (formatted, updating every second). Text input pre-filled with `activeTimer.description`. If `activeTimer.description` is null/empty, input has red border and "Description is required" helper text, and "Save" button is disabled until description is non-empty. "Save" button: calls `liveStore.stopTimer()` to get timer data, then calls `useCreateSession()` mutation (from `use-sessions.ts`) with `{ projectPath: timer.projectPath, startedAt: timer.startedAt, endedAt: new Date().toISOString(), durationMinutes: Math.round((Date.now() - Date.parse(timer.startedAt)) / 60000), description: description, projectId: timer.projectId, clientId: timer.clientId }`. "Discard" button (destructive variant): calls `liveStore.discardTimer()`, closes dialog.
  - Notes: Elapsed time display uses `setInterval(1000)` with cleanup in `useEffect` return. Import `useCreateSession` from `../sessions/use-sessions`.

- [x] Task 16: Create LivePage component
  - File: `src/renderer/src/features/live/LivePage.tsx` (new)
  - Action: Main page component with layout:
    ```
    <div className="flex h-full flex-col">
      <LiveStatsBar stats={todayStats} isLoading={statsLoading} />
      <div className="flex-1 overflow-auto px-4 pb-4">
        <h2 className="mb-3 text-[14px] font-semibold text-[var(--text-primary)]">Projects</h2>
        {projectStatuses.length > 0 ? (
          <ProjectWatchList projects={projectStatuses} />
        ) : (
          <EmptyState icon={Activity} title="No activity today" description="Start working and sessions will appear automatically." />
        )}
      </div>
    </div>
    ```
  - On mount: check `useLiveStore.getState().isStale()`. If true, show a dialog: "A timer from {date} was still running. Would you like to save it or discard?" with Save/Discard buttons.
  - Notes: Use `useTodayStats()` and `useProjectStatuses()` hooks. Import `EmptyState` and `Activity` icon.

- [x] Task 17: Wire up Live route
  - File: `src/renderer/src/App.tsx` (modify)
  - Action: Replace the index route's `EmptyState` element with `<LivePage />`. Add `import { LivePage } from '@/features/live/LivePage'`. Remove the `Activity` import and `EmptyState` import if no longer used elsewhere in this file.

#### Phase 5: Assets

- [x] Task 18: Create tray icon
  - File: `resources/tray-icon.png` (new)
  - Action: Create a 22x22 PNG icon for the system tray. Use a simple clock/timer shape. Can be generated programmatically using a canvas library, or use the existing `resources/icon.png` scaled down via sharp/jimp in a one-off script. For Windows, Electron's `nativeImage` handles PNG-to-ICO conversion automatically when creating the Tray.
  - Notes: If no icon creation tool is available, use a solid-color 22x22 placeholder PNG and note it for manual replacement. A 1-pixel transparent PNG will cause tray to be invisible -- avoid that.

- [x] Task 19: Bundle default alert sounds
  - Files: `resources/sounds/chime.wav`, `resources/sounds/bell.wav`, `resources/sounds/ping.wav`, `resources/sounds/alert.wav` (new)
  - Action: Source 4 short (1-2 second) notification sound effects in `.wav` format. WAV is used because Windows `SoundPlayer` only supports WAV natively. Options:
    - Use `powershell` to generate simple sine-wave tones as `.wav` files programmatically
    - Or download CC0-licensed sounds from freesound.org
    - Keep file sizes small (<200KB each)
  - Notes: Custom user sounds can be `.mp3` or `.wav` -- the platform-specific playback handles both. But BUNDLED defaults must be `.wav` for guaranteed Windows compatibility.

### Acceptance Criteria

#### Live Dashboard
- [x] AC 1: Given the app is running, when the user clicks the "Live" nav item, then the Live page displays today's aggregated stats (human hours, agent hours, sessions, prompts, tokens) and a project list.
- [x] AC 2: Given sessions exist for today, when the Live page loads, then stats reflect only today's sessions (midnight local time to now), not historical data.
- [x] AC 3: Given the Live page is displayed, when 30 seconds elapse, then the stats and project list auto-refresh without user interaction.
- [x] AC 4: Given no sessions exist for today, when the Live page loads, then an empty state message is shown.

#### Project Watching & Alerts
- [x] AC 5: Given a project appears in the Live list, when the user clicks the eye icon, then that project is marked as "watching" (persisted to DB) and the eye icon changes to filled/active state.
- [x] AC 6: Given a project is being watched with idle timeout of 15 minutes (default), when 11.25 minutes (75%) elapse since the last human prompt without a new prompt, then a desktop notification fires.
- [x] AC 7: Given a notification was fired for a gap, when no new prompts arrive, then the same gap does not trigger repeat notifications.
- [x] AC 8: Given a notification was fired and then the user sends a new prompt, when 75% of idle timeout elapses again, then a new notification fires for the new gap.
- [x] AC 24: Given a project was being watched yesterday, when the app restarts today, then that project is still marked as watching (watch state persisted in DB).

#### Alert Sounds
- [x] AC 9: Given a project is being watched, when the user selects a sound from the dropdown, then that sound preference is saved and plays on the next alert for that project.
- [x] AC 10: Given a project has "Silent" selected, when an alert fires, then a desktop notification appears but no sound plays.
- [x] AC 11: Given a user selects "Custom...", when they pick an audio file, then that file path is saved and used for future alerts on that project.
- [x] AC 12: Given a project had sound "bell" selected yesterday, when the app restarts today and that project appears, then the sound preference is still "bell" (persisted in DB).
- [x] AC 25: Given a user selected a custom sound file that has since been deleted/moved, when an alert fires, then the system falls back to `shell.beep()` and does not crash.

#### System Tray
- [x] AC 13: Given the app is running, when the user clicks the window close button (X), then the window hides and the app continues running in the system tray.
- [x] AC 14: Given the app is minimized to tray, when the user clicks the tray icon, then the main window is shown and focused.
- [x] AC 15: Given the app is in the tray, when the user right-clicks the tray icon and selects "Quit", then the app fully exits (process terminates, DB closed).
- [x] AC 16: Given the app is minimized to tray, when a prompt alert fires, then the desktop notification still appears.
- [x] AC 26: Given the app is in the tray, when the user presses Cmd+Q (macOS) or Alt+F4 (Windows), then the app fully exits.

#### Manual Timer
- [x] AC 17: Given the Live page is displayed, when the user clicks Start on a project, then a dialog appears prompting for an optional description, and after confirming the timer begins with elapsed time visible on the project card.
- [x] AC 18: Given a timer is running on Project A, when the user tries to start a timer on Project B, then the Start button on Project B is disabled (only one timer at a time).
- [x] AC 19: Given a timer is running with no description entered at start, when the user clicks Stop, then the stop dialog requires a description before allowing save (field is required, cannot be empty).
- [x] AC 20: Given a timer is running with a description entered at start, when the user clicks Stop, then the stop dialog shows the previously entered description pre-filled and allows immediate save.
- [x] AC 21: Given the stop dialog is showing, when the user clicks Discard, then the timer is discarded (no session created) and the dialog closes.
- [x] AC 22: Given a timer is stopped with a valid description, when the session is saved, then a manual session appears in the Sessions page with correct start time, end time, duration, description, and project/client attribution.
- [x] AC 23: Given a timer is running, when the user navigates away from the Live page and comes back, then the timer is still running with correct elapsed time (state persisted in Zustand store).
- [x] AC 27: Given the app crashed while a timer was running, when the app restarts and the user opens Live page, then a recovery dialog appears offering to save or discard the stale timer.

## Additional Context

### Dependencies

**New npm packages:** None required. All functionality uses Electron built-in APIs (`Tray`, `Notification`, `nativeImage`, `dialog`, `Menu`, `shell`) and Node.js built-ins (`child_process.spawn` for audio playback, `fs` for JSONL tail-reading).

**Bundled assets needed:**
- `resources/sounds/chime.wav` -- default alert sound
- `resources/sounds/bell.wav` -- alternative
- `resources/sounds/ping.wav` -- alternative
- `resources/sounds/alert.wav` -- alternative
- `resources/tray-icon.png` -- system tray icon (22x22)

**No changes needed to `electron-builder.yml`** -- `asarUnpack: resources/**` already covers new files in `resources/`.

**New DB migration:** 0008 (auto-named by drizzle-kit) -- `project_alert_config` table

**Existing IPC dependency:** `session:create` already supports manual session creation. Requires `projectPath` field.

### Testing Strategy

**Unit tests (main process, vitest node env):**
- `live-monitor-service.test.ts`:
  - Test `getTodayStats()` aggregation with mock sessions data
  - Test human hours interval merging matches renderer algorithm (same inputs -> same output)
  - Test alert threshold calculation (75% of idle timeout)
  - Test `setWatching` persists to DB and reads back correctly
  - Test alert deduplication (same gap not re-alerted, new gap does re-alert)
  - Test `playSound` spawns correct platform command

**Unit tests (renderer, vitest happy-dom):**
- `LivePage.test.tsx`: Test rendering with mock stats data. Test empty state when no sessions.
- `ProjectWatchList.test.tsx`: Test eye toggle calls mutation. Test sound dropdown renders options. Test timer button disabled when another project's timer is running.
- `ManualTimerDialog.test.tsx`: Test start mode (description optional, Start button enabled). Test stop mode with no prior description (Save disabled, validation shown). Test stop mode with prior description (pre-filled, Save enabled). Test Discard clears store.
- `use-live-store.test.ts`: Test startTimer sets state. Test startTimer throws if already active. Test stopTimer returns data and clears. Test isStale detects old timers. Test persist/restore from localStorage.

**Manual testing steps:**
1. Launch app, navigate to Live page, verify today's stats display correctly
2. Click eye on a project, verify it persists after page navigation and app restart
3. Wait for 75% of idle timeout on watched project, verify notification + sound
4. Select different sounds per project, verify correct sound plays
5. Close window via X, verify app stays in tray with icon visible
6. Click tray icon, verify window reappears and is focused
7. Right-click tray, select Quit, verify app fully exits
8. Start manual timer on Project A, verify Project B's Start is disabled
9. Navigate away from Live, come back, verify timer still running
10. Stop timer without description (should be required), add description, save
11. Verify manual session appears in Sessions page with correct data
12. Force-kill app while timer running, restart, verify stale timer dialog appears

### Notes

- Idle timeout is already configurable in Settings (default 15 min)
- Alert threshold = idle_timeout * 0.75 (not separately configurable)
- Live route `/` already exists in ActivityBar but shows EmptyState placeholder
- Session files are UUIDs, not date-named -- must filter by mtime for today
- Existing scan is incremental via scan_state table -- polling is cheap
- `type: "module"` in package.json -- preload outputs as `.mjs`
- electron-log must use `.js` extension imports
- The manual timer reuses the existing `session:create` IPC -- no new DB work needed for session storage
- `computeHumanMinutes` algorithm must be identical in main process and renderer -- consider extracting to `src/shared/` if practical, or document the algorithm inline
- Windows `SoundPlayer` only supports `.wav` -- bundle `.wav` for defaults, support `.mp3` for custom sounds via `MediaPlayer` fallback
- `shell.beep()` is the ultimate fallback if audio playback fails
