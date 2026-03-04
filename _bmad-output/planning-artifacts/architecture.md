---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
lastStep: 8
status: 'complete'
completedAt: '2026-03-03'
inputDocuments: [product-brief-ClawdTime-2026-03-03.md, prd.md]
workflowType: 'architecture'
project_name: 'ViberTime'
user_name: 'Tony'
date: '2026-03-03'
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Project Context Analysis

### Requirements Overview

**Functional Requirements:**
46 FRs across 9 capability areas: Session Detection & Data Processing (FR1-6), Git Integration (FR7-10), Client & Project Management (FR11-14), Session Management (FR15-21), AI Summarization (FR22-27), Token Usage Tracking (FR28-31), Reporting (FR32-39), Settings & Configuration (FR40-44), Application Lifecycle (FR45-46). The architecture must support a data pipeline that reads external session files, correlates them with git history, and produces structured time/billing data with optional AI enrichment.

**Non-Functional Requirements:**
20 NFRs across 5 categories. Architecture-critical NFRs: <3s startup with cached data (NFR1), <5s incremental scan (NFR2), <1% idle CPU (NFR4), OS-level credential storage (NFR7), abstracted session parser (NFR11), three-tier summarization degradation (NFR13), no N+1 queries (NFR18), shared cross-cutting services (NFR19), batch data processing (NFR20).

**Scale & Complexity:**

- Primary domain: Desktop application (Electron + TypeScript)
- Complexity level: Low-Medium
- Estimated architectural components: 8-10 (session parser, git reader, session detector, AI summarizer, data store, report generator, client/project manager, settings manager, credential store, UI layer)

### Technical Constraints & Dependencies

- **`.claude` folder format:** Undocumented, subject to change without notice. Architecture must isolate the parser behind a clean interface for resilience.
- **Git CLI/library:** Depends on git being installed on the user's machine. Must handle missing git, empty repos, and author filtering.
- **Claude AI access:** Two integration paths (Claude login preferred, API key fallback). Claude login feasibility is unvalidated — architecture must support swapping between methods.
- **SQLite:** Local database for caching. Single-user, no concurrency concerns.
- **Electron:** Provides cross-platform desktop shell. Main process handles file system and git access; renderer process handles UI.
- **OS credential storage:** Platform-specific (Windows Credential Manager, macOS Keychain, Linux Secret Service).

### Cross-Cutting Concerns Identified

- **Error handling & resilience:** Corrupt session files, missing repos, format changes, network failures during AI calls — all must fail gracefully with user-visible warnings, never crashes.
- **Configuration management:** Centralized config service for clients, projects, idle timeouts, AI settings, git identity, `.claude` paths. Coded once, used everywhere.
- **Data caching & incremental processing:** SQLite-backed cache with last-processed timestamps. All data pipelines operate incrementally.
- **Credential storage:** Secure, OS-native storage for API keys and Claude login tokens. Abstracted behind a cross-platform interface.
- **Logging:** Structured logging service for warnings (skipped files), errors, and debug info. Single implementation, used across all modules.
- **Batch processing:** All data operations (session parsing, git correlation, report generation) must process in batches to avoid N+1 patterns and minimize I/O.

## Starter Template Evaluation

### Technical Preferences

- **Language:** TypeScript
- **Desktop Framework:** Electron
- **Frontend Framework:** React
- **Build Tool:** Vite
- **Database:** SQLite (better-sqlite3)
- **Styling:** Tailwind CSS (to be added)
- **UI Components:** shadcn/ui (to be added)

### Primary Technology Domain

Desktop application (Electron) with React frontend, based on project requirements for a cross-platform local-only app with file system access, SQLite storage, and optional network calls for AI summarization.

### Starter Options Considered

1. **electron-vite (official) with React template** — purpose-built Electron + Vite build tooling with official React + TypeScript template. Actively maintained, large community, lean foundation. **Selected.**
2. **electron-vite-fullstack-template** — community template with React + Redux + Tailwind + SQLite pre-wired. Convenient but single-maintainer risk. Rejected.
3. **Electron Forge with Vite plugin** — comprehensive packaging/distribution tooling. Vite support still marked experimental. May be added later for packaging. Deferred.

