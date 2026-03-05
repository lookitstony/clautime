# Story 2.3: Session-to-Client/Project Attribution

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer using ClawdTime**,
I want **detected sessions to be automatically attributed to their matching client and project**,
so that **sessions are organized under the correct client/project in the Sessions view**.

## Acceptance Criteria

1. **Given** clients and projects are configured with directory paths, **When** a session scan runs (or re-scan is triggered), **Then** each detected session is matched to a project by comparing the session's directory path to configured project directory paths.

2. **Given** sessions have been attributed to projects, **When** the Sessions view renders, **Then** matched sessions display the client name and project color in the ProjectGroup rows.

3. **Given** some sessions do not match any configured project directory, **When** the Sessions view renders, **Then** unmatched sessions appear in an "Unassigned" group with a prompt to map their directory.

4. **Given** the user has configured project-to-client mappings, **When** the user navigates to the Clients view, **Then** they can view and manage all configured project-to-client mappings (FR44 — already done in Story 2.2).

5. **Given** project mappings have changed, **When** a re-scan is triggered, **Then** attributions are updated to reflect the new mappings.

6. **Given** sessions have been attributed, **When** the StatsBar and StatusBar render, **Then** they reflect client/project-aware data (client count, project count, attribution status).

## Tasks / Subtasks

- [x] **Task 1: Integrate attribution into scan flow** (AC: 1, 5)
  - [x] 1.1 Modify `session-handlers.ts` `session:scan` handler to call `clientProjectService.attributeSessions()` after `sessionService.scanSessions()` completes
  - [x] 1.2 Update `ScanResult` type in `src/shared/types/session.ts` to include `attributedCount: number`
  - [x] 1.3 Return attributed count in scan result so UI can show feedback
  - [x] 1.4 Unit test: verify attribution runs after scan and result includes count

- [x] **Task 2: Enrich session grouping with client/project data** (AC: 2, 3)
  - [x] 2.1 Update `useGroupedSessions()` hook in `use-sessions.ts` to accept projects and clients arrays
  - [x] 2.2 Group sessions by `projectId` (attributed) — look up project name, client name, and client color from the projects/clients arrays
  - [x] 2.3 Group unattributed sessions (NULL `projectId`) into an "Unassigned" bucket, keyed by unique `projectPath`
  - [x] 2.4 Sort: assigned groups alphabetically (client name → project name), unassigned group always last
  - [x] 2.5 Update `ProjectGroup` type to include `clientName`, `clientColor`, `projectId`, `isUnassigned` fields
  - [x] 2.6 Update `SessionsPage.tsx` to pass clients/projects data into the grouping hook

- [x] **Task 3: Update ProjectGroup component for client/project display** (AC: 2)
  - [x] 3.1 Modify `ProjectGroup.tsx` to display client name (muted text) next to project name
  - [x] 3.2 Use client color (from client record via `CLIENT_COLORS` CSS vars) for the project color dot instead of hard-coded index
  - [x] 3.3 For attributed groups: show "ClientName / ProjectName" pattern with color dot
  - [x] 3.4 Unit test: ProjectGroup renders client name and correct color

- [x] **Task 4: Create Unassigned sessions group** (AC: 3)
  - [x] 4.1 Render "Unassigned" group with neutral gray styling (muted color dot with opacity)
  - [x] 4.2 Show directory path as the group label (since no project name exists)
  - [x] 4.3 Add inline prompt/link: "Map this directory → Clients" that navigates to `/clients` view
  - [x] 4.4 Unit test: Unassigned group renders with correct styling and navigation link

- [x] **Task 5: Update StatsBar and StatusBar** (AC: 6)
  - [x] 5.1 Update `StatsBar` to show "Clients" count when clients exist (replaces placeholder "Active Sessions")
  - [x] 5.2 Add StatusBar footer in SessionsPage showing "X clients · Y projects · Z unassigned"
  - [x] 5.3 Unit test: StatsBar and StatusBar reflect client/project counts

- [x] **Task 6: Auto-trigger attribution on scan completion in UI** (AC: 1, 5)
  - [x] 6.1 After `useScanSessions()` mutation succeeds, attribution runs server-side automatically, sessions query invalidation picks up new attributions
  - [x] 6.2 Show toast with attribution results: "Scan complete: X sessions found, Y attributed"
  - [x] 6.3 Re-scan properly re-attributes when mappings have changed (attributeSessions runs on every scan)

