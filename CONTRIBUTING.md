# Contributing to ClauTime

Thanks for your interest in contributing! Here's how to get started.

## Contributor License Agreement

Before your first pull request can be merged, you must agree to our [Contributor License Agreement (CLA)](CLA.md). By opening a PR, you acknowledge that you have read, understood, and agree to the CLA terms.

## Development Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/lookitstony/clautime.git
   cd clautime
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start development:
   ```bash
   npm run dev
   ```

## Project Structure

```
src/
  main/           # Electron main process
    db/            # Database schema, migrations, Drizzle ORM
    services/      # Core services (session detection, live monitor, etc.)
    ipc/           # IPC handlers bridging main <-> renderer
    parsers/       # JSONL file parsers
  preload/         # Electron preload scripts
  renderer/        # React frontend
    src/
      components/  # Shared UI components
      features/    # Feature modules (sessions, live, reports, etc.)
      stores/      # Zustand stores
      lib/         # Utilities and helpers
  shared/          # Types shared between main and renderer
```

## Code Style

- TypeScript strict mode
- ESLint + Prettier for formatting
- Tailwind CSS v4 (CSS-first configuration, no tailwind.config.js)
- shadcn/ui components (new-york style)

## Testing

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
```

- **Renderer tests**: Use `happy-dom` environment (Vitest default)
- **Main process tests**: Use `// @vitest-environment node` directive

## Pull Request Guidelines

1. Keep PRs focused — one feature or fix per PR
2. Include tests for new functionality
3. Update types in `src/shared/` if adding new IPC channels
4. Run `npm run lint` and `npm test` before submitting
5. Write a clear PR description explaining what and why

## Reporting Issues

- Use GitHub Issues for bug reports and feature requests
- Include steps to reproduce for bugs
- Include your OS and Electron version

## Architecture Notes

- IPC follows the `ipcMain.handle` + `ipcRenderer.invoke` pattern with `IpcResult<T>` wrappers
- Database migrations are managed by Drizzle Kit with sequential numbering
- The live monitor uses JSONL file watching (mtime-based) rather than filesystem watchers
- All data stays local — no network calls for core functionality
