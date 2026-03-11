# ClauTime

**Automatic time tracking for Claude Code sessions.**

ClauTime monitors your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) usage and gives you a complete picture of how you spend your AI-assisted development time — across projects, clients, and teams.

## Why ClauTime?

Claude Code writes to JSONL log files as you work. ClauTime reads those files and automatically detects sessions, tracks token usage, counts prompts, and monitors activity in real time. No manual timers. No browser extensions. It just works.

## Features

- **Automatic session detection** — Scans Claude Code's JSONL logs to detect coding sessions with configurable idle timeouts
- **Live activity dashboard** — See which projects are active right now, with real-time processing indicators
- **Floating widgets** — Always-on-top mini windows showing per-project status and time
- **Client & project management** — Assign projects to clients, track billable vs non-billable work
- **Reports & export** — Session breakdowns, daily summaries, and period summaries exportable as Markdown
- **Analytics dashboard** — Customizable widgets for session trends, token usage, AI vs human time, and gap analysis
- **Desktop alerts** — Get notified when Claude finishes processing with configurable sounds and thresholds
- **Secret scanner** — Detects API keys, tokens, and credentials accidentally logged in JSONL files, with optional auto-redaction
- **After-hours mode** — Filter views to only show work outside business hours
- **Auto-updates** — Built-in updater keeps you on the latest version
- **Dark themed** — Sleek, native-feeling UI with multiple accent color themes

## Screenshots

*Coming soon*

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and used at least once

### Install & Run

```bash
git clone https://github.com/lookitstony/clautime.git
cd clautime
npm install
npm run dev
```

### Build

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

## Tech Stack

- **Electron 39** + electron-vite + Vite 7
- **React 19** + TypeScript
- **Tailwind CSS v4** + shadcn/ui
- **Drizzle ORM** + better-sqlite3
- **TanStack Query v5** + Zustand 5

## How It Works

1. Claude Code writes conversation logs to `~/.claude/projects/` as JSONL files
2. ClauTime scans these files and detects session boundaries using gap-based detection with tool-type-aware idle timeouts
3. Sessions are stored in a local SQLite database with full token counts, prompt counts, and timing data
4. The live monitor watches for file changes in real time to show active processing state
5. Everything stays local — no data leaves your machine

## Contributing

We welcome contributions! Please read our [Contributor License Agreement](CLA.md) before submitting a pull request.

By opening a pull request, you agree to the terms of the CLA.

### Development

```bash
npm run dev          # Start in development mode
npm test             # Run all tests
npm run lint         # Lint the codebase
npm run typecheck    # TypeScript type checking
```

## License

[Apache License 2.0](LICENSE)

Copyright 2026 ClauTime Contributors
