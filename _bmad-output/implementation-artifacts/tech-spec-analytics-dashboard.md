---
title: 'Customizable Analytics Dashboard'
slug: 'analytics-dashboard'
created: '2026-03-06'
status: 'completed'
stepsCompleted: [1, 2, 3, 4]
tech_stack: ['react-19', 'typescript', 'recharts-2.15', 'dnd-kit-react', 'tanstack-query-v5', 'tailwind-v4', 'shadcn-ui']
files_to_modify:
  - 'src/renderer/src/App.tsx'
  - 'src/renderer/src/components/shared/ActivityBar.tsx'
files_to_create:
  - 'src/renderer/src/features/analytics/AnalyticsPage.tsx'
  - 'src/renderer/src/features/analytics/use-analytics.ts'
  - 'src/renderer/src/features/analytics/widget-registry.ts'
  - 'src/renderer/src/features/analytics/WidgetPanel.tsx'
  - 'src/renderer/src/features/analytics/DashboardGrid.tsx'
  - 'src/renderer/src/features/analytics/chart-theme.ts'
  - 'src/renderer/src/features/analytics/widgets/DailyHoursChart.tsx'
  - 'src/renderer/src/features/analytics/widgets/HoursByProjectChart.tsx'
  - 'src/renderer/src/features/analytics/widgets/HoursByClientChart.tsx'
  - 'src/renderer/src/features/analytics/widgets/TokenUsageChart.tsx'
  - 'src/renderer/src/features/analytics/widgets/PromptsPerDayChart.tsx'
  - 'src/renderer/src/features/analytics/widgets/BillableEarningsChart.tsx'
  - 'src/renderer/src/features/analytics/widgets/SessionLengthChart.tsx'
  - 'src/renderer/src/features/analytics/widgets/PeakHoursChart.tsx'
code_patterns:
  - 'IPC: ipcMain.handle + ipcRenderer.invoke with IpcResult<T> — MUST unwrap with success check'
  - 'Data fetching: React Query v5 useQuery with queryFn unwrap-or-throw pattern'
  - 'Routing: createMemoryRouter in App.tsx, NavItem[] in ActivityBar'
  - 'Settings: key-value strings in app_settings via settings:set/get IPC'
  - 'Filter sentinel: __all__ for all options in Select components'
  - 'Date presets: getDateRangeForPreset() from lib/date'
test_patterns:
  - 'Framework: vitest + @testing-library/react + userEvent'
  - 'Router: createMemoryRouter with route children'
  - 'Tooltips: wrap with TooltipProvider delayDuration={0}'
---

# Tech-Spec: Customizable Analytics Dashboard

**Created:** 2026-03-06

## Overview

### Problem Statement

ClawdTime has rich session, project, and client data but no visual analytics. Users can only view data in tabular reports — no charts, trends, or at-a-glance insights into their work patterns, token usage, or billing.

### Solution

Add a new "Analytics" page with a fully customizable grid dashboard. Users choose from 8 chart widgets, drag/drop to reorder, resize via predefined size presets, and filter all widgets with a shared date range bar. Layout is persisted to the database so it survives restarts.

### Scope

**In Scope:**
- New `/analytics` route with ActivityBar icon
- 8 chart widgets: daily hours (stacked bar), hours by project (donut), hours by client (donut), token usage over time (bar), prompts per day (area), billable earnings (bar), session length distribution (histogram), peak activity hours (horizontal bar)
- Drag/drop reorder via `@dnd-kit/react` (React 19 compatible)
- Widget size presets (small/medium/large) via context menu or button
- Layout persistence (widget selection, positions, sizes) via app_settings
- Shared date range filter bar with presets (today, this week, this month, last month, custom, all-time) — defaults to "this week"
- Recharts 2.15.x for all visualizations
- Widget add/remove panel (shadcn Popover) to toggle which charts are visible

**Out of Scope:**
- Per-widget date filters
- Data export from individual charts
- Real-time streaming / live-updating charts
- Print/PDF of dashboard
- Free-form pixel-level resize (use size presets instead for React 19 compatibility)

