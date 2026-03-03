---
stepsCompleted: [1, 2, 3, 4, 5, 6]
inputDocuments: []
date: 2026-03-03
author: Looki
---

# Product Brief: VibeTime

<!-- Content will be appended sequentially through collaborative workflow steps -->

## Executive Summary

VibeTime is an open-source desktop application that automatically tracks developer working time by analyzing AI coding assistant interaction history. In an era where developers work across multiple projects simultaneously — prompting one AI session while another executes — traditional time tracking is impossible. VibeTime solves this by reading the session data that already exists, detecting work sessions with smart idle timeouts, and using AI to generate meaningful summaries of work completed. No punch clocks, no manual entry, no guesswork — just accurate, fair billing backed by real data.

---

## Core Vision

### Problem Statement

Developers using AI coding assistants like Claude Code work in a fundamentally new way — orchestrating multiple parallel sessions across 4-6 projects for 2-3 clients simultaneously. Traditional time trackers assume sequential, single-task work and require manual input. This makes accurate time reconstruction impossible, leaving developers to guess at billing splits and unable to provide clients with meaningful work summaries.

### Problem Impact

Developers either under-bill (losing income) or over-bill (risking client trust) because they cannot accurately attribute parallel work sessions to specific projects. As AI-assisted development becomes the norm, this problem affects every developer who bills for their time.

### Why Existing Solutions Fall Short

Tools like Toggl and Harvest require manual start/stop — useless when you're working on three projects at once. They track *time* but not *what was accomplished*. They have no understanding of AI-assisted workflows or the session data that already captures exactly when and what a developer worked on.

### Proposed Solution

A Tauri-based desktop app that watches local `.claude` folders, automatically detects work sessions using configurable idle timeouts (10 min default, extended for testing/builds), and generates AI-powered summaries from conversation history and commit messages. A dashboard provides date-range reporting with multiple formats — session breakdowns, daily summaries, and full period reports. Manual time blocks can be added for work outside AI tools.

### Key Differentiators

- **Zero-friction tracking** — works passively from data that already exists
- **Solves the parallel work problem** — accurately attributes simultaneous multi-project sessions
- **AI-generated work summaries** — not just hours, but what was accomplished
- **Open source** — community-driven, trust through transparency
- **Multi-AI support roadmap** — Claude first, then Gemini and Codex
- **Paid cloud tier planned** — multi-machine sync and team features as upgrade path

## Target Users

### Primary Users

**"Alex the Contract Dev"**

A freelance/contract developer who takes on 2-3 clients simultaneously, working across 4-6 projects. Alex uses Claude Code (and potentially other AI assistants) as their primary development workflow — running multiple AI sessions in parallel, prompting one while another executes. Alex bills hourly or by project and needs accurate, fair time attribution across clients. Currently has no reliable way to reconstruct how time was split across parallel work sessions and can't provide clients with meaningful summaries of what was accomplished.

**Motivations:** Fair billing, professional credibility with clients, personal accountability

**Pain points:** Can't reconstruct parallel work sessions, manual tracking is impossible with AI workflows, no way to generate work summaries automatically

**Success moment:** End of the week, opens VibeTime, selects a client's date range, and gets an accurate time report with AI-generated summaries ready to attach to an invoice.

### Secondary Users

Deferred to future versions. Enterprise dev shop developers and team/manager roles will be considered when the cloud sync platform is developed.

### User Journey

1. **Discovery:** Finds VibeTime on GitHub or dev community (Reddit, X, HN)
2. **Onboarding:** Installs the Tauri app, points it at project directories
3. **Core Usage:** App runs in background, passively tracking sessions — developer forgets it's there
4. **Success Moment:** First time they generate a weekly client report and realize it's accurate without any manual input
5. **Long-term:** It becomes part of their billing workflow — generate report, attach to invoice, done

## Success Metrics

**User Success:**
- Users generate accurate time reports without manual time entry
- Sessions are transparently visible so users can verify accuracy at a glance
- Minimal manual intervention needed — only adding time blocks for non-AI work

**User Success Indicators:**
- Users generate their first report within the first week of install
- Users rely on VibeTime for client billing instead of manual tracking or guesswork

### Business Objectives

- Build an active open-source community around VibeTime
- Establish VibeTime as the go-to time tracking tool for AI-assisted developers
- Validate demand before investing in the paid cloud sync tier

### Key Performance Indicators

| KPI | Target | Timeframe |
|-----|--------|-----------|
| GitHub stars | 100 | 3 months |
| Downloads | 25 | 3 months |

## MVP Scope

### Core Features

- **Session Detection Engine:** Reads `.claude` folder history to automatically detect work sessions with configurable idle timeouts (10 min default, extended for testing/builds)
- **Git Integration:** Analyzes commit history to enrich session data with concrete work accomplished
- **Client & Project Management:** Organize tracked time across multiple clients and multiple projects per client
- **Session Management:** View, modify, and enhance automatically detected sessions; add manual time blocks for non-AI work
- **Token Usage Tracking:** Track and display token consumption per project to understand AI cost burn
- **Reporting Page:** Generate reports by date range — session breakdowns, daily summaries, full period summaries with AI-generated work descriptions
- **Dashboard:** Visual overview of work efforts, time distribution across clients/projects, and token usage analytics
- **Settings:** Configurable idle thresholds, project/client configuration, directory paths for `.claude` folders

### Out of Scope for MVP

- Cloud sync / multi-machine support
- Gemini, Codex, or other AI assistant support
- Team/multi-user features
- Web-based UI (Tauri desktop only)
- Enterprise admin or manager roles
- Invoicing or payment integration

### MVP Success Criteria

- Accurately detects and attributes sessions across parallel projects
- Users can generate a client-ready time report with minimal manual adjustment
- Token usage visibility per project is functional and useful
- 100 GitHub stars and 25 downloads within 3 months

### Future Vision

VibeTime becomes the premier developer time tracking platform. As adoption grows from solo contract devs to boutique agencies and enterprise shops, the product expands to:

- **Cloud platform** with multi-machine sync and web dashboard (paid tier)
- **Multi-AI support** — Gemini, Codex, and future AI coding assistants
- **Team & enterprise features** — manager views, team cost reporting, resource allocation insights
- **Cost intelligence** — combining human hours + token usage to give companies a complete picture of where development money is going per project
- **Boutique agency tools** — multi-client tracking, consolidated reporting across developers
