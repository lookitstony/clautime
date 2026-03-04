# Story 1.7: Welcome Wizard & First Scan

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **new ViberTime user**,
I want **a guided first-launch experience that discovers my project directories and runs an initial scan**,
So that **I see my work sessions immediately without manual configuration**.

## Acceptance Criteria

1. **Given** the app is launched for the first time (no `setup_complete` setting), **When** the user navigates to any view, **Then** the Welcome Wizard overlay appears with "Welcome to ViberTime" and two paths: "Scan My Projects Folder" (primary button) and "I'll set up manually" (skip text link)
2. **And** choosing "Scan My Projects Folder" opens a native OS folder picker dialog via Electron's `dialog.showOpenDialog`
3. **And** the selected folder is recursively scanned for `.claude` directories, and discovered projects are listed with checkboxes to include/exclude
4. **And** if no `.claude` folders are found, a friendly message suggests trying a parent directory or switching to manual setup
5. **And** the user can confirm selected projects and trigger the initial session scan
6. **And** the initial scan processes sessions and displays results progressively (sessions appear as detected)
7. **And** choosing "I'll set up manually" closes the wizard and navigates to the Sessions view with an "Add Project" prompt
8. **And** after the wizard completes (scan or skip), the `setup_complete` setting is saved via SettingsService so the wizard doesn't show again
9. **And** the `claude_dir` setting is saved with the selected folder path for future scans
10. **And** after wizard completion, the user lands on the populated Sessions view

## Tasks / Subtasks

