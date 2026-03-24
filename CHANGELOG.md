# Changelog

All notable changes to ClauTime will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- Project selector for invoice line item generation — filter by specific project or all
- Ticket attribution on invoice line items using git commit spanning logic
- AI-generated business-friendly descriptions for invoice line items
- Multi-ticket support with indented line formatting per ticket
- Editable hours on invoice line items with auto-calculated amounts
- ACH-only payment toggle with persistent preference
- ACH error detection with Stripe setup link dialog
- Auto-sync invoice statuses from Stripe on list view
- Donate button on invoicing page

### Fixed
- Invoice date display off-by-one from UTC parsing of date-only strings
- Session date filtering now uses local time instead of UTC string comparison
- Invoice line items no longer pull unrelated project data into AI summaries

### Changed
- Invoice amount column is now read-only (driven by hours x rate)
- Removed manual sync button from invoice list (auto-syncs now)
- Hours display uses 2 decimal precision

## [0.1.0] - 2026-03-22

### Added
- **Session Detection** — Automatic discovery of Claude Code sessions from JSONL conversation files with tool-type-aware gap detection (5/10/30 min idle limits)
- **Client & Project Management** — Organize work by client and project with billable rates, auto-attribution of sessions to projects
- **Live Dashboard** — Real-time session monitoring with floating desktop widgets, activity glow indicators, and configurable alerts
- **AI Summaries** — Three-tier summary system (cached AI, git commits, fallback) using Claude Haiku for session and report descriptions
- **Git Integration** — Automatic commit correlation to sessions, commit-to-day attribution with spanning logic
- **Reports & Export** — Detailed timesheets and summary reports with PDF/Markdown/HTML export, daily breakdowns, and AI-generated work summaries
- **Stripe Invoicing** — Create and send invoices directly from session data with auto-generated line items, overlap detection, and invoice history
- **Secret Scanner** — 40+ regex patterns to detect API keys, passwords, and tokens in JSONL files with redaction support and custom patterns
- **Analytics** — AI vs Human time breakdown, gap analysis visualization, token usage tracking
- **Auto-Updates** — GitHub releases integration with electron-updater for seamless updates
- **Desktop Integration** — System tray with minimize-to-tray, floating widgets with hotkey toggle, desktop notifications
- **Offline Support** — Full functionality without network, graceful degradation of AI and Stripe features
- **Customization** — Dark/light themes, custom AI summary instructions, configurable idle timeouts, after-hours mode
