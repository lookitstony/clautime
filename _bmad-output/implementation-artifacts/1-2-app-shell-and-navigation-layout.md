# Story 1.2: App Shell & Navigation Layout

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer using ViberTime**,
I want **a navigable app shell with sidebar, status bar, and routed views**,
So that **I can switch between app sections and see the app's structural foundation**.

## Acceptance Criteria

1. **Given** the app is launched, **When** the main window renders, **Then** a 56px ActivityBar is visible on the left with 5 icon buttons (Sessions, Live, Reports, Clients, Settings)
2. **And** clicking an ActivityBar icon navigates to the corresponding route via React Router
3. **And** the active view is indicated with accent background (`rgba(var(--accent-rgb), 0.1)`) and a 3px accent left border on the ActivityBar icon
4. **And** a 24px StatusBar is visible at the bottom of the window
5. **And** the content area fills the remaining space between ActivityBar and StatusBar
6. **And** the dark theme is applied with `#16162a` background and teal `#14b8a6` accent (already configured in Story 1.1)
7. **And** the minimum window size is enforced at 800x600px (already configured in Story 1.1)
8. **And** system font stack is used for UI text and monospace for data values (already configured in Story 1.1)
9. **And** each view renders an EmptyState placeholder component with view-specific icon, title, and description
10. **And** keyboard navigation works between ActivityBar items (Tab into bar, arrow keys between icons, Enter to select)
11. **And** Zustand stores are set up for UI state (active view tracking, last active view memory)

## Tasks / Subtasks

