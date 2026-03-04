---
stepsCompleted: [step-01-validate-prerequisites, step-02-design-epics, step-03-create-stories, step-04-final-validation]
inputDocuments: [prd.md, architecture.md, ux-design-specification.md, ux-journey-flows-preview.md]
---

# ViberTime - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for ViberTime, decomposing the requirements from the PRD, UX Design if it exists, and Architecture requirements into implementable stories.

## Requirements Inventory

### Functional Requirements

FR1: System can automatically discover and read `.claude` session files from the user's `.claude` directory
FR2: System can extract project directory paths, session timestamps, conversation data, and token usage from session files
FR3: System can detect individual work sessions by identifying activity gaps using configurable idle timeouts (default 10 minutes)
FR4: System can deterministically attribute each session to a project based on the directory path associated with the session
FR5: System can incrementally process only new or changed session data since the last scan
FR6: System can store processed session data in a local SQLite database for fast retrieval
FR7: System can read git commit history from detected project directories
FR8: System can correlate git commits with sessions based on timestamp overlap, filtering to only the current user's commits (by git author/email)
FR9: System can extract commit messages to use as work descriptions when AI summarization is unavailable
FR10: User can configure their git identity (name/email) for commit filtering, or system can auto-detect from git config
FR11: User can create, edit, and delete client records
FR12: User can create, edit, and delete project records associated with clients
FR13: User can map detected project directory paths to client/project records
FR14: User can designate time as non-billable (personal, internal, exploratory work)
FR15: User can view a list of auto-detected sessions with timestamps, project attribution, and duration
FR16: User can view sessions filtered by date, client, or project
FR17: User can edit a session's attributed client/project (reassign)
FR18: User can split a single session into two sessions at a specified point in time
FR19: User can adjust session start and end times
FR20: User can add manual time blocks with client, project, time range, and description for non-AI work
FR21: User can visually distinguish between auto-detected sessions and manual time blocks
FR22: User can connect their Claude account (login/session) for AI-powered summarization
FR23: User can provide an Anthropic API key as a fallback for AI summarization
FR24: System can generate AI-powered work summaries for sessions using conversation history and git commit data
FR25: System can fall back to git commit messages as work descriptions when AI access is unavailable
FR26: System can display timestamps and project name only when neither AI nor git data is available
FR27: System can cache generated summaries in the local database for future offline access
FR28: System can extract and track token consumption data per session from `.claude` session files
FR29: User can view token usage aggregated by project
FR30: User can view token usage aggregated by client
FR31: User can view token usage for a specified date range
FR32: User can generate a report for a specified date range
FR33: User can generate a report filtered by client
FR34: User can generate a report filtered by project
FR35: User can view a session breakdown report (individual sessions with times, projects, and summaries)
FR36: User can view a daily summary report (aggregated hours and work per day)
FR37: User can view a full period summary report (total hours, work summaries across the entire date range)
FR38: User can export reports in a format suitable for attaching to invoices
FR39: User can regenerate reports after editing sessions to reflect updated data
FR40: User can configure the default idle timeout threshold for session detection
FR41: User can configure extended idle timeouts for specific scenarios (e.g., testing, builds)
FR42: User can configure the `.claude` directory path if it differs from the default location
FR43: User can configure AI access method (Claude login or API key)
FR44: User can view and manage all configured project-to-client mappings
FR45: System can check for updates via GitHub releases and prompt the user to update
FR46: System can operate fully offline for all features except AI summarization

### NonFunctional Requirements

NFR1: App startup to cached data visible in under 3 seconds
NFR2: Incremental session scan completes in under 5 seconds for typical usage (up to 50 new sessions)
NFR3: Report generation completes in under 2 seconds for cached data
NFR4: Background CPU usage under 1% when app is open but idle
NFR5: Memory footprint under 200MB during normal operation
NFR6: SQLite database operations (reads/writes) complete in under 100ms for individual queries
NFR7: API keys and Claude login credentials are stored securely using OS-level credential storage (e.g., Windows Credential Manager, macOS Keychain, Linux Secret Service)
NFR8: Session data remains local — no data is transmitted to external services except for AI summarization requests to Claude
NFR9: AI summarization requests send only the minimum data needed for summary generation, not full conversation history
NFR10: No telemetry, analytics, or usage data is collected or transmitted in MVP
NFR11: `.claude` session file parser is abstracted behind a clean interface to isolate the app from upstream format changes
NFR12: Git integration gracefully handles missing repos, empty histories, and repositories without commits from the configured user
NFR13: AI summarization gracefully degrades through three tiers (AI summary -> git commits -> timestamps only) without errors or user confusion
NFR14: App handles corrupt or malformed session files without crashing — logs warnings and skips affected files
NFR15: UI supports keyboard navigation for core workflows (session review, report generation)
NFR16: UI maintains sufficient color contrast ratios for readability
NFR17: Visual distinction between auto-detected and manual sessions does not rely solely on color
NFR18: Database access patterns must avoid N+1 query problems — use batch queries and joins to fetch related data in single operations
NFR19: Cross-cutting concerns (error handling, logging, data validation, configuration access) must be implemented as shared services/middleware, coded once and reused across all modules
NFR20: Data processing pipelines (session parsing, git correlation, summarization) must operate on batches, not individual records, to minimize I/O overhead

