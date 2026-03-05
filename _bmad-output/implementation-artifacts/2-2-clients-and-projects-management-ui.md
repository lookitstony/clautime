# Story 2.2: Clients & Projects Management UI

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer using ViberTime**,
I want **a Clients view where I can create, edit, and delete clients and their projects**,
so that **I can organize my work by client and map project directories for session attribution**.

## Acceptance Criteria

1. **Given** the user navigates to the Clients view, **When** the view renders, **Then** a list of clients is displayed with project counts per client
2. **And** the user can create a new client with a name and assigned color (from 8-color palette)
3. **And** the user can edit an existing client's name and color
4. **And** the user can delete a client (with confirmation popover)
5. **And** expanding a client shows its projects with directory paths
6. **And** the user can create a new project under a client with name and directory path (via folder picker)
7. **And** the user can edit a project's name, directory path, and billable status
8. **And** the user can delete a project (with confirmation popover)
9. **And** the user can mark a project as non-billable (FR14)
10. **And** all changes save via React Query mutations with optimistic updates and toast confirmations
11. **And** an EmptyState shows "No clients configured" with an "Add Client" button when empty

## Tasks / Subtasks

- [x] Task 1: Install missing shadcn/ui components (AC: #2, #3, #6, #7)
  - [x] Installed `switch` and `alert-dialog` via shadcn CLI. Used raw HTML inputs styled with Tailwind (matching WelcomeWizard pattern) instead of shadcn input/label components.
  - [x] Verify imports work with `@/components/ui/` alias

- [x] Task 2: Create ClientsPage entry component (AC: #1, #11)
  - [x] Create `src/renderer/src/features/clients/ClientsPage.tsx`
  - [x] Page structure: header with title "Clients & Projects" + "+ Add Client" button, scrollable client list
  - [x] Use `useClients()` hook (already exists) for data fetching
  - [x] Show `EmptyState` with `Users` icon, "No clients configured" title, "Add clients and projects to organize your sessions" description, and "Add Client" action button when `clients.length === 0`
  - [x] Show skeleton loading state while data loads (follow SessionsPage pattern)
  - [x] Update `App.tsx` router: replace the EmptyState at `/clients` route with `<ClientsPage />`

- [x] Task 3: Create ClientCard collapsible component (AC: #1, #5)
  - [x] Create `src/renderer/src/features/clients/ClientCard.tsx`
  - [x] Use shadcn `Collapsible` + `CollapsibleTrigger` + `CollapsibleContent` (same pattern as ProjectGroup)
  - [x] Collapsed row shows: color dot (using client's `color` CSS variable), client name, project count badge, edit/delete action buttons
  - [x] Row height `h-12`, padding `px-4`, hover `bg-[var(--background-elevated)]`
  - [x] Expand/collapse with chevron icon animation (ChevronRight → rotated 90° when open)
  - [x] Expanded content shows `ProjectList` for this client + "+ Add Project" button

- [x] Task 4: Create ClientForm dialog component (AC: #2, #3)
  - [x] Create `src/renderer/src/features/clients/ClientForm.tsx`
  - [x] Use shadcn `Dialog` for modal form (follow WelcomeWizard dialog pattern)
  - [x] Fields: name (text input, required), color picker (8 swatches from `CLIENT_COLORS`)
  - [x] Color picker: 8 circular swatches showing `var(--project-1)` through `var(--project-8)`, selected swatch shows checkmark
  - [x] Mode: "create" (title "Add Client", empty fields) or "edit" (title "Edit Client", pre-filled)
  - [x] Submit button disabled until name is non-empty
  - [x] On create: call `useCreateClient()` mutation, toast success "Client created"
  - [x] On edit: call `useUpdateClient()` mutation, toast success "Client updated"
  - [x] Close dialog on success
  - [x] Validate unique client name — show inline error if mutation fails with unique constraint error

- [x] Task 5: Create ProjectList component (AC: #5, #9)
  - [x] Create `src/renderer/src/features/clients/ProjectList.tsx`
  - [x] Renders inside expanded `ClientCard`
  - [x] Each project row: project name, directory path (truncated, monospace, muted), billable badge or "Non-billable" text, edit/delete buttons
  - [x] Row styling: `pl-10` indent (nested under client), `h-10` height, hover `bg-[var(--background-elevated)]`
  - [x] Use `useProjects(clientId)` hook to fetch projects for this client
  - [x] Show "No projects yet" text if empty
  - [x] "+ Add Project" button at bottom of project list

- [x] Task 6: Create ProjectForm dialog component (AC: #6, #7, #9)
  - [x] Create `src/renderer/src/features/clients/ProjectForm.tsx`
  - [x] Fields: name (text input, required), directory path (text input + "Browse" button), billable toggle (shadcn Switch)
  - [x] "Browse" button calls `window.api.dialog.openFolder()` and populates directory path field
  - [x] Mode: "create" (title "Add Project") or "edit" (title "Edit Project", pre-filled)
  - [x] `clientId` passed as prop for create mode
  - [x] On create: call `useCreateProject()` mutation with `{ clientId, name, directoryPath, isBillable }`
  - [x] On edit: call `useUpdateProject()` mutation
  - [x] Toast success on save: "Project created" / "Project updated"
  - [x] Validate unique directory path — show inline error if mutation fails

- [x] Task 7: Implement delete with confirmation popovers (AC: #4, #8)
  - [x] For client delete: AlertDialog with "Delete client '{name}'? This will also remove all projects under this client." + Cancel/Delete buttons
  - [x] For project delete: AlertDialog with "Delete project '{name}'?" + Cancel/Delete buttons
  - [x] Delete button uses red styling (bg-red-600 hover:bg-red-700)
  - [x] On confirm: call `useDeleteClient()` / `useDeleteProject()` mutation
  - [x] Toast success: "Client deleted" / "Project deleted"
  - [x] Used shadcn `AlertDialog` component (better UX than Popover for destructive confirmation)

- [x] Task 8: Wire up App.tsx route (AC: #1)
  - [x] Import `ClientsPage` in `App.tsx`
  - [x] Replace `/clients` route element from `EmptyState` to `<ClientsPage />`

- [x] Task 9: Write component tests (AC: all)
  - [x] Create `src/renderer/src/features/clients/ClientsPage.test.tsx` (5 tests):
    - Test renders empty state when no clients
    - Test renders client list when clients exist
    - Test loading skeleton state
    - Test header with title and Add Client button
    - Test error state when fetch fails
  - [x] Create `src/renderer/src/features/clients/ClientCard.test.tsx` (6 tests):
    - Test renders client name and color dot
    - Test shows project count badge
    - Test calls onToggle when clicked
    - Test edit button calls onEdit
    - Test delete button shows confirmation dialog
    - Test shows ProjectList when expanded
  - [x] Create `src/renderer/src/features/clients/ClientForm.test.tsx` (6 tests):
    - Test renders create mode with empty fields
    - Test renders edit mode with pre-filled values
    - Test submit button disabled when name empty
    - Test calls create mutation on submit
    - Test renders 8 color swatches
    - Test color swatch selection shows checkmark
  - [x] Create `src/renderer/src/features/clients/ProjectForm.test.tsx` (5 tests):
    - Test renders create mode
    - Test renders edit mode with pre-filled values
    - Test Browse button calls dialog.openFolder and populates path
    - Test billable toggle defaults to checked
    - Test calls create mutation on submit with correct data
  - [x] Follow existing test patterns: mock `window.api`, use `@testing-library/react`, wrap with `QueryClientProvider`

## Dev Notes

### Architecture Patterns (MUST follow from existing codebase)

- **Page structure**: `flex h-full flex-col` wrapper. Header with title + action button, `flex-1 overflow-auto` scrollable body. See `SessionsPage.tsx` for canonical example.
- **Collapsible rows**: Use shadcn `Collapsible` + `CollapsibleTrigger` + `CollapsibleContent`. See `ProjectGroup.tsx` for exact pattern.
- **Color dots**: `<span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />` where `color` is the CSS variable value (e.g., `var(--project-1)`). Note: to render CSS variables as inline styles, use `getComputedStyle` or map to hex values, OR use a className-based approach. Actually, inline `style={{ backgroundColor: 'var(--project-1)' }}` DOES work in React — the browser resolves the CSS variable.
- **Badges**: Use shadcn `Badge` with `secondary` variant for counts.
- **Toast notifications**: `import { toast } from 'sonner'` — `toast.success('...')`, `toast.error(error.message)`. `<Toaster />` is already mounted in `App.tsx`.
- **Dialog forms**: Follow `WelcomeWizard.tsx` pattern — `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`.
- **React Query mutations**: Already created in `use-clients.ts` and `use-projects.ts`. Use `useCreateClient()`, `useUpdateClient()`, `useDeleteClient()`, `useCreateProject()`, `useUpdateProject()`, `useDeleteProject()`. These already invalidate query caches on success.
- **Folder picker**: `window.api.dialog.openFolder()` returns `IpcResult<string | null>`. Already wired in preload.
- **Button variants**: `default` (primary), `outline` (secondary), `ghost` (tertiary), `destructive` (delete). Sizes: `default`, `xs`, `sm`, `icon`, `icon-sm`.
- **Monospace text**: Add `font-mono` class for data values (paths, durations).
- **Muted text**: `text-[var(--text-muted)]` or `text-[var(--text-secondary)]`.
- **CSS imports**: Use `@/components/ui/...` alias for shadcn components.

### Existing Hooks & Types (REUSE — DO NOT recreate)

All hooks already exist in `src/renderer/src/features/clients/`:
- `use-clients.ts`: `useClients()`, `useCreateClient()`, `useUpdateClient()`, `useDeleteClient()`
- `use-projects.ts`: `useProjects(clientId?)`, `useCreateProject()`, `useUpdateProject()`, `useDeleteProject()`, `useAttributeSessions()`

All shared types already exist in `src/shared/types/client-project.ts`:
- `Client`, `NewClient`, `UpdateClient`, `Project`, `NewProject`, `UpdateProject`, `CLIENT_COLORS`

### 8-Color Palette (CSS Variables)

Colors defined in `src/renderer/src/index.css`:
| Variable | Color | Hex |
|----------|-------|-----|
| `--project-1` | Blue | `#3b82f6` |
| `--project-2` | Amber | `#f59e0b` |
| `--project-3` | Emerald | `#10b981` |
| `--project-4` | Red | `#ef4444` |
| `--project-5` | Violet | `#8b5cf6` |
| `--project-6` | Pink | `#ec4899` |
| `--project-7` | Cyan | `#06b6d4` |
| `--project-8` | Orange | `#f97316` |

`CLIENT_COLORS` in `client-project.ts` stores these as `'var(--project-N)'` strings. Use them directly in inline styles or map to hex for color picker display.

### Design Tokens (from index.css)

- Background primary: `var(--background-primary)` = `#16162a`
- Background secondary: `var(--background-secondary)` = `#12121e`
- Background elevated: `var(--background-elevated)` = `#1e1e32`
- Surface border: `var(--surface-border)` = `#2a2a3e`
- Text primary: `var(--text-primary)` = `#e0e0e0`
- Text secondary: `var(--text-secondary)` = `#888888`
- Text muted: `var(--text-muted)` = `#555555`
- Accent: `var(--accent)` = `#14b8a6` (teal)

### UX Requirements (from UX Design Spec)

- **Destructive actions**: Red text/icon, requires confirmation popover. Pattern: "Delete this [item]? This cannot be undone." with Cancel + Delete buttons.
- **Empty states**: Centered vertically. Icon (24px, muted) + headline (16px, 600 weight) + description (13px, muted) + action button. Never a dead end.
- **Feedback**: Toast on all mutations (success/error). 5-second auto-dismiss. Bottom-right position (already configured).
- **Form pattern**: Dialog modal, title at top, fields stacked vertically, actions at bottom-right. Primary action disabled until valid.
- **Inline styles**: Use CSS variables directly in Tailwind classes or inline styles.

### Shadcn Components Already Installed

`button`, `badge`, `card`, `skeleton`, `dialog`, `collapsible`, `checkbox`, `tooltip`, `progress`, `sonner`

**NOT installed (need to add):** `input`, `label`, `popover`, `switch`, `separator`, `dropdown-menu`

Alternatively, use raw `<input>` elements styled with Tailwind (matching the design system) — the WelcomeWizard uses this approach. Either approach is fine.

### Project Structure Notes

New files to create:
- `src/renderer/src/features/clients/ClientsPage.tsx` — Page entry
- `src/renderer/src/features/clients/ClientCard.tsx` — Collapsible client row
- `src/renderer/src/features/clients/ClientForm.tsx` — Add/edit client dialog
- `src/renderer/src/features/clients/ProjectList.tsx` — Projects under a client
- `src/renderer/src/features/clients/ProjectForm.tsx` — Add/edit project dialog
- `src/renderer/src/features/clients/ClientsPage.test.tsx`
- `src/renderer/src/features/clients/ClientCard.test.tsx`
- `src/renderer/src/features/clients/ClientForm.test.tsx`
- `src/renderer/src/features/clients/ProjectForm.test.tsx`

Modified files:
- `src/renderer/src/App.tsx` — Replace `/clients` route element

### Testing Notes

- Renderer tests use `happy-dom` environment (default for renderer)
- Mock `window.api` object with jest-style mocks: `vi.fn().mockResolvedValue({ success: true, data: [...] })`
- Wrap components in `QueryClientProvider` with a fresh `QueryClient` per test
- Use `@testing-library/react` for rendering and assertions
- Use `@testing-library/user-event` for interactions (click, type)
- Follow patterns from existing tests: `use-clients.test.ts`, `use-projects.test.ts`
- `act()` wrapping may be needed for Radix Tooltip focus events

### Previous Story Intelligence (Story 2.1)

From Story 2.1 implementation:
- All CRUD service methods, IPC handlers, and preload bridge methods are complete and tested
- `useClients()` returns `{ data: Client[], isLoading, error }` — standard React Query shape
- `useProjects(clientId)` filters by clientId when provided
- Delete client cascades: nullifies `clientId` on sessions (but does NOT delete projects — we handle in service layer). Actually, the service DOES delete orphaned projects via cascade. Verify behavior.
- Auto-color assignment: when creating a client without specifying color, `ClientProjectService` assigns the next unused color from the palette
- Path normalization: `directoryPath` is normalized on Windows (uppercase drive letter, backslashes)
- 188 tests passing as of Story 2.1 completion — must not regress

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic 2, Story 2.2]
- [Source: _bmad-output/planning-artifacts/architecture.md#Renderer Features, File Structure]
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md#Custom Components, Form Patterns, Empty States, Feedback Patterns]
- [Source: src/renderer/src/features/sessions/SessionsPage.tsx — page layout pattern]
- [Source: src/renderer/src/features/sessions/ProjectGroup.tsx — collapsible row pattern]
- [Source: src/renderer/src/features/onboarding/WelcomeWizard.tsx — dialog form pattern]
- [Source: src/renderer/src/features/clients/use-clients.ts — existing React Query hooks]
- [Source: src/renderer/src/features/clients/use-projects.ts — existing React Query hooks]
- [Source: src/shared/types/client-project.ts — Client, Project, CLIENT_COLORS types]
- [Source: src/renderer/src/components/shared/EmptyState.tsx — empty state pattern]
- [Source: src/renderer/src/index.css — design tokens and project colors]
- [Source: src/renderer/src/lib/format.ts — getProjectColor utility]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

- TypeScript compilation: fixed unused `Users` import in App.tsx after route replacement
- Fixed `CLIENT_COLORS` `as const` narrowing issue in ClientForm.tsx — needed explicit `string` type for useState
- Used `AlertDialog` instead of `Popover` for delete confirmations (better UX for destructive actions)
- Used raw HTML inputs styled with Tailwind instead of shadcn Input/Label (matching WelcomeWizard pattern)

### Completion Notes List

- All 9 tasks completed successfully
- 22 new tests added (210 total, 0 regressions)
- 5 new UI components: ClientsPage, ClientCard, ClientForm, ProjectList, ProjectForm
- 2 new shadcn components installed: switch, alert-dialog
- Follows all existing patterns: SessionsPage layout, ProjectGroup collapsible, WelcomeWizard dialog forms
- All CRUD operations wired through existing React Query hooks (use-clients.ts, use-projects.ts)
- Color picker with 8 swatches, checkmark on selected
- Delete confirmations via AlertDialog with descriptive messaging
- Folder picker integration via `window.api.dialog.openFolder()`
- Billable toggle via shadcn Switch component

### File List

New files:
- src/renderer/src/features/clients/ClientsPage.tsx
- src/renderer/src/features/clients/ClientCard.tsx
- src/renderer/src/features/clients/ClientForm.tsx
- src/renderer/src/features/clients/ProjectList.tsx
- src/renderer/src/features/clients/ProjectForm.tsx
- src/renderer/src/features/clients/ClientsPage.test.tsx
- src/renderer/src/features/clients/ClientCard.test.tsx
- src/renderer/src/features/clients/ClientForm.test.tsx
- src/renderer/src/features/clients/ProjectForm.test.tsx
- src/renderer/src/components/ui/switch.tsx
- src/renderer/src/components/ui/alert-dialog.tsx

Modified files:
- src/renderer/src/App.tsx (replaced /clients EmptyState with ClientsPage, removed unused Users import)