## Context for Development

### Codebase Patterns

- **IPC pattern**: `ipcMain.handle` + `ipcRenderer.invoke` with `IpcResult<T>` wrapper. **CRITICAL**: All `queryFn` calls MUST unwrap `IpcResult` — check `result.success`, throw on error, return `result.data`. See `use-reports.ts` for the pattern.
- React Query v5 for data fetching — use `useQuery` with the unwrap-or-throw pattern
- Routes defined in `App.tsx` via `createMemoryRouter`, nav icons via `NavItem[]` in `ActivityBar.tsx`
- Settings persisted via `settings:set` / `settings:get` IPC (key-value strings in `app_settings` table, upsert on write)
- Tailwind CSS v4 (CSS-first, no config file), shadcn/ui (new-york style)
- Path alias `@/` → `src/renderer/src/*`
- Date presets: `getDateRangeForPreset()` from `lib/date`, plus manual `getLastMonthRange()` in ReportsPage
- Filter sentinel pattern: `__all__` string for "all" option in Select components
- ActivityBar: `NavItem[]` array with `{ icon: LucideIcon, label: string, route: string }`, keyboard nav with ArrowUp/ArrowDown

### Data Shapes Available (from report-service.ts)

**SessionLineItem** — per-session granularity:
```
{ date, projectName, clientName, startedAt, endedAt, durationMinutes, promptCount, inputTokens, outputTokens, description, source }
```
- `date` is a **formatted label** (e.g., "Mon, Mar 4, 2026") — NOT sortable. Use `startedAt` (ISO string) for date sorting/grouping.

**DailySummaryItem** — daily aggregation:
```
{ date, sessionCount, totalDurationMinutes, totalPrompts, totalInputTokens, totalOutputTokens, projects[] }
```
- `date` is a **formatted label** — NOT sortable. Data arrives pre-sorted from the service but widgets should not rely on label sort order.
- `projects` is a `string[]` of project names active that day — contains **no per-project duration breakdown**.

**PeriodProjectItem** — project-level aggregation:
```
{ projectName, clientName, sessionCount, totalDurationMinutes, totalPrompts, totalInputTokens, totalOutputTokens }
```

**ReportSummary** — always included with every report result:
```
{ totalSessions, totalDurationMinutes, totalPrompts, totalInputTokens, totalOutputTokens, totalBilledCost, billedByClient[] }
```

**billedByClient entry**: `{ clientName, hours, rate, cost }`

### Widget → Data Mapping

All widgets receive the full `WidgetProps` (session + summary data). Each widget picks what it needs.

| Widget | Primary Data | Key Fields | Notes |
| ------ | ------------ | ---------- | ----- |
| Daily Hours (stacked bar) | SessionLineItem[] | startedAt, projectName, durationMinutes | Group by date+project client-side. Use `startedAt` for date axis. |
| Hours by Project (donut) | PeriodProjectItem[] | projectName, totalDurationMinutes | Derived client-side from session data |
| Hours by Client (donut) | PeriodProjectItem[] | clientName, totalDurationMinutes | Derived client-side from session data |
| Token Usage (bar) | SessionLineItem[] | startedAt, inputTokens, outputTokens | Group by date client-side |
| Prompts per Day (area) | SessionLineItem[] | startedAt, promptCount | Group by date client-side |
| Billable Earnings (bar) | ReportSummary.billedByClient | clientName, hours, rate, cost | From summary |
| Session Length (histogram) | SessionLineItem[] | durationMinutes | Bucket into ranges |
| Peak Hours (horizontal bar) | SessionLineItem[] | startedAt (extract hour) | Count per hour |

### Data Strategy — Single IPC Call

**IMPORTANT**: Fetch only `session-breakdown` format via a single IPC call. This returns `SessionLineItem[]` + `ReportSummary` (with billing). Derive all other aggregations client-side:

- **Daily aggregation**: group `SessionLineItem[]` by `startedAt` date (YYYY-MM-DD)
- **Period/project aggregation**: group by `projectName`, sum durations/tokens/prompts
- **Period/client aggregation**: group by `clientName`, sum durations/tokens/prompts

This avoids 3 redundant IPC calls that each re-query the database and recompute billing.

### Files to Reference

| File | Purpose |
| ---- | ------- |
| `src/renderer/src/App.tsx` | Router — add `/analytics` route |
| `src/renderer/src/components/shared/ActivityBar.tsx` | Nav — add Analytics icon (`BarChart3` from lucide) |
| `src/renderer/src/features/reports/ReportsPage.tsx` | Date filter pattern, Select components, filter state |
| `src/renderer/src/features/reports/use-reports.ts` | IpcResult unwrap pattern in mutation queryFn |
| `src/main/services/report-service.ts` | Report generation — data shapes, billing calc |
| `src/shared/types/report.ts` | ReportFilters, ReportResult, ReportFormat, all item types |
| `src/renderer/src/lib/date.ts` | `getDateRangeForPreset()`, `DatePreset` type |

### Technical Decisions

- **`@dnd-kit/react` (v0.3.x)** instead of `react-grid-layout`: react-grid-layout depends on `react-draggable` which uses `findDOMNode` (removed in React 19, causes runtime crash). `@dnd-kit/react` is React 19 compatible, supports keyboard accessibility via `KeyboardSensor`, and is actively maintained.
- **Size presets instead of free-form resize**: Since we're not using react-grid-layout's built-in resize, widgets get 3 size options (small/medium/large) via a button or context menu. This is simpler, more accessible, and avoids the `react-resizable` dependency (also uses `findDOMNode`).
- **CSS Grid for layout**: Use CSS `display: grid` with `grid-template-columns` for the dashboard grid. `@dnd-kit` handles reorder via drag/drop. Grid reflows automatically.
- **Single IPC call**: Fetch `session-breakdown` format only. Derive daily/project/client aggregations client-side with `useMemo`. Eliminates 2 redundant database queries.
- **Recharts 2.15.x pinned**: Pin to `~2.15.0` to avoid breaking changes between minor versions.
- **Layout stored as JSON string** in `app_settings` key `analytics_dashboard_layout`
- **Widget registry pattern**: centralized config maps widget IDs to components, default sizes, titles
- **Chart theming**: `useChartColors()` hook subscribes to theme changes via `MutationObserver` on `<html>` element's `data-theme` attribute. Returns reactive color palette.
- **Default state**: page loads with `this-week` date preset and all 8 widgets visible
- **Recharts `ResponsiveContainer`**: all charts use `width="100%" height="100%"` for auto-sizing within their grid cells

## Implementation Plan

### Tasks

- [x] **Task 1: Install dependencies**
  - Action: `npm install recharts@~2.15.0 @dnd-kit/react`
  - Notes: `@dnd-kit/react` v0.3.x includes `@dnd-kit/core` and `@dnd-kit/dom` as dependencies. No CSS imports needed (unlike react-grid-layout).

- [x] **Task 2: Create chart theme utility**
  - File: `src/renderer/src/features/analytics/chart-theme.ts`
  - Action: Export `useChartColors()` hook
  - Details:
    - Use `useSyncExternalStore` with a `MutationObserver` on `document.documentElement` to reactively track `data-theme` and `data-accent` attribute changes
    - Read CSS variables via `getComputedStyle`: `--accent`, `--text-primary`, `--text-muted`, `--surface-border`, `--background-elevated`
    - Export a `CHART_PALETTE` array of 10 distinct HSL colors that work in both dark and light themes (vary hue at consistent 55% saturation, 60% lightness for dark, 45% lightness for light)
    - Return: `{ accent, textColor, mutedColor, gridColor, bgColor, palette: string[] }`
    - Re-renders consumers when theme or accent changes