- [x] **Task 7: Integration tests** (AC: 1-6)
  - [x] 7.1 Test full flow: attributed sessions display with client name and color
  - [x] 7.2 Test unassigned sessions grouping and "Map directory" navigation prompt
  - [x] 7.3 Test StatsBar shows client-aware stats and StatusBar shows counts

## Dev Notes

### Critical Architecture Patterns

1. **Attribution service already exists**: `ClientProjectService.attributeSessions()` in `src/main/services/client-project-service.ts` — finds sessions with NULL `projectId`, matches by normalized directory path (case-insensitive), updates both `projectId` AND `clientId` in a single DB transaction. DO NOT rewrite this.

2. **IPC + Hook already wired**: `window.api.projects.attributeSessions()` exposed via preload, `useAttributeSessions()` hook exists in `src/renderer/src/features/clients/use-projects.ts` with proper cache invalidation (`['sessions']` and `['projects']`). DO NOT recreate these.

3. **Session data flow**: Sessions arrive from parser with `projectPath` populated but `projectId`/`clientId` NULL. Attribution is a separate step that populates these FKs by matching `projectPath` to `project.directoryPath`.

4. **React Query cache strategy**: After attribution runs, invalidating `['sessions']` causes `useSessions()` to refetch — sessions now have `projectId`/`clientId` populated. The grouping hook re-groups with enriched data automatically.

5. **Client-side data joining pattern**: DO NOT create a server-side join query. Instead, fetch sessions, clients, and projects separately via existing hooks (`useSessions()`, `useClients()`, `useProjects()`), then join in the `useGroupedSessions()` hook. This follows the established pattern and keeps the data layer simple.

6. **Color system**: Client colors use CSS variables `var(--project-1)` through `var(--project-8)` defined in `CLIENT_COLORS` array. Color dots use inline `style={{ backgroundColor: color }}`. See `ClientCard.tsx` for the established pattern.

7. **Navigation**: Use `useUIStore().setActiveView('clients')` to navigate to Clients page from the "Map directory" prompt (same pattern as existing navigation).

### Existing Files to Modify

| File | Change |
|------|--------|
| `src/main/ipc/session-handlers.ts` | Call `attributeSessions()` after `scanSessions()` in `session:scan` handler |
| `src/shared/types/session.ts` | Add `attributedCount` to `ScanResult` type |
| `src/renderer/src/features/sessions/use-sessions.ts` | Update `useGroupedSessions()` to accept and join client/project data |
| `src/renderer/src/features/sessions/SessionsPage.tsx` | Pass clients/projects to grouping hook, handle unassigned group |
| `src/renderer/src/features/sessions/ProjectGroup.tsx` | Display client name, use client color, handle unassigned styling |
| `src/renderer/src/features/sessions/StatsBar.tsx` | Add client/project count stats |
| `src/renderer/src/features/sessions/StatusBar.tsx` | Show attribution awareness |

### Files NOT to Create

- No new service files — `attributeSessions()` exists
- No new IPC handlers — `project:attributeSessions` exists
- No new preload entries — already exposed
- No new React Query hooks for attribution — `useAttributeSessions()` exists

### Testing Approach

- **Main process tests**: Colocated `.test.ts` files with `// @vitest-environment node` directive
- **Renderer tests**: `happy-dom` environment (default), `@testing-library/react` + `@testing-library/user-event`
- **Mock `window.api`**: `vi.fn().mockResolvedValue({ success: true, data: ... })`
- **React Query**: Wrap in `QueryClientProvider` with fresh `QueryClient({ defaultOptions: { queries: { retry: false } } })`
- **electron-log mock**: `vi.mock('electron-log/main.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))`
- **Toast assertions**: Mock `sonner` toast function

### Project Structure Notes

- All session feature files live in `src/renderer/src/features/sessions/`
- Client feature files live in `src/renderer/src/features/clients/`
- Shared types in `src/shared/types/`
- Main process services in `src/main/services/`
- IPC handlers in `src/main/ipc/`
- No new directories needed

### Design Tokens for Unassigned Group

- Use `text-muted` color for "Unassigned" label
- Use `var(--surface-border)` or neutral gray for the color dot
- Use `text-xs text-muted-foreground` for the "Map directory" prompt
- Follow existing `ProjectGroup` 48px row height and layout

### Previous Story Intelligence (from Story 2.2)