### Selected Starter: electron-vite (official React-TS template)

**Rationale:** Actively maintained by the electron-vite team, well-documented, and provides a clean foundation without opinionated choices about state management, styling, or database. Safer long-term bet for an open-source project than community templates.

**Initialization Command:**

```bash
npm create @quick-start/electron@latest vibertime -- --template react-ts
```

**Architectural Decisions Provided by Starter:**

**Language & Runtime:**
TypeScript configured for main process, preload scripts, and renderer process. Separate tsconfig for each context.

**Build Tooling:**
Vite for both main and renderer builds. Fast HMR in development, optimized production builds.

**Code Organization:**
Three-context Electron architecture: main (Node.js), preload (bridge), renderer (React). Clear separation of concerns.

**Development Experience:**
Hot module replacement, fast cold starts, ESLint pre-configured.

**Additional Technologies to Add:**

- Tailwind CSS — utility-first styling
- shadcn/ui — accessible, customizable React component library
- better-sqlite3 — synchronous SQLite bindings for Node.js (main process)
- keytar or electron safeStorage — OS-level credential storage

**Note:** Project initialization using this command should be the first implementation story.

## Core Architectural Decisions

### Decision Priority Analysis

**Critical Decisions (Block Implementation):**
- Data layer: Drizzle ORM + better-sqlite3
- Security: Electron safeStorage for credentials
- IPC pattern: Service-based typed interfaces via contextBridge
- State management: React Query + Zustand
- Packaging: electron-builder
- Desktop GUI first, CLI deferred to Phase 2

**Important Decisions (Shape Architecture):**
- Logging: electron-log for structured local logging
- CI/CD: GitHub Actions for cross-platform builds and releases
- Auto-update: electron-updater via GitHub Releases

**Deferred Decisions (Post-MVP):**
- CLI companion tool — Phase 2. Architecture enables it: main process services are pure TypeScript with no Electron UI coupling. Extract to shared `@vibertime/core` package when ready.
- Cloud sync infrastructure (future paid tier)
- Telemetry/analytics platform
- Multi-AI provider abstraction layer

### Data Architecture

**ORM:** Drizzle ORM — lightweight, type-safe, SQL-first. Schema defined in TypeScript with zero runtime overhead. Compatible with better-sqlite3 synchronous driver.

**Database:** better-sqlite3 — synchronous SQLite bindings running in Electron main process. Single-user, no concurrency concerns. All data access through Drizzle's query builder.

**Migration Strategy:** Drizzle Kit for schema migrations, run automatically on app startup before UI loads.

**Caching Strategy:** SQLite IS the cache. Session data parsed from `.claude` folders is stored in SQLite with last-processed timestamps. All subsequent reads come from the database, not the file system. Incremental processing only scans files modified since last scan.

**Data Validation:** Drizzle schema provides type safety at the query layer. `.claude` file parser validates and sanitizes external data at the ingestion boundary.

### Authentication & Security

**Credential Storage:** Electron safeStorage API — encrypts sensitive data (API keys, Claude login tokens) using OS-level encryption (DPAPI on Windows, Keychain on macOS, libsecret on Linux). No third-party dependencies.

**IPC Security:** Strict contextBridge isolation. `nodeIntegration: false`, `contextIsolation: true`. Renderer process has zero direct access to Node.js APIs. All file system, database, and git operations go through explicitly exposed preload functions.

**Data Security:** All data stored locally. No network calls except optional AI summarization to Claude API. API keys never leave the main process — AI calls are made from main process, not renderer.

### API & Communication Patterns

**IPC Architecture:** Service-based pattern. Typed service interfaces defined in a shared types package. Preload script exposes service methods via `contextBridge.exposeInMainWorld`. Renderer calls `window.api.serviceName.method()`.

