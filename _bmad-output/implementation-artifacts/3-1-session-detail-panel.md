# Story 3.1: Session Detail Panel

Status: done

## Story

As a **developer using ClawdTime**,
I want **to click a session row and see full session details in an inline panel**,
so that **I can review all information about a specific session without leaving the Sessions view**.

## Acceptance Criteria

1. **Given** a SessionRow is visible in an expanded ProjectGroup, **When** the user clicks a SessionRow, **Then** a SessionDetailPanel expands inline below the clicked row.

2. **Given** the SessionDetailPanel is open, **Then** it displays: duration, time range (start–end), project name, client name, source badge (Auto/Manual), prompt count, and description/summary (or "No summary available").

3. **Given** a SessionDetailPanel is open, **When** the user clicks a different SessionRow, **Then** the current panel closes and the new one opens.

4. **Given** a SessionDetailPanel is open, **When** the user presses Escape, **Then** the panel closes.

5. **Given** the SessionDetailPanel is open for an auto-detected session, **Then** it shows action buttons: "Edit Time", "Reassign Project" (disabled stubs — implemented in Story 3.3).

6. **Given** the SessionDetailPanel is open for a manual session, **Then** it shows action buttons: "Edit Description", "Delete" (disabled stubs — implemented in Story 3.5).

7. **Given** the SessionDetailPanel opens, **Then** focus moves to the panel. When it closes, focus returns to the trigger SessionRow.

8. **Given** any window width, **Then** the panel adapts to full content width.

## Tasks / Subtasks

- [x] **Task 1: Create SessionDetailPanel component** (AC: 1, 2, 5, 6, 8)
  - [x] 1.1 Create `src/renderer/src/features/sessions/SessionDetailPanel.tsx`
  - [x] 1.2 Props: `session: Session`, `projectName: string | null`, `clientName: string | null`, `projectColor: string`, `onClose: () => void`
  - [x] 1.3 Detail grid (4 stat cards): Duration, Time Range, Prompts, Source — matching UX mockup layout
  - [x] 1.4 Description section: show `session.description` or "No summary available" muted text
  - [x] 1.5 Action buttons row: conditional on `session.source` — auto gets "Edit Time" + "Reassign Project"; manual gets "Edit Description" + "Delete" — all buttons disabled with tooltip "Coming in a future update"
  - [x] 1.6 Full-width layout, border-top separator, background `var(--background-elevated)`

- [x] **Task 2: Integrate panel into SessionsPage** (AC: 1, 3)
  - [x] 2.1 Render `SessionDetailPanel` inline below the selected `SessionRow` inside the day-group loop
  - [x] 2.2 Use existing `selectedSessionId` state — panel renders when `session.id === selectedSessionId`
  - [x] 2.3 Look up project/client names from the existing `projects`/`clients` data for the selected session
  - [x] 2.4 Pass `onClose={handleCloseDetail}` to panel with focus-return logic

- [x] **Task 3: Keyboard and focus management** (AC: 4, 7)
  - [x] 3.1 Add `onKeyDown` handler to panel: Escape calls `onClose()`
  - [x] 3.2 Use `useRef` + `useEffect` to focus the panel container when it mounts
  - [x] 3.3 On close, return focus to the SessionRow that triggered it (store ref via event.currentTarget)
  - [x] 3.4 `tabIndex={-1}` on panel container for programmatic focus

- [x] **Task 4: Scroll into view** (AC: 1)
  - [x] 4.1 When panel expands, scroll it into view if partially off-screen using `scrollIntoView({ behavior: 'smooth', block: 'nearest' })`

- [x] **Task 5: Unit tests** (AC: 1-8)
  - [x] 5.1 Test: panel renders with correct session data (duration, time range, project, client, source)
  - [x] 5.2 Test: auto session shows "Edit Time" and "Reassign Project" buttons
  - [x] 5.3 Test: manual session shows "Edit Description" and "Delete" buttons
  - [x] 5.4 Test: "No summary available" shown when description is null
  - [x] 5.5 Test: Escape key calls onClose
  - [x] 5.6 Test: panel receives focus on mount
  - [x] 5.7 Test: SessionsPage renders panel below selected session row
  - [x] 5.8 Test: clicking same session closes the panel (toggle behavior)

