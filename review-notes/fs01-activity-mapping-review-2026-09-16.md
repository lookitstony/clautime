# Activity mapping code review

Status: **fixed locally** on September 16, 2026. `getPromptTimings` now uses detector/mapped bounds for both retained database messages and the file fallback, using saved times only when no baseline exists. Saved time edits remain intact. Four permanent regressions cover swapped mappings and legacy bounds through both read paths, including response latency and tool-result filtering. Both mapping regressions failed before the fix; all **171 tests across eight targeted suites**, both typechecks and targeted ESLint now pass. No live change, commit or push.

Scope: latest explicit one-to-one activity mapping, including later reconciliation, transactional audit records, IPC/UI, and billing interactions. Local fixture databases only; no application launch, production changes, commits or pushes.

## Finding

**P2: Prompt Timeline does not follow the selected activity mapping.** `src/main/services/session-reconciliation.ts:279-283` preserves displayed session times and writes the chosen activity bounds to `session_derivations`, but `sessionService.getPromptTimings` still selects raw messages using the saved display times (`session-service.ts:1146-1147`), including in its file fallback. Selecting a different interval therefore updates the aggregate prompt/token counts while the detail panel shows another interval's prompts (or no prompts). Resolve the mapped activity bounds when loading the timeline, retaining the saved display-time edits.

Reproduced with two saved intervals, 10:00–10:10 and 10:40–10:50, and retained intervals containing two and three prompts respectively. Explicitly swapping the mapping gives the first saved row three prompts, but its timeline returns the original two messages. The regression expecting three fails.

Reproduction source is saved in `fs01-activity-mapping-review-repro-2026-09-16.txt`. To rerun, copy it to `src/main/services/activity-mapping-review.test.ts` and run that fixture through Electron's Node mode with Vitest. The temporary test was removed after review; implementation files were not changed.

## Verification

- Existing eight targeted suites: 167 tests passed.
- Both node and renderer typechecks passed before adding the temporary reproduction.
- Focused timeline regression: failed, expected three messages and received two.
- Diff whitespace check passed.
