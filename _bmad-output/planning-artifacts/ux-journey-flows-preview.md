## User Journey Flows

### Journey 1: First Launch — Setup to Wow Moment

**Goal:** New user installs ViberTime and sees their first reconstructed work history.

**Flow:**

```mermaid
flowchart TD
    A[App Opens First Time] --> B[Welcome Screen]
    B --> C{User Choice}
    C -->|Scan for projects| D[Select root projects folder]
    C -->|Skip setup| E[Empty Sessions view with 'Add Project' prompt]
    D --> F[Scanning .claude folders...]
    F --> G{Projects found?}
    G -->|Yes| H[Show discovered projects list]
    G -->|No| I[No .claude folders found - Add manually?]
    I --> E
    H --> J[User confirms / assigns clients]
    J --> K[Initial scan - recent 7 days]
    K --> L[Sessions appear grouped by project]
    L --> M[Wow moment - data is real and usable]
    M --> N[Background: load historical data]
    E --> O[User manually adds project directory]
    O --> P[Map to client]
    P --> K
```

**Screen-by-Screen:**

1. **Welcome Screen** — "Welcome to ViberTime. Let's find your projects." Two paths: "Scan My Projects Folder" (primary button) and "I'll set up manually" (text link to skip).
2. **Folder Picker** — Native OS folder picker. User selects their root projects directory (e.g., `~/projects` or `C:\projects`).
3. **Discovery Results** — List of discovered `.claude` folders with project directory names. Checkboxes to include/exclude. "Assign to Client" dropdown per project (can create new clients inline). "Confirm & Scan" button.
4. **Initial Scan** — Progress indicator as recent sessions load. Sessions appear in the grouped-by-project view as they're processed. Stats cards populate in real-time.
5. **Sessions View (populated)** — The wow moment. User sees their work history reconstructed. Status bar shows "Loading historical data..." for background processing.

**Skip Path:** User lands on empty Sessions view. Prominent empty state: "No projects configured. Add a project to start tracking." Button: "+ Add Project" which opens a form (directory path + client assignment).

**Error States:**
- No `.claude` folders found in selected directory → Friendly message: "No AI sessions found in this folder. Try a parent directory, or add projects manually."
- Folder permission denied → "Can't access this folder. Try another location or check permissions."

---

### Journey 2: Daily Check-in + Adding Manual Blocks

**Goal:** User opens ViberTime, verifies today's sessions, adds time for non-AI work.

**Flow:**

```mermaid
flowchart TD
    A[App Opens] --> B[Auto-scan triggers]
    B --> C[Cached data shows immediately]
    C --> D[New sessions appear as scan completes]
    D --> E[User scans project groups visually]
    E --> F{Sessions look right?}
    F -->|Yes| G{Non-AI work to add?}
    F -->|No| H[Expand project → click session → correct]
    G -->|Yes| I[Click '+ Manual Block' in header]
    G -->|No| J[Done - close app or keep live view]
    I --> K[Manual Block Form]
    K --> L[Select client/project]
    L --> M[Set time range]
    M --> N[Type description]
    N --> O[Save]
    O --> P[Block appears in project group with 'Manual' badge]
    P --> J
    H --> Q[See Journey 3: Session Correction]
```

**Manual Block Form (Modal):**
- Client/Project dropdown (pre-populated with configured projects)
- Date picker (defaults to today)
- Start time / End time pickers
- Description text field
- Save / Cancel buttons

**Interaction Details:**
- App opens → cached SQLite data renders instantly → auto-scan runs in background → new sessions fade in as detected
- Stats cards update as scan completes
- If a project group already exists for the manual block's project, the block appears within it
- If no project group exists (e.g., a meeting for a new client), a new group is created

---

### Journey 3: Session Correction — Fixing a Bad Session

**Goal:** User notices an incorrect session and fixes it quickly inline.

**Flow:**

```mermaid
flowchart TD
    A[User spots issue in session list] --> B[Expand project group]
    B --> C[Click session row to open detail panel]
    C --> D{What's wrong?}
    D -->|Wrong project| E[Click 'Reassign Project']
    D -->|Wrong time| F[Click 'Edit Time']
    D -->|Merged sessions| G[Click 'Split Session']
    D -->|Bad summary| H[Click 'Regenerate Summary']
    E --> I[Project/client dropdown]
    I --> J[Session moves to correct project group]
    F --> K[Inline time pickers for start/end]
    K --> L[Duration recalculates automatically]
    G --> M[Time picker: where to split]
    M --> N[Two sessions created from one]
    H --> O[AI regenerates summary]
    O --> P[New summary replaces old]
    J --> Q[Changes saved instantly]
    L --> Q
    N --> Q
    P --> Q
```

**Correction Interactions:**
- **Reassign:** Dropdown appears inline in detail panel. Select new project/client. Session animates from old project group to new one.
- **Edit Time:** Start/end time fields become editable. Duration updates live as times change. Save button confirms.
- **Split:** Time picker appears with a slider or input between session start and end. "Split Here" button creates two sessions. Both remain in same project group.
- **Regenerate Summary:** Button triggers AI re-summarization. Loading spinner on summary text. New summary replaces old. Previous summary is not preserved.

**Key UX principles:**
- All corrections happen in the inline detail panel — no navigation away
- Changes save immediately (optimistic update)
- Undo available via toast notification: "Session updated. Undo?"
- Stats cards and project group totals recalculate automatically

---

### Journey 4: Report Generation

**Goal:** User generates a client-ready time report for invoicing.

**Flow:**