### Additional Requirements

**From Architecture:**

- Starter template: electron-vite official React-TS template (`npm create @quick-start/electron@latest vibertime -- --template react-ts`) — impacts Epic 1, Story 1
- Add Tailwind CSS + shadcn/ui + Drizzle ORM + better-sqlite3 + electron-builder + electron-log + Vitest + React Router v7 during project setup
- Drizzle ORM schema with auto-migrations run on app startup
- IPC service layer: service-based typed interfaces via contextBridge with `IpcResult<T>` response format
- Electron safeStorage for credential management (API keys, Claude login tokens)
- React Query (TanStack Query) for all data fetching from main process — no useState+useEffect fetch patterns
- Zustand for UI-only state (filters, active tab, sidebar toggle)
- electron-builder for packaging (NSIS/DMG/AppImage) + electron-updater for auto-update from GitHub Releases
- GitHub Actions CI/CD for automated cross-platform builds and releases
- electron-log for structured logging (no console.log in production)
- Service-per-domain architecture: SessionService, GitService, ClientProjectService, AIService, ReportService, SettingsService, CredentialService, LogService
- Co-located test files (`*.test.ts`) with Vitest
- Main process services are pure TypeScript — no Electron UI coupling (enables future CLI extraction to @vibertime/core)

**From UX Design:**