- [x] Task 1: Install required shadcn/ui components (AC: #1, #10)
  - [x] Install shadcn/ui Tooltip component: `npx shadcn@latest add tooltip`
  - [x] Verify Tooltip renders with dark theme styling

- [x] Task 2: Create Zustand UI store (AC: #11)
  - [x] Create `src/renderer/src/stores/use-ui-store.ts`
  - [x] Define store state: `activeView` (string matching route path), `lastActiveView` (persisted to restore on relaunch)
  - [x] Export `useUIStore` with `setActiveView` action
  - [x] Write co-located unit test `use-ui-store.test.ts`

- [x] Task 3: Create ActivityBar component (AC: #1, #2, #3, #10)
  - [x] Create `src/renderer/src/components/shared/ActivityBar.tsx`
  - [x] Render 56px fixed-width vertical bar with `var(--background-secondary)` background
  - [x] Add 5 icon buttons using lucide-react icons:
    - Sessions: `LayoutList` icon, route `/sessions`
    - Live: `Activity` icon, route `/` (index)
    - Reports: `FileBarChart` icon, route `/reports`
    - Clients: `Users` icon, route `/clients`
    - Settings: `Settings` icon, route `/settings`
  - [x] Icon order (top to bottom): Sessions, Live, Reports, Clients, Settings
  - [x] Implement states: Default (muted icon `var(--text-muted)`), Active (accent bg + accent icon + 3px left border), Hover (elevated bg)
  - [x] Wrap each icon in shadcn Tooltip showing view name
  - [x] Use `useNavigate` from React Router for route changes
  - [x] Use `useUIStore` to track and reflect active view
  - [x] Sync active view with current route using `useLocation`
  - [x] Add `role="navigation"` and `aria-label="Main navigation"` to the bar
  - [x] Implement keyboard navigation: arrow keys between items, Enter/Space to select
  - [x] Write co-located unit test `ActivityBar.test.tsx`

- [x] Task 4: Create StatusBar component (AC: #4)
  - [x] Create `src/renderer/src/components/shared/StatusBar.tsx`
  - [x] Render 24px fixed-height bar at bottom with `var(--background-secondary)` background, top border `var(--surface-border)`
  - [x] Left section: "Watching 0 projects" placeholder + "Last scan: never" placeholder
  - [x] Right section: "0h 0m today" placeholder
  - [x] Use 11px font size, muted text color
  - [x] Component accepts props for future dynamic data (watchCount, lastScan, dailyTotal)
  - [x] Write co-located unit test `StatusBar.test.tsx`

- [x] Task 5: Create EmptyState component (AC: #9)
  - [x] Create `src/renderer/src/components/shared/EmptyState.tsx`
  - [x] Accept props: `icon` (LucideIcon), `title` (string), `description` (string), optional `action` (ReactNode for a CTA button)
  - [x] Layout: centered vertically, icon (24px, muted) + headline (16px, weight 600) + description (13px, muted) + optional action button
  - [x] Write co-located unit test `EmptyState.test.tsx`

- [x] Task 6: Update App.tsx with shell layout (AC: #1, #2, #4, #5, #9)
  - [x] Modify `src/renderer/src/App.tsx`
  - [x] Replace current `RootLayout` with three-zone layout: ActivityBar (left) + Content (center, flex-1) + StatusBar (bottom)
  - [x] Layout structure: outer flex row (ActivityBar + main column), main column is flex column (content + StatusBar)
  - [x] Replace `PlaceholderView` with view-specific `EmptyState` components using appropriate icons:
    - Sessions: `LayoutList` icon, "No Sessions Yet", "Sessions will appear here once scanning is configured"
    - Live Dashboard: `Activity` icon, "No Active Sessions", "Running sessions will appear here in real-time"
    - Reports: `FileBarChart` icon, "No Reports", "Generate reports once you have session data"
    - Clients: `Users` icon, "No Clients", "Add clients and projects to organize your sessions"
    - Settings: `Settings` icon, "Settings", "Configure your ViberTime preferences"
  - [x] Ensure `Toaster` remains in the layout
  - [x] Verify all routes work via React Router `createMemoryRouter`

- [x] Task 7: Final validation (AC: all)
  - [x] Run `npm run dev` — app launches with ActivityBar, content area, and StatusBar visible
  - [x] Click each ActivityBar icon — navigates to correct view
  - [x] Active icon shows accent styling (background + left border)
  - [x] Keyboard navigation: Tab to ActivityBar, arrow keys between icons, Enter to select
  - [x] StatusBar visible at bottom with placeholder text
  - [x] Each view shows EmptyState with appropriate icon and text
  - [x] Run `npx vitest run` — all tests pass (existing + new)
  - [x] No TypeScript errors, ESLint clean

## Dev Notes

### Architecture Patterns & Constraints

**Three-Context Electron Architecture (CRITICAL):**
- **Main** (`src/main/`): Node.js process — file system, database, git, network, OS APIs
- **Preload** (`src/preload/`): IPC bridge via `contextBridge.exposeInMainWorld()`
- **Renderer** (`src/renderer/`): React UI — pure browser context, no Node.js APIs
- This story is **renderer-only** — no changes to main or preload processes

**Component Location (from architecture):**
- ActivityBar, StatusBar, EmptyState → `src/renderer/src/components/shared/`
- Zustand store → `src/renderer/src/stores/`
- shadcn/ui components → `src/renderer/src/components/ui/`

**Naming Conventions (MUST follow):**
| Element | Convention | Examples |
|---------|-----------|----------|
| React components | PascalCase `.tsx` | `ActivityBar.tsx`, `StatusBar.tsx` |
| Non-component files | kebab-case | `use-ui-store.ts` |
| Zustand stores | `use[Name]Store` | `useUIStore` |
| Test files | co-located | `ActivityBar.test.tsx` |

**Anti-Patterns (NEVER do):**
- `console.log` for logging — use `electron-log/renderer` (import from `@/lib/log`)
- `any` type — always type explicitly
- Manual loading state booleans — React Query handles this (not needed for this story)
- Raw CSS for layout — use Tailwind utility classes with CSS custom properties

### UX Specification Details

**ActivityBar (from UX spec):**
- Width: 56px fixed
- Background: `var(--background-secondary)` (#12121e)
- Icon size: 20-24px
- Icon default color: `var(--text-muted)` (#555555)
- Icon active: `var(--accent)` (#14b8a6) with `rgba(var(--accent-rgb), 0.1)` background
- Active indicator: 3px left border in accent color
- Hover: `var(--background-elevated)` (#1e1e32) background
- Padding between icons: 8px vertical
- Tooltip on hover showing view name
- `role="navigation"`, `aria-label="Main navigation"`

**StatusBar (from UX spec):**
- Height: 24px fixed
- Background: `var(--background-secondary)` (#12121e)
- Top border: 1px solid `var(--surface-border)` (#2a2a3e)
- Font size: 11px
- Text color: `var(--text-muted)` (#555555)
- Left: watching count + last scan. Right: daily total
- Future: click scan status triggers rescan

**EmptyState (from UX spec):**
- Centered vertically in content area
- Icon: 24px, muted color
- Headline: 16px, weight 600
- Description: 13px, muted color
- Optional primary action button below

**Layout Structure:**
```
+--56px--+-------fluid-------+
|        |                    |
| Activity|   Content Area    |
|  Bar   |    (Outlet)        |
|        |                    |
|        +--------------------+
|        |   StatusBar 24px   |
+---------+-------------------+
```

**View Memory (from UX spec):**
- Remember last active view — reopening the app returns to the last view
- Use Zustand with persistence for this

### Library/Framework Requirements

| Library | Version | Notes for this story |
|---------|---------|---------------------|
| lucide-react | 0.577.x | Already installed. Use for ActivityBar icons |
| zustand | 5.x | Named imports only. `create` from `zustand`. Optional: `persist` middleware for view memory |
| react-router | 7.x | `useNavigate`, `useLocation` from `react-router`. Already configured with `createMemoryRouter` |
| shadcn/ui Tooltip | latest | Install via `npx shadcn@latest add tooltip`. Built on Radix Tooltip primitive |
| tailwindcss | 4.x | CSS-first. Use `@theme` variables. NO tailwind.config.js |

**Zustand v5 Pattern:**
```typescript
import { create } from 'zustand'

interface UIState {
  activeView: string
  setActiveView: (view: string) => void
}

export const useUIStore = create<UIState>((set) => ({
  activeView: '/',
  setActiveView: (view) => set({ activeView: view }),
}))
```

**React Router v7 Navigation Pattern:**
```typescript
import { useNavigate, useLocation } from 'react-router'
const navigate = useNavigate()
const location = useLocation()
// Navigate: navigate('/sessions')
// Check active: location.pathname === '/sessions'
```

### File Structure for This Story

```
src/renderer/src/
├── App.tsx                          # MODIFY — add ActivityBar + StatusBar layout
├── stores/
│   └── use-ui-store.ts             # NEW — Zustand UI state store
│   └── use-ui-store.test.ts        # NEW — Store tests
├── components/
│   ├── ui/
│   │   └── tooltip.tsx             # NEW — shadcn/ui Tooltip (auto-generated)
│   ├── shared/
│   │   ├── ActivityBar.tsx         # NEW — Primary navigation sidebar
│   │   ├── ActivityBar.test.tsx    # NEW — Navigation tests
│   │   ├── StatusBar.tsx           # NEW — Bottom status bar
│   │   ├── StatusBar.test.tsx      # NEW — StatusBar tests
│   │   ├── EmptyState.tsx          # NEW — Empty view placeholder
│   │   └── EmptyState.test.tsx     # NEW — EmptyState tests
```

### Previous Story Intelligence (Story 1.1)

**Key Learnings from Story 1.1:**
- Tailwind v4 CSS-first config works — all design tokens defined in `index.css` via `@theme` and `:root`
- shadcn/ui components need manual config for Electron-Vite paths — `components.json` has `@/` alias
- React Router v7 uses single `react-router` package — `createMemoryRouter` for Electron (no real URL bar)
- Path alias `@/` maps to `src/renderer/src/*` (configured in tsconfig.web.json + electron.vite.config.ts)
- `"type": "module"` in package.json
- electron-log renderer: import from `@/lib/log` (wrapper already created)
- Node.js v20.17.0 — EBADENGINE warnings are non-blocking
- Sonner toast component installed and working with dark theme

**Existing Code to Build On:**
- `App.tsx`: Has `RootLayout` with flex layout, `PlaceholderView` for routes, `createMemoryRouter` with 5 routes
- `index.css`: Full design token system with all CSS custom properties needed
- `main.tsx`: StrictMode + createRoot entry point
- `lib/utils.ts`: `cn()` utility for className merging
- `lib/log.ts`: electron-log renderer wrapper

**Git Commit Patterns:**
- Conventional commit style: descriptive messages
- Last commit: `b649a0d Update Claude Code configuration and agents`
- Story 1.1 commit: `1eea6e8 Implement Story 1.1: Project scaffolding with Electron-Vite and core dependencies`

### Project Structure Notes

- All new files in `src/renderer/src/` — this is a renderer-only story
- `components/shared/` directory already exists (has `.gitkeep`)
- `stores/` directory already exists (has `.gitkeep`)
- `components/ui/` directory already exists (has `sonner.tsx`)
- Path alias: import as `@/components/shared/ActivityBar` etc.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 1.2 — Acceptance Criteria]
- [Source: _bmad-output/planning-artifacts/architecture.md — Project Structure, Naming Conventions, Frontend Architecture, Anti-Patterns]
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md — ActivityBar spec, StatusBar spec, EmptyState spec, Layout Foundation, Navigation Patterns, Spacing]
- [Source: _bmad-output/implementation-artifacts/1-1-initialize-project-with-electron-vite-and-core-dependencies.md — Previous story learnings, file structure, debug notes]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

- jsdom incompatible with Node 20 + @csstools/css-calc ESM module — switched to happy-dom for test environment
- Removed unused `vi` import from ActivityBar.test.tsx to fix TS6133 error

### Completion Notes List

- Task 1: Installed shadcn/ui Tooltip via CLI. Radix-based, dark-theme compatible out of the box.
- Task 2: Created Zustand UI store with `persist` middleware for `lastActiveView` memory across relaunches. 3 unit tests pass.
- Task 3: Created ActivityBar with 5 nav items (Sessions, Live, Reports, Clients, Settings), accent active state, keyboard nav (ArrowUp/Down wrapping), tooltips, aria attributes. 7 unit tests pass.
- Task 4: Created StatusBar with 24px height, placeholder text, prop-based dynamic values. 3 unit tests pass.
- Task 5: Created EmptyState with icon, title, description, optional action. 3 unit tests pass.
- Task 6: Updated App.tsx with three-zone layout (ActivityBar + content + StatusBar), TooltipProvider wrapping, view-specific EmptyState per route, Toaster preserved.
- Task 7: All 19 tests pass (5 test files), TypeScript clean, no regressions.
- Infrastructure: Added happy-dom, @testing-library/react, @testing-library/jest-dom, @testing-library/user-event as dev deps. Configured vitest with happy-dom environment and test-setup.ts.

### Change Log

- 2026-03-04: Implemented Story 1.2 — App Shell & Navigation Layout. All 7 tasks complete, 19 tests passing, TypeScript clean.

### File List

- src/renderer/src/App.tsx (MODIFIED)
- src/renderer/src/stores/use-ui-store.ts (NEW)
- src/renderer/src/stores/use-ui-store.test.ts (NEW)
- src/renderer/src/components/ui/tooltip.tsx (NEW — shadcn generated)
- src/renderer/src/components/shared/ActivityBar.tsx (NEW)
- src/renderer/src/components/shared/ActivityBar.test.tsx (NEW)
- src/renderer/src/components/shared/StatusBar.tsx (NEW)
- src/renderer/src/components/shared/StatusBar.test.tsx (NEW)
- src/renderer/src/components/shared/EmptyState.tsx (NEW)
- src/renderer/src/components/shared/EmptyState.test.tsx (NEW)
- src/renderer/src/test-setup.ts (NEW)
- vitest.config.ts (MODIFIED — added happy-dom env + setup file)
- package.json (MODIFIED — added test dev deps + radix-ui/react-tooltip)
- _bmad-output/implementation-artifacts/sprint-status.yaml (MODIFIED)