- [x] **Task 3: Create widget registry**
  - File: `src/renderer/src/features/analytics/widget-registry.ts`
  - Action: Define `WidgetConfig` type, `WidgetProps` type, `WIDGET_REGISTRY` map, and `DEFAULT_LAYOUT`
  - Details:
    ```typescript
    type WidgetSize = 'small' | 'medium' | 'large'

    interface WidgetConfig {
      id: string
      title: string
      icon: LucideIcon  // from lucide-react, for the WidgetPanel toggle list
      defaultSize: WidgetSize
      component: React.ComponentType<WidgetProps>
    }

    interface WidgetProps {
      sessionData: SessionLineItem[]
      summaryData: ReportSummary | null
    }

    // Size maps to CSS grid column spans:
    // small = 1 col (half width), medium = 1 col (half width), large = 2 cols (full width)
    // small height = 250px, medium height = 350px, large height = 400px
    const SIZE_CONFIG: Record<WidgetSize, { colSpan: number; height: number }>

    interface DashboardLayout {
      widgets: { id: string; size: WidgetSize }[]  // ordered array = display order
    }
    ```
  - Define 8 widget entries with IDs: `daily-hours`, `hours-by-project`, `hours-by-client`, `token-usage`, `prompts-per-day`, `billable-earnings`, `session-length`, `peak-hours`
  - Each entry has an appropriate lucide icon (e.g., `BarChart3`, `PieChart`, `Coins`, `Clock`, `Zap`, `TrendingUp`)
  - Export `DEFAULT_LAYOUT`: all 8 widgets visible, alternating medium sizes, in a sensible default order

- [x] **Task 4: Create chart widget components (8 files)**
  - Directory: `src/renderer/src/features/analytics/widgets/`
  - Each widget receives `WidgetProps` and renders a Recharts chart
  - **All widgets must**:
    - Use `ResponsiveContainer` from Recharts (`width="100%" height="100%"`) for auto-sizing
    - Use `useChartColors()` for all colors (axis text, grid lines, series colors)
    - Handle empty data gracefully — show centered "No data for this period" message styled with `text-[var(--text-muted)]`
    - Use `useMemo` to transform/aggregate data from `sessionData` to avoid recomputation on re-render
    - Use `startedAt` ISO string for date grouping/sorting — format to short label (e.g., "Mar 4") for display only
  - Widget specifics:
    1. **`DailyHoursChart.tsx`** — `BarChart` with stacked bars per project. Group `sessionData` by `YYYY-MM-DD` date + `projectName`, sum `durationMinutes / 60`. If >6 projects, group smallest into "Other". X-axis: formatted date label. Y-axis: hours.
    2. **`HoursByProjectChart.tsx`** — `PieChart` (donut via `innerRadius={60}`). Group `sessionData` by `projectName`, sum `durationMinutes / 60`. Legend below chart. Tooltip: hours + percentage.
    3. **`HoursByClientChart.tsx`** — `PieChart` (donut). Group `sessionData` by `clientName` (null → "Unassigned"), sum `durationMinutes / 60`. Same pattern as project donut.
    4. **`TokenUsageChart.tsx`** — `BarChart` grouped bars. Group `sessionData` by date, sum `inputTokens` and `outputTokens` separately. Two series with distinct palette colors. Format Y-axis with K/M suffix (e.g., "1.2M"). X-axis: formatted date.
    5. **`PromptsPerDayChart.tsx`** — `AreaChart` with gradient fill using accent color. Group `sessionData` by date, sum `promptCount`. X-axis: formatted date. Y-axis: count.
    6. **`BillableEarningsChart.tsx`** — `BarChart` vertical. Data from `summaryData.billedByClient[]`. Bar per `clientName`, value: `cost`. Tooltip: "{hours}h × ${rate}/h = ${cost}". Show "No billable data" if `billedByClient` is empty.
    7. **`SessionLengthChart.tsx`** — Histogram via `BarChart`. Bucket `sessionData` by `durationMinutes` into ranges: 0-15, 15-30, 30-60, 60-120, 120-240, 240+. Count sessions per bucket. X-axis: bucket labels. Y-axis: session count.
    8. **`PeakHoursChart.tsx`** — `BarChart` horizontal (`layout="vertical"`). Extract hour (0-23) from `startedAt` via `new Date(startedAt).getHours()`. Count sessions per hour. Y-axis: hour labels ("12am", "1am", ... "11pm"). X-axis: session count.