- [x] Task 1: Add `dialog:openFolder` IPC handler in main process (AC: #2)
  - [x] Create `src/main/ipc/dialog-handlers.ts` with `dialog:openFolder` handler
  - [x] Use Electron's `dialog.showOpenDialog({ properties: ['openDirectory'] })` to open native folder picker
  - [x] Return `IpcResult<string | null>` — the selected folder path or null if cancelled
  - [x] Register in `src/main/ipc/index.ts`
  - [x] Add `dialog:discoverProjects` IPC handler that takes a folder path, recursively scans for `.claude/projects` subdirectories, and returns a list of discovered project paths (name + encoded path)
  - [x] Write tests for dialog-handlers (mock Electron dialog)

- [x] Task 2: Extend preload API with dialog and discovery methods (AC: #2, #3)
  - [x] Add to `src/preload/index.ts`:
    - `dialog.openFolder()` → invokes `dialog:openFolder`
    - `dialog.discoverProjects(folderPath: string)` → invokes `dialog:discoverProjects`
  - [x] Update `src/preload/index.d.ts` with `DialogApi` interface
  - [x] Define `DiscoveredProject` type in `src/shared/types/session.ts`: `{ projectPath: string, projectName: string, encodedName: string, hasClaudeDir: boolean }`

- [x] Task 3: Install shadcn `dialog` component (AC: #1)
  - [x] Run `npx shadcn@latest add dialog`
  - [x] Verify `src/renderer/src/components/ui/dialog.tsx` exists
  - [x] Also install `progress` if not present: `npx shadcn@latest add progress`

- [x] Task 4: Create WelcomeWizard component with step flow (AC: #1, #7, #8, #10)
  - [x] Create `src/renderer/src/features/onboarding/WelcomeWizard.tsx`
  - [x] Use shadcn Dialog as full-screen overlay (no close button — must complete or skip)
  - [x] Step state machine: `welcome` → `discovery` → `confirm` → `scanning` → `complete`
  - [x] **Welcome step**: ViberTime logo/icon, "Welcome to ViberTime" title, "Let's find your projects" subtitle, "Scan My Projects Folder" primary button, "I'll set up manually" text link
  - [x] **Discovery step**: After folder picker, show "Scanning for projects..." with spinner, then display results
  - [x] **Confirm step**: List discovered projects with checkboxes (all checked by default), project name + path preview, "Confirm & Scan" button, "Back" link
  - [x] **Scanning step**: Progress indicator, sessions appearing as they're detected (reuse scan mutation)
  - [x] **Complete step**: Brief summary "Found X sessions across Y projects", "Get Started" button
  - [x] Skip path: sets `setup_complete=true` via settings API, closes dialog, navigates to Sessions view

- [x] Task 5: Create `use-onboarding.ts` hooks (AC: #2, #3, #5, #8, #9)
  - [x] Create `src/renderer/src/features/onboarding/use-onboarding.ts`
  - [x] `useIsFirstLaunch()` — queries `settings:get('setup_complete')`, returns `{ isFirstLaunch: boolean, isLoading: boolean }`
  - [x] `useOpenFolderPicker()` — mutation calling `window.api.dialog.openFolder()`
  - [x] `useDiscoverProjects(folderPath)` — query calling `window.api.dialog.discoverProjects(folderPath)`
  - [x] `useCompleteSetup()` — mutation that sets `setup_complete=true` and optionally `claude_dir` via settings API, then invalidates settings queries

- [x] Task 6: Integrate WelcomeWizard into App.tsx (AC: #1, #10)
  - [x] In `App.tsx` or `RootLayout`, conditionally render `<WelcomeWizard />` when `isFirstLaunch` is true
  - [x] After wizard completion, navigate to `/sessions` route
  - [x] Wizard must render as an overlay on top of the app shell (Dialog component handles this)

- [x] Task 7: Create project discovery service in main process (AC: #3, #4)
  - [x] Create `src/main/services/discovery-service.ts`
  - [x] `discoverProjects(rootFolder: string): Promise<DiscoveredProject[]>`
  - [x] Recursively scan for `.claude` directories within `rootFolder`
  - [x] For each `.claude/projects` dir found, extract project names from encoded folder names
  - [x] Handle edge cases: no `.claude` found, permission errors, symlinks
  - [x] Write unit tests with mock file system

- [x] Task 8: Write tests for all new components and hooks (AC: all)
  - [x] Unit tests for discovery-service (mock fs)
  - [x] Component tests for WelcomeWizard (step transitions, skip path)
  - [x] Hook tests for use-onboarding (mock window.api)
  - [x] Integration test: full wizard flow from welcome → scan → complete
  - [x] Test that wizard doesn't appear when `setup_complete` is set

## Dev Notes

### Architecture Patterns & Constraints

**Three-Context Electron Architecture:**
- **Main** (`src/main/`): New dialog IPC handler + discovery service
- **Preload** (`src/preload/`): Extend API with dialog/discovery methods
- **Renderer** (`src/renderer/`): WelcomeWizard component + onboarding hooks

**IPC Pattern (MANDATORY):**
```typescript
// Main: dialog-handlers.ts
ipcMain.handle('dialog:openFolder', async (): Promise<IpcResult<string | null>> => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select your projects folder'
  })
  if (result.canceled || result.filePaths.length === 0) {
    return ipcSuccess(null)
  }
  return ipcSuccess(result.filePaths[0])
})

// Preload: index.ts
dialog: {
  openFolder: (): Promise<IpcResult<string | null>> =>
    ipcRenderer.invoke('dialog:openFolder'),
  discoverProjects: (folderPath: string): Promise<IpcResult<DiscoveredProject[]>> =>
    ipcRenderer.invoke('dialog:discoverProjects', folderPath)
}
```

**Electron `dialog` module:** MUST import from `electron` in main process only. The `dialog.showOpenDialog()` returns `{ canceled: boolean, filePaths: string[] }`. Do NOT try to use it from renderer or preload.

**Settings storage for wizard state:**
```typescript
// Check if first launch
const setupComplete = settingsService.getSetting('setup_complete')
// After wizard: save settings
settingsService.setSetting('setup_complete', 'true')
settingsService.setSetting('claude_dir', selectedPath)
```

**React Query Pattern:**
```typescript
// Check first launch via settings API
export function useIsFirstLaunch() {
  const { data, isLoading } = useQuery({
    queryKey: ['settings', 'setup_complete'],
    queryFn: async () => {
      const result = await window.api.settings.get('setup_complete')
      if (!result.success) throw new Error(result.error.message)
      return result.data
    }
  })
  return { isFirstLaunch: !isLoading && data !== 'true', isLoading }
}
```

### Feature File Structure

```
src/main/
├── ipc/
│   ├── dialog-handlers.ts          # NEW — folder picker + project discovery IPC
│   └── index.ts                    # MODIFY — register dialog handlers
├── services/
│   └── discovery-service.ts        # NEW — recursive .claude folder discovery
│
src/preload/
├── index.ts                        # MODIFY — add dialog API
├── index.d.ts                      # MODIFY — add DialogApi interface
│
src/renderer/src/
├── features/
│   └── onboarding/
│       ├── WelcomeWizard.tsx        # NEW — multi-step wizard component
│       ├── WelcomeWizard.test.tsx   # NEW — component tests
│       └── use-onboarding.ts        # NEW — React Query hooks
│
src/shared/types/
└── session.ts                      # MODIFY — add DiscoveredProject type
```

### Design System Requirements

**WelcomeWizard Dialog:**
- Full-screen overlay using shadcn Dialog (no backdrop dismiss, no X close)
- Centered content area, max-width 480px
- Background: `var(--background-primary)` with subtle overlay
- Title: 20px, weight 700, `var(--text-primary)`
- Subtitle: 14px, `var(--text-muted)`
- Primary button: `bg-[var(--accent)]`, white text, full-width within content area
- Skip link: 13px, `var(--text-muted)`, underline on hover

**Discovery Results List:**
- Each project row: checkbox + color dot + project name + path (truncated, muted)
- Row height: 40px, matching SessionRow pattern
- Checkbox: shadcn checkbox or native with accent styling
- "Select All" / "Deselect All" toggle at top

**Scanning Progress:**
- Reuse `useScanSessions()` mutation from `use-sessions.ts`
- Show session count increasing as scan progresses
- Status text: "Found X sessions across Y projects..."
- Use accent color for progress numbers

### Data Flow

```
WelcomeWizard (renderer)
  → Step 1: "Scan" button click
  → window.api.dialog.openFolder() → IPC → main → dialog.showOpenDialog() → folder path
  → Step 2: window.api.dialog.discoverProjects(path) → IPC → main → discoveryService → DiscoveredProject[]
  → Step 3: User confirms projects → window.api.sessions.scan(claudeDir) → IPC → main → sessionService.scanSessions()
  → Step 4: window.api.settings.set('setup_complete', 'true')
  → Step 4: window.api.settings.set('claude_dir', path)
  → Close dialog, navigate to /sessions
```

### Discovery Service Logic

The discovery service scans a root folder for `.claude` directories:
1. Start at user-selected folder (e.g., `C:\apps` or `~/projects`)
2. Look for `.claude/projects/` subdirectories at any depth (but skip `node_modules`, `.git`, etc.)
3. For each `.claude/projects/` found, list the encoded project name folders inside
4. Decode the encoded project name to get the actual project directory path
5. Return `DiscoveredProject[]` with name, path, and encoded folder name

**Important:** The existing `discoverSessionFiles()` in `src/main/parsers/session-parser.ts` already knows how to find `.claude/projects/*/` JSONL files from a given `.claude` base dir. The discovery service is different — it finds the `.claude` directories themselves from a broader root folder.

**Encoded project names:** In `~/.claude/projects/`, folder names are URL-encoded project paths like `C-%5Capps%5CClawdTime` → `C:\apps\ClawdTime`. Decode with `decodeURIComponent()` replacing `-` separators.

### Previous Story Intelligence

**Story 1.6 (Sessions View) — Key patterns:**
- `useSessions()`, `useScanSessions()` hooks in `src/renderer/src/features/sessions/use-sessions.ts`
- `useScanSessions()` uses `useMutation` with `queryClient.invalidateQueries({ queryKey: ['sessions'] })` on success
- `EmptyState` component at `@/components/shared/EmptyState` with icon, title, description, action props
- All renderer tests mock `window.api` via `vi.stubGlobal('api', { ... })`
- React Query wrapper: `QueryClient({ defaultOptions: { queries: { retry: false } } })`

**Story 1.5 (Session Detection Engine):**
- `sessionService.scanSessions(claudeDir?)` accepts optional claude dir override
- Default claude dir: `join(homedir(), '.claude')`
- Settings key `claude_dir` already checked by session service
- Settings key `idle_timeout_minutes` already used

**Story 1.3 (Database):**
- `settingsService.getSetting(key)` / `setSetting(key, value)` — simple key-value store
- Settings IPC: `settings:get`, `settings:set`, `settings:getAll`
- Preload already exposes `window.api.settings.get/set/getAll`

### Anti-Patterns (NEVER do)

- Don't use `remote` module — use IPC for all main process access
- Don't call `dialog.showOpenDialog` from renderer — it must go through IPC to main process
- Don't use `useState` + `useEffect` for settings/data fetching — use React Query
- Don't hardcode `.claude` path — use the folder picker result saved in settings
- Don't block the UI during scanning — use mutation with progressive updates
- Don't show the wizard on every launch — check `setup_complete` setting via React Query

### Library/Framework Requirements

| Library | Version | Notes for this story |
|---------|---------|---------------------|
| @tanstack/react-query | 5.x | `useQuery`, `useMutation` for settings and scan |
| shadcn/ui | latest | dialog, progress (new installs), button, badge (existing) |
| lucide-react | latest | Icons: `FolderSearch`, `Check`, `ArrowRight`, `Loader2` |
| electron | 39.x | `dialog.showOpenDialog` in main process |

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 1.7 — Acceptance Criteria]
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md#Journey 1 — First Launch flow]
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md#WelcomeFlow component spec]
- [Source: _bmad-output/planning-artifacts/architecture.md — IPC patterns, service architecture]
- [Source: src/main/services/session-service.ts — scanSessions() accepts claudeDir param]
- [Source: src/main/services/settings-service.ts — getSetting/setSetting pattern]
- [Source: src/preload/index.ts — existing API structure for settings and sessions]
- [Source: src/preload/index.d.ts — type definitions for preload API]
- [Source: src/renderer/src/features/sessions/use-sessions.ts — useScanSessions() pattern]
- [Source: src/renderer/src/components/shared/EmptyState.tsx — EmptyState component API]
- [Source: src/renderer/src/App.tsx — RootLayout and route structure]
- [Source: _bmad-output/implementation-artifacts/1-6-sessions-view-grouped-by-project.md — Previous story learnings]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

- Claude CLI encodes project paths by replacing `:`, `\`, `/` with `-` (NOT URL encoding). Example: `C:\apps\ClawdTime` → `C--apps-ClawdTime`
- shadcn Dialog hides close button via `[&>button]:hidden` CSS selector
- `onInteractOutside` and `onEscapeKeyDown` with `e.preventDefault()` blocks dismissal
- `useNavigate()` must be called inside router context — RootLayout is inside router so this works

### Completion Notes List

- Task 1: Created `dialog-handlers.ts` with `dialog:openFolder` (Electron dialog.showOpenDialog) and `dialog:discoverProjects` IPC handlers. Registered in IPC index.
- Task 2: Extended preload API with `dialog.openFolder()` and `dialog.discoverProjects()`. Added `DialogApi` interface to index.d.ts. Added `DiscoveredProject` type to shared types.
- Task 3: Installed shadcn dialog, progress, and checkbox components.
- Task 4: Created `WelcomeWizard.tsx` with 5-step flow (welcome → discovery → confirm → scanning → complete). Non-dismissable Dialog overlay. Welcome step with scan/skip options. Discovery spinner. Confirm step with project checkboxes and select all/deselect all. Scanning spinner. Complete step with summary and "Get Started" button. Skip path saves setup_complete and closes.
- Task 5: Created `use-onboarding.ts` with `useIsFirstLaunch()` (checks setup_complete setting), `useOpenFolderPicker()`, `useDiscoverProjects()`, and `useCompleteSetup()` (saves setup_complete + optional claude_dir, invalidates settings queries).
- Task 6: Integrated WelcomeWizard into RootLayout in App.tsx. Conditionally rendered when `isFirstLaunch` is true. On complete, navigates to `/sessions`.
- Task 7: Created `discovery-service.ts` with recursive `.claude/projects` scanning. Decodes Claude CLI path encoding (`:`, `\`, `/` → `-`). Skips node_modules/.git/etc. Max depth 5. Handles permission errors gracefully.
- Task 8: Wrote 19 new tests: discovery-service (6 tests — discovery, empty, permissions, skip dirs, recursive, missing projects folder), WelcomeWizard (8 tests — render, skip, setup_complete on skip, folder picker, confirm step, no projects, complete step, cancel), use-onboarding (5 tests — first launch true/false, loading, complete setup, claude_dir).

### Change Log

- 2026-03-04: Implemented Story 1.7 — Welcome Wizard & First Scan. All 8 tasks complete, 141 tests passing (19 new).

### File List

- src/main/ipc/dialog-handlers.ts (NEW)
- src/main/ipc/index.ts (MODIFIED — register dialog handlers)
- src/main/services/discovery-service.ts (NEW)
- src/main/services/discovery-service.test.ts (NEW)
- src/preload/index.ts (MODIFIED — add dialog API)
- src/preload/index.d.ts (MODIFIED — add DialogApi interface)
- src/shared/types/session.ts (MODIFIED — add DiscoveredProject type)
- src/renderer/src/features/onboarding/WelcomeWizard.tsx (NEW)
- src/renderer/src/features/onboarding/WelcomeWizard.test.tsx (NEW)
- src/renderer/src/features/onboarding/use-onboarding.ts (NEW)
- src/renderer/src/features/onboarding/use-onboarding.test.ts (NEW)
- src/renderer/src/App.tsx (MODIFIED — integrate WelcomeWizard)
- src/renderer/src/components/ui/dialog.tsx (NEW — shadcn)
- src/renderer/src/components/ui/progress.tsx (NEW — shadcn)
- src/renderer/src/components/ui/checkbox.tsx (NEW — shadcn)

