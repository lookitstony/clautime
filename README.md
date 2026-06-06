# ClauTime

**Automatic time tracking for Claude Code sessions.**

ClauTime monitors your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) usage and gives you a complete picture of how you spend your AI-assisted development time across projects, clients, and teams.

## Why ClauTime?

Claude Code writes to JSONL log files as you work. ClauTime reads those files and automatically detects sessions, tracks token usage, counts prompts, and monitors activity in real time. No manual timers. No browser extensions. It just works.

## Features

### Tracking

- **Automatic session detection**: scans Claude Code's JSONL logs to detect coding sessions with tool-type-aware idle timeouts (5/10/30 minute gaps depending on what Claude was doing)
- **Live activity dashboard**: see which projects are active right now, with real-time processing indicators that glow when Claude is actively working
- **Floating widgets**: always-on-top mini windows showing per-project status, elapsed time, and activity state. Stay visible across desktops
- **Manual time entry**: add manual time blocks for non-Claude work, or run a manual timer for ad-hoc tasks
- **Per-session billable toggle**: mark individual sessions billable or non-billable on the fly
- **After-hours mode**: filter views to only show work outside business hours

### Clients, projects & git

- **Client & project management**: assign projects to clients with hourly billable rates, auto-attribute sessions to projects from their working directory
- **Git commit correlation**: automatically links commits to the session they were authored in, with day-spanning attribution logic
- **Ticket attribution**: detects ticket IDs in commits (e.g. `TRI-1234`, `JIRA-42`) and rolls them up per day/project for invoicing
- **Welcome wizard**: first-run onboarding that auto-discovers your existing Claude Code projects

### Invoicing (Stripe)

- **Auto-generated invoices**: build invoices straight from billable session data with one click; line items grouped by day and project
- **AI-written line descriptions**: Claude Haiku turns commit messages and session summaries into business-friendly descriptions for each line
- **Stripe integration**: send invoices through Stripe, including ACH/bank-transfer-only mode, hosted invoice URL, and downloadable PDF
- **Test/sandbox mode**: separate live and test Stripe keys with a dedicated test email override; switch modes without losing data
- **Auto-sync from Stripe**: invoice statuses (paid, open, void) sync automatically from Stripe; import existing Stripe invoices into the local list
- **Overlap detection**: prevents accidentally re-invoicing the same period twice
- **Configurable due dates and memos**: default 30-day due, auto-generated period memos with ticket lists and AI overview

### Reports & analytics

- **Three report formats**: session breakdown (every session as a line), daily summary (totals per day with project rollups), and period summary (week/month/quarter rollups with AI-written overall summary)
- **Multi-format export**: save reports as Markdown, CSV, or PDF, or copy them straight to clipboard
- **Customizable analytics dashboard**: nine drag-and-drop widgets covering daily hours, billable earnings, hours by client, hours by project, peak hours, prompts per day, session length distribution, token usage, and work vs idle time
- **Configurable week start**: pick Monday, Sunday, or Saturday as the start of your week; applies across sessions, reports, and analytics

### AI summaries

- **Three-tier summary system**: cached AI summary (Claude Haiku) → git commit messages → no summary, automatic fallback
- **Per-session AI summaries**: on-demand or batched generation; results are cached locally
- **Custom AI instructions**: override the default prompts for both detailed and brief summary styles

### Privacy & security

- **Local-first**: everything stays on your machine. No telemetry, no cloud sync, no remote DB
- **Encrypted credentials**: API keys (Anthropic, Stripe) stored via Electron `safeStorage` (OS keychain)
- **Secret scanner**: detects 40+ patterns of API keys, tokens, passwords, and private keys accidentally logged in your JSONL files. Optional auto-redaction. Supports user-defined custom patterns

### Notifications & system integration

- **Desktop alerts**: native Windows/macOS toast notifications when Claude finishes processing, with configurable sounds and idle thresholds. Visible over fullscreen apps including Citrix VDI sessions
- **System tray**: minimize-to-tray; quit and toggle widgets from the tray icon
- **Auto-updates**: built-in electron-updater pulls updates from GitHub releases
- **Themed UI**: dark theme with four accent colors (teal, amber, purple, blue)

## Screenshots

_Coming soon_

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
5. Everything stays local. No data leaves your machine

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
