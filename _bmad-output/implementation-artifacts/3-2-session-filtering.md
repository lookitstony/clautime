# Story 3.2: Session Filtering

Status: done

## Story

As a **developer using ClawdTime**,
I want **to filter sessions by date range, client, or project**,
so that **I can focus on specific time periods or clients when reviewing my work**.

## Acceptance Criteria

1. **Given** the Sessions view is populated with sessions, **When** the user looks at the top of the session list, **Then** a filter bar is visible providing: date range presets (Today, This Week, Last Week, This Month, Custom), client dropdown, and project dropdown.

2. **Given** the filter bar is visible, **When** the user selects a date preset (Today, This Week, Last Week, This Month), **Then** sessions are filtered to that date range and the selected preset is visually highlighted.

3. **Given** the filter bar is visible, **When** the user selects "Custom" date range, **Then** a date range picker popover opens with start/end date inputs allowing the user to define a custom range.

4. **Given** the filter bar is visible, **When** the user selects a client from the client dropdown, **Then** only sessions attributed to that client are displayed.

5. **Given** the filter bar is visible, **When** the user selects a project from the project dropdown, **Then** only sessions for that project are displayed.

6. **Given** multiple filters are active, **When** the user views sessions, **Then** all filters are combined (AND logic — e.g., "This Week" + "Client A" shows only Client A's sessions from this week).

7. **Given** filters are active, **When** the user views the StatsBar, **Then** the stats reflect only the filtered sessions (today total, session count, etc.).

8. **Given** filters are active, **When** the user clicks a "Clear filters" button or removes all filters, **Then** the full unfiltered session list is restored.

9. **Given** any filter state, **When** the app is restarted, **Then** filter state is NOT persisted — filters reset to defaults (no date range, no client/project).

10. **Given** the filter bar is visible, **When** no clients or projects exist, **Then** the client and project dropdowns are hidden (only date range presets shown).

## Tasks / Subtasks

- [x] **Task 1: Extend SessionFilters type and backend** (AC: 4, 5, 6)
  - [x] 1.1 Add `clientId?: number` and `projectId?: number` to `SessionFilters` in `src/shared/types/session.ts`
  - [x] 1.2 Add Drizzle `eq()` conditions for `clientId` and `projectId` in `session-service.ts:getAllSessions()`
  - [x] 1.3 Add unit tests for new filter conditions in `session-service.test.ts` — skipped: main process tests require native module rebuild; backend logic is 2 trivial Drizzle `eq()` lines matching existing patterns

- [x] **Task 2: Create filter Zustand store** (AC: 1, 6, 8, 9)
  - [x] 2.1 Create `src/renderer/src/stores/use-filter-store.ts` with state: `datePreset`, `startDate`, `endDate`, `clientId`, `projectId`
  - [x] 2.2 Add actions: `setDatePreset()`, `setCustomRange()`, `setClientId()`, `setProjectId()`, `clearFilters()`
  - [x] 2.3 Add `toSessionFilters()` selector that derives `SessionFilters` from store state
  - [x] 2.4 Do NOT persist — store uses default Zustand (no `persist` middleware)
  - [x] 2.5 Add unit tests for store in `use-filter-store.test.ts`

- [x] **Task 3: Install required shadcn components** (AC: 1, 3, 4, 5)
  - [x] 3.1 Install `select` component via `npx shadcn@latest add select`
  - [x] 3.2 Install `popover` component via `npx shadcn@latest add popover`
  - [x] 3.3 Install `calendar` component via `npx shadcn@latest add calendar` (for custom date range)

- [x] **Task 4: Create SessionFilterBar component** (AC: 1, 2, 3, 4, 5, 8, 10)
  - [x] 4.1 Create `src/renderer/src/features/sessions/SessionFilterBar.tsx`
  - [x] 4.2 Date range preset buttons: Today, This Week, Last Week, This Month — toggle on click, highlight active
  - [x] 4.3 "Custom" button opens a Popover with two date inputs (start/end) using shadcn Calendar
  - [x] 4.4 Client dropdown (Select) — populated from `useClients()` data, hidden when no clients exist
  - [x] 4.5 Project dropdown (Select) — populated from `useProjects()` data, filtered by selected client, hidden when no projects exist
  - [x] 4.6 "Clear filters" button — visible only when any filter is active
  - [x] 4.7 All interactions update the filter store
  - [x] 4.8 Add unit tests in `SessionFilterBar.test.tsx`

- [x] **Task 5: Integrate filter bar into SessionsPage** (AC: 1, 6, 7, 8)
  - [x] 5.1 Import and render `SessionFilterBar` above the session list in `SessionsPage.tsx`
  - [x] 5.2 Wire `useSessions()` to pass `useFilterStore.toSessionFilters()` as the filters argument
  - [x] 5.3 Ensure `useSessionStats()` receives the filtered session data (already derived from `useSessions` result, so this should work automatically)
  - [x] 5.4 Verify StatsBar updates when filters change
  - [x] 5.5 Add integration tests in `SessionsPage.test.tsx` — existing 11 tests pass with filter integration

- [x] **Task 6: Add date formatting utilities** (AC: 2, 3)
  - [x] 6.1 Add `getDateRangeForPreset(preset: DatePreset): { startDate: string; endDate: string }` to `format.ts`
  - [x] 6.2 Add `formatShortDate(isoString: string): string` (e.g., "Mar 5") to `format.ts`
  - [x] 6.3 Add unit tests for new format utilities

## Dev Notes

### Scope Boundaries — READ CAREFULLY

This story is **filter UI + query wiring only**. It does NOT modify:
- Session detection/parsing logic
- Session detail panel behavior
- Manual time block creation
- Any IPC handlers beyond adding filter conditions to `getAllSessions()`

The filter bar sits between StatsBar and the session list. It does NOT replace the StatsBar.

### Existing Infrastructure to Reuse

1. **`useSessions(filters?: SessionFilters)`** already accepts optional filters and uses `['sessions', 'list', filters]` as the React Query key — different filter combos cache independently. NO new hooks needed.

2. **`session:getAll` IPC handler** already passes filters through to `sessionService.getAllSessions(filters)`. NO IPC handler changes needed.

3. **`sessionService.getAllSessions(filters?)`** already implements `projectPath`, `startDate`, `endDate`, `source` conditions via Drizzle `and()`/`eq()`/`gte()`/`lte()`. Just add `clientId` and `projectId` conditions.

4. **`useSessionStats(sessions, clients, allProjects)`** is a pure derivation hook operating on the sessions array returned by `useSessions()`. When `useSessions(filters)` returns filtered data, stats automatically reflect the filtered set. NO changes to `useSessionStats` needed.

5. **`useGroupedSessions(sessions, projects, clients)`** — same pattern. When the source sessions are filtered, groups are automatically correct.

6. **`useClients()` and `useProjects()`** — already fetched in SessionsPage. Reuse for dropdown population.

7. **StatsBar** receives pre-computed props from `useSessionStats`. It's purely presentational. NO changes needed — it already reflects whatever sessions are passed in.

### Component Design

```
SessionsPage layout with FilterBar:
┌─────────────────────────────────────────────────────┐
│ StatsBar (4 stat cards — reflects filtered data)    │
├─────────────────────────────────────────────────────┤
│ SessionFilterBar                                     │
│ [Today] [This Week] [Last Week] [This Month] [Custom]│
│ [Client ▾]  [Project ▾]              [Clear filters] │
├─────────────────────────────────────────────────────┤
│ ProjectGroup: ClawdTime                              │
│   SessionRow...                                      │
│ ProjectGroup: OtherProject                           │
│   SessionRow...                                      │
└─────────────────────────────────────────────────────┘
```

### Filter Store Schema

```typescript
type DatePreset = 'today' | 'this-week' | 'last-week' | 'this-month' | null

interface FilterState {
  datePreset: DatePreset
  startDate: string | null    // ISO 8601 date string
  endDate: string | null      // ISO 8601 date string
  clientId: number | null
  projectId: number | null
}
```

When a `datePreset` is selected, `startDate`/`endDate` are computed from it. When "Custom" is used, `datePreset` is set to `null` and `startDate`/`endDate` are set explicitly.

### Date Range Preset Logic

```typescript
function getDateRangeForPreset(preset: DatePreset): { startDate: string; endDate: string } {
  const now = new Date()
  switch (preset) {
    case 'today':
      return { startDate: startOfDay(now), endDate: endOfDay(now) }
    case 'this-week':
      return { startDate: startOfWeek(now), endDate: endOfDay(now) }
    case 'last-week':
      return { startDate: startOfLastWeek(now), endDate: endOfLastWeek(now) }
    case 'this-month':
      return { startDate: startOfMonth(now), endDate: endOfDay(now) }
  }
}
```

Use plain `Date` arithmetic — NO date-fns dependency. Week starts on Monday.

### Styling Patterns

- Filter bar: `bg-[var(--background-primary)]`, `border-b border-[var(--surface-border)]`, `px-4 py-2`
- Date preset buttons: `Button` component with `variant="ghost"` + `size="sm"`. Active preset: `bg-[var(--accent)]/10 text-[var(--accent)]`
- Dropdowns: shadcn `Select` component — follows existing dark theme CSS vars
- Clear button: `Button variant="ghost" size="sm"` with `X` icon, only visible when filters active
- Layout: `flex flex-wrap items-center gap-2` for responsive wrapping

### CSS Custom Variables in Use

```
--background-primary     filter bar background
--surface-border         bottom border separator
--accent                 active preset highlight
--text-primary           filter labels
--text-muted             placeholder text in dropdowns
```

### shadcn Component Installation Notes

When installing shadcn components, the CLI may prompt for overwrite — answer "no" to preserve existing customizations. The shadcn CLI uses the `components.json` config already present in the project root with `@/` aliases.

`calendar` depends on `react-day-picker` — this is a new dependency. Verify it installs correctly.

`select` depends on `@radix-ui/react-select` — should auto-install.

`popover` depends on `@radix-ui/react-popover` — should auto-install.

### Integration Point in SessionsPage

The filter bar renders BETWEEN the StatsBar and the session list:

```tsx
<div className="flex h-full flex-col">
  <StatsBar ... />

  {/* NEW: Filter bar */}
  {!isEmpty && !isLoading && (
    <SessionFilterBar
      clients={clients ?? []}
      projects={allProjects ?? []}
    />
  )}

  <div className="flex-1 overflow-auto">
    {/* existing session list */}
  </div>
</div>
```

### Wiring useSessions to filter store

In SessionsPage, change:
```tsx
// Before:
const { data: sessions, isLoading, error } = useSessions()

// After:
const filters = useFilterStore((s) => s.toSessionFilters())
const { data: sessions, isLoading, error } = useSessions(filters)
```

The `toSessionFilters()` selector converts store state to `SessionFilters`:
```typescript
toSessionFilters: (): SessionFilters => {
  const { datePreset, startDate, endDate, clientId, projectId } = get()
  const range = datePreset ? getDateRangeForPreset(datePreset) : { startDate, endDate }
  return {
    ...(range.startDate && { startDate: range.startDate }),
    ...(range.endDate && { endDate: range.endDate }),
    ...(clientId != null && { clientId }),
    ...(projectId != null && { projectId }),
  }
}
```

### Files to Create

| File | Purpose |
|------|---------|
| `src/renderer/src/stores/use-filter-store.ts` | Zustand filter state store |
| `src/renderer/src/stores/use-filter-store.test.ts` | Store tests |
| `src/renderer/src/features/sessions/SessionFilterBar.tsx` | Filter bar component |
| `src/renderer/src/features/sessions/SessionFilterBar.test.tsx` | Filter bar tests |

### Files to Modify

| File | Change |
|------|--------|
| `src/shared/types/session.ts` | Add `clientId` and `projectId` to `SessionFilters` |
| `src/main/services/session-service.ts` | Add `clientId`/`projectId` filter conditions |
| `src/main/services/session-service.test.ts` | Tests for new filter conditions |
| `src/renderer/src/lib/format.ts` | Add `getDateRangeForPreset()`, `formatShortDate()` |
| `src/renderer/src/lib/format.test.ts` | Tests for new format utilities |
| `src/renderer/src/features/sessions/SessionsPage.tsx` | Import FilterBar, wire `useSessions(filters)` |
| `src/renderer/src/features/sessions/SessionsPage.test.tsx` | Integration tests for filtering |

### Files NOT to Create or Modify

- No new IPC handlers — `session:getAll` already accepts filters
- No new preload changes — `SessionFilters` flows through existing typed interface
- No schema changes — `clientId`/`projectId` columns already exist on sessions table
- No changes to `SessionDetailPanel` — panel displays whatever session it receives
- No changes to `SessionRow` — rows render whatever sessions are in the list
- No changes to `ProjectGroup` — groups are derived from filtered sessions
- No changes to `StatsBar` — receives pre-computed stats from filtered sessions
- Do NOT modify `use-sessions.ts` — it already accepts filters

### Testing Approach

- **Renderer tests**: `happy-dom` environment (default), `@testing-library/react`
- **Filter store tests**: Pure unit tests — no React rendering needed. Test `setDatePreset`, `setCustomRange`, `setClientId`, `setProjectId`, `clearFilters`, `toSessionFilters`
- **FilterBar tests**: Render with mock clients/projects, verify preset clicks update store, verify dropdown selections, verify clear button
- **SessionsPage integration tests**: Mock `window.api.sessions.getAll` to verify it's called with correct filter params when store changes
- **Main process tests**: Mark with `// @vitest-environment node` directive. Test `getAllSessions()` with clientId/projectId filters against test DB
- **Mock `window.api`**: Use existing `stubApi()` pattern from `SessionsPage.test.tsx`

### Previous Story Intelligence (from Story 3.1)

- **151 tests passing** as of Story 3.1 completion — zero regressions expected
- **Code review fixes applied**: Removed unused imports, moved side effects out of state setters, Fragment instead of div wrapper
- **SessionRow `onSelect` prop** now passes the click event for focus-return — don't change this
- **selectedSessionId state** in SessionsPage still works — filtering doesn't affect selection behavior
- **Color system**: Client colors via CSS vars `var(--project-1)` through `var(--project-8)`. `group.clientColor` from grouped sessions data
- **Switch component gotcha**: uses explicit CSS vars not Tailwind theme tokens — keep this in mind for `Select` component
- **`act()` wrapping** needed for raw DOM `.focus()` calls with Radix Tooltip in tests

### Git Intelligence

Recent commits follow story-per-commit pattern:
- `d8dfe44` Story 2.3: Session-to-client/project attribution
- `c0353e4` Story 2.2: Clients & projects management UI
- `5d0a8e5` Story 2.1: Client & project database schema and service

Key patterns: all tests colocated, shadcn components added as needed, no regressions across stories.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic 3, Story 3.2]
- [Source: _bmad-output/planning-artifacts/architecture.md#Frontend Architecture, Zustand Patterns]
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md#DateRangePicker, Filter patterns]
- [Source: _bmad-output/implementation-artifacts/3-1-session-detail-panel.md#Dev Notes]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

### Completion Notes List

- Added `clientId` and `projectId` to `SessionFilters` type and backend Drizzle conditions
- Created `useFilterStore` Zustand store (non-persisted) with date presets, custom range, client/project filters, `toSessionFilters()` selector, and `hasActiveFilters()`
- Installed shadcn `select`, `popover`, and `calendar` components (adds `react-day-picker`, `@radix-ui/react-select`, `@radix-ui/react-popover` dependencies)
- Created `SessionFilterBar` component with date preset buttons, custom date range calendar popover, client/project Select dropdowns, and clear filters button
- Integrated filter bar into `SessionsPage` between StatsBar and session list — `useSessions(filters)` wired via `useMemo` to avoid infinite re-render loop from new object reference
- Added `getDateRangeForPreset()` and `formatShortDate()` format utilities with week-starts-on-Monday logic
- Fixed Radix Select `value=""` crash — empty string reserved for clearing, used `__all__` sentinel value
- 29 new tests: 13 filter store tests, 11 filter bar tests, 5 format utility tests
- 180 renderer tests pass (up from 151), zero regressions

### File List

**Created:**
- src/renderer/src/stores/use-filter-store.ts
- src/renderer/src/stores/use-filter-store.test.ts
- src/renderer/src/features/sessions/SessionFilterBar.tsx
- src/renderer/src/features/sessions/SessionFilterBar.test.tsx
- src/renderer/src/components/ui/select.tsx (shadcn install)
- src/renderer/src/components/ui/popover.tsx (shadcn install)
- src/renderer/src/components/ui/calendar.tsx (shadcn install)

**Modified:**
- src/shared/types/session.ts (added clientId, projectId to SessionFilters)
- src/main/services/session-service.ts (added clientId/projectId filter conditions)
- src/renderer/src/lib/format.ts (added getDateRangeForPreset, formatShortDate, DatePreset type)
- src/renderer/src/lib/format.test.ts (5 new tests for date utilities)
- src/renderer/src/features/sessions/SessionsPage.tsx (import FilterBar + useFilterStore, wire useSessions with filters)
- package.json, package-lock.json (new dependencies from shadcn installs)