**Error Handling:** All IPC calls return typed result objects (`{ success: true, data } | { success: false, error }`). No uncaught exceptions cross the IPC boundary. Renderer receives structured errors it can display to users.

**Service Organization:** One service per domain — SessionService, GitService, ClientProjectService, AIService, ReportService, SettingsService, CredentialService. Each service maps to an IPC channel namespace.

### Frontend Architecture

**Data Fetching & Server State:** TanStack Query (React Query) — manages all data fetched from the main process via IPC. Provides caching, background refetching, loading/error states, and stale-while-revalidate patterns. Eliminates manual loading state management.

**UI State:** Zustand — lightweight store for client-only state (selected filters, active tab, sidebar toggle, modal state). No boilerplate, no providers, simple get/set API.

**Component Library:** shadcn/ui — copy-paste accessible components built on Radix UI primitives. Styled with Tailwind CSS. Full control over component code, no dependency lock-in.

**Routing:** React Router v7 for page navigation — Sessions, Reports, Clients/Projects, Settings views.

**Testing:** Vitest — same Vite transforms and config, fast watch mode, compatible with electron-vite. Co-located test files (`*.test.ts`).

**Styling:** Tailwind CSS — utility-first, pairs with shadcn/ui, tree-shakeable in production.

### Infrastructure & Deployment

**Packaging:** electron-builder — creates platform-specific installers (NSIS for Windows, DMG for macOS, AppImage for Linux). Mature, well-documented, strong community support.

**Auto-Update:** electron-updater (bundled with electron-builder) — checks GitHub Releases for new versions, downloads and installs updates. Free for open-source projects.

**CI/CD:** GitHub Actions — automated builds on push/PR, cross-platform release builds on git tag. Publishes artifacts to GitHub Releases.

**Logging:** electron-log — structured logging to OS-standard log locations with file rotation. Works in both main and renderer processes. Debug, info, warn, error levels. No cloud telemetry for MVP.

**Environment Configuration:** Vite's built-in `import.meta.env` for compile-time config. `app.isPackaged` for runtime detection of dev vs production. No additional environment tooling needed.

### Decision Impact Analysis

**Implementation Sequence:**
1. Project scaffolding (electron-vite React-TS template)
2. Add Tailwind CSS + shadcn/ui + Drizzle ORM + better-sqlite3
3. Configure electron-builder + electron-updater
4. Implement IPC service layer (preload + main process services)
5. Set up Drizzle schema and migrations
6. Build domain services (session parser, git reader, etc.)
7. Build React UI with React Query + Zustand
8. Configure GitHub Actions CI/CD
9. First release to GitHub Releases

**Cross-Component Dependencies:**
- Drizzle schema must be defined before any service can persist data
- IPC service layer must exist before React Query hooks can fetch data
- electron-builder config must be set up before auto-update can be tested
- safeStorage credential service must exist before AI summarization service can store/retrieve API keys

## Implementation Patterns & Consistency Rules

### Pattern Categories Defined

**Critical Conflict Points Identified:** 5 categories where AI agents could make different choices — naming, structure, formats, communication, and process patterns. All resolved below.

### Naming Patterns

**Database Naming Conventions:**
- Tables: snake_case, plural — `sessions`, `client_projects`, `token_usage_records`
- Columns: snake_case — `idle_timeout`, `created_at`, `session_id`
- Foreign keys: `{referenced_table_singular}_id` — `client_id`, `project_id`
- Indexes: `idx_{table}_{columns}` — `idx_sessions_project_id`, `idx_sessions_started_at`

**IPC Channel Naming Conventions:**
- Format: `service:method` — `session:getAll`, `git:getCommits`, `settings:update`
- One namespace per domain service
- Method names match the service interface method names exactly

