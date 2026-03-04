---
stepsCompleted: [step-01-init, step-02-discovery, step-02b-vision, step-02c-executive-summary, step-03-success, step-04-journeys, step-05-domain, step-06-innovation, step-07-project-type, step-08-scoping, step-09-functional, step-10-nonfunctional, step-11-polish, step-12-complete]
inputDocuments: [product-brief-ClawdTime-2026-03-03.md]
workflowType: 'prd'
documentCounts:
  briefs: 1
  research: 0
  brainstorming: 0
  projectDocs: 0
classification:
  projectType: desktop_app
  domain: developer_tool
  complexity: low
  projectContext: greenfield
  productName: ViberTime
---

# Product Requirements Document - ViberTime

**Author:** Tony
**Date:** 2026-03-03

## Executive Summary

ViberTime is an open-source Electron desktop application that automatically tracks developer working time by reading AI coding assistant session data. Developers using tools like Claude Code work across multiple projects and clients simultaneously — running parallel AI sessions, prompting one while another executes. Traditional time trackers assume sequential single-task work and require manual input, making accurate time reconstruction impossible. ViberTime solves this by passively analyzing the session history that already exists in local `.claude` folders, detecting work sessions with smart idle timeouts, enriching them with git commit data, and generating AI-powered summaries of work accomplished. The result: accurate, fair billing backed by real data — no timers, no manual entry, no behavior change required.

The primary user is a freelance or contract developer billing multiple clients, who needs to accurately attribute parallel AI-assisted work sessions to specific projects and generate client-ready reports. Born from the founder's own need to track time for an active contract engagement, ViberTime targets a gap no existing tool addresses.

### What Makes This Special

- **Zero friction** — works passively from data that already exists. No timers to start, no entries to log. The developer's workflow doesn't change at all.
- **Solves the parallel work problem** — the only tool that accurately attributes time when a developer is running multiple AI sessions across multiple projects simultaneously.
- **AI-generated work summaries** — reports include not just hours, but what was accomplished, pulled from conversation history and git commits.
- **Right tool, right time** — AI-assisted development is mainstream but the tooling layer around it (tracking, billing, cost intelligence) doesn't exist yet. ViberTime is the picks-and-shovels play.

## Project Classification

- **Project Type:** Desktop Application (Electron — TypeScript)
- **Domain:** Developer Tooling
- **Complexity:** Low — no regulatory requirements, no compliance concerns, no multi-tenancy for MVP
- **Project Context:** Greenfield — new product, no existing codebase

## Success Criteria

### User Success

- A developer with 2-3 active client projects generates accurate weekly time reports in under 5 minutes of manual effort — reviewing auto-detected sessions and optionally adding non-AI time blocks.
- Session detection is 100% accurate — every session is correctly attributed to the right project based on `.claude` folder location. No guessing, no misattribution.
- Users trust the data enough to attach it directly to client invoices.

### Business Success

- 100 GitHub stars within 3 months of public release.
- 25+ downloads within 3 months.
- Active GitHub engagement (issues filed, feature requests, discussions) as proxy for real adoption — since there is no telemetry in a local-only app.
- Establish ViberTime as the recognized time tracking tool for AI-assisted development workflows.

### Technical Success

- **Low resource footprint** — background processing is nearly invisible on CPU and memory.
- **Fast startup** — app opens and data is immediately available, powered by an internal data store (SQLite) that caches processed session data.
- **Incremental processing** — only new/changed session data is scanned, not the full history on every launch.
- **100% session detection accuracy** — deterministic mapping from `.claude` folder paths to configured projects.

### Measurable Outcomes

| Metric | Target | How Measured |
|--------|--------|--------------|
| Time to generate weekly report | < 5 minutes manual effort | User workflow |
| Session attribution accuracy | 100% | Deterministic folder mapping |
| App background CPU usage | < 1% | System monitoring |
| App startup to data visible | < 3 seconds | App performance |
| GitHub stars (3 months) | 100 | GitHub |
| Downloads (3 months) | 25 | GitHub releases |

## Product Scope

