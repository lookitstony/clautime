# Sessions time review — September 15, 2026

## Result

Read-only inspection of `C:\Users\looki\AppData\Roaming\clautime\clautime.db` and original Codex rollout files. No application code, live settings, sessions, or invoices were changed. Existing unrelated workspace changes were left intact.

At approximately 14:28 Eastern, the Sessions calculation across all projects/tools produced:

| Period (America/New_York) | Merged session time |
|---|---:|
| Monday, September 14 | 3h 46m |
| Tuesday, September 15 | 2h 03m |
| This Week | 5h 49m |

These are recorded AI-session intervals with simultaneous sessions counted once, not verified personal working hours. The week starts Monday; after-hours filtering is disabled. Today's values can increase while the app runs.

The reported approximately two-hour **weekly** total was not reproduced with all filters cleared. The user's exact selected project/client/tool and whether the number is a top card or project subtotal remain unknown. PipedCreations alone totals 1h 54m this week; today's all-project total is 2h 03m. Neither establishes which number the user saw.

## Data checks

- All 103 Codex rollout files modified since Monday's local midnight have scan-state entries. None was behind by more than 100 KB when checked.
- Independently parsed those original files and ran the repository's detector with the saved 15-minute timeout. Detected intervals match stored Codex intervals, apart from this actively growing review conversation's end timestamp. Yesterday's Codex-only merged time is 3h 43m; Claude adds approximately three non-overlapping minutes.
- SQLite `PRAGMA quick_check` returned `ok` on a connection opened with `mode=ro` and `query_only=ON`.
- No archived Codex rollout files were present in the default archived-session directory.

## Compression hypothesis

Found three `compacted` records during September 14, plus one associated `context_compacted` notification. Earlier timestamped records remain in the original files; no backward timestamps were found in the inspected day's records. All three compactions occur inside stored continuous sessions for their own source files:

| Compaction, Eastern | Stored interval containing it | Recorded duration |
|---|---|---:|
| 00:21:18, ButtonMaker | 00:17:20–00:37:26 | 20m |
| 14:53:00, Trident | 14:22:35–14:54:12 | 32m |
| 17:03:22, ButtonMaker | 16:49:04–17:04:25 | 15m |

These compactions did not erase or split the corresponding recorded time. The parser ignores replacement-history snapshots, retains the surrounding original messages, and handles cumulative token-counter resets separately from elapsed-time calculation. This establishes the behavior of the inspected files, not every possible Codex version or compaction format.

## Algorithm findings

### “Human Hours” does not measure the entire workday

[session-detector.ts](C:/apps/ClawdTime/src/main/services/session-detector.ts:92) splits message gaps exceeding 15 minutes unless a qualifying tool execution bridges them. The whole split gap is excluded. Each segment lasts from its first to last timestamped message ([line 354](C:/apps/ClawdTime/src/main/services/session-detector.ts:354)); no allowance is added for reading, testing, editing, or other work after the last message. Conversely, autonomous agent activity can count while the user is absent.

Example: yesterday's Trident transcript finishes one segment at 13:12:35 and receives its next user message at 14:22:35. That roughly 70-minute gap contributes zero. The inspected log does not establish whether the user was working during it. Simply increasing the timeout would also count real breaks, so this review does not invent recovered work hours.

### Date presets can become stale overnight

[SessionsPage.tsx](C:/apps/ClawdTime/src/renderer/src/features/sessions/SessionsPage.tsx:56) memoizes the concrete date range using filter settings as dependencies. Calendar date is not a dependency. If the page remains mounted across midnight with unchanged filters, refetches can continue querying yesterday's end boundary. This is a code-review finding; it is not established as the cause of the user's displayed number.

### Midnight-ending sessions can be excluded

[format.ts](C:/apps/ClawdTime/src/renderer/src/lib/format.ts:155) ends a date range at 23:59:59.999, while [session-service.ts](C:/apps/ClawdTime/src/main/services/session-service.ts:900) requires a session's end to be inside that range. The detector clips continuous sessions to exactly 00:00:00.000. A prior-day fragment therefore fails a filter ending on that day.

Concrete affected row: session 952225 runs September 14, 23:59:35.817–September 15, 00:00:00.000 Eastern. A September 14-only query excludes it. It is included in the September 14–15 weekly range. This small boundary loss does not explain several missing hours.

## Validation and remaining uncertainty

102 existing tests passed across the Codex parser, session detector, date formatting, and Sessions statistics suites. These tests do not establish that the current date-refresh behavior or measurement policy is correct.

The import checks support that yesterday's recorded Codex activity is present. They do not establish total personal working time or explain the precise two-hour weekly UI figure without the visible card/subtotal and remaining filters.

## Follow-up fixes

After the user recalled a mall trip and authorized fixing confirmed defects, implemented the two date-filter fixes locally. Sessions now refreshes preset dates at local midnight and on focus/visibility changes after sleep. Session and model-usage queries include the preceding day's exclusive midnight end while excluding sessions starting on the next day. Custom dates and client/project/tool filters are preserved. The 15-minute idle policy and compaction handling were not changed.

Regression tests first reproduced the date-rollover and midnight-omission defects, then passed with the fixes. In total, 170 tests passed across eight affected/related suites, and both TypeScript checks passed. Targeted lint had no errors and one existing import-formatting warning. Database tests ran against in-memory databases using Electron's Node runtime to match the existing SQLite native binary. No live rebuild, rescan, data change, or deployment was performed.