**Code Naming Conventions:**
- Variables and functions: camelCase — `getSessionById`, `idleTimeout`
- Types and interfaces: PascalCase — `Session`, `ClientProject`, `IpcResult<T>`
- React components: PascalCase — `SessionList`, `ReportFilter`
- Component files: PascalCase `.tsx` — `SessionList.tsx`, `ReportFilter.tsx`
- Non-component files: kebab-case — `session-service.ts`, `use-sessions.ts`
- Zustand stores: `use[Name]Store` — `useFilterStore`, `useUIStore`
- React Query hooks: `use[Name]` — `useSessions`, `useClientProjects`
- Drizzle schema files: kebab-case — `sessions.ts`, `client-projects.ts`

### Structure Patterns

**Project Organization:**
- Main process services: `src/main/services/` — one file per service (`session-service.ts`)
- Drizzle schema: `src/main/db/schema/` — one file per table group
- Drizzle migrations: `src/main/db/migrations/` — auto-generated by Drizzle Kit
- Shared types: `src/shared/types/` — IPC interfaces, domain models used by both main and renderer
- Preload: `src/preload/` — IPC bridge exposing typed service methods
- Renderer features: `src/renderer/features/{feature}/` — `sessions/`, `reports/`, `clients/`, `settings/`
- shadcn/ui components: `src/renderer/components/ui/` — standard shadcn location
- Shared/layout components: `src/renderer/components/` — app-level, non-UI-library components

**Test Organization:**
- Co-located with source — `session-service.test.ts` next to `session-service.ts`
- Test utilities: `src/test/` — shared mocks, fixtures, helpers

### Format Patterns

**IPC Response Format:**
All IPC calls return a typed result wrapper — never raw values, never thrown exceptions across the boundary:
```typescript
type IpcResult<T> = { success: true; data: T } | { success: false; error: { code: string; message: string } }
```

**Date/Time Formats:**
- Database storage: ISO 8601 strings (`2026-03-03T14:30:00Z`)
- UI display: Formatted via `Intl.DateTimeFormat` — never raw ISO strings shown to users
- Duration in DB: Integer minutes
- Duration in UI: Formatted as `2h 15m`

**ID Strategy:**
- Auto-increment integers from SQLite — simple, no UUIDs needed for local-only app

**Null Handling:**
- Use `null` (not `undefined`) for absent database values
- TypeScript types reflect nullability explicitly (`string | null`)

### Communication Patterns

**IPC Flow:**
Renderer → `window.api.sessions.getAll(filters)` → preload → `ipcRenderer.invoke('session:getAll', filters)` → main handler → returns `IpcResult<Session[]>`

**Push Events (main → renderer):**
`webContents.send('session:scan-progress', progress)` for real-time updates during long operations (scan progress, AI summarization status).

**React Query Keys:**
Array format matching service namespace:
- List: `['sessions', 'list', filters]`
- Detail: `['sessions', 'detail', id]`
- Invalidation: `queryClient.invalidateQueries({ queryKey: ['sessions'] })`

**Zustand Patterns:**
- Direct set for simple state: `useFilterStore.setState({ dateRange })`
- Setter functions defined in store for complex updates
- No action creators, no reducers, no middleware

### Process Patterns

**Error Handling:**
- Services throw typed `AppError` (with `code` + `message`)
- IPC layer catches all errors and wraps into `{ success: false, error }` format
- React Query `onError` callbacks display toast notifications to users
- `electron-log.error()` for all caught errors in main process

**Loading States:**
- Managed entirely by React Query — `isLoading`, `isFetching`, `isError`
- No manual loading boolean state variables
- Skeleton/spinner components driven by React Query status

**Logging Levels:**
- `error`: Crashes, data loss, unrecoverable failures
- `warn`: Skipped files, degraded features, fallback activated
- `info`: Scan complete, report generated, app lifecycle events
- `debug`: Development only, verbose internal state

**Validation:**
- At ingestion boundaries only: `.claude` file parser, user input forms
- Internal service-to-service calls trust typed inputs
- Drizzle schema enforces DB-level constraints

**React Error Boundaries:**
- One at app root — catches unhandled crashes, shows recovery UI
- One per feature route — isolates feature failures without crashing the whole app