- [x] **Task 5: Create data-fetching hook**
  - File: `src/renderer/src/features/analytics/use-analytics.ts`
  - Action: Create `useAnalyticsData()` and `useDashboardLayout()` hooks
  - **`useAnalyticsData(filters: ReportFilters | null)`**:
    ```typescript
    const query = useQuery({
      queryKey: ['analytics', filters],
      queryFn: async () => {
        const result = await window.api.reports.generate(filters!, 'session-breakdown')
        if (!result.success) throw new Error(result.error.message)
        return result.data  // ReportResult
      },
      enabled: !!filters
    })
    // Return unwrapped data:
    return {
      sessionData: query.data?.sessionBreakdown ?? [],
      summaryData: query.data?.summary ?? null,
      isLoading: query.isLoading,
      isError: query.isError
    }
    ```
  - **`useDashboardLayout()`**:
    - Read layout from settings via `useQuery(['settings', 'analytics_dashboard_layout'], ...)`
    - Parse JSON string → `DashboardLayout`, fallback to `DEFAULT_LAYOUT` if missing/invalid/parse error
    - `saveLayout(layout: DashboardLayout)`: JSON-stringify and save via `settings:set`, debounced 300ms
    - `toggleWidget(id: string)`: add/remove widget from `widgets` array, save
    - `reorderWidgets(fromIndex: number, toIndex: number)`: move widget in array, save
    - `resizeWidget(id: string, size: WidgetSize)`: update size for widget, save
    - Use `useMutation` for saves to avoid stale query cache issues

- [x] **Task 6: Create DashboardGrid component**
  - File: `src/renderer/src/features/analytics/DashboardGrid.tsx`
  - Action: CSS Grid + @dnd-kit drag/drop reorder
  - Details:
    - CSS Grid: `grid-template-columns: repeat(2, 1fr)`, gap: 16px
    - Each widget card: rounded-lg border, `bg-[var(--background-elevated)]`, title bar with widget name + size toggle button (cycles small→medium→large) + drag handle icon
    - `large` size widgets span 2 columns (`grid-column: span 2`)
    - `small`/`medium` span 1 column with different heights (250px / 350px)
    - **@dnd-kit integration**:
      - Wrap grid in `<DndContext>` with `PointerSensor` and `KeyboardSensor`
      - Each widget card wrapped in `<SortableContext>` items
      - Use `useSortable()` hook on each card for drag handle
      - `onDragEnd` → call `reorderWidgets(oldIndex, newIndex)`
    - **Keyboard accessibility**: `KeyboardSensor` from @dnd-kit enables `Space` to pick up, `ArrowUp`/`ArrowDown` to move, `Space` to drop. Announce via `aria-live` region.
    - Pass `WidgetProps` (`sessionData`, `summaryData`) to each widget component from the registry

- [x] **Task 7: Create widget panel (Popover)**
  - File: `src/renderer/src/features/analytics/WidgetPanel.tsx`
  - Action: shadcn `Popover` listing all 8 widgets with `Switch` toggles
  - Details:
    - Trigger: `<Button variant="outline" size="sm">` with `<LayoutGrid size={14} />` icon + "Customize" label
    - Popover content: vertical list, one row per widget:
      - Widget icon (from `WidgetConfig.icon`, size 16)
      - Widget title text
      - `<Switch>` on the right, checked if widget is in current layout
    - Toggle on → adds widget to end of layout with `defaultSize`
    - Toggle off → removes widget from layout (position lost — re-added at end)
    - Popover closes on outside click (default Radix behavior)

