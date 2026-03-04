# Story 1.1: Initialize Project with Electron-Vite and Core Dependencies

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer**,
I want **the ViberTime project scaffolded with all core dependencies installed and configured**,
So that **I have a working development environment to build features on**.

## Acceptance Criteria

1. **Given** no existing project, **When** the project is initialized using `npm create @quick-start/electron@latest vibertime -- --template react-ts`, **Then** the project compiles and runs, showing a blank Electron window
2. **And** Tailwind CSS is installed and configured with the Vite plugin (`@tailwindcss/vite`)
3. **And** shadcn/ui is initialized with dark theme CSS variables in `globals.css`
4. **And** Drizzle ORM and better-sqlite3 are installed as dependencies
5. **And** React Router v7 is installed and a root route is configured
6. **And** Vitest is installed with co-located test configuration
7. **And** electron-log is installed and configured for main process logging
8. **And** electron-builder is configured with basic build targets (NSIS, DMG, AppImage)
9. **And** ESLint and TypeScript configs are validated across all three contexts (main, preload, renderer)
10. **And** `npm run dev` launches the app with HMR working

## Tasks / Subtasks

- [x] Task 1: Scaffold Electron-Vite project (AC: #1)
  - [x] Run `npm create @quick-start/electron@latest vibertime -- --template react-ts`
  - [x] Verify project compiles and blank Electron window appears
  - [x] Verify HMR is working in development mode

- [x] Task 2: Install and configure Tailwind CSS v4 (AC: #2)
  - [x] Install `tailwindcss` and `@tailwindcss/vite`
  - [x] Add `@tailwindcss/vite` plugin to renderer Vite config in `electron.vite.config.ts`
  - [x] Create CSS entry with `@import "tailwindcss"` directive (Tailwind v4 CSS-first config)
  - [x] Set up `@theme` block with ViberTime design tokens (colors, fonts, spacing)
  - [x] Configure dark mode default with semantic CSS custom properties
  - [x] Define accent color themes (Teal default: #14b8a6, Amber: #f59e0b, Purple: #a78bfa, Blue: #3b82f6)
  - [x] Define 8 project colors as CSS custom properties
  - [x] Set up responsive breakpoints: compact (max-width: 1023px), standard (min-width: 1024px), spacious (min-width: 1440px)

- [x] Task 3: Initialize shadcn/ui (AC: #3)
  - [x] Run `npx shadcn@latest init` (select dark theme, set path alias `@/`)
  - [x] Configure `components.json` for ViberTime project paths
  - [x] Verify base CSS variables are set in `globals.css` with HSL-based tokens
  - [x] Install Sonner toast component via `npx shadcn@latest add sonner`
  - [x] Verify a basic shadcn/ui component renders correctly with dark theme

- [x] Task 4: Install Drizzle ORM + better-sqlite3 (AC: #4)
  - [x] Install `drizzle-orm` and `better-sqlite3` as dependencies
  - [x] Install `drizzle-kit` and `@types/better-sqlite3` as dev dependencies
  - [x] Create `drizzle.config.ts` pointing to schema directory
  - [x] Create `src/main/db/` directory structure with placeholder `index.ts`
  - [x] Verify better-sqlite3 native module compiles for Electron's Node version (Node 22.x)
  - [x] Configure electron-builder to include native module rebuild

- [x] Task 5: Install React Router v7 (AC: #5)
  - [x] Install `react-router` (single unified package in v7)
  - [x] Configure `createMemoryRouter` in renderer (memory router recommended for Electron)
  - [x] Set up root route layout and placeholder routes for 5 views
  - [x] Verify navigation works between placeholder routes

- [x] Task 6: Install and configure Vitest (AC: #6)
  - [x] Install `vitest` as dev dependency
  - [x] Configure Vitest to read from `electron.vite.config.ts` or create `vitest.config.ts`
  - [x] Create a sample test file to verify test runner works
  - [x] Verify co-located test pattern (`*.test.ts` next to source files)

- [x] Task 7: Install and configure electron-log (AC: #7)
  - [x] Install `electron-log`
  - [x] Initialize in main process: `import log from 'electron-log/main'; log.initialize()`
  - [x] CRITICAL: `log.initialize()` must be called BEFORE creating any BrowserWindow
  - [x] Configure file rotation and log levels
  - [x] Verify logging works from main process
  - [x] Set up renderer process import: `import log from 'electron-log/renderer'`

- [x] Task 8: Configure electron-builder (AC: #8)
  - [x] Create `electron-builder.yml` with basic config
  - [x] Configure targets: NSIS (Windows), DMG (macOS), AppImage (Linux)
  - [x] Set `appId`, `productName`, `files`, `directories`
  - [x] Configure native module rebuild for better-sqlite3
  - [x] Verify build command runs without errors (dry run)

- [x] Task 9: Install remaining dependencies
  - [x] Install `@tanstack/react-query` for data fetching
  - [x] Install `zustand` for UI-only state management
  - [x] Install `electron-updater` for future auto-update support
  - [x] Verify all dependencies resolve without conflicts

- [x] Task 10: Validate TypeScript and ESLint configs (AC: #9)
  - [x] Verify separate tsconfig files for main, preload, and renderer contexts
  - [x] Ensure strict TypeScript mode is enabled
  - [x] Verify ESLint runs without errors across all contexts
  - [x] Ensure path aliases (`@/`) work in renderer context

- [x] Task 11: Create project directory structure
  - [x] Create `src/main/services/` directory
  - [x] Create `src/main/ipc/` directory
  - [x] Create `src/main/db/schema/` directory
  - [x] Create `src/main/db/migrations/` directory
  - [x] Create `src/main/parsers/` directory
  - [x] Create `src/renderer/components/ui/` directory (shadcn/ui)
  - [x] Create `src/renderer/components/shared/` directory
  - [x] Create `src/renderer/components/sessions/` directory
  - [x] Create `src/renderer/components/live/` directory
  - [x] Create `src/renderer/components/reports/` directory
  - [x] Create `src/renderer/components/settings/` directory
  - [x] Create `src/renderer/components/onboarding/` directory
  - [x] Create `src/renderer/features/` directory
  - [x] Create `src/renderer/stores/` directory
  - [x] Create `src/renderer/lib/` directory
  - [x] Create `src/shared/types/` directory
  - [x] Create `src/test/` directory for shared test utilities

- [x] Task 12: Final validation (AC: #10)
  - [x] Run `npm run dev` — app launches with HMR
  - [x] Run `npx vitest run` — sample test passes
  - [x] Verify Tailwind classes render correctly in the Electron window
  - [x] Verify no TypeScript errors across all contexts
  - [x] Verify ESLint passes across all contexts

## Dev Notes

### Architecture Patterns & Constraints

**Three-Context Electron Architecture (CRITICAL):**
- **Main** (`src/main/`): Node.js process — file system, database, git, network, OS APIs
- **Preload** (`src/preload/`): IPC bridge via `contextBridge.exposeInMainWorld()`
- **Renderer** (`src/renderer/`): React UI — pure browser context, no Node.js APIs
- `nodeIntegration: false`, `contextIsolation: true` — MANDATORY security settings

**Naming Conventions (MUST follow consistently):**

| Element | Convention | Examples |
|---------|-----------|----------|
| Database tables | snake_case, plural | `sessions`, `client_projects` |
| Database columns | snake_case | `idle_timeout`, `created_at` |
| IPC channels | `service:method` | `session:getAll`, `git:getCommits` |
| Variables/functions | camelCase | `getSessionById`, `idleTimeout` |
| Types/interfaces | PascalCase | `Session`, `IpcResult<T>` |
| React components | PascalCase .tsx | `SessionList.tsx` |
| Non-component files | kebab-case | `session-service.ts`, `use-sessions.ts` |
| Zustand stores | `use[Name]Store` | `useFilterStore`, `useUIStore` |
| React Query hooks | `use[Name]` | `useSessions` |
| Drizzle schemas | kebab-case | `sessions.ts`, `client-projects.ts` |
| Test files | co-located | `session-service.test.ts` |

**Anti-Patterns (NEVER do):**
- `useState` + `useEffect` for data fetching — use React Query
- Raw `ipcRenderer.send/on` — use typed service interfaces through preload
- `console.log` for logging — use `electron-log`
- Manual loading state booleans — React Query handles this
- Raw SQL strings — use Drizzle query builder
- `any` type — always type explicitly

### Design System Setup (from UX Spec)

**Color System:**
```css
/* Base dark theme */
--background-primary:    #16162a;
--background-secondary:  #12121e;
--background-elevated:   #1e1e32;
--surface-border:        #2a2a3e;
--text-primary:          #e0e0e0;
--text-secondary:        #888888;
--text-muted:            #555555;

/* Accent (switchable via single variable) */
--accent:                #14b8a6;  /* Teal default */
--accent-rgb:            20,184,166;

/* 8 project colors */
--project-1: #3b82f6; --project-2: #f59e0b; --project-3: #10b981; --project-4: #ef4444;
--project-5: #8b5cf6; --project-6: #ec4899; --project-7: #06b6d4; --project-8: #f97316;
```

**Typography:**
- UI text: `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
- Data values: `'SF Mono', 'Cascadia Code', 'Consolas', monospace`

**Minimum window size:** 800x600px (set via Electron `BrowserWindow` options)

### Library/Framework Version Requirements (as of March 2026)

| Library | Version | Critical Notes |
|---------|---------|---------------|
| electron-vite | 5.0.0 | Based on Vite 6; `build.isolatedEntries` for multi-entry |
| Electron | ~40.x | Node 22.x bundled; verify better-sqlite3 compatibility |
| Tailwind CSS | 4.2.0 | **CSS-first config** — NO `tailwind.config.js`; use `@theme` in CSS + `@tailwindcss/vite` plugin |
| shadcn/ui | latest | Unified `radix-ui` package; supports React 19 + Tailwind v4 |
| Drizzle ORM | 0.45.x | Use stable, NOT v1 beta; `drizzle-kit` for migrations |
| React Router | 7.x | Single `react-router` package; use `createMemoryRouter` for Electron |
| TanStack Query | 5.x | Single object params: `useQuery({ queryKey, queryFn })`; `isPending` not `isLoading` |
| Zustand | 5.x | Named imports only (no default export); `create` from `zustand` |
| Vitest | 4.x | Reads from vite config; `projects` instead of `workspace` |
| electron-builder | 26.x | Windows PATH issues with node-module-collector; configure native rebuild |
| electron-log | 5.4.x | `log.initialize()` in main BEFORE window creation; renderer uses IPC |
| Sonner | 2.x | Install via shadcn: `npx shadcn@latest add sonner` |

### Tailwind CSS v4 Migration Notes (CRITICAL)

Tailwind v4 is a MAJOR change from v3. Do NOT use v3 patterns:
- **NO `tailwind.config.js`** — all config is CSS-first via `@theme` block
- **NO `@tailwind base/components/utilities`** — use `@import "tailwindcss"`
- **NO PostCSS plugin** — use `@tailwindcss/vite` plugin directly
- Border utilities now use `currentColor` by default
- `flex-shrink-0` is now `shrink-0`

### electron-log v5 Setup (CRITICAL ORDER)

```typescript
// src/main/index.ts — MUST be at the very top, before any window creation
import log from 'electron-log/main';
log.initialize(); // REQUIRED before creating BrowserWindow
```

### React Router v7 for Electron

Use `createMemoryRouter` (NOT `BrowserRouter`) since Electron doesn't have a real URL bar:
```typescript
import { createMemoryRouter, RouterProvider } from 'react-router';
```

### better-sqlite3 Native Module

better-sqlite3 is a native Node.js addon that must be compiled for Electron's specific Node version. Use `@electron/rebuild` or configure electron-builder's rebuild settings. Verify the module loads in the main process before proceeding.

### Project Structure Notes

Full target directory structure for this story:
```
vibertime/
├── electron.vite.config.ts
├── electron-builder.yml
├── drizzle.config.ts
├── package.json
├── tsconfig.json
├── tsconfig.node.json
├── tsconfig.web.json
├── resources/                    # App icon
├── src/
│   ├── main/
│   │   ├── index.ts             # App entry, window creation, lifecycle
│   │   ├── db/
│   │   │   ├── index.ts         # Database connection placeholder
│   │   │   ├── schema/          # Drizzle schema files (empty for now)
│   │   │   └── migrations/      # Auto-generated by Drizzle Kit
│   │   ├── services/            # Service files (empty for now)
│   │   ├── ipc/                 # IPC handlers (empty for now)
│   │   └── parsers/             # Session parser (empty for now)
│   ├── preload/
│   │   └── index.ts             # contextBridge setup
│   ├── renderer/
│   │   ├── main.tsx             # React entry
│   │   ├── App.tsx              # Root with router, providers
│   │   ├── index.css            # Tailwind + design tokens
│   │   ├── components/
│   │   │   ├── ui/              # shadcn/ui components
│   │   │   ├── shared/          # ActivityBar, StatsBar, StatusBar, EmptyState
│   │   │   ├── sessions/        # Session components
│   │   │   ├── live/            # Live dashboard components
│   │   │   ├── reports/         # Report components
│   │   │   ├── settings/        # Settings components
│   │   │   └── onboarding/      # Welcome flow
│   │   ├── features/            # Feature modules
│   │   ├── stores/              # Zustand stores
│   │   └── lib/                 # Utils, query client
│   ├── shared/
│   │   └── types/               # Shared TypeScript types
│   └── test/                    # Shared test utilities
└── .github/
    └── workflows/               # CI/CD (future stories)
```

### References

- [Source: _bmad-output/planning-artifacts/architecture.md — Technical Stack, Code Structure, Naming Conventions]
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md — Design System, Color Palette, Typography, Component Structure]
- [Source: _bmad-output/planning-artifacts/prd.md — Product Overview, Technology Constraints, NFRs]
- [Source: _bmad-output/planning-artifacts/epics.md — Epic 1, Story 1.1 Acceptance Criteria]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Debug Log References

- Node.js v20.17.0 EBADENGINE warnings for packages requiring ^20.19.0+ — non-blocking, all packages installed and functional
- electron-vite 5.0.0 with `"type": "module"` produces preload as `.mjs` — updated preload path reference accordingly
- shadcn CLI created literal `@` directory instead of resolving alias — manually created component and fixed components.json paths
- Removed `next-themes` dependency auto-installed by shadcn (Next.js-specific, not needed for Electron)

### Completion Notes List

- Scaffolded via `npm create @quick-start/electron@latest` with react-ts template
- Tailwind CSS v4 configured with CSS-first `@theme` block, full ViberTime design token system (dark theme, 4 accent themes, 8 project colors, shadcn/ui CSS variable bridge)
- shadcn/ui manually configured due to Electron-Vite non-standard paths; Sonner toast component installed and adapted for Electron (removed next-themes dependency)
- Drizzle ORM + better-sqlite3 installed; native module rebuilt for Electron via postinstall script; drizzle.config.ts created
- React Router v7 with `createMemoryRouter` — 5 placeholder views (Live Dashboard, Sessions, Reports, Clients, Settings)
- Vitest v4 configured with separate vitest.config.ts; co-located test pattern working; 3 sample tests passing
- electron-log v5 initialized BEFORE BrowserWindow creation (critical ordering)
- electron-builder.yml configured for ClawdTime (NSIS/DMG/AppImage targets, better-sqlite3 asarUnpack, GitHub publish)
- TanStack Query v5, Zustand, and electron-updater installed
- All TypeScript checks pass (node + web contexts), ESLint clean
- Full directory structure created per architecture spec
- Minimum window size set to 800x600, contextIsolation: true, nodeIntegration: false

### Change Log

- 2026-03-04: Story 1.1 implemented — full project scaffolding with all core dependencies
- 2026-03-04: Code review fixes — 7 issues resolved (1 HIGH, 6 MEDIUM): added renderer electron-log, log config, sandbox docs, preload logging, HTML title, components.json aliases, tsconfig paths

### File List

- package.json (new)
- package-lock.json (new)
- electron.vite.config.ts (new)
- electron-builder.yml (new)
- drizzle.config.ts (new)
- vitest.config.ts (new)
- components.json (new)
- tsconfig.json (new)
- tsconfig.node.json (new)
- tsconfig.web.json (modified — added @/ path alias)
- eslint.config.mjs (new)
- .editorconfig (new)
- .prettierrc.yaml (new)
- .prettierignore (new)
- .gitignore (modified — added Electron-Vite patterns)
- src/main/index.ts (new — app entry with electron-log init)
- src/main/db/index.ts (new — placeholder)
- src/main/db/schema/.gitkeep (new)
- src/main/db/migrations/.gitkeep (new)
- src/main/services/.gitkeep (new)
- src/main/ipc/.gitkeep (new)
- src/main/parsers/.gitkeep (new)
- src/preload/index.ts (new)
- src/preload/index.d.ts (new)
- src/renderer/index.html (new)
- src/renderer/src/main.tsx (new)
- src/renderer/src/App.tsx (new — router with 5 views)
- src/renderer/src/index.css (new — Tailwind v4 + design tokens)
- src/renderer/src/env.d.ts (new)
- src/renderer/src/lib/log.ts (new — renderer electron-log wrapper)
- src/renderer/src/lib/utils.ts (new — cn utility)
- src/renderer/src/lib/utils.test.ts (new — 3 tests)
- src/renderer/src/components/ui/sonner.tsx (new)
- src/renderer/src/components/shared/.gitkeep (new)
- src/renderer/src/components/sessions/.gitkeep (new)
- src/renderer/src/components/live/.gitkeep (new)
- src/renderer/src/components/reports/.gitkeep (new)
- src/renderer/src/components/settings/.gitkeep (new)
- src/renderer/src/components/onboarding/.gitkeep (new)
- src/renderer/src/features/.gitkeep (new)
- src/renderer/src/stores/.gitkeep (new)
- src/renderer/src/hooks/.gitkeep (new)
- src/shared/types/.gitkeep (new)
- src/test/.gitkeep (new)
- resources/icon.png (new)
- build/ (new — electron-builder resources)
- .vscode/ (new — editor settings)