- **Page structure**: `flex h-full flex-col` wrapper with header + scrollable body
- **Collapsible rows**: shadcn `Collapsible` + `CollapsibleTrigger` + `CollapsibleContent`
- **Color dots**: inline `style={{ backgroundColor: color }}` — React handles CSS variable resolution
- **Dialog forms**: Follow WelcomeWizard pattern
- **React Query mutations**: Use existing hooks with automatic cache invalidation
- **Raw HTML inputs styled with Tailwind** (matching WelcomeWizard approach)
- **AlertDialog for delete confirmations**
- **Toast via sonner** (already mounted in App.tsx)
- **CSS vars**: `--background-primary`, `--background-secondary`, `--background-elevated`, `--surface-border`, `--text-primary`, `--text-secondary`, `--text-muted`
- **Accent**: teal (`#14b8a6`)

### Git Intelligence

Recent commits show clean story-per-commit pattern:
- `c0353e4` Story 2.2: Clients & projects management UI
- `5d0a8e5` Story 2.1: Client & project database schema and service
- `b1a7719` Fix wizard flow, project dedup, day grouping, and scan filtering
- `8004e92` Story 1.7: Welcome wizard and first scan

Key patterns from commits:
- All test files colocated with source
- Existing 210 tests passing (0 regressions)
- shadcn components added as needed (switch, alert-dialog already installed)

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic 2, Story 2.3]
- [Source: _bmad-output/planning-artifacts/prd.md#FR4, FR11-14, FR15-17, FR44]
- [Source: _bmad-output/planning-artifacts/architecture.md#IPC Patterns, Service Layer, Database Schema]
- [Source: _bmad-output/planning-artifacts/ux-design.md#Session Attribution UI, Project Groups, Unassigned Group]
- [Source: _bmad-output/implementation-artifacts/2-2-clients-and-projects-management-ui.md#Dev Notes]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

### Completion Notes List

- Integrated `attributeSessions()` into `session:scan` IPC handler — attribution now runs automatically after every scan
- Added `attributedCount` to `ScanResult` type for UI feedback
- Rewrote `useGroupedSessions()` to accept projects/clients arrays and group sessions by `projectId` (attributed) or `projectPath` (unassigned)
- `ProjectGroup` component now displays "ClientName / ProjectName" with client color dot for attributed sessions
- Unassigned groups render with muted gray dot, opacity styling, and "Map this directory to a client" navigation link
- `StatsBar` conditionally shows "Clients" and "Unassigned" cards when clients are configured
- `useScanSessions()` now shows toast with attribution count on scan completion
- Code review fixes applied:
  - H1: "Map directory" button now uses both `navigate()` and `setActiveView()` for proper routing
  - H2: Removed duplicate inline StatusBar from SessionsPage — existing `StatusBar.tsx` component handles this
  - M1: Updated `StatusBar.tsx` to pass clients/projects to `useSessionStats()` for client-aware display
  - M2: Removed dead `projectCount` prop from StatsBar interface
  - L1: Added "(Unassigned)" to aria-label for unassigned groups
- All 223 tests pass (0 regressions)

### File List

**Modified:**
- src/shared/types/session.ts (added `attributedCount` to ScanResult)
- src/main/ipc/session-handlers.ts (call attributeSessions after scan)
- src/main/services/session-service.ts (added attributedCount: 0 to ScanResult returns)
- src/renderer/src/features/sessions/use-sessions.ts (enriched grouping, stats, scan toast)
- src/renderer/src/features/sessions/SessionsPage.tsx (wire clients/projects, unassigned group, navigate fix)
- src/renderer/src/features/sessions/ProjectGroup.tsx (client name, unassigned styling, aria-label fix)
- src/renderer/src/features/sessions/StatsBar.tsx (client-aware cards, removed dead projectCount prop)
- src/renderer/src/components/shared/StatusBar.tsx (client-aware display with clients/projects data)
- src/renderer/src/features/sessions/SessionsPage.test.tsx (updated mocks, MemoryRouter wrapper, 8 tests)
- src/renderer/src/features/sessions/ProjectGroup.test.tsx (6 new tests for client/unassigned/aria-label)
- src/renderer/src/features/sessions/StatsBar.test.tsx (3 new tests for client-aware stats)
- src/renderer/src/components/shared/StatusBar.test.tsx (updated for client-aware StatusBar)
- src/renderer/src/features/onboarding/WelcomeWizard.test.tsx (updated scan result mock)
