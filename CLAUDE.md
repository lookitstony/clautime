# ClauTime — Claude Code Project Reference

## Build & Dev Commands
```bash
npm run dev              # Start dev server with hot reload
npm run build            # TypeScript check + bundle
npm run build:win        # Windows NSIS installer
npm run build:mac        # macOS DMG
npm run build:linux      # Linux AppImage
npm run build:unpack     # Unpacked dev build (no installer)
npm run test             # Run vitest once
npm run test:watch       # Vitest watch mode
npm run lint             # ESLint
npm run format           # Prettier
npm run typecheck        # TypeScript check (node + web)
npm run typecheck:node   # Main process only
npm run typecheck:web    # Renderer only
npm run rebuild:node     # Rebuild better-sqlite3 for Node (tests)
npm run rebuild:electron # Rebuild better-sqlite3 for Electron (dev)
```

## Architecture
- **Electron 39** with electron-vite 5 + Vite 7 — three-process model
- **Main process** (`src/main/`): Node.js runtime — DB, services, IPC handlers, file watchers
- **Renderer** (`src/renderer/`): React 19 + TypeScript — UI, state, hooks
- **Preload** (`src/preload/`): Context-isolated IPC bridge, outputs as `.mjs`
- **Shared** (`src/shared/`): Types and utilities shared between main/renderer
- `"type": "module"` in package.json — ESM throughout

## Tech Stack
- React 19, TypeScript 5.9, Tailwind CSS v4 (CSS-first, NO tailwind.config.js), shadcn/ui (new-york)
- Drizzle ORM 0.45 + better-sqlite3 12.6 (synchronous, WAL mode)
- TanStack Query v5 (server state), Zustand 5 (UI state, localStorage persist)
- React Router v7 (createMemoryRouter), Lucide icons, Sonner toasts
- electron-log 5 (`.js` extension required, call `log.initialize()` before BrowserWindow)
- electron-builder 26 + electron-updater 6.8 (GitHub releases)

## Database
- SQLite at `~/.electron/userData/clautime.db` (auto-migrates from old `clawdtime` folder)
- 11 migrations (0000–0010), next migration is **0011**
- Schema files: `src/main/db/schema/*.ts` — snake_case SQL, camelCase TypeScript
- Migrations: `drizzle-kit generate` → sequential numbering → auto-run on app startup
- Tables: sessions, clients, projects, ai_summaries, git_commits, raw_messages, progress_events, app_settings, scan_state, project_alert_config, secret_findings

## IPC Pattern
All IPC uses `IpcResult<T>` wrapper — never throw raw exceptions across IPC boundary:
```typescript
// Handler (main): ipcMain.handle('channel:method', async (_event, args) => { try { return ipcSuccess(data) } catch { return ipcError('CODE', msg) } })
// Caller (renderer): const result = await window.api.namespace.method(args); if (result.success) { result.data } else { result.error }
```
- Channel naming: `namespace:method` (e.g., `session:scan`, `ai:generateSummary`)
- Services throw `AppError(code, message)` — IPC handlers catch and wrap

## Key Services (src/main/services/)
- **session-detector**: Gap-based session detection (tool-type-aware: 5/10/30 min gaps)
- **session-service**: CRUD + scan/rebuild logic, auto-triggers git scan
- **ai-service**: 3-tier fallback (cached AI → git commits → empty), Claude API
- **live-monitor-service**: Real-time JSONL file watching, 5s interval, midnight-aware
- **secret-scan-service**: 40+ regex patterns, custom patterns, JSONL redaction
- **credential-service**: API keys in Electron secure storage

## Path Alias
- `@/` → `src/renderer/src/*` (renderer only — main process uses relative imports)
- `tsconfig.web.json` includes `src/shared/**/*` for shared types

## Naming Conventions
- **Files**: PascalCase for React components (`SessionsPage.tsx`), kebab-case for everything else (`session-service.ts`)
- **Exports**: PascalCase interfaces/types, camelCase functions, UPPER_SNAKE_CASE constants
- **Tests**: `*.test.ts` / `*.test.tsx` colocated with source
- **IPC channels**: `namespace:method` with lowercase

## Testing
- Vitest 4 + happy-dom (renderer) / `// @vitest-environment node` (main process)
- Mock `electron-log/main.js` and `electron` app BEFORE importing services
- In-memory SQLite (`:memory:`) for test DB with migrations applied in setup
- @testing-library/react + @testing-library/jest-dom for component tests
- Radix Select in happy-dom needs `vi.stubGlobal('HTMLSelectElement', ...)` mock

## Logging
- Import: `import log from 'electron-log/main.js'` (MUST use `.js` extension)
- Preload: `import log from 'electron-log/preload.js'`
- File rotation: 10MB per file, stored in userData folder

## Git & Branching
- Direct commits to `master` — no feature branches or PRs
- Descriptive imperative commit messages (no conventional commit prefixes)
- Remote: `origin/master` on GitHub (`lookitstony/clautime`)

## Shell Commands
- **Do NOT use `&&`** to chain commands — use `;` or run separately
- Use `python` not `python3` on Windows (MS Store alias issue)