### Enforcement Guidelines

**All AI Agents MUST:**
- Follow the naming conventions table exactly — no freestyle naming
- Use the `IpcResult<T>` wrapper for every main↔renderer call
- Co-locate tests with source files
- Use React Query for all data fetching — no `useEffect` + `useState` fetch patterns
- Use Drizzle query builder — no raw SQL strings
- Handle errors at service boundaries, not inside business logic
- Use `electron-log` for all logging — no `console.log` in production code

**Anti-Patterns (Never Do These):**
- `useState` + `useEffect` for data fetching — use React Query instead
- Raw `ipcRenderer.send/on` — use typed service interfaces through preload
- `console.log` for logging — use `electron-log`
- Manual loading state booleans — React Query handles this
- Raw SQL strings — use Drizzle query builder
- `any` type — always type explicitly, especially IPC payloads
- Storing secrets in plain text files — use `safeStorage`

## Project Structure & Boundaries

### Complete Project Directory Structure

```
vibertime/
├── package.json
├── electron.vite.config.ts
├── electron-builder.yml
├── drizzle.config.ts
├── tsconfig.json
├── tsconfig.node.json
├── tsconfig.web.json
├── tailwind.config.js
├── postcss.config.js
├── .eslintrc.cjs
├── .gitignore
├── dev-app-update.yml
├── .github/
│   └── workflows/
│       ├── ci.yml                          # Build + test on push/PR
│       └── release.yml                     # Cross-platform build on tag
├── resources/
│   └── icon.png                            # App icon for all platforms
├── src/
│   ├── main/
│   │   ├── index.ts                        # App entry, window creation, lifecycle (FR45-46)
│   │   ├── db/
│   │   │   ├── index.ts                    # Database connection (better-sqlite3 + Drizzle)
│   │   │   ├── schema/
│   │   │   │   ├── sessions.ts             # sessions, session_events tables
│   │   │   │   ├── clients.ts              # clients, projects tables
│   │   │   │   ├── git-data.ts             # commits table
│   │   │   │   ├── ai-summaries.ts         # ai_summaries table
│   │   │   │   ├── token-usage.ts          # token_usage_records table
│   │   │   │   └── settings.ts             # app_settings table
│   │   │   └── migrations/                 # Auto-generated by Drizzle Kit
│   │   ├── services/
│   │   │   ├── session-service.ts          # FR1-6: Session detection & data processing
│   │   │   ├── session-manager-service.ts  # FR15-21: Session CRUD, manual time blocks
│   │   │   ├── git-service.ts              # FR7-10: Git integration & author filtering
│   │   │   ├── client-project-service.ts   # FR11-14: Client & project management
│   │   │   ├── ai-service.ts              # FR22-27: AI summarization (Claude login + API key)
│   │   │   ├── token-usage-service.ts      # FR28-31: Token usage tracking
│   │   │   ├── report-service.ts           # FR32-39: Report generation
│   │   │   ├── settings-service.ts         # FR40-44: Settings & configuration
│   │   │   ├── credential-service.ts       # safeStorage credential management
│   │   │   └── log-service.ts              # electron-log setup & configuration
│   │   ├── ipc/
│   │   │   ├── index.ts                    # Register all IPC handlers
│   │   │   ├── session-handlers.ts         # session:* channel handlers
│   │   │   ├── git-handlers.ts             # git:* channel handlers
│   │   │   ├── client-project-handlers.ts  # clientProject:* handlers
│   │   │   ├── ai-handlers.ts             # ai:* channel handlers
│   │   │   ├── token-usage-handlers.ts     # tokenUsage:* handlers
│   │   │   ├── report-handlers.ts          # report:* channel handlers
│   │   │   ├── settings-handlers.ts        # settings:* channel handlers
│   │   │   └── credential-handlers.ts      # credential:* handlers
│   │   └── parsers/
│   │       ├── claude-session-parser.ts     # .claude folder parsing (NFR11: abstracted)
│   │       └── parser-types.ts             # Parser interface for future AI tool support
│   ├── preload/
│   │   ├── index.ts                        # contextBridge.exposeInMainWorld (all services)
│   │   └── index.d.ts                      # Type declarations for window.api
│   ├── renderer/
│   │   ├── index.html
│   │   ├── main.tsx                        # React entry point
│   │   ├── App.tsx                         # Root: router, providers, error boundary
│   │   ├── globals.css                     # Tailwind base styles
│   │   ├── components/
│   │   │   ├── ui/                         # shadcn/ui components (Button, Dialog, etc.)
│   │   │   ├── Layout.tsx                  # App shell: sidebar + header + content area
│   │   │   ├── ErrorBoundary.tsx           # Root + feature-level error boundaries
│   │   │   └── Toast.tsx                   # Notification toast system
│   │   ├── features/
│   │   │   ├── sessions/
│   │   │   │   ├── SessionsPage.tsx        # Sessions view entry
│   │   │   │   ├── SessionList.tsx         # Session list with filters
│   │   │   │   ├── SessionDetail.tsx       # Individual session view
│   │   │   │   ├── SessionEditForm.tsx     # Edit session assignment/duration
│   │   │   │   ├── ManualTimeBlock.tsx     # Add manual time blocks (FR19)
│   │   │   │   └── use-sessions.ts         # React Query hooks for sessions
│   │   │   ├── reports/
│   │   │   │   ├── ReportsPage.tsx         # Reports view entry
│   │   │   │   ├── ReportFilter.tsx        # Date range, client/project filters
│   │   │   │   ├── ReportOutput.tsx        # Rendered report with export options
│   │   │   │   ├── SessionBreakdown.tsx    # Per-session detail view (FR34)
│   │   │   │   ├── DailySummary.tsx        # Daily aggregated view (FR35)
│   │   │   │   └── use-reports.ts          # React Query hooks for reports
│   │   │   ├── clients/
│   │   │   │   ├── ClientsPage.tsx         # Client/project management view
│   │   │   │   ├── ClientList.tsx          # Client list with project counts
│   │   │   │   ├── ClientForm.tsx          # Add/edit client
│   │   │   │   ├── ProjectList.tsx         # Projects under a client
│   │   │   │   ├── ProjectForm.tsx         # Add/edit project with directory mapping
│   │   │   │   └── use-clients.ts          # React Query hooks for clients/projects
│   │   │   └── settings/
│   │   │       ├── SettingsPage.tsx         # Settings view entry
│   │   │       ├── GeneralSettings.tsx     # Idle timeout, scan paths (FR40-41)
│   │   │       ├── AISettings.tsx          # Claude login / API key config (FR42)
│   │   │       ├── GitSettings.tsx         # Git identity config (FR10)
│   │   │       ├── DirectorySettings.tsx   # .claude folder paths (FR43)
│   │   │       └── use-settings.ts         # React Query hooks for settings
│   │   ├── stores/
│   │   │   ├── use-filter-store.ts         # Date range, client/project filter state
│   │   │   └── use-ui-store.ts             # Sidebar, modal, active tab state
│   │   └── lib/
│   │       ├── query-client.ts             # TanStack Query client configuration
│   │       └── utils.ts                    # Shared renderer utilities (formatDuration, etc.)
│   └── shared/
│       └── types/
│           ├── ipc.ts                      # IpcResult<T>, service interface contracts
│           ├── session.ts                  # Session, SessionEvent domain types
│           ├── client.ts                   # Client, Project domain types
│           ├── report.ts                   # Report, ReportFilter types
│           ├── settings.ts                 # Settings domain types
│           └── token-usage.ts              # TokenUsage domain types
```