- Dark mode default with semantic CSS custom properties for future light mode
- Teal accent (#14b8a6) as default theme, 4 user-selectable themes (Teal, Amber, Purple, Blue) via single `--accent` CSS variable
- VS Code-style activity bar (56px) with 5 views: Sessions, Live, Reports, Clients, Settings
- Grouped-by-project session hierarchy with 3-level drill-down (Project Group -> Session Row -> Detail Panel)
- Live dashboard view with file system watchers for real-time session monitoring
- Welcome wizard with skip option for first-launch onboarding
- Inline editing pattern for all session corrections (no modals for simple edits)
- Minimum window size 800x600px, design target 1024-1440px
- WCAG 2.1 AA accessibility compliance with axe-core automated testing
- `prefers-reduced-motion` respected for all animations
- 8 fixed project colors for visual identification
- Monospace font for all data values (timestamps, durations, token counts)
- System font stack for UI text
- Skeleton loading states matching final layout structure
- Optimistic updates with undo toast (5-second timeout) for all edit operations
- Status bar (24px fixed bottom) showing watching projects count, last scan time, daily total
- Stats bar (4 cards) at top of Sessions view: Today's Total, Active Sessions, Total Sessions, Tokens Used
- 15 custom components defined: ActivityBar, ProjectGroup, SessionRow, SessionDetailPanel, LiveCard, StatsBar, StatusBar, DateRangePicker, TimeEditor, SplitSessionControl, ManualBlockForm, ReportRenderer, ThemeSelector, WelcomeFlow, EmptyState
- Progressive data loading on first launch: scan recent 7 days first, historical data in background
- Toast notifications via Sonner (bottom-right, max 3 stacked, 5-second auto-dismiss)

### FR Coverage Map

| FR | Epic | Description |
|----|------|-------------|
| FR1 | Epic 1 | Discover `.claude` session files |
| FR2 | Epic 1 | Extract paths, timestamps, conversations, tokens |
| FR3 | Epic 1 | Detect sessions via idle timeouts |
| FR4 | Epic 1 | Attribute sessions to projects by directory |
| FR5 | Epic 1 | Incremental processing |
| FR6 | Epic 1 | SQLite storage |
| FR7 | Epic 4 | Read git commit history |
| FR8 | Epic 4 | Correlate commits with sessions |
| FR9 | Epic 4 | Git commit messages as work descriptions |
| FR10 | Epic 4 | Configure git identity |
| FR11 | Epic 2 | Create/edit/delete clients |
| FR12 | Epic 2 | Create/edit/delete projects |
| FR13 | Epic 2 | Map directories to clients/projects |
| FR14 | Epic 2 | Non-billable time designation |
| FR15 | Epic 3 | View auto-detected sessions |
| FR16 | Epic 3 | Filter sessions by date/client/project |
| FR17 | Epic 3 | Reassign session client/project |
| FR18 | Epic 3 | Split sessions |
| FR19 | Epic 3 | Adjust session times |
| FR20 | Epic 3 | Add manual time blocks |
| FR21 | Epic 3 | Visual distinction auto vs manual |
| FR22 | Epic 5 | Connect Claude account |
| FR23 | Epic 5 | API key fallback |
| FR24 | Epic 5 | AI work summaries |
| FR25 | Epic 5 | Git commit fallback |
| FR26 | Epic 5 | Timestamps-only fallback |
| FR27 | Epic 5 | Cache summaries |
| FR28 | Epic 6 | Extract token usage data |
| FR29 | Epic 6 | Token usage by project |
| FR30 | Epic 6 | Token usage by client |
| FR31 | Epic 6 | Token usage by date range |
| FR32 | Epic 7 | Report for date range |
| FR33 | Epic 7 | Report filtered by client |
| FR34 | Epic 7 | Report filtered by project |
| FR35 | Epic 7 | Session breakdown report |
| FR36 | Epic 7 | Daily summary report |
| FR37 | Epic 7 | Period summary report |
| FR38 | Epic 7 | Export for invoices |
| FR39 | Epic 7 | Regenerate after edits |
| FR40 | Epic 8 | Configure idle timeout |
| FR41 | Epic 8 | Extended idle timeouts |
| FR42 | Epic 1 | Configure `.claude` directory path |
| FR43 | Epic 5 | Configure AI access method |
| FR44 | Epic 2 | View/manage project-client mappings |
| FR45 | Epic 8 | Auto-update from GitHub |
| FR46 | Epic 8 | Offline operation |

## Epic List

### Epic 1: Project Setup & Session Discovery
User installs ViberTime, configures project directories, and sees auto-detected work sessions for the first time.
**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR6, FR42

### Epic 2: Client & Project Management
User can create clients and projects, map detected directories to them, and see sessions organized by client/project.
**FRs covered:** FR11, FR12, FR13, FR14, FR44

### Epic 3: Session Management & Corrections
User can review, filter, edit, split, and reassign sessions, plus add manual time blocks for non-AI work.
**FRs covered:** FR15, FR16, FR17, FR18, FR19, FR20, FR21

### Epic 4: Git Integration & Enrichment
Sessions are enriched with git commit data, giving users work descriptions and context even without AI summarization.
**FRs covered:** FR7, FR8, FR9, FR10

### Epic 5: AI Summarization
User connects their Claude account or API key, and sessions receive AI-generated work summaries pulling from conversation history and git data.
**FRs covered:** FR22, FR23, FR24, FR25, FR26, FR27, FR43

### Epic 6: Token Usage Tracking
User can see how many tokens they've consumed per session, project, client, and date range.
**FRs covered:** FR28, FR29, FR30, FR31

### Epic 7: Reporting & Export
User generates client-ready time reports with date ranges, filters, and multiple formats, then exports them for invoicing.
**FRs covered:** FR32, FR33, FR34, FR35, FR36, FR37, FR38, FR39

### Epic 8: Settings, Updates & Polish
User can configure idle timeouts, appearance themes, and receive auto-updates. App works fully offline except AI.
**FRs covered:** FR40, FR41, FR45, FR46

---

## Epic 1: Project Setup & Session Discovery

User installs ViberTime, configures project directories, and sees auto-detected work sessions for the first time.

### Story 1.1: Initialize Project with Electron-Vite and Core Dependencies

As a **developer**,
I want **the ViberTime project scaffolded with all core dependencies installed and configured**,
So that **I have a working development environment to build features on**.

**Acceptance Criteria:**

**Given** no existing project
**When** the project is initialized using `npm create @quick-start/electron@latest vibertime -- --template react-ts`
**Then** the project compiles and runs, showing a blank Electron window
**And** Tailwind CSS is installed and configured with PostCSS
**And** shadcn/ui is initialized with dark theme CSS variables in `globals.css`
**And** Drizzle ORM and better-sqlite3 are installed as dependencies
**And** React Router v7 is installed and a root route is configured
**And** Vitest is installed with co-located test configuration
**And** electron-log is installed and configured for main process logging
**And** electron-builder is configured with basic build targets (NSIS, DMG, AppImage)
**And** ESLint and TypeScript configs are validated across all three contexts (main, preload, renderer)
**And** `npm run dev` launches the app with HMR working

### Story 1.2: App Shell & Navigation Layout

As a **developer using ViberTime**,
I want **a navigable app shell with sidebar, status bar, and routed views**,
So that **I can switch between app sections and see the app's structural foundation**.

**Acceptance Criteria:**

**Given** the app is launched
**When** the main window renders
**Then** a 56px ActivityBar is visible on the left with 5 icon buttons (Sessions, Live, Reports, Clients, Settings)
**And** clicking an ActivityBar icon navigates to the corresponding route via React Router
**And** the active view is indicated with accent background and left border on the ActivityBar icon
**And** a 24px StatusBar is visible at the bottom of the window
**And** the content area fills the remaining space between ActivityBar and StatusBar
**And** the dark theme is applied with `#16162a` background and teal `#14b8a6` accent
**And** the minimum window size is enforced at 800x600px
**And** system font stack is used for UI text and monospace for data values
**And** each view renders an EmptyState placeholder component
**And** keyboard navigation works between ActivityBar items (Tab, arrow keys, Enter)
**And** Zustand stores are set up for UI state (active view, sidebar state)

### Story 1.3: Database Schema & Service Foundation

As a **developer using ViberTime**,
I want **the database schema, IPC service layer, and cross-cutting services established**,
So that **all future features have a consistent data and communication foundation**.

**Acceptance Criteria:**

**Given** the app starts up
**When** the main process initializes
**Then** a SQLite database is created (or opened if existing) via better-sqlite3
**And** Drizzle ORM migrations run automatically before the UI loads
**And** the `sessions` table is created with columns: id, project_path, started_at, ended_at, duration_minutes, source (auto/manual), description, status, created_at, updated_at
**And** the `app_settings` table is created with key-value storage for configuration
**And** the IPC service layer is scaffolded with typed `IpcResult<T>` response format
**And** `contextBridge.exposeInMainWorld` exposes a typed `window.api` object in the preload script
**And** a `SettingsService` exists in main process for reading/writing app settings
**And** `electron-log` is configured with file rotation and appropriate log levels
**And** a shared `AppError` class exists with `code` and `message` fields for structured errors
**And** React Query client is configured in the renderer with default options
**And** at least one round-trip IPC call works end-to-end (e.g., `settings:get`)

### Story 1.4: Claude Session File Parser

As a **developer using ViberTime**,
I want **the system to read and parse `.claude` session files from the user's `.claude` directory**,
So that **raw session data can be extracted for processing into work sessions**.

**Acceptance Criteria:**

**Given** a `.claude` directory exists at the configured path (default `~/.claude`)
**When** the parser scans the directory
**Then** all session files are discovered and read
**And** project directory paths are extracted from each session file
**And** session timestamps are extracted from each session file
**And** conversation data references are extracted for future AI summarization
**And** token usage data is extracted from each session file
**And** the parser is abstracted behind a clean `SessionParser` interface (NFR11)
**And** corrupt or malformed session files are skipped with a warning logged via electron-log (NFR14)
**And** the parser processes files in batches, not one at a time (NFR20)
**And** parser output is a typed array of `ParsedSessionData` objects with all extracted fields
**And** unit tests validate parsing of valid files, corrupt files, and empty directories

### Story 1.5: Session Detection Engine

As a **developer using ViberTime**,
I want **the system to detect individual work sessions from parsed data using idle timeouts and attribute them to projects**,
So that **my work time is automatically organized into distinct sessions per project**.

**Acceptance Criteria:**

**Given** parsed session data from the Claude Session File Parser
**When** the session detection engine processes the data
**Then** individual work sessions are detected by identifying activity gaps exceeding the configured idle timeout (default 10 minutes)
**And** each detected session is deterministically attributed to a project based on the directory path (FR4)
**And** only new or changed session data is processed since the last scan (FR5), tracked via last-processed timestamps
**And** detected sessions are stored in the SQLite database via Drizzle ORM (FR6)
**And** the `SessionService` in the main process orchestrates parsing → detection → storage
**And** IPC handlers expose `session:scan` and `session:getAll` methods to the renderer
**And** database operations use batch inserts, not individual row inserts (NFR18, NFR20)
**And** incremental scan completes in under 5 seconds for up to 50 new sessions (NFR2)
**And** the configurable idle timeout value is read from `app_settings` in the database
**And** unit tests validate session boundary detection, project attribution, and incremental processing

### Story 1.6: Sessions View — Grouped by Project

As a **developer using ViberTime**,
I want **to see my detected sessions grouped by project with summary statistics**,
So that **I can quickly understand where my time went at a glance**.

**Acceptance Criteria:**

**Given** the app has detected sessions stored in the database
**When** the user navigates to the Sessions view
**Then** sessions are displayed grouped by project using ProjectGroup components
**And** each ProjectGroup row shows: project color dot, project name, session count badge, and total duration (monospace, accent color)
**And** clicking a ProjectGroup expands it to show individual SessionRow components
**And** each SessionRow shows: time range (monospace), duration, and status badge (Auto)
**And** a StatsBar at the top shows 4 cards: Today's Total, Active Sessions (0 for now), Total Sessions, Tokens Used
**And** the StatusBar at the bottom shows "Watching X projects" and last scan time
**And** data is fetched via React Query hooks calling `window.api.sessions.getAll()`
**And** skeleton loading states display while data loads
**And** an EmptyState shows "No sessions found" with a "Scan Now" button when no data exists
**And** only one SessionRow detail panel can be open at a time
**And** keyboard navigation works for expanding/collapsing groups and selecting sessions

### Story 1.7: Welcome Wizard & First Scan

As a **new ViberTime user**,
I want **a guided first-launch experience that discovers my project directories and runs an initial scan**,
So that **I see my work sessions immediately without manual configuration**.

**Acceptance Criteria:**

**Given** the app is launched for the first time (no projects configured)
**When** the Welcome Wizard appears
**Then** it displays "Welcome to ViberTime" with two paths: "Scan My Projects Folder" (primary button) and "I'll set up manually" (skip link)
**And** choosing "Scan My Projects Folder" opens a native OS folder picker dialog via Electron
**And** the selected folder is recursively scanned for `.claude` directories
**And** discovered projects are listed with checkboxes to include/exclude
**And** the user can confirm and trigger the initial scan
**And** the initial scan processes the most recent 7 days of data first, displaying sessions progressively
**And** historical data loads in the background with a status bar indicator ("Loading historical data...")
**And** choosing "I'll set up manually" skips to an empty Sessions view with an "Add Project" prompt
**And** if no `.claude` folders are found, a friendly message suggests trying a parent directory or manual setup
**And** the `.claude` directory path setting (FR42) is saved for future scans
**And** after the wizard completes, the user lands on the populated Sessions view

---

## Epic 2: Client & Project Management

User can create clients and projects, map detected directories to them, and see sessions organized by client/project.

### Story 2.1: Client & Project Database Schema

As a **developer using ViberTime**,
I want **database tables for clients and projects with directory mappings**,
So that **session data can be associated with billable client/project records**.

**Acceptance Criteria:**

**Given** the app starts up
**When** Drizzle migrations run
**Then** a `clients` table is created with columns: id, name, color (from 8-color palette), is_active, created_at, updated_at
**And** a `projects` table is created with columns: id, client_id (FK), name, directory_path, is_billable, is_active, created_at, updated_at
**And** the `sessions` table gains a nullable `project_id` (FK) and `client_id` (FK) column
**And** a `ClientProjectService` exists in the main process with CRUD operations for clients and projects
**And** IPC handlers expose `clientProject:*` methods (getClients, createClient, updateClient, deleteClient, getProjects, createProject, updateProject, deleteProject)
**And** directory-to-project mapping logic is implemented: given a session's directory path, find the matching project record
**And** unit tests validate CRUD operations and directory mapping logic

### Story 2.2: Clients & Projects Management UI

As a **developer using ViberTime**,
I want **a Clients view where I can create, edit, and delete clients and their projects**,
So that **I can organize my work by client and map project directories for session attribution**.

**Acceptance Criteria:**

**Given** the user navigates to the Clients view
**When** the view renders
**Then** a list of clients is displayed with project counts per client
**And** the user can create a new client with a name and assigned color (from 8-color palette)
**And** the user can edit an existing client's name and color
**And** the user can delete a client (with confirmation popover)
**And** expanding a client shows its projects with directory paths
**And** the user can create a new project under a client with name and directory path (via folder picker)
**And** the user can edit a project's name, directory path, and billable status
**And** the user can delete a project (with confirmation popover)
**And** the user can mark a project as non-billable (FR14)
**And** all changes save via React Query mutations with optimistic updates and toast confirmations
**And** an EmptyState shows "No clients configured" with an "Add Client" button when empty

### Story 2.3: Session-to-Client/Project Attribution

As a **developer using ViberTime**,
I want **detected sessions to be automatically attributed to their matching client and project**,
So that **sessions are organized under the correct client/project in the Sessions view**.

**Acceptance Criteria:**

**Given** clients and projects are configured with directory paths
**When** a session scan runs (or re-scan is triggered)
**Then** each detected session is matched to a project by comparing the session's directory path to configured project directory paths
**And** matched sessions display the client name and project color in the ProjectGroup rows
**And** unmatched sessions appear in an "Unassigned" group with a prompt to map their directory
**And** the user can view and manage all configured project-to-client mappings from the Clients view (FR44)
**And** re-scanning updates attributions if mappings have changed
**And** the StatsBar and StatusBar reflect client/project-aware data

---

## Epic 3: Session Management & Corrections

User can review, filter, edit, split, and reassign sessions, plus add manual time blocks for non-AI work.

### Story 3.1: Session Detail Panel

As a **developer using ViberTime**,
I want **to click a session row and see full session details in an inline panel**,
So that **I can review all information about a specific session without leaving the Sessions view**.

**Acceptance Criteria:**

**Given** a SessionRow is visible in an expanded ProjectGroup
**When** the user clicks a SessionRow
**Then** a SessionDetailPanel expands inline below the clicked row
**And** the panel displays: duration, time range (start–end), project name, client name, source badge (Auto/Manual), and description/summary (or "No summary available")
**And** clicking a different SessionRow closes the current panel and opens the new one
**And** pressing Escape closes the open panel
**And** the panel shows action buttons: Edit Time, Reassign Project (for auto sessions); Edit Description, Delete (for manual blocks)
**And** focus moves to the panel when it opens, and returns to the trigger row when it closes
**And** the panel adapts to window width (full content width at all sizes)

### Story 3.2: Session Filtering

As a **developer using ViberTime**,
I want **to filter sessions by date range, client, or project**,
So that **I can focus on specific time periods or clients when reviewing my work**.

**Acceptance Criteria:**

**Given** the Sessions view is populated with sessions
**When** the user applies filters
**Then** a filter bar at the top of the Sessions view provides: date range presets (Today, This Week, Last Week, This Month, Custom), client dropdown, and project dropdown
**And** selecting a date preset filters sessions to that range
**And** selecting a custom date range opens a calendar picker
**And** selecting a client filters to sessions for that client only
**And** selecting a project filters to sessions for that project only
**And** multiple filters can be combined (e.g., This Week + Client A)
**And** StatsBar updates to reflect filtered data
**And** clearing all filters returns to the full session list
**And** filter state is managed via Zustand store (not persisted across app restarts)
**And** React Query refetches with filter parameters via `window.api.sessions.getAll(filters)`

### Story 3.3: Edit Session Time & Reassign Project

As a **developer using ViberTime**,
I want **to adjust a session's start/end times and reassign it to a different project**,
So that **I can correct inaccurate auto-detection without starting from scratch**.

**Acceptance Criteria:**

**Given** a SessionDetailPanel is open for an auto-detected session
**When** the user clicks "Edit Time"
**Then** the start and end time fields become editable inline (TimeEditor component)
**And** duration recalculates live as times are changed
**And** pressing Enter saves the changes, Escape cancels
**And** a toast notification shows "Session updated. Undo?" with 5-second timeout

**Given** a SessionDetailPanel is open for an auto-detected session
**When** the user clicks "Reassign Project"
**Then** a project/client dropdown appears inline in the detail panel
**And** selecting a new project moves the session to the target ProjectGroup with animation
**And** both source and target ProjectGroup totals recalculate
**And** a toast notification shows "Session reassigned. Undo?" with 5-second timeout
**And** all changes use optimistic updates via React Query mutations

### Story 3.4: Split Session

As a **developer using ViberTime**,
I want **to split a single session into two at a chosen point in time**,
So that **I can separate merged work blocks that should be tracked independently**.

**Acceptance Criteria:**

**Given** a SessionDetailPanel is open for an auto-detected session
**When** the user clicks "Split Session"
**Then** a SplitSessionControl modal appears with a time input between the session's start and end times
**And** a preview shows the resulting two sessions with their durations
**And** clicking "Split Here" creates two sessions from the original, both in the same ProjectGroup
**And** the original session is replaced by the two new sessions in the database
**And** a toast notification shows "Session split. Undo?" with 5-second timeout
**And** split point cannot be set at the session boundaries (must be between start and end)
**And** StatsBar session count updates to reflect the additional session

### Story 3.5: Manual Time Blocks

As a **developer using ViberTime**,
I want **to add manual time blocks for work done outside of Claude Code**,
So that **my reports capture all billable work including meetings, testing, and manual code review**.

**Acceptance Criteria:**

**Given** the user is on the Sessions view
**When** the user clicks the "+ Manual Block" button in the header
**Then** a ManualBlockForm modal opens with fields: client/project dropdown, date picker (defaults to today), start time, end time, and description
**And** the primary action button is disabled until all required fields are valid
**And** end time must be after start time (inline validation with error message)
**And** saving creates a manual session record with source="manual" in the database
**And** the manual block appears in the correct ProjectGroup with a "Manual" badge (visually distinct from auto-detected via badge and left border color, not color alone — NFR17)
**And** manual blocks show "Edit Description" and "Delete" actions in the detail panel (not Split or Regenerate Summary)
**And** deleting a manual block requires confirmation via popover and shows an undo toast
**And** Escape or clicking outside the modal dismisses it (with unsaved changes warning if fields are dirty)

---

## Epic 4: Git Integration & Enrichment

Sessions are enriched with git commit data, giving users work descriptions and context even without AI summarization.

### Story 4.1: Git Service & Commit Reading

As a **developer using ViberTime**,
I want **the system to read git commit history from my project directories**,
So that **session data can be enriched with concrete work descriptions from commits**.

**Acceptance Criteria:**

**Given** a project directory is configured and contains a git repository
**When** the git service processes the directory
**Then** git commit history is read by spawning `git log` as a child process
**And** commits are stored in a `git_commits` table with columns: id, project_id, hash, message, author_name, author_email, committed_at, created_at
**And** the git service gracefully handles: missing git binary, non-git directories, empty repositories, and repos without user's commits (NFR12)
**And** warnings are logged via electron-log for any graceful failures
**And** commit reading processes in batches (NFR20)
**And** a `GitService` exists in the main process with IPC handlers on `git:*` namespace
**And** unit tests validate commit extraction, error handling, and batch processing

### Story 4.2: Git Commit Correlation with Sessions

As a **developer using ViberTime**,
I want **git commits automatically correlated with my work sessions by timestamp**,
So that **each session shows what code changes were made during that time period**.

**Acceptance Criteria:**

**Given** sessions and git commits exist in the database for the same project
**When** the correlation engine runs (during scan or on demand)
**Then** commits are matched to sessions based on timestamp overlap (commit time falls within session start–end range)
**And** only the current user's commits are included, filtered by git author name/email (FR8)
**And** matched commits are associated with their session in the database
**And** the SessionDetailPanel displays a "Git Commits" section listing correlated commit messages
**And** sessions without matching commits show no git section (no error, just absent)
**And** commit messages serve as work descriptions when AI summarization is unavailable (FR9)
**And** correlation runs in batch, not per-session (NFR20)

### Story 4.3: Git Identity Configuration

As a **developer using ViberTime**,
I want **to configure my git identity for commit filtering or have it auto-detected**,
So that **only my commits are correlated with sessions, not those from other contributors**.

**Acceptance Criteria:**

**Given** the user navigates to Settings
**When** the Git Identity section is displayed
**Then** the system auto-detects git name and email from `git config --global` and displays them
**And** the user can manually override the auto-detected name and email
**And** the configured identity is saved via SettingsService and used by GitService for filtering
**And** changing the git identity triggers a re-correlation of existing commits on next scan
**And** if git config is not available, the fields are empty with a prompt to enter manually

---

## Epic 5: AI Summarization

User connects their Claude account or API key, and sessions receive AI-generated work summaries pulling from conversation history and git data.

### Story 5.1: Credential Storage & AI Configuration UI

As a **developer using ViberTime**,
I want **to configure my AI access method and have credentials stored securely**,
So that **I can enable AI-powered session summaries using my existing Claude access**.

**Acceptance Criteria:**

**Given** the user navigates to Settings > AI Configuration
**When** the section renders
**Then** three options are available: Claude Login (preferred), API Key (fallback), None (git commits only)
**And** selecting "API Key" shows a masked input field for the Anthropic API key
**And** a "Test Connection" button validates the API key and shows success/error status
**And** credentials are stored securely using Electron safeStorage (NFR7)
**And** a `CredentialService` in the main process handles secure storage and retrieval
**And** API keys never leave the main process — never exposed to the renderer (NFR8)
**And** selecting "None" disables AI summarization with a note: "Sessions will use git commit messages as descriptions"
**And** the selected AI method is saved via SettingsService (FR43)
**And** Claude Login option shows a placeholder: "Coming soon — use API Key for now" (feasibility TBD per architecture)

### Story 5.2: AI Summary Generation Service

As a **developer using ViberTime**,
I want **the system to generate AI-powered work summaries for my sessions**,
So that **my reports include meaningful descriptions of what I accomplished, not just timestamps**.

**Acceptance Criteria:**

**Given** AI access is configured (API key validated)
**When** the user requests summary generation for a session (or batch of sessions)
**Then** the `AIService` sends a summarization request to the Claude API from the main process
**And** the request includes only the minimum data needed: session time range, project name, correlated git commits, and conversation metadata (NFR9)
**And** the AI generates a concise work summary (1-3 sentences)
**And** generated summaries are stored in an `ai_summaries` table linked to the session (FR27)
**And** cached summaries are returned on subsequent requests without re-calling the API
**And** summary generation status is shown inline in the SessionDetailPanel (loading spinner on summary text)
**And** IPC handlers expose `ai:generateSummary` and `ai:generateBatchSummaries` methods
**And** batch generation processes multiple sessions with progress feedback ("Generating summaries 3 of 12...")

### Story 5.3: Three-Tier Summarization Fallback

As a **developer using ViberTime**,
I want **session descriptions to gracefully degrade when AI is unavailable**,
So that **sessions always have some level of description without errors or confusion**.

**Acceptance Criteria:**

**Given** a session needs a description displayed
**When** the system checks available data sources
**Then** Tier 1: if an AI summary is cached, it is displayed
**And** Tier 2: if no AI summary but git commits exist, commit messages are displayed as the work description (FR25)
**And** Tier 3: if neither AI nor git data is available, only timestamps and project name are shown (FR26)
**And** the tier being displayed is indicated subtly (e.g., "AI Summary" vs "Git Commits" vs no label)
**And** the transition between tiers is seamless — no error messages, no broken states (NFR13)
**And** a "Generate Summary" button appears for Tier 2/3 sessions when AI is configured
**And** the fallback logic is tested for all three states with unit tests

---

## Epic 6: Token Usage Tracking

User can see how many tokens they've consumed per session, project, client, and date range.

### Story 6.1: Token Usage Data Extraction & Storage

As a **developer using ViberTime**,
I want **token consumption data extracted from `.claude` session files and stored per session**,
So that **I can understand my AI token usage across projects**.

**Acceptance Criteria:**

**Given** the Claude Session File Parser extracts token usage data (partially done in Story 1.4)
**When** session data is processed
**Then** token usage is stored in a `token_usage_records` table with columns: id, session_id (FK), input_tokens, output_tokens, total_tokens, created_at
**And** a `TokenUsageService` exists in the main process with aggregation methods
**And** IPC handlers expose `tokenUsage:getByProject`, `tokenUsage:getByClient`, `tokenUsage:getByDateRange`
**And** token data is extracted during the scan pipeline (no separate scan needed)
**And** the SessionDetailPanel shows token count for individual sessions
**And** the StatsBar "Tokens Used" card displays total tokens for the current filter period

### Story 6.2: Token Usage Aggregation Views

As a **developer using ViberTime**,
I want **to view token usage aggregated by project, client, and date range**,
So that **I can track AI costs and usage patterns across my work**.

**Acceptance Criteria:**

**Given** token usage data exists in the database
**When** the user views token usage information
**Then** token usage is visible per-project in the ProjectGroup rows (total tokens for that project)
**And** token usage is visible per-client when filtering by client
**And** token usage responds to the date range filter in the Sessions view
**And** all token values are displayed in monospace font for scannability
**And** aggregation queries use batch operations and joins (NFR18)
**And** token data in the StatsBar updates when filters change

---

## Epic 7: Reporting & Export

User generates client-ready time reports with date ranges, filters, and multiple formats, then exports them for invoicing.

### Story 7.1: Report Generation Engine

As a **developer using ViberTime**,
I want **a report service that generates structured reports from session data**,
So that **I can produce accurate time reports for client invoicing**.

**Acceptance Criteria:**

**Given** sessions exist in the database with client/project attributions
**When** a report is requested via the `ReportService`
**Then** a `ReportService` in the main process generates reports based on date range, client filter, and project filter (FR32, FR33, FR34)
**And** three report formats are supported:
- Session Breakdown: individual sessions with times, projects, and summaries (FR35)
- Daily Summary: aggregated hours and work per day (FR36)
- Period Summary: total hours and work summaries across the full date range (FR37)
**And** report generation completes in under 2 seconds for cached data (NFR3)
**And** IPC handlers expose `report:generate` with parameters for date range, filters, and format
**And** reports include both auto-detected and manual time blocks
**And** reports reflect the latest session data including any edits (FR39)

### Story 7.2: Reports View & Filter UI

As a **developer using ViberTime**,
I want **a Reports view with date range picker, client filter, and format selector**,
So that **I can configure and preview reports before exporting them**.

**Acceptance Criteria:**

**Given** the user navigates to the Reports view
**When** the view renders
**Then** a filter bar is displayed with: DateRangePicker (presets: Today, This Week, Last Week, This Month, Custom), client dropdown, project dropdown, and format selector (Session Summaries, Daily Summary, Period Summary)
**And** selecting filters triggers report generation via React Query
**And** the report renders in the main content area using a ReportRenderer component
**And** Session Summaries format shows sessions grouped by day with project color indicators and AI summaries
**And** Daily Summary format shows aggregated hours and key work items per day
**And** Period Summary format shows total hours, project breakdown, and overall accomplishments
**And** an EmptyState shows "Select a date range to generate a report" when no filters are set
**And** if report data is empty, a message suggests trying a different date range

### Story 7.3: Report Export

As a **developer using ViberTime**,
I want **to export reports in formats suitable for attaching to invoices**,
So that **I can deliver professional time reports to my clients**.

**Acceptance Criteria:**

**Given** a report is rendered in the Reports view
**When** the user clicks the "Export" dropdown button
**Then** export options are available: Copy to Clipboard (Markdown), Save as PDF, Save as Markdown file
**And** Copy to Clipboard copies clean, formatted Markdown to the system clipboard with a success toast
**And** Save as PDF generates a clean, printable PDF with professional formatting via Electron's `printToPDF`
**And** Save as Markdown opens a native save dialog and writes a `.md` file
**And** exported reports include: date range, client name, total hours, and all session/summary data per the selected format
**And** the export format is polished and professional — clean typography, clear structure, ready to attach to an invoice
**And** regenerating a report after editing sessions produces an updated export (FR39)

---

## Epic 8: Settings, Updates & Polish

User can configure idle timeouts, appearance themes, and receive auto-updates. App works fully offline except AI.

### Story 8.1: Session Detection Settings

As a **developer using ViberTime**,
I want **to configure idle timeout thresholds for session detection**,
So that **session boundaries match my actual work patterns**.

**Acceptance Criteria:**

**Given** the user navigates to Settings > Session Detection
**When** the section renders
**Then** a default idle timeout slider/input is displayed (range 1-60 minutes, default 10 minutes) (FR40)
**And** an extended idle timeout for builds/tests is displayed (range 10-120 minutes, default 30 minutes) (FR41)
**And** changes save automatically on slider release / input blur with a "Settings saved" toast
**And** the updated timeout values are used by the SessionService on the next scan
**And** the `.claude` directory path setting is displayed with a browse button and current path (FR42)
**And** changing the `.claude` directory path triggers a rescan prompt

### Story 8.2: Theme Selector & Appearance Settings

As a **developer using ViberTime**,
I want **to choose from 4 accent color themes**,
So that **the app matches my visual preferences**.

**Acceptance Criteria:**

**Given** the user navigates to Settings > Appearance
**When** the ThemeSelector renders
**Then** 4 color swatches are displayed: Teal (#14b8a6, default), Amber (#f59e0b), Purple (#a78bfa), Blue (#3b82f6)
**And** clicking a swatch applies the theme immediately by updating the `--accent` CSS custom property
**And** the active swatch shows a checkmark and accent border
**And** the selected theme is persisted via SettingsService and restored on app restart
**And** all UI elements using the accent color update live (ActivityBar, StatsBar, buttons, badges, links)
**And** `prefers-reduced-motion` is respected for the transition between themes

### Story 8.3: Auto-Update from GitHub Releases

As a **developer using ViberTime**,
I want **the app to check for updates and prompt me to install them**,
So that **I always have the latest features and fixes without manual downloads**.

**Acceptance Criteria:**

**Given** the app is running a packaged build
**When** the app checks for updates (on startup and periodically)
**Then** electron-updater checks GitHub Releases for a newer version (FR45)
**And** if an update is available, a non-intrusive notification appears with version info and "Update Now" / "Later" options
**And** clicking "Update Now" downloads and installs the update, then restarts the app
**And** clicking "Later" dismisses the notification until the next check
**And** update checks do not block the UI or interfere with active work
**And** the current version is displayed in Settings
**And** update checks work on Windows, macOS, and Linux

### Story 8.4: Offline Operation Validation

As a **developer using ViberTime**,
I want **all features except AI summarization to work fully offline**,
So that **I can track time, review sessions, and generate reports without an internet connection**.

**Acceptance Criteria:**

**Given** the app is running without internet connectivity
**When** the user performs core workflows
**Then** session scanning, detection, and storage work fully offline (FR46)
**And** git commit reading works offline (git is local)
**And** client/project management works offline
**And** session editing, splitting, and manual blocks work offline
**And** report generation works offline with cached data
**And** token usage tracking works offline
**And** AI summarization gracefully shows "AI unavailable — using git commits" (no error dialogs)
**And** update checks fail silently with a log warning (no user-facing error)
**And** no data is transmitted to external services when offline (NFR8, NFR10)