See [Project Scoping & Phased Development](#project-scoping--phased-development) for full MVP feature set, phased roadmap, and risk mitigation strategy.

**MVP summary:** Session detection, git integration, client/project management, session management, AI summarization, token tracking, reporting, settings, and SQLite data store. Dashboard and CLI deferred to Phase 2.

## User Journeys

### Journey 1: Alex's First Week — Setup to First Report

**Who:** Alex, freelance developer, just landed a new contract client alongside two existing ones. Juggles 4 projects across 3 clients using Claude Code daily.

**Opening Scene:** It's Sunday night. Alex just finished a busy first week on the new contract. Three clients need invoices by Monday. Alex has no idea how to split the week — there were days where all three clients had work running in parallel Claude sessions. The old approach was guessing, and Alex always felt guilty about it.

**Rising Action:** Alex installs ViberTime, points it at the project directories. The app scans the `.claude` folders and immediately reconstructs the entire week — every session, every project, timestamped and attributed. Alex connects their Claude login so ViberTime can generate work summaries. In settings, Alex maps each project directory to a client and sets the idle timeout to 10 minutes.

**Climax:** Alex selects "Client A" and the date range for the week. ViberTime generates a clean report: 12.5 hours across 3 projects, with AI-generated summaries of what was accomplished in each session — "Implemented authentication flow, fixed 3 bugs in payment module, added unit tests." Alex looks at the session breakdown and it matches their memory perfectly.

**Resolution:** Alex exports three client reports in under 5 minutes, attaches them to invoices, and sends them off. For the first time, billing feels fair and defensible. ViberTime becomes part of the weekly workflow — generate, review, invoice, done.

**Requirements revealed:** Project directory scanning, session detection, client/project mapping, Claude login integration, AI summarization, date-range reporting, report export.

### Journey 2: Alex Adds Non-AI Work

**Who:** Same Alex, mid-week.

**Opening Scene:** Alex spent 2 hours in a client meeting and another hour doing manual code review outside of Claude Code. ViberTime has no way to know about this work — it only tracks AI sessions.

**Rising Action:** Alex opens ViberTime, navigates to the day view, and sees the auto-detected Claude sessions. There are gaps where the meeting and review happened. Alex clicks "Add Manual Time Block," selects the client, enters the time range, and types a quick description: "Client kickoff meeting — requirements review."

**Climax:** The manual block appears alongside the auto-detected sessions, color-coded differently so it's visually distinct. The daily total now accurately reflects all work, not just AI-assisted work.

**Resolution:** At the end of the week, the report includes both auto-detected and manual entries, giving a complete picture of time spent per client.

**Requirements revealed:** Manual time block entry, visual distinction between auto-detected and manual entries, day view of sessions, combined reporting.

### Journey 3: Alex Fixes a Bad Session

**Who:** Same Alex, reviewing auto-detected sessions.

**Opening Scene:** Alex opens ViberTime and notices a session attributed to Client A's project that was actually exploratory work on a personal side project in the same directory. The idle timeout also merged two separate work sessions into one long 4-hour block when there was actually a 15-minute break in between.

**Rising Action:** Alex clicks the misattributed session and reassigns it to "Personal / Non-billable." For the merged session, Alex splits it into two sessions at the point where the break occurred, adjusting the times.

**Climax:** The corrected data is saved immediately. The client report regenerates cleanly with the accurate numbers.

**Resolution:** Alex's trust in ViberTime grows — even when the automation isn't perfect, the correction workflow is fast and painless. It's still 10x faster than manual time tracking from scratch.

**Requirements revealed:** Session editing (reassign project/client), session splitting, non-billable category, instant report recalculation, intuitive correction UI.

### Journey 4: Alex Sets Up AI Summarization

**Who:** Alex, during initial configuration.

**Opening Scene:** Alex has ViberTime installed and sessions are being detected, but the reports just show timestamps and project names — no descriptions of what was accomplished.

**Rising Action:** Alex navigates to Settings > AI Configuration. The preferred option is "Connect Claude Account" — Alex clicks it, logs into their existing Claude subscription, and authorizes ViberTime to use the session for summarization. If that doesn't work, there's a fallback field for "Anthropic API Key."

**Climax:** Alex regenerates a report. Now each session includes an AI-generated summary: "Refactored database layer, migrated from raw SQL to ORM, added connection pooling." The summary pulls from the Claude conversation history and git commits from that time window.

**Resolution:** Client reports now tell a story, not just show hours. Clients are impressed by the level of detail and transparency.

**Requirements revealed:** AI configuration settings, Claude login integration (preferred), API key fallback, session summarization from conversation history + git data, regeneratable reports.

### Journey Requirements Summary

| Capability Area | Revealed By Journeys |
|----------------|---------------------|
| Project directory scanning & session detection | 1, 3 |
| Client/project management & mapping | 1, 2, 3 |
| Claude login integration for AI access | 1, 4 |
| API key fallback for AI access | 4 |
| AI-powered session summarization | 1, 4 |
| Date-range reporting with export | 1, 2 |
| Manual time block entry | 2 |
| Session editing (reassign, split) | 3 |
| Non-billable time category | 3 |
| Settings & configuration UI | 1, 4 |
| Git integration for enriched summaries | 1, 4 |
| Token usage tracking per project | 1 |

## Innovation & Novel Patterns

### Detected Innovation Areas

- **Passive time tracking from AI session data** — inverts the fundamental assumption that time tracking requires developer action. ViberTime reads data that already exists in `.claude` folders, eliminating friction entirely.
- **AI-powered work summarization via user's own Claude session** — uses the developer's existing Claude subscription for summarization, removing cost barriers. Reports include what was accomplished, not just hours logged.
- **Parallel session attribution** — the only tool designed to accurately attribute time across simultaneous multi-project AI sessions, a workflow pattern unique to AI-assisted development.

### Market Context & Competitive Landscape

- No direct competitor exists. Existing tools address adjacent problems: ccusage tracks token costs, Timely tracks general time, claude-devtools provides session debugging. None connect session data to billing.
- An open feature request on Claude Code's GitHub confirms unmet demand for session-based time tracking for freelancer billing.
- The AI coding assistant market has 85%+ developer adoption but zero tooling for time/billing around these workflows.

### Validation Approach

- Founder is the target user with an active contract — immediate dogfooding from day one.
- Open source launch on GitHub enables rapid community feedback.
- The open feature request on Claude Code's repo is a ready-made audience to announce to.

## Desktop Application Specific Requirements

### Project-Type Overview

ViberTime is an Electron-based desktop application (TypeScript) targeting Windows, Mac, and Linux. It operates as an on-demand application — users open it when they need to review sessions or generate reports. A CLI companion tool is planned to bring core query functionality into the terminal.

### Platform Support

- **Windows:** Primary development platform. Electron native build.
- **macOS:** Full support via Electron.
- **Linux:** Full support via Electron.
- **CLI tool:** Lightweight terminal interface for querying time data without opening the full desktop app. (Scope TBD — MVP or post-MVP based on effort.)

### System Integration

- **`.claude` folder reading** — reads session history from the user's `.claude` directory (typically `~/.claude`). Extracts project paths, session timestamps, conversation data, and token usage from session files.
- **Git integration** — reads commit history from detected project directories to enrich session summaries with concrete work accomplished.
- **SQLite data store** — local database for caching processed session data. Enables fast startup and incremental processing.
- **Claude AI access** — connects to user's Claude account (preferred) or Anthropic API key (fallback) for AI-powered session summarization.
- **No background process** — app runs on-demand, scans and processes data when opened.
- **No system tray** — no persistent background presence.

### Update Strategy

- **Electron auto-updater** — electron-updater checks GitHub releases for new versions and prompts the user to update.
- **Distribution:** GitHub releases as the primary distribution channel.

### Offline Capabilities

- **Fully functional offline** for session detection, time viewing, session management, and reporting.
- **AI summarization requires connectivity** — falls back gracefully:
  1. **Online + Claude access:** AI-generated summaries from conversation history + git commits
  2. **Offline or no Claude:** Git commit messages from the session time window as work descriptions
  3. **No git data:** Timestamps and project name only (always available)
- **Summaries are cached** — once generated, AI summaries are stored in SQLite and available offline going forward.

### Implementation Considerations

- **Data discovery approach:** ViberTime reads the `.claude` folder to discover project paths automatically rather than requiring manual repo configuration. Validate during architecture that session files contain sufficient project path data.
- **Incremental processing:** Only scan new/changed session data since last app launch. Track last-processed timestamps per session file.
- **CLI companion:** Consider whether the CLI shares the same TypeScript core library/SQLite store as the desktop app, or operates independently. Architecture decision needed.
- **Cross-platform testing:** Electron handles most platform differences, but file path handling (Windows backslashes vs Unix forward slashes) and `.claude` folder default locations need platform-specific logic.

## Project Scoping & Phased Development

### MVP Strategy & Philosophy

**MVP Approach:** Problem-solving MVP — ship the minimum that lets the founder accurately track and bill time for an active contract engagement. Validate that `.claude` session data + git history can reliably reconstruct work narratives before investing in polish.

**Resource Requirements:** Solo developer (founder), leveraging AI-assisted development. TypeScript/Electron stack chosen for developer familiarity.

**Key Architecture Decision:** Evaluate whether a shared core library (used by both CLI and Electron app) is the right approach, or if building the desktop app directly is simpler for MVP. Defer to architecture phase.

### MVP Feature Set (Phase 1)

**Core User Journeys Supported:**
- Journey 1: Setup to first report (happy path)
- Journey 2: Adding non-AI work (manual time blocks)
- Journey 3: Fixing a bad session (error recovery)
- Journey 4: AI summarization setup

**Must-Have Capabilities:**
- Session detection engine — read `.claude` folder, detect sessions, attribute to projects
- Git integration — enrich sessions with commit history
- Client & project management — map detected projects to clients
- Session management — view, edit, split, reassign sessions; add manual time blocks
- AI summarization — Claude login (preferred), API key fallback, git commit fallback for offline
- Reporting — date-range reports with session breakdowns, daily summaries, full period summaries
- Settings — idle thresholds, project/client config, AI configuration
- SQLite data store — cached session data for fast startup and incremental processing
- Token usage tracking — per-project token consumption visibility

### Post-MVP Features

**Phase 2 (Growth):**
- CLI companion tool for terminal-based time queries
- Dashboard — visual overview of work distribution and token analytics
- Multi-AI support — Gemini, Codex session data
- Optional anonymous telemetry
- Claude login approach (if not feasible for MVP, research and add here)

**Phase 3 (Expansion):**
- Cloud platform — multi-machine sync, web dashboard, paid tier
- Team & enterprise features — manager views, team cost reporting
- Cost intelligence — combined human hours + token usage per project
- Boutique agency tools — multi-client, multi-developer consolidated reporting

### Risk Mitigation Strategy

**Technical Risks:**
- `.claude` folder structure is undocumented and could change → Abstract parser behind clean interface, monitor Claude Code releases
- Claude login for summarization may not be technically feasible → API key fallback always available, git commit fallback for offline
- Data stitching (correlating sessions with git commits into coherent narratives) → Prototype the data pipeline first before building full UI

**Market Risks:**
- Product depends on Claude Code adoption remaining strong → Multi-AI support in Phase 2 diversifies risk
- Open source may not generate revenue → Validate community demand before investing in paid cloud tier

**Resource Risks:**
- Solo developer building cross-platform app → Electron + TypeScript reduces learning curve; AI-assisted development accelerates output
- Scope creep from feature ideas → Strict MVP boundaries; dashboard and CLI deferred to Phase 2

## Functional Requirements

### Session Detection & Data Processing

- **FR1:** System can automatically discover and read `.claude` session files from the user's `.claude` directory
- **FR2:** System can extract project directory paths, session timestamps, conversation data, and token usage from session files
- **FR3:** System can detect individual work sessions by identifying activity gaps using configurable idle timeouts (default 10 minutes)
- **FR4:** System can deterministically attribute each session to a project based on the directory path associated with the session
- **FR5:** System can incrementally process only new or changed session data since the last scan
- **FR6:** System can store processed session data in a local SQLite database for fast retrieval

### Git Integration

- **FR7:** System can read git commit history from detected project directories
- **FR8:** System can correlate git commits with sessions based on timestamp overlap, filtering to only the current user's commits (by git author/email)
- **FR9:** System can extract commit messages to use as work descriptions when AI summarization is unavailable
- **FR10:** User can configure their git identity (name/email) for commit filtering, or system can auto-detect from git config

### Client & Project Management

- **FR11:** User can create, edit, and delete client records
- **FR12:** User can create, edit, and delete project records associated with clients
- **FR13:** User can map detected project directory paths to client/project records
- **FR14:** User can designate time as non-billable (personal, internal, exploratory work)

### Session Management

- **FR15:** User can view a list of auto-detected sessions with timestamps, project attribution, and duration
- **FR16:** User can view sessions filtered by date, client, or project
- **FR17:** User can edit a session's attributed client/project (reassign)
- **FR18:** User can split a single session into two sessions at a specified point in time
- **FR19:** User can adjust session start and end times
- **FR20:** User can add manual time blocks with client, project, time range, and description for non-AI work
- **FR21:** User can visually distinguish between auto-detected sessions and manual time blocks

### AI Summarization

- **FR22:** User can connect their Claude account (login/session) for AI-powered summarization
- **FR23:** User can provide an Anthropic API key as a fallback for AI summarization
- **FR24:** System can generate AI-powered work summaries for sessions using conversation history and git commit data
- **FR25:** System can fall back to git commit messages as work descriptions when AI access is unavailable
- **FR26:** System can display timestamps and project name only when neither AI nor git data is available
- **FR27:** System can cache generated summaries in the local database for future offline access

### Token Usage Tracking

- **FR28:** System can extract and track token consumption data per session from `.claude` session files
- **FR29:** User can view token usage aggregated by project
- **FR30:** User can view token usage aggregated by client
- **FR31:** User can view token usage for a specified date range

### Reporting

- **FR32:** User can generate a report for a specified date range
- **FR33:** User can generate a report filtered by client
- **FR34:** User can generate a report filtered by project
- **FR35:** User can view a session breakdown report (individual sessions with times, projects, and summaries)
- **FR36:** User can view a daily summary report (aggregated hours and work per day)
- **FR37:** User can view a full period summary report (total hours, work summaries across the entire date range)
- **FR38:** User can export reports in a format suitable for attaching to invoices
- **FR39:** User can regenerate reports after editing sessions to reflect updated data

### Settings & Configuration

- **FR40:** User can configure the default idle timeout threshold for session detection
- **FR41:** User can configure extended idle timeouts for specific scenarios (e.g., testing, builds)
- **FR42:** User can configure the `.claude` directory path if it differs from the default location
- **FR43:** User can configure AI access method (Claude login or API key)
- **FR44:** User can view and manage all configured project-to-client mappings

### Application Lifecycle

- **FR45:** System can check for updates via GitHub releases and prompt the user to update
- **FR46:** System can operate fully offline for all features except AI summarization

## Non-Functional Requirements

### Performance

- **NFR1:** App startup to cached data visible in under 3 seconds
- **NFR2:** Incremental session scan completes in under 5 seconds for typical usage (up to 50 new sessions)
- **NFR3:** Report generation completes in under 2 seconds for cached data
- **NFR4:** Background CPU usage under 1% when app is open but idle
- **NFR5:** Memory footprint under 200MB during normal operation
- **NFR6:** SQLite database operations (reads/writes) complete in under 100ms for individual queries

### Security

- **NFR7:** API keys and Claude login credentials are stored securely using OS-level credential storage (e.g., Windows Credential Manager, macOS Keychain, Linux Secret Service)
- **NFR8:** Session data remains local — no data is transmitted to external services except for AI summarization requests to Claude
- **NFR9:** AI summarization requests send only the minimum data needed for summary generation, not full conversation history
- **NFR10:** No telemetry, analytics, or usage data is collected or transmitted in MVP

### Integration

- **NFR11:** `.claude` session file parser is abstracted behind a clean interface to isolate the app from upstream format changes
- **NFR12:** Git integration gracefully handles missing repos, empty histories, and repositories without commits from the configured user
- **NFR13:** AI summarization gracefully degrades through three tiers (AI summary → git commits → timestamps only) without errors or user confusion
- **NFR14:** App handles corrupt or malformed session files without crashing — logs warnings and skips affected files

### Accessibility

- **NFR15:** UI supports keyboard navigation for core workflows (session review, report generation)
- **NFR16:** UI maintains sufficient color contrast ratios for readability
- **NFR17:** Visual distinction between auto-detected and manual sessions does not rely solely on color

### Engineering Quality

- **NFR18:** Database access patterns must avoid N+1 query problems — use batch queries and joins to fetch related data in single operations
- **NFR19:** Cross-cutting concerns (error handling, logging, data validation, configuration access) must be implemented as shared services/middleware, coded once and reused across all modules
- **NFR20:** Data processing pipelines (session parsing, git correlation, summarization) must operate on batches, not individual records, to minimize I/O overhead