### Architectural Boundaries

**Process Boundaries (Electron):**
- **Main process** (`src/main/`): All Node.js operations — file system, database, git CLI, network (AI calls). No UI code.
- **Preload** (`src/preload/`): Thin bridge only. Exposes typed service interfaces via `contextBridge`. No business logic.
- **Renderer** (`src/renderer/`): React UI only. Zero access to Node.js, file system, or database. All data via `window.api.*`.

**Service Boundaries (Main Process):**
Each service owns its domain data and logic. Services call each other within the main process when needed (e.g., `session-service` calls `git-service` to correlate commits). Cross-service calls use direct imports — no IPC within main process.

**Data Boundaries:**
- `.claude` files → `claude-session-parser.ts` → `session-service.ts` → SQLite (via Drizzle)
- Git CLI → `git-service.ts` → SQLite (via Drizzle)
- SQLite → services → IPC → React Query → UI components

**External Integration Points:**
- `.claude` folders (read-only, file system)
- Git CLI (`git log`, `git config` — spawned as child processes)
- Claude API (HTTPS, from main process only)
- GitHub Releases (electron-updater, read-only)

### Requirements to Structure Mapping

| FR Category | Main Process | Renderer |
|-------------|-------------|----------|
| FR1-6: Session Detection | `services/session-service.ts`, `parsers/claude-session-parser.ts` | `features/sessions/` |
| FR7-10: Git Integration | `services/git-service.ts` | — (data surfaces through sessions) |
| FR11-14: Client/Project Mgmt | `services/client-project-service.ts` | `features/clients/` |
| FR15-21: Session Management | `services/session-manager-service.ts` | `features/sessions/` |
| FR22-27: AI Summarization | `services/ai-service.ts` | `features/settings/AISettings.tsx` |
| FR28-31: Token Usage | `services/token-usage-service.ts` | `features/reports/` (token data in reports) |
| FR32-39: Reporting | `services/report-service.ts` | `features/reports/` |
| FR40-44: Settings | `services/settings-service.ts` | `features/settings/` |
| FR45-46: App Lifecycle | `index.ts` (main entry) | `App.tsx` (startup scan trigger) |