- [x] **Task 8: Create AnalyticsPage (main dashboard)**
  - File: `src/renderer/src/features/analytics/AnalyticsPage.tsx`
  - Action: Main page with filter bar + DashboardGrid
  - Details:
    - **Initial state**: `datePreset = 'this-week'`, all widgets visible
    - **Filter bar** (top, single row, flex-wrap for narrow windows):
      - Date preset `<Select>`: today, this-week, last-week, this-month, last-month, all-time, custom
      - Custom date inputs: two `<input type="date">` shown only when preset is "custom"
      - Client filter `<Select>`: __all__ + list from `useQuery(['clients'])`
      - Project filter `<Select>`: __all__ + list from `useQuery(['projects'])`
      - After-hours toggle: read `after_hours_mode` from settings, apply to filters
      - `<WidgetPanel />` customize button (right-aligned)
    - **Filter → data flow**: `useMemo` computes `ReportFilters` from state, passed to `useAnalyticsData(filters)`
    - **Content area**: `<DashboardGrid>` receives `sessionData`, `summaryData`, `layout`, and layout mutation callbacks
    - **Loading state**: show `<LoaderCircle>` spinner overlay while `isLoading`
    - **Empty state**: if data loaded but `sessionData` is empty, show centered message "No sessions found for this period"

- [x] **Task 9: Wire up routing and navigation**
  - File: `src/renderer/src/App.tsx`
    - Add import: `import { AnalyticsPage } from '@/features/analytics/AnalyticsPage'`
    - Add route: `{ path: 'analytics', element: <AnalyticsPage /> }` — after `reports` route
  - File: `src/renderer/src/components/shared/ActivityBar.tsx`
    - Add import: `import { BarChart3 } from 'lucide-react'`
    - Add nav item: `{ icon: BarChart3, label: 'Analytics', route: '/analytics' }` — insert after Reports entry

- [x] **Task 10: Write tests**
  - **Unit tests** (`src/renderer/src/features/analytics/__tests__/`):
    - `widget-registry.test.ts`: verify all 8 widgets registered, each has valid id/title/icon/component/defaultSize
    - `use-analytics.test.ts`: mock `window.api.reports.generate`, verify:
      - Single IPC call with `session-breakdown` format
      - Returns unwrapped `sessionData` and `summaryData`
      - Handles error (IpcResult.success = false) by throwing
      - `enabled: false` when filters is null
    - `use-analytics.test.ts` (layout): mock `window.api.settings.get/set`, verify:
      - Loads and parses saved layout
      - Falls back to DEFAULT_LAYOUT on missing/invalid JSON
      - `saveLayout` debounces and calls settings:set
      - `toggleWidget` adds/removes correctly
      - `reorderWidgets` moves items correctly
  - **Component tests**:
    - `DailyHoursChart.test.tsx`: render with mock SessionLineItem[], verify BarChart renders with correct data points
    - `AnalyticsPage.test.tsx`: render with mocked hooks, verify filter bar renders, grid renders with widgets
    - `WidgetPanel.test.tsx`: render, toggle a switch, verify callback fired with correct widget id

### Acceptance Criteria

