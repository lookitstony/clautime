# Story 1.6: Sessions View — Grouped by Project

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer using ViberTime**,
I want **to see my detected sessions grouped by project with summary statistics**,
So that **I can quickly understand where my time went at a glance**.

## Acceptance Criteria

1. **Given** the app has detected sessions stored in the database, **When** the user navigates to the Sessions view, **Then** sessions are displayed grouped by project using ProjectGroup components
2. **And** each ProjectGroup row shows: project color dot, project name, session count badge, and total duration (monospace, accent color)
3. **And** clicking a ProjectGroup expands it to show individual SessionRow components
4. **And** each SessionRow shows: time range (monospace), duration, and status badge (Auto)
5. **And** a StatsBar at the top shows 4 cards: Today's Total, Active Sessions (0 for now), Total Sessions, Tokens Used
6. **And** the StatusBar at the bottom shows "Watching X projects" and last scan time
7. **And** data is fetched via React Query hooks calling `window.api.sessions.getAll()`
8. **And** skeleton loading states display while data loads
9. **And** an EmptyState shows "No sessions found" with a "Scan Now" button when no data exists
10. **And** only one SessionRow detail panel can be open at a time
11. **And** keyboard navigation works for expanding/collapsing groups and selecting sessions

## Tasks / Subtasks

- [x] Task 1: Install required shadcn/ui components (AC: all)
  - [x]Install shadcn `collapsible` component: `npx shadcn@latest add collapsible`
  - [x]Install shadcn `card` component: `npx shadcn@latest add card`
  - [x]Install shadcn `badge` component: `npx shadcn@latest add badge`
  - [x]Install shadcn `button` component: `npx shadcn@latest add button`
  - [x]Install shadcn `skeleton` component: `npx shadcn@latest add skeleton`
  - [x]Verify all components exist in `src/renderer/src/components/ui/`