**Cross-Cutting Concerns Mapping:**

| Concern | Location |
|---------|----------|
| Credential storage | `services/credential-service.ts` |
| Logging | `services/log-service.ts` (config), `electron-log` (usage everywhere) |
| Error handling | `ipc/*.ts` (wraps to IpcResult), `ErrorBoundary.tsx` (React) |
| IPC type safety | `shared/types/ipc.ts` + `preload/index.ts` |
| DB migrations | `db/migrations/` (auto-run on startup) |

### Data Flow

```
.claude folders ──→ claude-session-parser ──→ session-service ──→ SQLite
                                                    ↑
git CLI ──────────→ git-service ────────────────────┘
                                                    ↓
                                              report-service ──→ IPC ──→ React Query ──→ UI
                                                    ↑
                                              ai-service ──→ Claude API
```

## Architecture Validation Results

### Coherence Validation ✅

**Decision Compatibility:**
All technology choices verified compatible — electron-vite + React + TypeScript (native template), Drizzle ORM + better-sqlite3 (verified), React Query + Zustand (complementary), electron-builder + electron-updater (bundled), Tailwind CSS + shadcn/ui (designed together), Vitest + Vite (same ecosystem). No conflicts or contradictions found.

**Pattern Consistency:**
Naming conventions are consistent across all layers — snake_case in DB maps cleanly to camelCase in TypeScript via Drizzle. IPC channel naming (`service:method`) aligns with service organization. File naming conventions match the technology expectations (PascalCase React components, kebab-case services).

**Structure Alignment:**
Project structure directly supports all architectural decisions. Three-context Electron separation (main/preload/renderer) is reflected in the directory tree. Feature-based renderer organization aligns with React Router pages. Service-per-domain in main process aligns with IPC channel namespaces.

### Requirements Coverage Validation ✅

**Functional Requirements (46 FRs):**
All 9 FR categories mapped to specific main process services and renderer features. Every FR has an identifiable implementation location in the project structure. No orphaned requirements.