- [x] AC 1: Given the app is running, when the user clicks the Analytics icon in the ActivityBar, then the Analytics page loads with "this week" date preset selected and all 8 chart widgets visible in a grid layout.
- [x] AC 2: Given the Analytics page is loaded with "this week" selected, when data exists for the period, then all visible chart widgets render with correct data (no empty charts when data exists).
- [x] AC 3: Given the user changes the date preset from "this week" to "this month", then all chart widgets update to reflect the new date range.
- [x] AC 4: Given the user drags a widget to a new position in the grid, when they release, then the widget stays in the new position and the layout persists across page navigation and app restart.
- [x] AC 5: Given the user clicks a widget's size toggle, when cycling through small/medium/large, then the widget resizes accordingly, the chart re-renders to fill the new size, and the layout persists.
- [x] AC 6: Given the user clicks "Customize" and toggles off a widget, then the widget disappears from the grid. When toggled back on, it reappears at the end of the grid with its default size.
- [x] AC 7: Given no data exists for the selected period, when the dashboard loads, then each widget shows a "No data for this period" message instead of an empty chart.
- [x] AC 8: Given the user has a client with a billable rate, when viewing the Billable Earnings chart, then earnings display correctly per client with tooltip showing hours × rate = cost.
- [x] AC 9: Given the user switches between dark and light theme, then all chart colors, text, and grid lines update to match the theme without a page reload.
- [x] AC 10: Given the user selects a specific client or project in the filter bar, then all widgets filter to show only data for that client/project.
- [x] AC 11: Given after-hours mode is enabled in settings, when the dashboard loads, then only after-hours sessions are included in all charts.
- [x] AC 12: Given the user uses keyboard only, when navigating the dashboard, then widgets can be reordered via keyboard (Space to pick up, arrows to move, Space to drop) with screen reader announcements.
- [x] AC 13: Given a large "all-time" date range with 1000+ sessions, when the dashboard loads, then all charts render without noticeable lag (data transformations are memoized).

## Additional Context

### Dependencies

- `recharts@~2.15.0` — charting library, pinned to minor version for stability
- `@dnd-kit/react` (v0.3.x) — React 19 compatible drag/drop. Includes `@dnd-kit/core` and `@dnd-kit/dom` as transitive deps.
- **NOT using**: `react-grid-layout` (depends on `react-draggable` which uses `findDOMNode`, removed in React 19 — causes runtime crash)

### Testing Strategy

**Unit tests (vitest):**
- Widget registry: all 8 entries valid
- `useAnalyticsData`: single IPC call, unwrap-or-throw, error handling
- `useDashboardLayout`: load/save/default/toggle/reorder/resize

**Component tests (vitest + @testing-library/react):**
- Chart widgets: render with mock data, verify Recharts elements
- AnalyticsPage: filter bar + grid rendering
- WidgetPanel: toggle interactions

**Manual testing:**
- Drag/drop reorder, size cycling, verify persistence after restart
- Switch dark/light themes, verify chart colors reactively update
- Test empty data, single session, all-time large datasets
- Verify all 7 date presets produce correct date ranges
- Keyboard-only reorder test
- Narrow window: verify filter bar wraps gracefully

### Notes

- **Single IPC call strategy**: only `session-breakdown` is fetched. All aggregations (daily, per-project, per-client) are derived client-side with `useMemo`. This is a deliberate choice to avoid 3 redundant DB queries. The trade-off is more client-side computation, but with `useMemo` this is negligible even for 1000+ sessions.
- **Date sorting**: `SessionLineItem.date` and `DailySummaryItem.date` are formatted label strings (e.g., "Mon, Mar 4, 2026") — NOT sortable. Always use `startedAt` (ISO string) for grouping and sorting. Format to short labels only for Recharts axis display.
- **Color palette**: 10 distinct HSL colors varying hue at 36° intervals. Dark theme: `hsl(H, 55%, 60%)`. Light theme: `hsl(H, 55%, 45%)`. Theme hook detects which to use.
- **Performance**: `useMemo` all data transformations in each widget. For the stacked daily hours chart with many projects, limit to top 6 projects + "Other" bucket.
- **@dnd-kit CSS**: no external CSS imports needed (unlike react-grid-layout). Drag overlay styles are inline via the library's render props.
- **Filter bar responsive**: uses `flex flex-wrap gap-2` so items wrap to next line at narrow widths. "Customize" button is `ml-auto` to push right.

## Review Notes
- Adversarial review completed
- Findings: 17 total, 12 fixed, 5 skipped (noise/undecided/low-impact)
- Resolution approach: auto-fix
- Key fixes: replaced mutable registerWidget pattern with React.lazy, added layout validation, fixed debounce cleanup, removed unstable useCallback deps, guarded division by zero, added error state UI, filtered projects by client, unique SVG gradient IDs, DRY formatDateKey utility
