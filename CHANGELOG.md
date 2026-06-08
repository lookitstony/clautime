# Changelog

All notable changes to ClauTime will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [1.1.3] - 2026-06-08

### Fixed

- Main application window icon was showing the default Electron icon in packaged builds. Same root cause as the v1.1.2 tray icon fix: the `?asset` import resolved to a path inside `app.asar` where Electron's BrowserWindow `icon` option couldn't reliably load it. Now loaded from `process.resourcesPath` (outside asar) in production.

## [1.1.2] - 2026-06-07

### Fixed

- System tray showed the default Electron icon in packaged builds. The tray icon now ships as an extraResource (outside asar) and loads via `process.resourcesPath` so it resolves reliably. A warning is logged when the image fails to load instead of silently defaulting.

## [1.1.1] - 2026-06-07

### Fixed

- Auto-updater UI was silent regardless of result. Now shows toast feedback for "update available" (with Download action), "downloaded" (with Restart action), "you're on the latest version", and check errors.
- Background auto-update checks now prompt from any page in the app, not just Settings.
- "Check for Updates" button in dev/unpacked builds now reports that auto-updates are disabled in development instead of silently no-op'ing.

### Changed

- Sample ticket IDs in invoice AI prompts and source comments switched from `TRI-*` to generic `PROJ-*` placeholders.

### Docs

- Expanded README features list (invoicing, AI summaries, billable toggle, ticket attribution, system tray, encrypted credentials, custom secret patterns).
- Added First Run walkthrough and end-user download instructions to README.
- Refreshed `docs/` landing page: updated feature grid (12 cards), new "For Contractors" section with ACH vs credit-card invoice fee comparison, Download Latest Release button.
- Added `.github/FUNDING.yml` pointing to the existing Stripe donate link.

## [1.1.0] - 2026-06-05

### Added

- **Session billable flag** — toggle individual sessions billable/non-billable from the detail panel
- **Stripe test/sandbox mode** — separate keys per mode, dedicated test email override, mode-aware overlap checks
- **Invoice PDF support** — store and link to Stripe's hosted invoice PDF URL
- **Stripe import** — pull existing invoices from Stripe into the local list
- **Invoice list sort + filter** — sort by date/client/period/amount/status; status filter pills
- Project selector for invoice line item generation — filter by specific project or all
- Configurable start-of-week setting (Mon/Sun/Sat) across sessions, reports, analytics, and invoice flow
- Editable due date field on invoice creation (default 30 days)
- Auto-generated invoice memos with period summary, tickets, and AI overview
- Ticket attribution on invoice line items using git commit spanning logic
- AI-generated business-friendly descriptions for invoice line items
- Multi-ticket support with indented line formatting per ticket
- Editable hours on invoice line items with auto-calculated amounts
- ACH-only payment toggle with persistent preference
- ACH error detection with Stripe setup link dialog
- Auto-sync invoice statuses from Stripe on list view
- Donate button on invoicing page

### Fixed

- Stripe 500-char line description cap — dynamic per-line budgets, combined summary mode for high-ticket days, deterministic fallback
- Ticket extraction filters out non-ticket prefixes (UTF-8, ISO-8859, etc.)
- AI hallucinating work based on project names instead of actual commits
- Invoice date display off-by-one from UTC parsing of date-only strings
- Session date filtering now uses local time instead of UTC string comparison
- Invoice line items no longer pull unrelated project data into AI summaries
- Sandbox email save not providing feedback (useEffect sync pattern)
- Overlap check comparing across sandbox/live modes
- AI refusal detection falls back to commit-based descriptions
- Skip negligible sessions (under 3 min) from invoice line items
- Cap Stripe memo at 500 chars to avoid API rejection

### Changed

- Invoice amount column is now read-only (driven by hours x rate)
- Removed manual sync button from invoice list (auto-syncs now)
- Hours display uses 2 decimal precision
- Enforce no "we/our" and no markdown in all AI invoice prompts

## [1.0.0] - 2026-03-24

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