**Non-Functional Requirements (20 NFRs):**
All architecture-critical NFRs addressed: startup performance (NFR1) via SQLite cache, incremental scan (NFR2) via timestamps, low idle CPU (NFR4) via on-demand design, credential storage (NFR7) via safeStorage, parser abstraction (NFR11) via interface, summarization fallback (NFR13) via ai-service, N+1 prevention (NFR18) via batch patterns and Drizzle, cross-cutting services (NFR19) via shared services, batch processing (NFR20) via documented patterns.

### Implementation Readiness Validation ✅

**Decision Completeness:**
All critical technology decisions documented with specific packages. Two minor gaps resolved during validation: test framework (Vitest) and router (React Router v7) finalized.

**Structure Completeness:**
Complete directory tree with every file annotated with its FR mapping. All integration points specified. Component boundaries well-defined across Electron's three-context architecture.

**Pattern Completeness:**
All 5 conflict categories resolved with concrete examples. Enforcement guidelines and anti-patterns documented. Sufficient for AI agents to implement consistently without ambiguity.

### Gap Analysis Results

**Critical Gaps:** None found.

**Resolved During Validation:**
- Test framework: Vitest selected (Vite ecosystem, same config)
- Router: React Router v7 selected (established, simple for 4-page app)

**Deferred (Not Blocking MVP):**
- E2E testing framework (Playwright for Electron) — decide when E2E stories are created
- Specific shadcn/ui components to install — decide per feature story
- Claude login authentication flow details — validate feasibility in implementation

### Architecture Completeness Checklist

**✅ Requirements Analysis**
- [x] Project context thoroughly analyzed (46 FRs, 20 NFRs)
- [x] Scale and complexity assessed (Low-Medium)
- [x] Technical constraints identified (`.claude` format, git dependency, Claude API access)
- [x] Cross-cutting concerns mapped (error handling, config, caching, credentials, logging, batch processing)

**✅ Architectural Decisions**
- [x] Critical decisions documented with specific packages
- [x] Technology stack fully specified (13 core technologies)
- [x] Integration patterns defined (service-based IPC)
- [x] Performance considerations addressed (incremental processing, SQLite cache)

**✅ Implementation Patterns**
- [x] Naming conventions established (DB, IPC, code, files)
- [x] Structure patterns defined (feature-based renderer, service-based main)
- [x] Communication patterns specified (IPC flow, React Query keys, Zustand)
- [x] Process patterns documented (error handling, loading, logging, validation)

**✅ Project Structure**
- [x] Complete directory structure defined with FR annotations
- [x] Component boundaries established (main/preload/renderer)
- [x] Integration points mapped (file system, git CLI, Claude API, GitHub Releases)
- [x] Requirements to structure mapping complete (all 46 FRs)

### Architecture Readiness Assessment

**Overall Status:** READY FOR IMPLEMENTATION

**Confidence Level:** High — all requirements covered, all decisions coherent, no critical gaps.

**Key Strengths:**
- Clean separation of concerns via Electron's three-context architecture
- Type-safe IPC boundary prevents runtime errors between processes
- Service-per-domain design enables future CLI extraction (`@vibertime/core`)
- Incremental processing design satisfies performance NFRs
- Parser abstraction enables future multi-AI-tool support

**Areas for Future Enhancement:**
- E2E testing strategy (when stories require it)
- Claude login authentication flow (validate feasibility, API key fallback ready)
- CLI companion extraction (Phase 2)
- Cloud sync architecture (future paid tier)

### Implementation Handoff

**AI Agent Guidelines:**
- Follow all architectural decisions exactly as documented
- Use implementation patterns consistently across all components
- Respect project structure and boundaries
- Refer to this document for all architectural questions
- When in doubt, check the Enforcement Guidelines and Anti-Patterns sections

**First Implementation Priority:**
```bash
npm create @quick-start/electron@latest vibertime -- --template react-ts
```
Then add: Tailwind CSS, shadcn/ui, Drizzle ORM, better-sqlite3, electron-builder, electron-log, Vitest, React Router v7