## Dev Notes

### Scope Boundaries — READ CAREFULLY

This story is **display-only**. The action buttons (Edit Time, Reassign Project, Edit Description, Delete) are rendered as **disabled stubs**. Their functionality is implemented in:
- Story 3.3: Edit Session Time & Reassign Project
- Story 3.5: Manual Time Blocks (Edit Description, Delete)

Do NOT implement any IPC update/delete handlers, mutations, or editing flows. Just render the buttons with `disabled` prop and a tooltip.

### Existing Infrastructure to Reuse

1. **`selectedSessionId` state** already exists in `SessionsPage.tsx` — toggles on click, clears on group collapse. DO NOT create new state.

2. **`SessionRow` already has `isSelected` prop** and `aria-expanded` attribute. DO NOT modify SessionRow beyond what's needed to render the panel below it.

3. **Session data is already fetched** via `useSessions()` — the panel just displays fields from the `Session` object. NO new IPC calls needed. NO `useSession(id)` hook needed.

4. **Project/client data** is already fetched in `SessionsPage` via `useClients()` and `useProjects()`. Look up names by matching `session.projectId`/`session.clientId` to the already-loaded arrays.

5. **Format utilities** exist in `src/renderer/src/lib/format.ts`:
   - `formatDuration(minutes)` → "2h 15m"
   - `formatTimeRange(startedAt, endedAt)` → "09:15 – 11:42"

6. **shadcn `Badge` component** already installed for source badge (Auto/Manual).

7. **`Button` component** from shadcn already installed — use `variant="ghost"` + `size="sm"` + `disabled` for action buttons.

### Component Design

```
SessionDetailPanel layout (inline, below SessionRow):
┌─────────────────────────────────────────────────────┐
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │
│  │ Duration │ │ Time     │ │ Prompts  │ │ Source │ │
│  │ 2h 15m   │ │ 09:15–   │ │ 24       │ │ Auto   │ │
│  │          │ │ 11:30    │ │          │ │        │ │
│  └──────────┘ └──────────┘ └──────────┘ └────────┘ │
│                                                     │
│  Project: Acme Corp / ClawdTime                     │
│                                                     │
│  Description                                        │
│  No summary available                               │
│                                                     │
│  [Edit Time]  [Reassign Project]                    │
└─────────────────────────────────────────────────────┘
```

### Styling Patterns