```mermaid
flowchart TD
    A[Navigate to Reports view] --> B[Select date range]
    B --> C{Use preset or custom?}
    C -->|Preset| D[Today / This Week / Last Week / This Month]
    C -->|Custom| E[Date range picker]
    D --> F[Select client filter]
    E --> F
    F --> G{Filter by client?}
    G -->|Yes| H[Select client from dropdown]
    G -->|All clients| I[Show all]
    H --> J[Choose report format]
    I --> J
    J --> K{Format?}
    K -->|Session summaries| L[Per-session detail with AI summaries]
    K -->|Period summary| M[Full period narrative summary]
    K -->|Payroll times| N[Simple hours-per-day table]
    L --> O[Report renders in-app]
    M --> O
    N --> O
    O --> P{AI summaries needed?}
    P -->|Summaries cached| Q[Report complete]
    P -->|Summaries not generated| R[Generate summaries button]
    R --> S[AI summarization runs per session]
    S --> Q
    Q --> T[Export button]
    T --> U{Export format}
    U --> V[Copy to clipboard / Save as PDF / Save as Markdown]
```

**Report View Layout:**
- **Filter bar (top):** Date range presets + custom picker | Client dropdown | Format selector
- **Report content (main area):** Rendered report matching selected format
- **Action bar (bottom or top-right):** "Generate Summaries" (if needed) | "Export" dropdown

**Report Formats:**
1. **Session Summaries:** Each session listed with project, time range, duration, and AI summary. Grouped by day. Project color indicators.
2. **Period Summary:** AI-generated narrative summarizing all work across the selected date range. Total hours, project breakdown, key accomplishments.
3. **Payroll Times:** Simple table — date, hours worked, project. No summaries, no descriptions. Just numbers for timesheet submission.

**AI Summary Generation:**
- If summaries already cached → report renders instantly
- If summaries needed → "Generate Summaries" button with progress (3 of 12 sessions summarized...)
- Summaries cached permanently after generation — future reports for same sessions are instant

---

### Journey 5: Settings Configuration

**Goal:** User configures ViberTime — AI access, idle thresholds, theme, projects, git identity.

**Flow:**

```mermaid
flowchart TD
    A[Navigate to Settings] --> B[Settings page with sections]
    B --> C[Projects & Clients]
    B --> D[AI Configuration]
    B --> E[Session Detection]
    B --> F[Appearance]
    B --> G[Git Identity]
    C --> C1[View all project-to-client mappings]
    C1 --> C2[Add / Edit / Remove projects]
    C2 --> C3[Add / Edit / Remove clients]
    C3 --> C4[Rescan project directories]
    D --> D1{Choose AI method}
    D1 -->|Claude Login| D2[Connect Claude account]
    D1 -->|API Key| D3[Enter Anthropic API key]
    D1 -->|None| D4[Git commits only as fallback]
    D2 --> D5[Test connection]
    D3 --> D5
    D5 --> D6{Connection OK?}
    D6 -->|Yes| D7[Status: Connected]
    D6 -->|No| D8[Error message + retry]
    E --> E1[Default idle timeout - slider/input - 10 min default]
    E1 --> E2[Extended timeout for builds/tests - 30 min default]
    E2 --> E3[.claude directory path override]
    F --> F1[Theme accent color selector - Teal/Amber/Purple/Blue]
    F1 --> F2[Preview updates live as selection changes]
    G --> G1[Auto-detect from git config]
    G1 --> G2[Manual override name/email]
```

**Settings Layout:**
- Vertical section list on the left (or stacked sections with headers)
- Each section expands to show its controls
- Changes save automatically (no save button needed) — toast confirmation: "Settings saved"

**Settings Sections:**

1. **Projects & Clients** — Table of all configured projects with client assignment, directory path, and color. Add/edit/remove. "Rescan" button to re-discover `.claude` folders.
2. **AI Configuration** — Radio/toggle for method (Claude Login / API Key / None). Connection test button. Status indicator (Connected / Not configured / Error). Credential stored via safeStorage.
3. **Session Detection** — Idle timeout slider (1-60 min, default 10). Extended timeout for builds/tests (10-120 min, default 30). `.claude` directory path with browse button (defaults to `~/.claude`).
4. **Appearance** — Theme accent color selector with live preview (Teal, Amber, Purple, Blue). Future: light mode toggle.
5. **Git Identity** — Auto-detected name and email from `git config`. Manual override fields. Used to filter commits to only the current user's work.

---

### Journey Patterns

**Common patterns across all journeys:**

**Navigation Pattern:** Sidebar icon click → view loads with cached data → background refresh if needed. No loading screens for cached data.

**Progressive Disclosure Pattern:** Summary first → expand for detail → drill in for full context. Applied consistently: project groups → sessions → detail panel. Report presets → custom filters → advanced options.

**Inline Editing Pattern:** Click a value to edit it. Changes save automatically. Toast with undo. No separate edit screens or modal forms for simple changes.

**Feedback Pattern:** Optimistic updates (UI changes immediately). Toast notifications for confirmations. Status bar for ambient system state. Progress indicators only for operations > 2 seconds.

**Error Recovery Pattern:** Friendly message explaining what went wrong. Clear action to fix (retry, try different input, manual alternative). Never a dead end — always a path forward.

### Flow Optimization Principles

1. **Minimize steps to value** — First scan shows results in under 30 seconds of first launch. Daily check-in is open-and-glance. Report generation is 3 clicks.
2. **Default to the common case** — Today's sessions on launch. This week for reports. Auto-detected settings where possible. Manual overrides available but not required.
3. **Never block the user** — Background scanning, progressive loading, cached data first. AI summarization is async and non-blocking.
4. **Make corrections cheap** — Every edit is inline, instant, and undoable. The cost of fixing a mistake is seconds, not minutes.
5. **Show the source** — Sessions link to their evidence (git commits, `.claude` data). Reports show how numbers were calculated. Trust comes from transparency.