- [x] Task 2: Create `use-sessions.ts` React Query hooks (AC: #7)
  - [x]Create `src/renderer/src/features/sessions/use-sessions.ts`
  - [x]`useSessions(filters?: SessionFilters)` — calls `window.api.sessions.getAll(filters)`, returns `Session[]`
    - Query key: `['sessions', 'list', filters]`
    - Unwrap `IpcResult<T>` — throw on `success: false`
  - [x]`useScanSessions()` — mutation calling `window.api.sessions.scan()`
    - On success: invalidate `['sessions']` queries
    - Returns `ScanResult`
  - [x]`useSessionStats()` — derived hook: query all sessions, compute `todayTotal`, `activeSessions` (0 for now), `totalSessions`, `tokensUsed` (0 for now)
  - [x]`useGroupedSessions()` — derived hook: takes `Session[]`, groups by `projectPath`, computes per-group stats (sessionCount, totalDuration)
  - [x]All hooks handle loading, error, and empty states via React Query's built-in states

- [x] Task 3: Create utility helpers for session display (AC: #2, #4)
  - [x]Add to `src/renderer/src/lib/utils.ts` (or create `src/renderer/src/lib/format.ts` if cleaner):
    - `formatDuration(minutes: number): string` — e.g., `125` → `"2h 5m"`, `0` → `"0m"`
    - `formatTimeRange(startedAt: string, endedAt: string): string` — e.g., `"09:15 – 11:42"`
    - `formatRelativeTime(isoString: string): string` — e.g., `"2 min ago"`, `"1h ago"`, `"yesterday"`
    - `getProjectColor(projectPath: string): string` — deterministic color from 8-color palette using hash of project path
    - `getProjectName(projectPath: string): string` — extract last path segment, e.g., `/apps/ClawdTime` → `ClawdTime`
  - [x]Write unit tests for all formatters

- [x] Task 4: Create StatsBar component (AC: #5)
  - [x]Create `src/renderer/src/features/sessions/StatsBar.tsx`
  - [x]4 cards in a CSS grid row: Today's Total, Active Sessions, Total Sessions, Tokens Used
  - [x]Each card: label (11px, uppercase, muted, letter-spacing) on top, value (24px, monospace, weight 700) below
  - [x]Today's Total value uses accent color; others use default text color
  - [x]At < 1024px width: stack to 2x2 grid
  - [x]Skeleton variant: use shadcn `Skeleton` matching card layout
  - [x]Props: `todayTotal: string`, `activeSessions: number`, `totalSessions: number`, `tokensUsed: number`, `isLoading: boolean`

- [x] Task 5: Create ProjectGroup component (AC: #1, #2, #3, #11)
  - [x]Create `src/renderer/src/features/sessions/ProjectGroup.tsx`
  - [x]Uses shadcn `Collapsible` as foundation
  - [x]Collapsed row (48px height): chevron icon (rotates on expand) + project color dot (8px circle) + project name (weight 600) + session count badge + total duration (monospace, accent, weight 700)
  - [x]Expanded: shows children (SessionRow list)
  - [x]`aria-expanded`, `role="group"`, `aria-label="[Project Name] - [N] sessions, [duration] total"`
  - [x]Keyboard: Enter/Space to toggle expand/collapse
  - [x]Props: `projectPath: string`, `sessions: Session[]`, `isExpanded: boolean`, `onToggle: () => void`, `children: ReactNode`

- [x] Task 6: Create SessionRow component (AC: #4, #10, #11)
  - [x]Create `src/renderer/src/features/sessions/SessionRow.tsx`
  - [x]40px height, indented 16px, left border 2px in project color
  - [x]Content: time range (monospace) + status badge (Auto/Manual) + duration (monospace, weight 600)
  - [x]Click to select/expand detail placeholder (for now, just visual selection state — accent left border, elevated bg)
  - [x]`role="button"`, `aria-expanded` for future detail panel
  - [x]Only one SessionRow can be selected at a time (managed by parent page)
  - [x]Keyboard: Enter/Space to select
  - [x]Props: `session: Session`, `projectColor: string`, `isSelected: boolean`, `onSelect: () => void`

- [x] Task 7: Create SessionsPage — assembles the full view (AC: all)
  - [x]Create `src/renderer/src/features/sessions/SessionsPage.tsx`
  - [x]Layout: StatsBar at top → ProjectGroup list in scrollable area
  - [x]State: `expandedGroups: Set<string>`, `selectedSessionId: number | null`
  - [x]Uses `useSessions()`, `useSessionStats()`, `useGroupedSessions()`
  - [x]Loading state: skeleton StatsBar + 3 skeleton ProjectGroup rows
  - [x]Empty state: uses `EmptyState` component with "No sessions found" + "Scan Now" button
  - [x]"Scan Now" button triggers `useScanSessions()` mutation
  - [x]Arrow key navigation between project groups
  - [x]Only one detail panel (selected session) open at a time

- [x] Task 8: Update StatusBar to show live session data (AC: #6)
  - [x]Modify `src/renderer/src/components/shared/StatusBar.tsx` to accept data from parent or use React Query
  - [x]Show "Watching X projects" (count of unique project paths) + "Last scan: [relative time]"
  - [x]Right side: daily total (monospace, accent)
  - [x]Option A: StatusBar stays a presentational component, App.tsx passes props
  - [x]Option B: StatusBar uses its own `useSessions()` + `useSettings()` hooks internally
  - [x]Decide based on simplicity — either approach is fine

- [x] Task 9: Wire up routes and integrate (AC: all)
  - [x]Update `src/renderer/src/App.tsx`:
    - Replace `EmptyState` placeholder at `/sessions` route with `<SessionsPage />`
    - Import from `@/features/sessions/SessionsPage`
  - [x]Verify the full data flow: App launch → navigate to Sessions → React Query fetches → grouped display renders

- [x] Task 10: Write tests (AC: all)
  - [x]Unit tests for formatting utilities (formatDuration, formatTimeRange, formatRelativeTime, getProjectColor, getProjectName)
  - [x]Component tests for StatsBar (renders values, skeleton state)
  - [x]Component tests for ProjectGroup (expand/collapse, displays stats)
  - [x]Component tests for SessionRow (displays data, selection state)
  - [x]Integration test for SessionsPage (loading, empty, populated states)
  - [x]Test keyboard navigation on ProjectGroup (Enter/Space toggle)
  - [x]Mock `window.api.sessions` in tests

## Dev Notes

### Architecture Patterns & Constraints

**Three-Context Electron Architecture (CRITICAL):**
- **Renderer** (`src/renderer/`): ALL new code for this story lives here
- **Main** (`src/main/`): NO changes needed — session backend is complete from Story 1.5
- **Preload** (`src/preload/`): NO changes needed — `window.api.sessions.*` already exposed

**React Query Pattern (MANDATORY — no useState+useEffect for fetching):**
```typescript
// Query key format from architecture
const queryKey = ['sessions', 'list', filters]

// Fetch pattern — unwrap IpcResult
const fetchSessions = async (filters?: SessionFilters): Promise<Session[]> => {
  const result = await window.api.sessions.getAll(filters)
  if (!result.success) throw new Error(result.error.message)
  return result.data
}

// Hook
export function useSessions(filters?: SessionFilters) {
  return useQuery({
    queryKey: ['sessions', 'list', filters],
    queryFn: () => fetchSessions(filters)
  })
}
```

**Zustand — UI state only:**
- `expandedGroups` and `selectedSessionId` can live in component state (useState) since they don't need to persist
- OR use Zustand if the state needs to survive view switches. UX spec says "Remember expanded/collapsed state within a session" — so Zustand with `persist` middleware may be appropriate for expanded groups

**Component Library:** shadcn/ui components copied into `src/renderer/src/components/ui/`. Use `@/components/ui/...` imports. New shadcn components need to be installed with `npx shadcn@latest add <name>`.

**Path alias:** `@/` maps to `src/renderer/src/*` — use for all renderer imports.

### Feature File Structure

```
src/renderer/src/
├── features/
│   └── sessions/
│       ├── SessionsPage.tsx          # NEW — main view, assembles everything
│       ├── StatsBar.tsx              # NEW — 4 stats cards at top
│       ├── ProjectGroup.tsx          # NEW — collapsible project group row
│       ├── SessionRow.tsx            # NEW — individual session within group
│       └── use-sessions.ts           # NEW — React Query hooks
├── lib/
│   └── utils.ts                      # MODIFY — add formatting helpers
├── components/
│   ├── shared/
│   │   └── StatusBar.tsx             # MODIFY — wire up live data
│   └── ui/
│       ├── collapsible.tsx           # NEW — shadcn component
│       ├── card.tsx                  # NEW — shadcn component
│       ├── badge.tsx                 # NEW — shadcn component
│       ├── button.tsx               # NEW — shadcn component
│       └── skeleton.tsx             # NEW — shadcn component
└── App.tsx                           # MODIFY — replace sessions route placeholder
```

### Design System Requirements

**Colors (from CSS custom properties already in index.css):**
- Background: `var(--background-primary)`, `var(--background-elevated)`
- Text: `var(--text-primary)`, `var(--text-secondary)`, `var(--text-muted)`
- Accent: `var(--accent)` for active elements, durations, totals
- Project colors: `var(--project-1)` through `var(--project-8)` — deterministic assignment by hashing projectPath
- Border: `var(--surface-border)`

**Typography:**
- Font: System font stack (already configured as `font-sans` in Tailwind)
- Monospace: `font-mono` class for all numeric/time values
- Stats card labels: 11px, uppercase, letter-spacing, muted
- Stats card values: 24px, monospace, weight 700
- Body/row text: 13px
- Status badges: 10px, weight 600, uppercase

**Layout:**
- StatsBar: 4-column CSS grid, gap 12px. Stacks 2x2 below 1024px
- ProjectGroup row: 48px height, full-width click target
- SessionRow: 40px height, indented 16px from project row, 2px left border in project color
- Scrollable session list (not the whole page — StatsBar stays fixed at top)

### Data Flow

```
App.tsx (route: /sessions)
  → SessionsPage.tsx
    → useSessions() → window.api.sessions.getAll() → IPC → main → DB
    → useSessionStats() — derived from session data
    → useGroupedSessions() — groups sessions by projectPath
    → StatsBar (receives computed stats)
    → ProjectGroup[] (one per unique projectPath)
      → SessionRow[] (sessions within that project)
```

### Grouping Logic

Sessions are grouped by `projectPath` field. Each group:
- `projectPath` — full path, e.g., `C:\apps\ClawdTime`
- `projectName` — extracted last segment, e.g., `ClawdTime`
- `projectColor` — deterministic from 8-color palette (hash projectPath → index 0-7)
- `sessionCount` — number of sessions in group
- `totalDuration` — sum of `durationMinutes` across all sessions in group
- `sessions` — array of `Session` objects, sorted by `startedAt` descending (most recent first)

### Formatting Rules (from UX spec)

- **Duration:** `formatDuration(125)` → `"2h 5m"`, `formatDuration(45)` → `"45m"`, `formatDuration(0)` → `"0m"`
- **Time range:** `formatTimeRange(start, end)` → `"09:15 – 11:42"` (use en-dash, local time from ISO strings)
- **Relative time:** `formatRelativeTime(iso)` → `"2 min ago"`, `"1h ago"`, `"yesterday"`, `"Mar 3"`
- **Monospace rule:** ALL numeric/time data uses `font-mono` class
- **Right-align:** All numeric values (durations, counts) right-aligned in rows
- **Truncation:** Use `truncate` Tailwind class (ellipsis). Never wrap in data rows.

### Project Color Assignment

Deterministic color from 8-color palette:
```typescript
const PROJECT_COLORS = [
  'var(--project-1)', 'var(--project-2)', 'var(--project-3)', 'var(--project-4)',
  'var(--project-5)', 'var(--project-6)', 'var(--project-7)', 'var(--project-8)'
]

function getProjectColor(projectPath: string): string {
  let hash = 0
  for (const char of projectPath) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0
  return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length]
}
```

### Keyboard Navigation

- **Tab** into session list area
- **Arrow Up/Down** between project groups (collapsed) and session rows (when expanded)
- **Enter/Space** on ProjectGroup → toggle expand/collapse
- **Enter/Space** on SessionRow → select/deselect (open/close detail area)
- **Escape** closes any open detail panel
- All interactive elements have visible focus ring: `outline: 2px solid var(--accent)`

### Skeleton Loading Pattern

When `isLoading` is true:
- StatsBar: 4 skeleton cards (same dimensions as real cards)
- Session list: 3 skeleton ProjectGroup rows (48px each, no expand)
- Use shadcn `Skeleton` component with `bg-[var(--background-elevated)]`

### Empty State

When sessions array is empty and not loading:
- Use existing `EmptyState` component from `@/components/shared/EmptyState`
- Icon: `LayoutList` from lucide-react
- Title: "No Sessions Found"
- Description: "Run a scan to detect your Claude Code sessions"
- Action: `<Button onClick={scan}>Scan Now</Button>` triggering `useScanSessions()` mutation

### Testing Patterns

**Renderer tests use happy-dom** (default vitest config — no `// @vitest-environment node` directive needed).

**Mock `window.api` for all component/hook tests:**
```typescript
vi.stubGlobal('api', {
  sessions: {
    getAll: vi.fn(),
    scan: vi.fn(),
    getById: vi.fn()
  }
})
```

**React Query test wrapper:**
```typescript
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  })
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  )
}
```

**React Router test wrapper** (needed for components using `useNavigate`):
```typescript
import { MemoryRouter } from 'react-router'

function renderWithRouter(ui: React.ReactElement, { route = '/' } = {}) {
  return render(
    <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
  )
}
```

### Previous Story Intelligence

**Story 1.5 (Session Detection Engine) — What's available for this story:**
- `window.api.sessions.getAll(filters?)` → `IpcResult<Session[]>` — returns all sessions, optionally filtered
- `window.api.sessions.scan(claudeDir?)` → `IpcResult<ScanResult>` — triggers a scan
- `Session` type: `{ id, projectPath, startedAt, endedAt, durationMinutes, source, description, status, claudeSessionId, sourceFile, createdAt, updatedAt }`
- Sessions are sorted by `startedAt` ascending from the DB

**Story 1.2 (App Shell) — Existing patterns:**
- `ActivityBar` with VS Code-style nav, `StatusBar` at bottom, `EmptyState` component
- `useUIStore` Zustand store with `activeView` persistence
- Routes defined in `App.tsx` with `createMemoryRouter`
- `TooltipProvider` wraps root layout
- `Toaster` (sonner) at root level

**Story 1.3 (Database) — Key patterns:**
- `IpcResult<T>` type: `{ success: true, data: T } | { success: false, error: { code, message } }`
- React Query client configured with 30s staleTime, retry: 1, no refetch on window focus

### Anti-Patterns (NEVER do)

- `useState` + `useEffect` for data fetching — use React Query
- `console.log` — not needed in renderer (use React Query devtools if debugging)
- `any` type — always type explicitly
- Import from `src/main/` or `src/preload/` — renderer ONLY imports from `@/...` and `../../shared/types/`
- Raw CSS — use Tailwind classes and CSS custom properties
- Manual loading boolean state — React Query handles `isLoading`/`isFetching`

### Library/Framework Requirements

| Library | Version | Notes for this story |
|---------|---------|---------------------|
| @tanstack/react-query | 5.x | `useQuery`, `useMutation`, `useQueryClient` |
| react-router | 7.x | `createMemoryRouter`, `Outlet` (already configured) |
| zustand | 5.x | Only if expanded state needs to persist across view switches |
| lucide-react | latest | Icons: `ChevronRight`, `LayoutList`, `Clock`, `Activity`, `Hash`, `Zap` |
| shadcn/ui | latest | collapsible, card, badge, button, skeleton |

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 1.6 — Acceptance Criteria, BDD format]
- [Source: _bmad-output/planning-artifacts/architecture.md — Frontend Architecture, React Query patterns, component structure]
- [Source: _bmad-output/planning-artifacts/architecture.md — Implementation Patterns, Naming Conventions, Anti-Patterns]
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md — ProjectGroup, SessionRow, StatsBar, StatusBar specs]
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md — Color system, typography, spacing, keyboard nav]
- [Source: src/renderer/src/App.tsx — Current route structure, RootLayout, providers]
- [Source: src/renderer/src/components/shared/StatusBar.tsx — Current StatusBar implementation]
- [Source: src/renderer/src/components/shared/EmptyState.tsx — EmptyState component API]
- [Source: src/renderer/src/stores/use-ui-store.ts — Zustand store pattern]
- [Source: src/renderer/src/lib/query-client.ts — Query client configuration]
- [Source: src/shared/types/session.ts — Session, SessionFilters, ScanResult types]
- [Source: src/preload/index.d.ts — window.api.sessions API surface]
- [Source: _bmad-output/implementation-artifacts/1-5-session-detection-engine.md — Backend implementation details]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

- better-sqlite3 NODE_MODULE_VERSION mismatch — run `npm run rebuild:node` before tests, `npm run rebuild:electron` for dev
- shadcn Collapsible removes children from DOM when closed (not just hidden) — tests should check `not.toBeInTheDocument()` not `not.toBeVisible()`
- React Query mutation `useScanSessions()` is async — tests need `await waitFor()` after triggering scan click

### Completion Notes List

- Task 1: Installed 5 shadcn/ui components: collapsible, card, badge, button, skeleton. Also installed `class-variance-authority` dependency.
- Task 2: Created `use-sessions.ts` with `useSessions()`, `useScanSessions()`, `useSessionStats()`, `useGroupedSessions()`. Groups sorted by total duration descending, sessions within groups sorted most-recent-first.
- Task 3: Created `format.ts` with formatDuration, formatTimeRange (en-dash separator), formatRelativeTime, getProjectColor (deterministic hash → 8-color palette), getProjectName. 18 unit tests.
- Task 4: Created `StatsBar.tsx` with 4 stat cards in responsive CSS grid (auto-fit minmax). Skeleton variant for loading. Today's Total uses accent color.
- Task 5: Created `ProjectGroup.tsx` using shadcn Collapsible. 48px trigger row with rotating chevron, color dot, name, count badge, duration. Full ARIA support: role=group, aria-expanded, aria-label. Enter/Space keyboard toggle. 8 tests.
- Task 6: Created `SessionRow.tsx`. 40px height, indented, 2px left border in project color. Time range + Auto/Manual badge + duration. Selection state with elevated bg. ARIA: role=button, aria-expanded. 7 tests.
- Task 7: Created `SessionsPage.tsx` assembling StatsBar + ProjectGroup list. expandedGroups Set + selectedSessionId state. Loading/empty/populated states. Scan Now button triggers mutation. 5 integration tests.
- Task 8: Rewrote `StatusBar.tsx` from props-based to hooks-based using useSessions/useSessionStats internally. Shows project count, last scan status, daily total in accent monospace. Added role=status, aria-live=polite. Updated 3 tests.
- Task 9: Updated App.tsx route `/sessions` to render `<SessionsPage />` instead of EmptyState placeholder. Removed unused LayoutList import.
- Task 10: All tests written across tasks. 122 total tests passing (41 new for this story). Covers: format utilities (18), StatsBar (3), ProjectGroup (8), SessionRow (7), SessionsPage (5), StatusBar (3 updated).

### Change Log

- 2026-03-04: Implemented Story 1.6 — Sessions View grouped by project. All 10 tasks complete, 122 tests passing (41 new).

### File List

- src/renderer/src/features/sessions/use-sessions.ts (NEW)
- src/renderer/src/features/sessions/SessionsPage.tsx (NEW)
- src/renderer/src/features/sessions/StatsBar.tsx (NEW)
- src/renderer/src/features/sessions/StatsBar.test.tsx (NEW)
- src/renderer/src/features/sessions/ProjectGroup.tsx (NEW)
- src/renderer/src/features/sessions/ProjectGroup.test.tsx (NEW)
- src/renderer/src/features/sessions/SessionRow.tsx (NEW)
- src/renderer/src/features/sessions/SessionRow.test.tsx (NEW)
- src/renderer/src/features/sessions/SessionsPage.test.tsx (NEW)
- src/renderer/src/lib/format.ts (NEW)
- src/renderer/src/lib/format.test.ts (NEW)
- src/renderer/src/components/shared/StatusBar.tsx (MODIFIED — hooks-based)
- src/renderer/src/components/shared/StatusBar.test.tsx (MODIFIED — updated for hooks)
- src/renderer/src/App.tsx (MODIFIED — sessions route uses SessionsPage)
- src/renderer/src/components/ui/collapsible.tsx (NEW — shadcn)
- src/renderer/src/components/ui/card.tsx (NEW — shadcn)
- src/renderer/src/components/ui/badge.tsx (NEW — shadcn)
- src/renderer/src/components/ui/button.tsx (NEW — shadcn)
- src/renderer/src/components/ui/skeleton.tsx (NEW — shadcn)