- Panel background: `var(--background-elevated)` (same as selected row)
- Border-top: `1px solid var(--surface-border)`
- Padding: `16px 36px` (matches UX mockup's `detail-panel` class)
- Stat card values: monospace font, `font-size: 13px`
- Stat card labels: `text-xs`, `color: var(--text-muted)`
- Description text: `var(--text-secondary)`, "No summary available" in `var(--text-muted)` italic
- Action buttons: `ghost` variant, `sm` size, grouped in a flex row with `gap-2`
- Left padding `pl-10` to align with SessionRow content (accounts for project group indentation)

### CSS Custom Variables in Use

```
--background-elevated    panel + stat card background
--surface-border         dividers
--text-primary           stat values
--text-secondary         description text
--text-muted             labels, "no summary" placeholder
--accent                 project name highlight (optional)
```

### Integration Point in SessionsPage

The panel renders **inside** the day-group session loop, immediately after the SessionRow whose `id` matches `selectedSessionId`. Pseudocode:

```tsx
{dayGroup.sessions.map(session => (
  <React.Fragment key={session.id}>
    <SessionRow
      session={session}
      projectColor={group.clientColor || projectColor}
      isSelected={selectedSessionId === session.id}
      onSelect={() => selectSession(session.id)}
    />
    {selectedSessionId === session.id && (
      <SessionDetailPanel
        session={session}
        projectName={group.projectName}
        clientName={group.clientName}
        projectColor={group.clientColor || projectColor}
        onClose={() => setSelectedSessionId(null)}
      />
    )}
  </React.Fragment>
))}
```

### Files to Create

| File | Purpose |
|------|---------|
| `src/renderer/src/features/sessions/SessionDetailPanel.tsx` | New component |
| `src/renderer/src/features/sessions/SessionDetailPanel.test.tsx` | Tests |

### Files to Modify

| File | Change |
|------|--------|
| `src/renderer/src/features/sessions/SessionsPage.tsx` | Render SessionDetailPanel below selected row, pass project/client data |
| `src/renderer/src/features/sessions/SessionsPage.test.tsx` | Add test for panel rendering on selection |

### Files NOT to Create or Modify

- No new IPC handlers — this is display-only
- No new services — no data mutations
- No new hooks — session data already available from list query
- No preload changes — no new IPC channels
- No schema changes — no DB modifications
- Do NOT modify `SessionRow.tsx` — it already handles selection correctly
- Do NOT modify `use-sessions.ts` — no new queries/mutations needed

### Testing Approach

- **Renderer tests**: `happy-dom` environment (default), `@testing-library/react`
- **Mock `window.api`**: Not needed — panel only displays data passed via props
- **React Query**: Not needed for panel tests — no data fetching
- **For SessionsPage integration test**: Use existing mock patterns from `SessionsPage.test.tsx` — mock `window.api.sessions.getAll`, `window.api.clients.getAll`, `window.api.projects.getAll`
- **Keyboard testing**: `fireEvent.keyDown(panel, { key: 'Escape' })` → verify `onClose` called
- **Focus testing**: Wrap in `act()` for programmatic focus (Radix tooltip gotcha from previous stories)

### Previous Story Intelligence (from Story 2.3)

- **223 tests passing** as of last commit — zero regressions expected
- **Code review fixes applied**: navigation uses both `navigate()` and `setActiveView()` for routing
- **Existing pattern**: `ProjectGroup` uses `Collapsible` → `CollapsibleContent` wrapping children. The `SessionDetailPanel` lives INSIDE `CollapsibleContent`, not outside it
- **Color system**: Client colors via CSS vars `var(--project-1)` through `var(--project-8)`. Use `group.clientColor` from the grouped sessions data
- **Toast via sonner** already mounted — not needed for this story (no mutations)
- **Switch component gotcha**: uses explicit CSS vars not Tailwind theme tokens — keep this in mind for any new components

### Git Intelligence

Recent commits follow story-per-commit pattern:
- `d8dfe44` Story 2.3: Session-to-client/project attribution
- `c0353e4` Story 2.2: Clients & projects management UI
- `5d0a8e5` Story 2.1: Client & project database schema and service

Key patterns: all tests colocated, shadcn components added as needed, no regressions across stories.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic 3, Story 3.1]
- [Source: _bmad-output/planning-artifacts/architecture.md#Frontend Architecture, Component Library]
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md#SessionDetailPanel]
- [Source: _bmad-output/planning-artifacts/ux-design-grouped.html#detail-panel]
- [Source: _bmad-output/implementation-artifacts/2-3-session-to-client-project-attribution.md#Dev Notes]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

### Completion Notes List

- Created `SessionDetailPanel` component with 4 stat cards (Duration, Time Range, Prompts, Source), project/client attribution display, description section, and conditional action buttons
- Integrated panel into `SessionsPage` inline below selected `SessionRow` using existing `selectedSessionId` state
- Panel auto-focuses on mount, Escape key closes it, focus returns to trigger row on close via `requestAnimationFrame`
- Auto-scrolls into view on open using `scrollIntoView({ behavior: 'smooth', block: 'nearest' })`
- SessionRow `onSelect` prop updated to pass click event for focus-return element tracking (minimal change to type signature)
- Action buttons rendered as disabled stubs: "Edit Time" + "Reassign Project" for auto sessions, "Edit Description" + "Delete" for manual sessions
- 13 new tests added: 11 in SessionDetailPanel.test.tsx + 2 integration tests in SessionsPage.test.tsx
- 151 renderer tests pass (up from 138), zero regressions

### File List

**Created:**
- src/renderer/src/features/sessions/SessionDetailPanel.tsx
- src/renderer/src/features/sessions/SessionDetailPanel.test.tsx

**Modified:**
- src/renderer/src/features/sessions/SessionsPage.tsx (import SessionDetailPanel, add handleCloseDetail, render panel inline, focus-return ref)
- src/renderer/src/features/sessions/SessionsPage.test.tsx (2 new integration tests for panel open/close)
- src/renderer/src/features/sessions/SessionRow.tsx (onSelect prop type updated to pass event for focus-return tracking)
