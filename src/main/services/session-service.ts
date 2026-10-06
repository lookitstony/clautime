import { historySyncWorkspace } from './folder-sync-history-records'
import {
  journalLegacySessionDeletion,
  journalLegacySessionSplit,
  journalSessionMutation,
  prepareSessionSync,
  journalManualSessionDeletion,
  journalManualSessionSplit,
  mappedSessionObservedHeads,
  journalMappedSplitCopies
} from './folder-sync-session-local'
import { stat } from 'node:fs/promises'
import { setImmediate as yieldToMainLoop } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { join, basename, dirname, sep } from 'node:path'
import {
  eq,
  and,
  gte,
  lte,
  inArray,
  notInArray,
  sql,
  or,
  isNull,
  isNotNull,
  type SQL
} from 'drizzle-orm'
import log from 'electron-log/main.js'
import { getDb } from '../db'
import { sessions } from '../db/schema/sessions'
import { scanState } from '../db/schema/scan-state'
import { rawMessages } from '../db/schema/raw-messages'
import { progressEvents } from '../db/schema/raw-messages'
import { sessionModelUsage } from '../db/schema/session-model-usage'
import { sessionDerivations, sessionTimeOverrides } from '../db/schema/session-derivations'
import { sessionDeletions, activeSessionCondition } from '../db/schema/session-deletions'
import { sessionSplits } from '../db/schema/session-history'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import {
  sessionReconciliationCases,
  sessionReconciliationResolutions
} from '../db/schema/session-reconciliation'
import {
  recordSessionRevision,
  splitMeasurement,
  applySessionSplits,
  SessionReconciliationError
} from './session-history'
import { retainInvoiceBillingRefs } from './session-billing'
import { getManualTimeEntry, recordManualTimeEntry } from './manual-time-entries'
import { storeActivityEvidence } from './activity-evidence'
import {
  retainLegacySession,
  adoptedLegacySessionsElsewhere,
  sourceLessLegacyDeletions,
  sourceLessLegacySessions
} from './session-legacy'
import {
  getReconciliationCases as readReconciliationCases,
  keepSavedHistory,
  mapSavedHistory,
  replaceSavedHistory,
  retainedResolutionCount,
  recordReconciliationFailure,
  resolveReconciliationCase
} from './session-reconciliation'
import { settingsService } from './settings-service'
import { clientProjectService } from './client-project-service'
import { detectSessionsFromMultiple, detectSessionsWithPolicy } from './session-detector'
import { getWorkspacePolicy } from './workspace-policy'
import { reconcileMappedSource, SessionMappingReconciliationError } from './session-mapping-scanner'
import { deleteMappedSession, splitMappedSession } from './canonical-history-operations'
import { currentReportingDateKey } from './reporting-calendar'
import { filterSessionsBySourceMachine } from './folder-sync-machine-view'
import { parseSessionFiles } from './parse-orchestrator'
import { enabledProviders, providerForFile } from '../providers'
import { isExcludedProjectPath } from '../../shared/paths'
import type {
  SessionFilters,
  ScanResult,
  SessionScanError,
  PromptTiming,
  UpdateSession,
  GapAnalysis,
  TimeBreakdownDay,
  DetectedSession,
  ModelUsageAggregate,
  ModelUsageFilters,
  SessionTool,
  SessionActivityMapping,
  SessionReplacementChoice
} from '../../shared/types/session'
import type { ParsedSessionData, ParsedMessage, TokenUsage } from '../parsers/types'

const DEFAULT_IDLE_TIMEOUT_MINUTES = 15

/**
 * Discover session files from every enabled provider, tagged by provider id so
 * the caller can log the per-provider split. Each provider owns how it finds and
 * filters its own files (see src/main/providers/).
 *
 * `claudeDirOverride` is Claude-specific (a test fixture or user claude_dir), so
 * it is handed ONLY to the Claude provider — never to Codex, whose root is a
 * different tree. Other providers resolve their own roots.
 */
async function discoverFilesByProvider(
  claudeDirOverride?: string,
  projectFilter?: string[]
): Promise<{ id: SessionTool; files: string[] }[]> {
  return Promise.all(
    enabledProviders().map(async (p) => ({
      id: p.id,
      // Isolate each provider: one provider's discovery throwing must not fail
      // the whole multi-provider scan (the others still have work to do).
      files: await p
        .discoverFiles({
          rootOverride: p.id === 'claude' ? claudeDirOverride : undefined,
          projectFilter
        })
        .catch((err) => {
          log.warn(`Discovery failed for provider ${p.id}:`, err)
          return [] as string[]
        })
    }))
  )
}

/**
 * Reconstruct per-file ParsedSessionData from the raw_messages store.
 * With no filter it covers every stored file (full rebuild). With a filter it
 * covers only the given main files plus their subagent files — how incremental
 * scans see full per-file history while reading only appended bytes from disk.
 */
function reconstructParsedFromRaw(
  db: ReturnType<typeof getDb>,
  filter?: { mainFiles: string[]; subFiles: string[] }
): ParsedSessionData[] {
  const fileList = filter ? [...new Set([...filter.mainFiles, ...filter.subFiles])] : null
  if (fileList && fileList.length === 0) return []

  // Disk discovery cannot enumerate deleted child logs. Select their retained
  // streams using the main conversation's stored identity, not current offsets.
  const subDirectories = filter
    ? [
        ...new Set(
          db
            .selectDistinct({
              sourceFile: rawMessages.sourceFile,
              sessionId: rawMessages.claudeSessionId
            })
            .from(rawMessages)
            .where(
              and(inArray(rawMessages.sourceFile, filter.mainFiles), eq(rawMessages.isSubagent, 0))
            )
            .all()
            .map(
              (r) =>
                join(
                  dirname(r.sourceFile),
                  r.sessionId || basename(r.sourceFile, '.jsonl'),
                  'subagents'
                ) + sep
            )
        )
      ]
    : []

  // A prefix range uses the source-file indexes; substr() forces a full history scan.
  // Every directory ends in the platform separator, so incrementing it gives the
  // exclusive upper bound for precisely that directory (including deleted logs).
  const directoryRange = (
    column: typeof rawMessages.sourceFile | typeof progressEvents.sourceFile,
    dir: string
  ): SQL =>
    and(
      gte(column, dir),
      sql`${column} < ${dir.slice(0, -1) + String.fromCharCode(sep.charCodeAt(0) + 1)}`
    )!

  const allRawMessages = db
    .select()
    .from(rawMessages)
    .where(
      fileList
        ? or(
            inArray(rawMessages.sourceFile, fileList),
            ...subDirectories.map((dir) => directoryRange(rawMessages.sourceFile, dir))
          )
        : undefined
    )
    .orderBy(rawMessages.sourceFile, rawMessages.timestamp)
    .all()
  const allProgressEvents = db
    .select()
    .from(progressEvents)
    .where(
      fileList
        ? or(
            inArray(progressEvents.sourceFile, fileList),
            ...subDirectories.map((dir) => directoryRange(progressEvents.sourceFile, dir))
          )
        : undefined
    )
    .orderBy(progressEvents.sourceFile, progressEvents.timestamp)
    .all()

  // Group by sourceFile (main messages only, isSubagent=0)
  const mainByFile = new Map<string, typeof allRawMessages>()
  const subByFile = new Map<string, typeof allRawMessages>()
  for (const rm of allRawMessages) {
    const map = rm.isSubagent === 0 ? mainByFile : subByFile
    const list = map.get(rm.sourceFile) ?? []
    list.push(rm)
    map.set(rm.sourceFile, list)
  }

  // Group progress events by sourceFile
  const progressByFile = new Map<string, typeof allProgressEvents>()
  for (const pe of allProgressEvents) {
    const list = progressByFile.get(pe.sourceFile) ?? []
    list.push(pe)
    progressByFile.set(pe.sourceFile, list)
  }

  // 3. Reconstruct ParsedSessionData[] from DB records
  const reconstructed: ParsedSessionData[] = []
  for (const [sourceFile, msgs] of mainByFile) {
    const first = msgs[0]
    const sessionId = first.claudeSessionId || basename(sourceFile, '.jsonl')
    const projectPathEncoded = first.projectPathEncoded || basename(dirname(sourceFile))
    const projectDirectory = msgs.find((m) => m.cwd)?.cwd || null

    // Reconstruct messages
    const parsedMessages: ParsedMessage[] = msgs.map((rm) => ({
      type: rm.type,
      timestamp: rm.timestamp,
      sessionId: rm.claudeSessionId || sessionId,
      cwd: rm.cwd,
      gitBranch: rm.gitBranch,
      model: rm.model,
      usage:
        rm.inputTokens || rm.outputTokens || rm.cacheCreationInputTokens || rm.cacheReadInputTokens
          ? {
              inputTokens: rm.inputTokens,
              outputTokens: rm.outputTokens,
              cacheCreationInputTokens: rm.cacheCreationInputTokens,
              cacheReadInputTokens: rm.cacheReadInputTokens
            }
          : null,
      uuid: rm.uuid,
      parentUuid: rm.parentUuid,
      isToolResult: rm.isToolResult === 1,
      hasToolUse: rm.hasToolUse === 1,
      toolNames: rm.toolNames ? safeParseJsonArray(rm.toolNames) : []
    }))

    // Aggregate main token usage
    const totalTokenUsage = emptyTokenUsage()
    for (const rm of msgs) {
      totalTokenUsage.inputTokens += rm.inputTokens
      totalTokenUsage.outputTokens += rm.outputTokens
      totalTokenUsage.cacheCreationInputTokens += rm.cacheCreationInputTokens
      totalTokenUsage.cacheReadInputTokens += rm.cacheReadInputTokens
    }

    // Collect subagent data for this main source file's session
    // Subagent messages have their own sourceFile, so we need to match by session directory
    const subagentTokenUsage = emptyTokenUsage()
    const subagentMessages: ParsedMessage[] = []
    const subagentProgressTimestamps: string[] = []

    // Find subagent files that belong to this main file's session
    const sessionDir = join(dirname(sourceFile), sessionId, 'subagents') + sep
    for (const [subFile, subMsgs] of subByFile) {
      if (subFile.startsWith(sessionDir)) {
        for (const sm of subMsgs) {
          subagentTokenUsage.inputTokens += sm.inputTokens
          subagentTokenUsage.outputTokens += sm.outputTokens
          subagentTokenUsage.cacheCreationInputTokens += sm.cacheCreationInputTokens
          subagentTokenUsage.cacheReadInputTokens += sm.cacheReadInputTokens

          subagentMessages.push({
            type: sm.type,
            timestamp: sm.timestamp,
            sessionId: sm.claudeSessionId || sessionId,
            cwd: sm.cwd,
            gitBranch: sm.gitBranch,
            model: sm.model,
            usage:
              sm.inputTokens ||
              sm.outputTokens ||
              sm.cacheCreationInputTokens ||
              sm.cacheReadInputTokens
                ? {
                    inputTokens: sm.inputTokens,
                    outputTokens: sm.outputTokens,
                    cacheCreationInputTokens: sm.cacheCreationInputTokens,
                    cacheReadInputTokens: sm.cacheReadInputTokens
                  }
                : null,
            uuid: sm.uuid,
            parentUuid: sm.parentUuid,
            isToolResult: sm.isToolResult === 1,
            hasToolUse: sm.hasToolUse === 1,
            toolNames: sm.toolNames ? JSON.parse(sm.toolNames) : []
          })
        }
      }
    }

    // Collect progress timestamps — merge main + subagent
    const mainProgress = (progressByFile.get(sourceFile) ?? []).map((p) => p.timestamp)
    for (const [subFile, subPEs] of progressByFile) {
      if (subFile.startsWith(sessionDir)) {
        for (const pe of subPEs) {
          subagentProgressTimestamps.push(pe.timestamp)
        }
      }
    }
    // Merge main + subagent progress for the detector
    const allProgress = [...mainProgress, ...subagentProgressTimestamps].sort()

    const timestamps = parsedMessages.filter((m) => m.timestamp).map((m) => m.timestamp)
    const models = [...new Set(msgs.filter((m) => m.model).map((m) => m.model!))]

    reconstructed.push({
      sessionId,
      sourceFile,
      tool: providerForFile(sourceFile).id,
      projectPathEncoded,
      projectDirectory,
      messages: parsedMessages,
      progressTimestamps: allProgress,
      firstTimestamp: timestamps[0] ?? null,
      lastTimestamp: timestamps[timestamps.length - 1] ?? null,
      totalTokenUsage,
      subagentTokenUsage,
      models,
      messageCount: parsedMessages.length,
      summary: null,
      subagentMessages,
      subagentProgressTimestamps
    })
  }

  return reconstructed
}

/** First stored cwd for a file — exclusion checks on cwd-less incremental tails. */
function storedCwdForFile(db: ReturnType<typeof getDb>, sourceFile: string): string | null {
  const row = db
    .select({ cwd: rawMessages.cwd })
    .from(rawMessages)
    .where(and(eq(rawMessages.sourceFile, sourceFile), isNotNull(rawMessages.cwd)))
    .limit(1)
    .get()
  return row?.cwd ?? null
}

function safeParseJsonArray(str: string): string[] {
  try {
    const parsed = JSON.parse(str)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function emptyTokenUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
}

/**
 * Calendar day of an ISO timestamp in local time, as YYYY-MM-DD.
 * Slicing the ISO string instead would key off the UTC day, putting late-evening
 * work on tomorrow's date west of UTC. Mirrors getDateKey in report-service.
 */
function localDateKey(isoString: string): string {
  return currentReportingDateKey(isoString)
}

/** Date filters include their last millisecond; session ends are exclusive. */
function sessionEndCondition(endDate: string): SQL {
  return or(
    lte(sessions.endedAt, endDate),
    and(
      eq(sessions.endedAt, new Date(new Date(endDate).getTime() + 1).toISOString()),
      // Keep a zero-duration session at the next day's midnight on that day.
      lte(sessions.startedAt, endDate)
    )
  )!
}

/**
 * SessionService orchestrates: discover → filter → parse → store raw → detect → store sessions.
 * All database operations use batch inserts in transactions (NFR18, NFR20).
 */
function configuredIdleTimeout(): number {
  const workspace = getWorkspacePolicy(getDb())
  if (workspace) return workspace.policy.idleTimeoutMinutes
  const setting = settingsService.getSetting('idle_timeout_minutes')
  const parsed = setting ? parseInt(setting, 10) : NaN
  return Number.isNaN(parsed) ? DEFAULT_IDLE_TIMEOUT_MINUTES : parsed
}

function isMappedSession(db: ReturnType<typeof getDb>, id: number): boolean {
  return !!db
    .select({ id: sessionActivityMappings.id })
    .from(sessionActivityMappings)
    .where(eq(sessionActivityMappings.sessionId, id))
    .get()
}

function detectConfiguredSessions(
  recordings: ParsedSessionData[],
  timeout: number
): DetectedSession[] {
  const workspace = getWorkspacePolicy(getDb())
  return workspace
    ? detectSessionsWithPolicy(recordings, workspace.policy)
    : detectSessionsFromMultiple(recordings, timeout)
}

export const sessionService = {
  _scanInProgress: false,

  /**
   * Scan for new/changed session files, detect sessions, and store in DB.
   * Only processes files modified since last scan (incremental - FR5).
   */
  async scanSessions(claudeDir?: string, projectFilter?: string[]): Promise<ScanResult> {
    if (this._scanInProgress) {
      log.warn('Scan/rebuild already in progress, skipping')
      return { newSessions: 0, updatedFiles: 0, totalFiles: 0, durationMs: 0, attributedCount: 0 }
    }
    this._scanInProgress = true
    try {
      return await this._doScan(claudeDir, projectFilter)
    } finally {
      this._scanInProgress = false
    }
  },

  async _doScan(claudeDir?: string, projectFilter?: string[]): Promise<ScanResult> {
    const startTime = Date.now()

    let idleTimeoutMinutes = configuredIdleTimeout()

    log.info(`Starting session scan (idle timeout: ${idleTimeoutMinutes}min)`)

    // 1. Discover session files from every enabled provider (optionally filtered)
    const perProvider = await discoverFilesByProvider(claudeDir, projectFilter)
    const allFiles = perProvider.flatMap((r) => r.files)
    log.info(
      `Discovered ${allFiles.length} total session files (${perProvider
        .map((r) => `${r.files.length} ${r.id}`)
        .join(', ')})`
    )

    // Backfill raw_messages on first scan if table is empty
    await this._backfillIfNeeded(claudeDir, projectFilter)

    // 2. Filter to only new/changed files (also collects file mtimes, sizes,
    // and the per-file consumed byte offsets for incremental parsing)
    const { files: filesToProcess, mtimes, fileSizes, offsets } = await filterChangedFiles(allFiles)
    log.info(`${filesToProcess.length} files need processing (new or changed)`)

    if (filesToProcess.length === 0) {
      const errors = this.getReconciliationCases().map(({ sourceFile, message }) => ({
        sourceFile,
        message
      }))
      const durationMs = Date.now() - startTime
      log.info(`Scan complete (no changes) in ${durationMs}ms`)
      return {
        newSessions: 0,
        updatedFiles: 0,
        totalFiles: allFiles.length,
        durationMs,
        attributedCount: 0,
        ...(errors.length > 0 ? { errors } : {})
      }
    }

    // 3. Parse changed files — off the main thread, and only appended bytes
    // for files whose consumed offset is known
    const db = getDb()
    const parseResults = await parseSessionFiles(
      filesToProcess.map((path) => ({ path, providerId: providerForFile(path).id })),
      offsets
    )
    const parsedSessions: ParsedSessionData[] = []
    for (const p of parseResults) {
      if (!p) continue
      // Codex has no excluded-dir convention — filter piped-swarm worktrees by
      // cwd. An incremental tail may not contain a cwd line, so fall back to
      // the cwd already stored for this file.
      const cwd = p.projectDirectory ?? storedCwdForFile(db, p.sourceFile)
      if (cwd && isExcludedProjectPath(cwd)) continue
      parsedSessions.push(p)
    }

    // 4. Store raw messages in DB (with dedup)
    await storeRawMessages(parsedSessions, false)

    // Reconstruct and reconcile one source per turn so a startup backlog cannot
    // monopolize the main loop. Keep each source's sessions and checkpoint atomic.
    let errors: SessionScanError[] = []
    let committedSessions = 0
    let updatedFiles = 0
    let detectedCount = 0
    for (const p of parsedSessions) {
      await yieldToMainLoop()
      const reconstructed = reconstructParsedFromRaw(db, {
        mainFiles: [p.sourceFile],
        subFiles: Object.keys(p.fileOffsets ?? {}).filter((f) => f !== p.sourceFile)
      })
      // A reviewed policy may have changed while this scan yielded.
      idleTimeoutMinutes = configuredIdleTimeout()
      const fileDetected = detectConfiguredSessions(reconstructed, idleTimeoutMinutes).filter(
        (d) => d.sourceFile === p.sourceFile
      )
      detectedCount += fileDetected.length
      const activity = reconstructed.find((file) => file.sourceFile === p.sourceFile)
      try {
        const reconciledCount = db.transaction((tx) => {
          const activeCount =
            retainedResolutionCount(tx, p.sourceFile, fileDetected, idleTimeoutMinutes, activity) ??
            reconcileMappedSource(tx, fileDetected, p.sourceFile) ??
            reconcileDetectedSessions(tx, fileDetected, p.sourceFile)
          resolveReconciliationCase(tx, p.sourceFile)
          const scanNow = new Date().toISOString()
          for (const [filePath, consumed] of Object.entries(p.fileOffsets ?? {})) {
            if (filePath === p.sourceFile) continue
            tx.insert(scanState)
              .values({
                filePath,
                lastModifiedAt: scanNow,
                lastScannedAt: scanNow,
                sessionCount: 0,
                lastFileSize: consumed
              })
              .onConflictDoUpdate({ target: scanState.filePath, set: { lastFileSize: consumed } })
              .run()
          }
          const checkpoint = {
            lastModifiedAt: mtimes.get(p.sourceFile) ?? scanNow,
            lastScannedAt: scanNow,
            sessionCount: activeCount,
            lastFileSize: p.fileOffsets?.[p.sourceFile] ?? fileSizes.get(p.sourceFile) ?? 0
          }
          tx.insert(scanState)
            .values({ filePath: p.sourceFile, ...checkpoint })
            .onConflictDoUpdate({ target: scanState.filePath, set: checkpoint })
            .run()
          return activeCount
        })
        committedSessions += reconciledCount
        updatedFiles++
      } catch (error) {
        if (!(error instanceof SessionReconciliationError)) throw error
        db.transaction((tx) =>
          recordReconciliationFailure(
            tx,
            p.sourceFile,
            error.message,
            fileDetected,
            idleTimeoutMinutes,
            activity,
            error instanceof SessionMappingReconciliationError
          )
        )
        errors.push({ sourceFile: p.sourceFile, message: error.message })
        log.warn(error.message)
      }
    }

    log.info(`Detected ${detectedCount} sessions from ${parsedSessions.length} parsed files`)

    // Include retained sources whose physical files were not part of this scan.
    errors = this.getReconciliationCases().map(({ sourceFile, message }) => ({
      sourceFile,
      message
    }))
    // Only mark a complete scan when no reconciliation remains unresolved.
    if (errors.length === 0) settingsService.setSetting('last_scan_at', new Date().toISOString())

    const durationMs = Date.now() - startTime
    log.info(
      `Scan finished: ${committedSessions} sessions from ${updatedFiles} files, ${errors.length} unresolved in ${durationMs}ms`
    )

    return {
      newSessions: committedSessions,
      updatedFiles,
      totalFiles: allFiles.length,
      durationMs,
      attributedCount: 0,
      ...(errors.length > 0 ? { errors } : {})
    }
  },

  /**
   * Rebuild sessions from raw_messages DB data (no file I/O).
   * Only re-derives 'auto' sessions; manual sessions are preserved.
   */
  async rebuildSessionsFromRaw(): Promise<ScanResult> {
    if (this._scanInProgress) {
      log.warn('Scan/rebuild already in progress, skipping')
      return { newSessions: 0, updatedFiles: 0, totalFiles: 0, durationMs: 0, attributedCount: 0 }
    }
    this._scanInProgress = true
    try {
      return this._doRebuild()
    } finally {
      this._scanInProgress = false
    }
  },

  getReconciliationCases() {
    const db = getDb()
    // Revalidate kept approvals independently of filesystem discovery. This also
    // protects invoice previews and catches bulk assignment/policy changes.
    const kept = db
      .selectDistinct({ sourceFile: sessionReconciliationCases.sourceFile })
      .from(sessionReconciliationCases)
      .innerJoin(
        sessionReconciliationResolutions,
        eq(sessionReconciliationCases.sourceFile, sessionReconciliationResolutions.sourceFile)
      )
      .where(isNotNull(sessionReconciliationCases.resolvedAt))
      .all()
    if (kept.length > 0) {
      const timeout = configuredIdleTimeout()
      db.transaction((tx) => {
        const reconstructed = reconstructParsedFromRaw(db, {
          mainFiles: kept.map((row) => row.sourceFile),
          subFiles: []
        })
        const detected = detectConfiguredSessions(reconstructed, timeout)
        for (const { sourceFile } of kept) {
          const activity = reconstructed.find((row) => row.sourceFile === sourceFile)
          const intervals = detected.filter((row) => row.sourceFile === sourceFile)
          try {
            retainedResolutionCount(tx, sourceFile, intervals, timeout, activity)
          } catch (error) {
            if (!(error instanceof SessionReconciliationError)) throw error
            recordReconciliationFailure(tx, sourceFile, error.message, intervals, timeout, activity)
          }
        }
      })
    }
    return readReconciliationCases()
  },

  keepSavedHistory(sourceFile: string, fingerprint: string): void {
    if (this._scanInProgress) throw new Error('A scan is running. Confirm after it finishes.')
    const timeout = configuredIdleTimeout()
    const db = getDb()
    db.transaction((tx) => {
      const reconstructed = reconstructParsedFromRaw(db, { mainFiles: [sourceFile], subFiles: [] })
      const detected = detectConfiguredSessions(reconstructed, timeout).filter(
        (row) => row.sourceFile === sourceFile
      )
      keepSavedHistory(
        tx,
        sourceFile,
        fingerprint,
        detected,
        timeout,
        reconstructed.find((file) => file.sourceFile === sourceFile)
      )
    })
  },

  mapSavedHistory(
    sourceFile: string,
    fingerprint: string,
    mappings: SessionActivityMapping[]
  ): void {
    if (this._scanInProgress) throw new Error('A scan is running. Confirm after it finishes.')
    const timeout = configuredIdleTimeout()
    const db = getDb()
    db.transaction((tx) => {
      const reconstructed = reconstructParsedFromRaw(db, { mainFiles: [sourceFile], subFiles: [] })
      const detected = detectConfiguredSessions(reconstructed, timeout).filter(
        (row) => row.sourceFile === sourceFile
      )
      mapSavedHistory(
        tx,
        sourceFile,
        fingerprint,
        mappings,
        detected,
        timeout,
        reconstructed.find((file) => file.sourceFile === sourceFile)
      )
    })
  },

  replaceSavedHistory(
    sourceFile: string,
    fingerprint: string,
    choices: SessionReplacementChoice[] = []
  ): void {
    if (this._scanInProgress) throw new Error('A scan is running. Confirm after it finishes.')
    const timeout = configuredIdleTimeout()
    const db = getDb()
    db.transaction((tx) => {
      const reconstructed = reconstructParsedFromRaw(db, { mainFiles: [sourceFile], subFiles: [] })
      const detected = detectConfiguredSessions(reconstructed, timeout).filter(
        (row) => row.sourceFile === sourceFile
      )
      replaceSavedHistory(
        tx,
        sourceFile,
        fingerprint,
        detected,
        timeout,
        reconstructed.find((file) => file.sourceFile === sourceFile),
        choices
      )
    })
  },

  async recheckReconciliation(sourceFile: string): Promise<ScanResult> {
    if (this._scanInProgress) throw new Error('A scan is running. Recheck after it finishes.')
    if (!this.getReconciliationCases().some((row) => row.sourceFile === sourceFile)) {
      throw new Error('This source no longer has a pending review. Refresh the list.')
    }
    this._scanInProgress = true
    try {
      return this._doRebuild(sourceFile)
    } finally {
      this._scanInProgress = false
    }
  },

  _doRebuild(sourceFile?: string): ScanResult {
    const startTime = Date.now()
    const db = getDb()

    const idleTimeoutMinutes = configuredIdleTimeout()

    log.info(`Rebuilding sessions from raw messages (idle timeout: ${idleTimeoutMinutes}min)`)

    const reconstructed = reconstructParsedFromRaw(
      db,
      sourceFile ? { mainFiles: [sourceFile], subFiles: [] } : undefined
    )

    if (reconstructed.length === 0) {
      if (sourceFile)
        throw new Error(
          'No retained activity is available to recheck this source. Saved history and its review were retained.'
        )
      log.info('No raw messages to rebuild from')
      return {
        newSessions: 0,
        updatedFiles: 0,
        totalFiles: 0,
        durationMs: Date.now() - startTime,
        attributedCount: 0
      }
    }

    // 4. Detect sessions
    const detected = detectConfiguredSessions(reconstructed, idleTimeoutMinutes)
    log.info(`Rebuild detected ${detected.length} sessions from ${reconstructed.length} files`)
    const errors: SessionScanError[] = []
    let committedSessions = 0
    for (const file of reconstructed) {
      const fileDetected = detected.filter((d) => d.sourceFile === file.sourceFile)
      try {
        committedSessions += db.transaction((tx) => {
          const count =
            retainedResolutionCount(tx, file.sourceFile, fileDetected, idleTimeoutMinutes, file) ??
            reconcileMappedSource(tx, fileDetected, file.sourceFile) ??
            reconcileDetectedSessions(tx, fileDetected, file.sourceFile)
          resolveReconciliationCase(tx, file.sourceFile)
          return count
        })
      } catch (error) {
        if (!(error instanceof SessionReconciliationError)) throw error
        db.transaction((tx) =>
          recordReconciliationFailure(
            tx,
            file.sourceFile,
            error.message,
            fileDetected,
            idleTimeoutMinutes,
            file,
            error instanceof SessionMappingReconciliationError
          )
        )
        errors.push({ sourceFile: file.sourceFile, message: error.message })
        log.warn(error.message)
      }
    }

    const durationMs = Date.now() - startTime
    log.info(
      `Rebuild finished: ${committedSessions} sessions, ${errors.length} unresolved in ${durationMs}ms`
    )

    return {
      newSessions: committedSessions,
      updatedFiles: 0,
      totalFiles: reconstructed.length,
      durationMs,
      attributedCount: 0,
      ...(errors.length > 0 ? { errors } : {})
    }
  },

  /**
   * Scan for new JSONL data then rebuild sessions from raw messages.
   * Used when changing idle timeout — ensures raw_messages are current before rebuild.
   */
  async scanAndRebuild(): Promise<ScanResult> {
    if (this._scanInProgress) {
      log.warn('Scan/rebuild already in progress, skipping')
      return { newSessions: 0, updatedFiles: 0, totalFiles: 0, durationMs: 0, attributedCount: 0 }
    }
    this._scanInProgress = true
    try {
      // Scan first to capture latest JSONL data
      await this._doScan()
      // Then rebuild from raw messages with new idle timeout
      return this._doRebuild()
    } finally {
      this._scanInProgress = false
    }
  },

  /**
   * Backfill raw_messages from existing JSONL files on first run.
   */
  async _backfillIfNeeded(claudeDir?: string, projectFilter?: string[]): Promise<void> {
    const db = getDb()
    const count = db
      .select({ count: sql<number>`count(*)` })
      .from(rawMessages)
      .get()
    if (count && count.count > 0) return

    log.info('Raw messages table empty — running backfill...')

    const perProvider = await discoverFilesByProvider(claudeDir, projectFilter)
    const allFiles = perProvider.flatMap((r) => r.files)
    log.info(
      `Backfill: parsing ${allFiles.length} JSONL files (${perProvider
        .map((r) => `${r.files.length} ${r.id}`)
        .join(', ')})`
    )

    // Parse off the main thread in small chunks — a backfill touches every
    // file, and storing between chunks keeps peak memory bounded.
    const BACKFILL_CHUNK = 5
    const entries = allFiles.map((path) => ({ path, providerId: providerForFile(path).id }))
    for (let i = 0; i < entries.length; i += BACKFILL_CHUNK) {
      const parsed = await parseSessionFiles(entries.slice(i, i + BACKFILL_CHUNK), {})
      for (const p of parsed) {
        if (!p) continue
        if (p.projectDirectory && isExcludedProjectPath(p.projectDirectory)) continue
        await storeRawMessages([p])
      }
    }

    // Legacy rows without source activity stay intact; do not invent messages.

    // Update scanState lastFileSize for all processed files
    for (const filePath of allFiles) {
      try {
        const fileStat = await stat(filePath)
        const scanNow = new Date().toISOString()
        db.insert(scanState)
          .values({
            filePath,
            lastModifiedAt: fileStat.mtime.toISOString(),
            lastScannedAt: scanNow,
            sessionCount: 0,
            lastFileSize: fileStat.size
          })
          .onConflictDoUpdate({
            target: scanState.filePath,
            set: { lastFileSize: fileStat.size, lastScannedAt: scanNow }
          })
          .run()
      } catch {
        // File may no longer exist
      }
    }

    log.info('Backfill complete')
  },

  /**
   * Query sessions from DB with optional filters.
   */
  getAllSessions(filters?: SessionFilters) {
    const db = getDb()
    const conditions: SQL[] = [activeSessionCondition]

    // Exclude sessions belonging to inactive (excluded) projects
    const excludedIds = clientProjectService.getExcludedProjectIds()
    if (excludedIds.length > 0) {
      conditions.push(or(isNull(sessions.projectId), notInArray(sessions.projectId, excludedIds))!)
    }

    if (filters?.projectPath) {
      conditions.push(eq(sessions.projectPath, filters.projectPath))
    }
    if (filters?.startDate) {
      conditions.push(gte(sessions.startedAt, filters.startDate))
    }
    if (filters?.endDate) {
      conditions.push(sessionEndCondition(filters.endDate))
    }
    if (filters?.source) {
      conditions.push(eq(sessions.source, filters.source))
    }
    if (filters?.tool) {
      conditions.push(eq(sessions.tool, filters.tool))
    }
    if (filters?.clientId != null) {
      conditions.push(eq(sessions.clientId, filters.clientId))
    }
    if (filters?.projectId != null) {
      conditions.push(eq(sessions.projectId, filters.projectId))
    }

    const rows = db
      .select()
      .from(sessions)
      .where(and(...conditions))
      .orderBy(sessions.startedAt)
      .all()
    // Sessions view only, applied before the caller computes any total.
    return filters?.sourceMachine
      ? filterSessionsBySourceMachine(db, rows, filters.sourceMachine)
      : rows
  },

  /**
   * Get a single session by ID.
   */
  getSessionById(id: number) {
    const db = getDb()
    return (
      db
        .select()
        .from(sessions)
        .where(and(eq(sessions.id, id), activeSessionCondition))
        .get() ?? null
    )
  },

  /**
   * Update a session's fields (time, project, description).
   */
  updateSession(id: number, data: UpdateSession) {
    const db = getDb()
    const existing = this.getSessionById(id)
    if (!existing) {
      throw new Error(`Session ${id} not found`)
    }

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() }
    if (data.startedAt !== undefined) updates.startedAt = data.startedAt
    if (data.endedAt !== undefined) updates.endedAt = data.endedAt
    if (data.durationMinutes !== undefined) updates.durationMinutes = data.durationMinutes
    if (data.description !== undefined) updates.description = data.description
    if (data.billable !== undefined) updates.billable = data.billable ? 1 : 0
    if (data.projectId !== undefined) updates.projectId = data.projectId
    if (data.clientId !== undefined) updates.clientId = data.clientId

    const changed = Object.fromEntries(
      Object.entries(updates).filter(
        ([key, value]) => key !== 'updatedAt' && existing[key as keyof typeof existing] !== value
      )
    )
    if (Object.keys(changed).length === 0) return existing

    db.transaction((tx) =>
      journalSessionMutation(tx, id, () => {
        recordSessionRevision(
          tx,
          existing,
          'edit',
          Object.fromEntries(
            Object.keys(changed).map((key) => [key, existing[key as keyof typeof existing]])
          ),
          changed
        )
        tx.update(sessions).set(updates).where(eq(sessions.id, id)).run()
        const timeEdits = {
          ...(data.startedAt !== undefined && data.startedAt !== existing.startedAt
            ? { startedAt: 1 }
            : {}),
          ...(data.endedAt !== undefined && data.endedAt !== existing.endedAt
            ? { endedAt: 1 }
            : {}),
          ...(data.durationMinutes !== undefined &&
          data.durationMinutes !== existing.durationMinutes
            ? { durationMinutes: 1 }
            : {})
        }
        if (existing.source === 'auto' && Object.keys(timeEdits).length > 0) {
          tx.insert(sessionTimeOverrides)
            .values({ sessionId: id, ...timeEdits })
            .onConflictDoUpdate({ target: sessionTimeOverrides.sessionId, set: timeEdits })
            .run()
        }
      })
    )

    return db.select().from(sessions).where(eq(sessions.id, id)).get()!
  },

  /**
   * Hide a session from active history without erasing its audit row.
   */
  deleteSession(id: number) {
    const db = getDb()
    const existing = db.select().from(sessions).where(eq(sessions.id, id)).get()
    if (!existing) {
      throw new Error(`Session ${id} not found`)
    }

    if (
      db.select().from(sessionDeletions).where(eq(sessionDeletions.sessionId, id)).get() &&
      !this.getSessionById(id)
    )
      return
    if (!this.getSessionById(id))
      throw new Error(`Session ${id} is audit history; delete its active parts instead`)
    db.transaction((tx) => prepareSessionSync(tx, [id]))
    // Adopted activity is deleted by its reviewed coverage, never by saved times.
    if (isMappedSession(db, id))
      return db.transaction((tx) =>
        deleteMappedSession(tx, id, {
          observedSessionEditHeads: mappedSessionObservedHeads(tx, id)
        })
      )
    const baseline = db
      .select()
      .from(sessionDerivations)
      .where(eq(sessionDerivations.sessionId, id))
      .get()
    if (
      existing.source === 'auto' &&
      !baseline &&
      !existing.sourceFile &&
      !existing.claudeSessionId?.trim()
    ) {
      throw new Error(
        'This legacy session has no source identity or known conversation. Resolve its activity mapping before deleting it from history.'
      )
    }
    const range = baseline ?? existing
    db.transaction((tx) => {
      prepareSessionSync(tx, [id])
      const legacyRecordId =
        existing.source === 'auto' && !baseline ? retainLegacySession(tx, existing) : null
      tx.insert(sessionDeletions)
        .values({
          legacyRecordId,
          id: randomUUID(),
          sessionId: id,
          sourceFile: existing.source === 'auto' ? existing.sourceFile : null,
          tool: existing.tool,
          claudeSessionId: existing.claudeSessionId,
          startedAt: range.startedAt,
          endedAt: range.endedAt,
          createdAt: new Date().toISOString()
        })
        .onConflictDoNothing({ target: sessionDeletions.sessionId })
        .run()
      journalManualSessionDeletion(tx, id)
      journalLegacySessionDeletion(tx, id)
    })
  },

  /**
   * Create a manual session.
   */
  createSession(data: {
    projectPath: string
    startedAt: string
    endedAt: string
    durationMinutes: number
    description?: string
    projectId?: number | null
    clientId?: number | null
  }) {
    const db = getDb()
    const now = new Date().toISOString()
    return db.transaction((tx) => {
      const session = tx
        .insert(sessions)
        .values({
          projectPath: data.projectPath,
          startedAt: data.startedAt,
          endedAt: data.endedAt,
          durationMinutes: data.durationMinutes,
          source: 'manual',
          description: data.description ?? null,
          status: 'completed',
          promptCount: 0,
          projectId: data.projectId ?? null,
          clientId: data.clientId ?? null,
          createdAt: now,
          updatedAt: now
        })
        .returning()
        .get()
      recordManualTimeEntry(tx, session.id)
      prepareSessionSync(tx, [session.id])
      return session
    })
  },

  /** Keep the original as audit history and record a replayable split revision. */
  splitSession(
    id: number,
    splitAt: string
  ): [typeof sessions.$inferSelect, typeof sessions.$inferSelect] {
    const db = getDb()
    const existing = this.getSessionById(id)
    if (!existing) throw new Error(`Session ${id} not found`)
    db.transaction((tx) => prepareSessionSync(tx, [id]))
    // Adopted activity splits by exact event ownership into adopted parts.
    if (isMappedSession(db, id))
      return db.transaction((tx) => {
        prepareSessionSync(tx, [id])
        const children = splitMappedSession(tx, id, splitAt)
        journalMappedSplitCopies(
          tx,
          id,
          children.map((row) => row.id)
        )
        return children
      })
    const baseline = db
      .select()
      .from(sessionDerivations)
      .where(eq(sessionDerivations.sessionId, id))
      .get()
    const cut = Date.parse(splitAt)
    if (!Number.isFinite(cut)) throw new Error('Invalid split point')
    splitAt = new Date(cut).toISOString()
    const usage = db
      .select()
      .from(sessionModelUsage)
      .where(eq(sessionModelUsage.sessionId, id))
      .all()
    const saved = {
      ...existing,
      claudeSessionId: existing.claudeSessionId ?? '',
      sourceFile: existing.sourceFile ?? '',
      modelUsage: usage
    }
    const displayed = splitMeasurement(saved, splitAt)
    const measured = splitMeasurement({ ...saved, ...(baseline ?? {}) }, splitAt)
    const parentOverrides = db
      .select()
      .from(sessionTimeOverrides)
      .where(eq(sessionTimeOverrides.sessionId, id))
      .get()
    const now = new Date().toISOString()
    return db.transaction((tx) => {
      prepareSessionSync(tx, [id])
      const manualParent = existing.source === 'manual' ? getManualTimeEntry(tx, id) : undefined
      if (existing.source === 'manual' && !manualParent) {
        throw new Error('Manual time entry identity is missing; saved history was retained')
      }
      const legacyRecordId =
        existing.source === 'auto' && !baseline ? retainLegacySession(tx, existing) : null
      retainInvoiceBillingRefs(tx)
      const children = displayed.map((part, index) => {
        const row = tx
          .insert(sessions)
          .values({
            ...existing,
            id: undefined,
            startedAt: part.startedAt,
            endedAt: part.endedAt,
            durationMinutes: part.durationMinutes,
            promptCount: measured[index].promptCount,
            inputTokens: measured[index].inputTokens,
            outputTokens: measured[index].outputTokens,
            createdAt: now,
            updatedAt: now
          })
          .returning()
          .get()
        if (manualParent) recordManualTimeEntry(tx, row.id, manualParent.id)
        insertModelUsage(tx, row.id, measured[index])
        if (legacyRecordId) retainLegacySession(tx, row)
        if (baseline) {
          const reference = measured[index]
          tx.insert(sessionDerivations)
            .values({
              sessionId: row.id,
              startedAt: reference.startedAt,
              endedAt: reference.endedAt,
              durationMinutes: reference.durationMinutes
            })
            .run()
          tx.insert(sessionTimeOverrides)
            .values({
              sessionId: row.id,
              startedAt: Number(
                (index === 0 && parentOverrides?.startedAt) || row.startedAt !== reference.startedAt
              ),
              endedAt: Number(
                (index === 1 && parentOverrides?.endedAt) || row.endedAt !== reference.endedAt
              ),
              durationMinutes: Number(
                parentOverrides?.durationMinutes ||
                  row.durationMinutes !== reference.durationMinutes
              )
            })
            .run()
        }
        return row
      }) as [typeof sessions.$inferSelect, typeof sessions.$inferSelect]
      const revisionId = recordSessionRevision(tx, existing, 'split', existing, {
        splitAt,
        children
      })
      const range = baseline ?? existing
      const split = tx.insert(sessionSplits).values({
        revisionId,
        legacyRecordId,
        parentSessionId: id,
        firstSessionId: children[0].id,
        secondSessionId: children[1].id,
        sourceFile: existing.source === 'auto' ? existing.sourceFile : null,
        tool: existing.tool,
        claudeSessionId: existing.claudeSessionId,
        startedAt: range.startedAt,
        endedAt: range.endedAt,
        splitAt
      })
      // An entry restored through shared history keeps its first split's audit row; this
      // split stays recorded by its revision and the shared split naming these parts.
      if (manualParent || (legacyRecordId && historySyncWorkspace(tx)))
        split.onConflictDoNothing({ target: sessionSplits.parentSessionId }).run()
      else split.run()
      journalLegacySessionSplit(
        tx,
        id,
        legacyRecordId
          ? {
              legacyRecordId,
              firstSessionId: children[0].id,
              secondSessionId: children[1].id,
              splitAt
            }
          : undefined
      )
      prepareSessionSync(tx, [id])
      journalManualSessionSplit(
        tx,
        id,
        children.map((row) => row.id),
        splitAt
      )
      return children
    })
  },

  /**
   * Extract prompt timings for a session.
   * Tries raw_messages DB first, falls back to JSONL file parsing.
   */
  async getPromptTimings(sessionId: number): Promise<PromptTiming[]> {
    const session = this.getSessionById(sessionId)
    if (!session?.sourceFile) return []

    const db = getDb()
    // Activity follows the detector mapping; saved times may be user overrides.
    const range =
      db
        .select()
        .from(sessionDerivations)
        .where(eq(sessionDerivations.sessionId, sessionId))
        .get() ?? session

    // Try DB first
    const dbMessages = db
      .select()
      .from(rawMessages)
      .where(
        and(
          eq(rawMessages.sourceFile, session.sourceFile),
          gte(rawMessages.timestamp, range.startedAt),
          lte(rawMessages.timestamp, range.endedAt),
          eq(rawMessages.isSubagent, 0)
        )
      )
      .orderBy(rawMessages.timestamp)
      .all()

    if (dbMessages.length > 0) {
      return buildTimingsFromMessages(
        dbMessages.map((rm) => ({
          type: rm.type,
          timestamp: rm.timestamp,
          isToolResult: rm.isToolResult === 1
        }))
      )
    }

    // Fall back to JSONL file parsing
    const parsed = await providerForFile(session.sourceFile).parseFile(session.sourceFile)
    if (!parsed) return []

    const startMs = new Date(range.startedAt).getTime()
    const endMs = new Date(range.endedAt).getTime()
    const msgs = parsed.messages
      .filter((m) => {
        if (!m.timestamp) return false
        const t = new Date(m.timestamp).getTime()
        return t >= startMs && t <= endMs
      })
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))

    return buildTimingsFromMessages(
      msgs.map((m) => ({
        type: m.type,
        timestamp: m.timestamp,
        isToolResult: m.isToolResult
      }))
    )
  },

  /**
   * Compute work vs idle breakdown for sessions by date.
   * For each session, analyzes raw_messages to determine how much of the
   * session duration is active work (<2min gaps) vs idle gaps.
   */
  getTimeBreakdown(startDate: string, endDate: string): TimeBreakdownDay[] {
    const db = getDb()
    const idleTimeout = this._getIdleTimeout()
    const WORK_THRESHOLD = 2 // minutes

    // Get sessions in date range (excluding inactive projects)
    const excludedIds = clientProjectService.getExcludedProjectIds()
    const excludeCondition =
      excludedIds.length > 0
        ? or(isNull(sessions.projectId), notInArray(sessions.projectId, excludedIds))
        : undefined
    const sessionRows = db
      .select()
      .from(sessions)
      .where(
        and(
          gte(sessions.startedAt, startDate),
          lte(sessions.startedAt, endDate),
          eq(sessions.source, 'auto'),
          activeSessionCondition,
          excludeCondition
        )
      )
      .orderBy(sessions.startedAt)
      .all()

    if (sessionRows.length === 0) return []

    // For each session, get raw messages and compute breakdown
    const dailyMap = new Map<
      string,
      { workMinutes: number; idleMinutes: number; totalMinutes: number }
    >()

    // Built once and reused for every session: rebuilding the query per row dominated the cost.
    const messagesIn = (withFile: boolean) =>
      db
        .select({ timestamp: rawMessages.timestamp })
        .from(rawMessages)
        .where(
          and(
            gte(rawMessages.timestamp, sql.placeholder('start')),
            lte(rawMessages.timestamp, sql.placeholder('end')),
            ...(withFile ? [eq(rawMessages.sourceFile, sql.placeholder('file'))] : [])
          )
        )
        .orderBy(rawMessages.timestamp)
        .prepare()
    const fileMessages = messagesIn(true)
    const windowMessages = messagesIn(false)

    for (const session of sessionRows) {
      const date = localDateKey(session.startedAt)

      // Get messages for this session's time window and source file
      const window = { start: session.startedAt, end: session.endedAt }
      const msgs = session.sourceFile
        ? fileMessages.all({ ...window, file: session.sourceFile })
        : windowMessages.all(window)

      let workMin = 0
      let idleMin = 0

      if (msgs.length >= 2) {
        let previous = Date.parse(msgs[0].timestamp)
        for (let i = 1; i < msgs.length; i++) {
          const current = Date.parse(msgs[i].timestamp)
          const gap = (current - previous) / 60_000
          previous = current
          if (gap > 0 && gap <= idleTimeout) {
            if (gap < WORK_THRESHOLD) {
              workMin += gap
            } else {
              idleMin += gap
            }
          }
        }
      } else {
        // No raw messages — treat entire duration as work
        workMin = session.durationMinutes
      }

      const day = dailyMap.get(date) ?? { workMinutes: 0, idleMinutes: 0, totalMinutes: 0 }
      day.workMinutes += workMin
      day.idleMinutes += idleMin
      day.totalMinutes += session.durationMinutes
      dailyMap.set(date, day)
    }

    return Array.from(dailyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, data]) => ({
        date,
        workMinutes: Math.round(data.workMinutes),
        idleMinutes: Math.round(data.idleMinutes),
        totalMinutes: Math.round(data.totalMinutes)
      }))
  },

  /**
   * Aggregate per-model token usage across sessions (for API cost estimation).
   * Applies the same excluded-project logic as getAllSessions.
   */
  getModelUsage(filters?: ModelUsageFilters): ModelUsageAggregate[] {
    const db = getDb()
    const conditions: SQL[] = [activeSessionCondition]

    const excludedIds = clientProjectService.getExcludedProjectIds()
    if (excludedIds.length > 0) {
      conditions.push(or(isNull(sessions.projectId), notInArray(sessions.projectId, excludedIds))!)
    }
    if (filters?.startDate) conditions.push(gte(sessions.startedAt, filters.startDate))
    if (filters?.endDate) conditions.push(sessionEndCondition(filters.endDate))
    if (filters?.clientId != null) conditions.push(eq(sessions.clientId, filters.clientId))
    if (filters?.projectId != null) conditions.push(eq(sessions.projectId, filters.projectId))
    if (filters?.sessionIds) {
      if (filters.sessionIds.length === 0) return []
      conditions.push(inArray(sessionModelUsage.sessionId, filters.sessionIds))
    }

    return db
      .select({
        model: sessionModelUsage.model,
        inputTokens: sql<number>`sum(${sessionModelUsage.inputTokens})`,
        outputTokens: sql<number>`sum(${sessionModelUsage.outputTokens})`,
        cacheCreationInputTokens: sql<number>`sum(${sessionModelUsage.cacheCreationInputTokens})`,
        cacheReadInputTokens: sql<number>`sum(${sessionModelUsage.cacheReadInputTokens})`,
        sessionCount: sql<number>`count(distinct ${sessionModelUsage.sessionId})`
      })
      .from(sessionModelUsage)
      .innerJoin(sessions, eq(sessionModelUsage.sessionId, sessions.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(sessionModelUsage.model)
      .all()
  },

  /** @internal */
  _getIdleTimeout(): number {
    return configuredIdleTimeout()
  },

  /**
   * Analyze gaps between messages across all raw_messages to help visualize
   * idle timeout impact. Returns gap distribution buckets and session count
   * at various timeout values.
   */
  getGapAnalysis(): GapAnalysis {
    const db = getDb()

    // Get all messages ordered by source file then timestamp
    const msgs = db
      .select({ sourceFile: rawMessages.sourceFile, timestamp: rawMessages.timestamp })
      .from(rawMessages)
      .orderBy(rawMessages.sourceFile, rawMessages.timestamp)
      .all()

    if (msgs.length === 0) {
      return { gaps: [], sessionCounts: [], totalMessages: 0 }
    }

    // Compute gaps between consecutive messages within same source file
    const gaps: number[] = []
    for (let i = 1; i < msgs.length; i++) {
      if (msgs[i].sourceFile !== msgs[i - 1].sourceFile) continue
      const prevTime = new Date(msgs[i - 1].timestamp).getTime()
      const currTime = new Date(msgs[i].timestamp).getTime()
      const gapMinutes = (currTime - prevTime) / 60_000
      if (gapMinutes > 0 && gapMinutes < 480) {
        // Cap at 8 hours, ignore negatives
        gaps.push(Math.round(gapMinutes * 10) / 10) // 1 decimal
      }
    }

    gaps.sort((a, b) => a - b)

    // Build histogram buckets (0-1, 1-2, ..., 59-60, 60+)
    const bucketSize = 1
    const maxBucket = 60
    const buckets: { minMinutes: number; maxMinutes: number; count: number }[] = []
    for (let i = 0; i <= maxBucket; i += bucketSize) {
      const min = i
      const max = i === maxBucket ? Infinity : i + bucketSize
      const count = gaps.filter((g) => g >= min && g < max).length
      buckets.push({ minMinutes: min, maxMinutes: max === Infinity ? 999 : max, count })
    }

    // Work time = sum of small gaps (< 2 min) — actual active coding time between prompts
    const WORK_THRESHOLD = 2
    const workMinutes = Math.round(
      gaps.filter((g) => g < WORK_THRESHOLD).reduce((s, g) => s + g, 0)
    )

    // Session counts at various timeout values
    const timeoutValues = [5, 10, 15, 20, 25, 30, 45, 60]
    const sessionCounts = timeoutValues.map((timeout) => {
      const idleMinutes = Math.round(
        gaps.filter((g) => g >= WORK_THRESHOLD && g <= timeout).reduce((s, g) => s + g, 0)
      )
      return {
        timeoutMinutes: timeout,
        estimatedSessions: gaps.filter((g) => g > timeout).length + 1,
        workMinutes,
        idleMinutes,
        totalTrackedMinutes: workMinutes + idleMinutes
      }
    })

    return { gaps: buckets, sessionCounts, totalMessages: msgs.length }
  }
}

function buildTimingsFromMessages(
  msgs: { type: string; timestamp: string; isToolResult: boolean }[]
): PromptTiming[] {
  const timings: PromptTiming[] = []
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i]
    if (msg.type !== 'user' || msg.isToolResult) continue

    let responseAt: string | null = null
    let latencySeconds: number | null = null
    for (let j = i + 1; j < msgs.length; j++) {
      if (msgs[j].type === 'assistant') {
        responseAt = msgs[j].timestamp
        latencySeconds = Math.round(
          (new Date(msgs[j].timestamp).getTime() - new Date(msg.timestamp).getTime()) / 1000
        )
        break
      }
    }

    timings.push({ promptAt: msg.timestamp, responseAt, latencySeconds })
  }
  return timings
}

/**
 * Reconcile only one-to-one intervals. Until split/merge review is implemented,
 * an ambiguous change aborts the transaction instead of replacing saved work.
 * The baseline keeps user-edited times out of identity matching.
 */
function reconcileDetectedSessions(
  tx: Pick<ReturnType<typeof getDb>, 'select' | 'insert' | 'update' | 'delete'>,
  detected: DetectedSession[],
  sourceFile: string
): number {
  let activeCount = 0
  const byFile = new Map<string, DetectedSession[]>([[sourceFile, []]])
  for (const d of detected) {
    const group = byFile.get(d.sourceFile) ?? []
    group.push(d)
    byFile.set(d.sourceFile, group)
  }
  for (const [sourceFile, fileDetected] of byFile) {
    if (adoptedLegacySessionsElsewhere(tx, sourceFile, fileDetected).length)
      throw new SessionReconciliationError(
        `Session reconciliation needs review for ${sourceFile}. This legacy history is already linked to another source. Review this activity before importing it.`
      )
    if (sourceLessLegacySessions(tx, fileDetected).length)
      throw new SessionReconciliationError(
        `Session reconciliation needs review for ${sourceFile}. Saved legacy history has the same conversation but no source mapping. Review it before importing this activity.`
      )
    const existing = tx
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.source, 'auto'),
          eq(sessions.sourceFile, sourceFile),
          activeSessionCondition
        )
      )
      .all()
    const baselines = new Map(
      tx
        .select()
        .from(sessionDerivations)
        .innerJoin(sessions, eq(sessionDerivations.sessionId, sessions.id))
        .where(eq(sessions.sourceFile, sourceFile))
        .all()
        .map((r) => [r.session_derivations.sessionId, r.session_derivations])
    )
    const overlaps = (
      a: { startedAt: string; endedAt: string },
      b: { startedAt: string; endedAt: string }
    ): boolean => {
      const [aStart, aEnd, bStart, bEnd] = [a.startedAt, a.endedAt, b.startedAt, b.endedAt].map(
        Date.parse
      )
      return (
        aStart === bStart ||
        (aStart < bEnd && bStart < aEnd) ||
        (aStart === aEnd && aStart >= bStart && aStart <= bEnd) ||
        (bStart === bEnd && bStart >= aStart && bStart <= aEnd)
      )
    }
    const deletions = tx
      .select()
      .from(sessionDeletions)
      .where(eq(sessionDeletions.sourceFile, sourceFile))
      .all()
    if (
      fileDetected.length > 0 &&
      (deletions.some((deletion) => deletion.legacyRecordId) ||
        sourceLessLegacyDeletions(tx, fileDetected).length > 0)
    ) {
      throw new SessionReconciliationError(
        `Session reconciliation needs review for ${sourceFile}. Returned activity cannot be mapped safely to deleted legacy history; the deletion and saved history were retained.`
      )
    }
    const incoming = applySessionSplits(tx, sourceFile, fileDetected).filter((d) => {
      const overlapping = deletions.filter((deletion) => overlaps(deletion, d))
      if (overlapping.length === 0) return true
      if (
        overlapping.some(
          (deletion) =>
            deletion.tool === d.tool &&
            deletion.claudeSessionId === d.claudeSessionId &&
            Date.parse(d.startedAt) >= Date.parse(deletion.startedAt) &&
            Date.parse(d.endedAt) <= Date.parse(deletion.endedAt)
        )
      )
        return false
      throw new SessionReconciliationError(
        `Session reconciliation needs review for ${sourceFile}. New boundaries overlap deleted history; the deletion and saved history were retained.`
      )
    })
    activeCount += incoming.length
    const matches = incoming.map((d) =>
      existing.filter((s) =>
        d.localSessionId !== undefined
          ? s.id === d.localSessionId
          : overlaps(baselines.get(s.id) ?? s, d)
      )
    )
    const ambiguous =
      existing.some((s) => matches.filter((rows) => rows.includes(s)).length !== 1) ||
      matches.some(
        (rows, i) =>
          rows.length > 1 ||
          (rows.length === 1 &&
            (rows[0].tool !== incoming[i].tool ||
              rows[0].claudeSessionId !== incoming[i].claudeSessionId ||
              Date.parse((baselines.get(rows[0].id) ?? rows[0]).startedAt) !==
                Date.parse(incoming[i].startedAt)))
      )
    if (ambiguous) {
      throw new SessionReconciliationError(
        `Session reconciliation needs review for ${sourceFile}. Saved history was retained; split/merge reconciliation is not yet supported.`
      )
    }

    for (const [index, d] of incoming.entries()) {
      const previous = matches[index][0]
      const baseline = previous ? baselines.get(previous.id) : undefined
      const storedUsage = previous
        ? tx
            .select()
            .from(sessionModelUsage)
            .where(eq(sessionModelUsage.sessionId, previous.id))
            .all()
        : []
      const modelUsage = d.modelUsage ?? []
      // A legacy transcript may only contain a surviving suffix. Do not replace
      // its saved aggregates with a smaller, incomplete reconstruction.
      if (
        previous &&
        !baseline &&
        (previous.promptCount > d.promptCount ||
          previous.inputTokens > d.inputTokens ||
          previous.outputTokens > d.outputTokens ||
          storedUsage.some((row) => {
            const usage = modelUsage.find((u) => u.model === row.model)
            return (
              !usage ||
              row.inputTokens > usage.inputTokens ||
              row.outputTokens > usage.outputTokens ||
              row.cacheCreationInputTokens > usage.cacheCreationInputTokens ||
              row.cacheReadInputTokens > usage.cacheReadInputTokens
            )
          }))
      ) {
        throw new SessionReconciliationError(
          `Legacy session reconciliation needs review for ${sourceFile}. Saved totals exceed retained activity; history was preserved.`
        )
      }
      const measured = {
        startedAt: d.startedAt,
        endedAt: d.endedAt,
        durationMinutes: d.durationMinutes
      }
      let id: number
      if (previous) {
        const savedOverrides = tx
          .select()
          .from(sessionTimeOverrides)
          .where(eq(sessionTimeOverrides.sessionId, previous.id))
          .get()
        // Preserve inferred pre-migration edits too. Once inferred, intent must
        // survive later equality with the moving detector baseline.
        const reference = baseline ?? measured
        const overrides = {
          startedAt:
            savedOverrides?.startedAt || Number(previous.startedAt !== reference.startedAt),
          endedAt: savedOverrides?.endedAt || Number(previous.endedAt !== reference.endedAt),
          durationMinutes:
            savedOverrides?.durationMinutes ||
            Number(previous.durationMinutes !== reference.durationMinutes)
        }
        tx.insert(sessionTimeOverrides)
          .values({ sessionId: previous.id, ...overrides })
          .onConflictDoUpdate({ target: sessionTimeOverrides.sessionId, set: overrides })
          .run()
        // Legacy rows have no trustworthy baseline: retain their saved times.
        // Once mapped, only fields without explicit/inferred overrides advance.
        const updates = {
          startedAt: baseline && !overrides.startedAt ? d.startedAt : previous.startedAt,
          endedAt: baseline && !overrides.endedAt ? d.endedAt : previous.endedAt,
          durationMinutes:
            baseline && !overrides.durationMinutes ? d.durationMinutes : previous.durationMinutes,
          promptCount: d.promptCount,
          inputTokens: d.inputTokens,
          outputTokens: d.outputTokens
        }
        id = previous.id
        if (
          Object.entries(updates).some(
            ([key, value]) => previous[key as keyof typeof updates] !== value
          )
        ) {
          tx.update(sessions)
            .set({ ...updates, updatedAt: new Date().toISOString() })
            .where(eq(sessions.id, id))
            .run()
        }
      } else {
        id = tx
          .insert(sessions)
          .values({
            ...measured,
            projectPath: d.projectPath,
            source: 'auto',
            status: 'completed',
            tool: d.tool,
            claudeSessionId: d.claudeSessionId,
            promptCount: d.promptCount,
            inputTokens: d.inputTokens,
            outputTokens: d.outputTokens,
            sourceFile: d.sourceFile
          })
          .returning({ id: sessions.id })
          .get().id
      }
      tx.insert(sessionDerivations)
        .values({ sessionId: id, ...measured })
        .onConflictDoUpdate({ target: sessionDerivations.sessionId, set: measured })
        .run()
      if (
        storedUsage.length !== modelUsage.length ||
        modelUsage.some(
          (usage) =>
            !storedUsage.some(
              (row) =>
                row.model === usage.model &&
                row.inputTokens === usage.inputTokens &&
                row.outputTokens === usage.outputTokens &&
                row.cacheCreationInputTokens === usage.cacheCreationInputTokens &&
                row.cacheReadInputTokens === usage.cacheReadInputTokens
            )
        )
      ) {
        tx.delete(sessionModelUsage).where(eq(sessionModelUsage.sessionId, id)).run()
        insertModelUsage(tx, id, d)
      }
    }
  }
  return activeCount
}

/** Insert per-model usage rows for a freshly inserted session. */
function insertModelUsage(
  tx: Pick<ReturnType<typeof getDb>, 'insert'>,
  sessionId: number,
  d: DetectedSession
): void {
  if (!d.modelUsage || d.modelUsage.length === 0) return
  tx.insert(sessionModelUsage)
    .values(
      d.modelUsage.map((u) => ({
        sessionId,
        model: u.model,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheCreationInputTokens: u.cacheCreationInputTokens,
        cacheReadInputTokens: u.cacheReadInputTokens
      }))
    )
    .run()
}

/** Refresh a re-parsed null-uuid row's mutable fields (mirrors the uuid upsert). */
function updateNullUuidRow(
  tx: Pick<ReturnType<typeof getDb>, 'update'>,
  sourceFile: string,
  msg: ParsedMessage
): void {
  tx.update(rawMessages)
    .set({
      model: msg.model,
      inputTokens: msg.usage?.inputTokens ?? 0,
      outputTokens: msg.usage?.outputTokens ?? 0,
      cacheCreationInputTokens: msg.usage?.cacheCreationInputTokens ?? 0,
      cacheReadInputTokens: msg.usage?.cacheReadInputTokens ?? 0,
      isToolResult: msg.isToolResult ? 1 : 0,
      hasToolUse: msg.hasToolUse ? 1 : 0,
      toolNames: msg.toolNames.length > 0 ? JSON.stringify(msg.toolNames) : null
    })
    .where(
      and(
        eq(rawMessages.sourceFile, sourceFile),
        eq(rawMessages.timestamp, msg.timestamp),
        eq(rawMessages.type, msg.type),
        msg.parentUuid
          ? eq(rawMessages.parentUuid, msg.parentUuid)
          : isNull(rawMessages.parentUuid),
        isNull(rawMessages.uuid)
      )
    )
    .run()
}

/**
 * Store raw messages and progress events in DB with dedup.
 */
async function storeRawMessages(
  parsedSessions: ParsedSessionData[],
  persistOffsets = true
): Promise<void> {
  const db = getDb()

  const nullKey = (sf: string, ts: string, type: string, parentUuid: string | null): string =>
    `${sf}\u0000${ts}\u0000${type}\u0000${parentUuid ?? ''}`

  for (const parsed of parsedSessions) {
    // Yield outside the transaction; evidence and raw messages still commit together.
    await yieldToMainLoop()
    // Null-uuid dedup: preload the existing keys for the affected files once,
    // instead of running a SELECT per message inside the transaction.
    const subFileOf = (msg: ParsedMessage): string =>
      (msg as ParsedMessage & { sourceFile?: string }).sourceFile || parsed.sourceFile
    const nullUuidFiles = new Set<string>()
    for (const msg of parsed.messages) if (!msg.uuid) nullUuidFiles.add(parsed.sourceFile)
    for (const msg of parsed.subagentMessages ?? [])
      if (!msg.uuid) nullUuidFiles.add(subFileOf(msg))
    const existingNullKeys = new Set<string>()
    if (nullUuidFiles.size > 0) {
      const rows = db
        .select({
          sourceFile: rawMessages.sourceFile,
          timestamp: rawMessages.timestamp,
          type: rawMessages.type,
          parentUuid: rawMessages.parentUuid
        })
        .from(rawMessages)
        .where(and(inArray(rawMessages.sourceFile, [...nullUuidFiles]), isNull(rawMessages.uuid)))
        .all()
      for (const r of rows)
        existingNullKeys.add(nullKey(r.sourceFile, r.timestamp, r.type, r.parentUuid))
    }

    db.transaction((tx) => {
      const now = new Date().toISOString()
      const projectPathEncoded = parsed.projectPathEncoded

      storeActivityEvidence(tx, parsed, now)

      // Store main messages
      for (const msg of parsed.messages) {
        if (msg.uuid) {
          // Upsert on the partial unique index (source_file, uuid) WHERE uuid IS
          // NOT NULL. Sessions are now detected from these rows rather than the
          // fresh parse, so a re-parsed message must refresh its stored values
          // (some providers rewrite messages in place, e.g. usage totals).
          tx.run(
            sql`INSERT INTO raw_messages (source_file, claude_session_id, type, timestamp, cwd, git_branch, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, uuid, parent_uuid, is_tool_result, has_tool_use, tool_names, is_subagent, project_path_encoded, created_at) VALUES (${parsed.sourceFile}, ${msg.sessionId || null}, ${msg.type}, ${msg.timestamp}, ${msg.cwd}, ${msg.gitBranch}, ${msg.model}, ${msg.usage?.inputTokens ?? 0}, ${msg.usage?.outputTokens ?? 0}, ${msg.usage?.cacheCreationInputTokens ?? 0}, ${msg.usage?.cacheReadInputTokens ?? 0}, ${msg.uuid}, ${msg.parentUuid}, ${msg.isToolResult ? 1 : 0}, ${msg.hasToolUse ? 1 : 0}, ${msg.toolNames.length > 0 ? JSON.stringify(msg.toolNames) : null}, ${0}, ${projectPathEncoded}, ${now}) ON CONFLICT(source_file, uuid) WHERE uuid IS NOT NULL DO UPDATE SET timestamp=excluded.timestamp, model=excluded.model, input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens, cache_creation_input_tokens=excluded.cache_creation_input_tokens, cache_read_input_tokens=excluded.cache_read_input_tokens, tool_names=excluded.tool_names, has_tool_use=excluded.has_tool_use, is_tool_result=excluded.is_tool_result`
          )
        } else {
          // Null-uuid: dedup on (sourceFile, timestamp, type, parentUuid) via
          // preloaded keys; refresh usage on a re-parsed match (see uuid upsert)
          const key = nullKey(parsed.sourceFile, msg.timestamp, msg.type, msg.parentUuid)
          if (existingNullKeys.has(key)) {
            updateNullUuidRow(tx, parsed.sourceFile, msg)
          } else {
            existingNullKeys.add(key)
            tx.insert(rawMessages)
              .values({
                sourceFile: parsed.sourceFile,
                claudeSessionId: msg.sessionId || null,
                type: msg.type,
                timestamp: msg.timestamp,
                cwd: msg.cwd,
                gitBranch: msg.gitBranch,
                model: msg.model,
                inputTokens: msg.usage?.inputTokens ?? 0,
                outputTokens: msg.usage?.outputTokens ?? 0,
                cacheCreationInputTokens: msg.usage?.cacheCreationInputTokens ?? 0,
                cacheReadInputTokens: msg.usage?.cacheReadInputTokens ?? 0,
                uuid: null,
                parentUuid: msg.parentUuid,
                isToolResult: msg.isToolResult ? 1 : 0,
                hasToolUse: msg.hasToolUse ? 1 : 0,
                toolNames: msg.toolNames.length > 0 ? JSON.stringify(msg.toolNames) : null,
                isSubagent: 0,
                projectPathEncoded,
                createdAt: now
              })
              .run()
          }
        }
      }

      // Store subagent messages
      for (const msg of parsed.subagentMessages ?? []) {
        const subSourceFile =
          (msg as ParsedMessage & { sourceFile?: string }).sourceFile || parsed.sourceFile

        if (msg.uuid) {
          tx.run(
            sql`INSERT INTO raw_messages (source_file, claude_session_id, type, timestamp, cwd, git_branch, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, uuid, parent_uuid, is_tool_result, has_tool_use, tool_names, is_subagent, project_path_encoded, created_at) VALUES (${subSourceFile}, ${msg.sessionId || null}, ${msg.type}, ${msg.timestamp}, ${msg.cwd}, ${msg.gitBranch}, ${msg.model}, ${msg.usage?.inputTokens ?? 0}, ${msg.usage?.outputTokens ?? 0}, ${msg.usage?.cacheCreationInputTokens ?? 0}, ${msg.usage?.cacheReadInputTokens ?? 0}, ${msg.uuid}, ${msg.parentUuid}, ${msg.isToolResult ? 1 : 0}, ${msg.hasToolUse ? 1 : 0}, ${msg.toolNames.length > 0 ? JSON.stringify(msg.toolNames) : null}, ${1}, ${projectPathEncoded}, ${now}) ON CONFLICT(source_file, uuid) WHERE uuid IS NOT NULL DO UPDATE SET timestamp=excluded.timestamp, model=excluded.model, input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens, cache_creation_input_tokens=excluded.cache_creation_input_tokens, cache_read_input_tokens=excluded.cache_read_input_tokens, tool_names=excluded.tool_names, has_tool_use=excluded.has_tool_use, is_tool_result=excluded.is_tool_result`
          )
        } else {
          const key = nullKey(subSourceFile, msg.timestamp, msg.type, msg.parentUuid)
          if (existingNullKeys.has(key)) {
            updateNullUuidRow(tx, subSourceFile, msg)
          } else {
            existingNullKeys.add(key)
            tx.insert(rawMessages)
              .values({
                sourceFile: subSourceFile,
                claudeSessionId: msg.sessionId || null,
                type: msg.type,
                timestamp: msg.timestamp,
                cwd: msg.cwd,
                gitBranch: msg.gitBranch,
                model: msg.model,
                inputTokens: msg.usage?.inputTokens ?? 0,
                outputTokens: msg.usage?.outputTokens ?? 0,
                cacheCreationInputTokens: msg.usage?.cacheCreationInputTokens ?? 0,
                cacheReadInputTokens: msg.usage?.cacheReadInputTokens ?? 0,
                uuid: null,
                parentUuid: msg.parentUuid,
                isToolResult: msg.isToolResult ? 1 : 0,
                hasToolUse: msg.hasToolUse ? 1 : 0,
                toolNames: msg.toolNames.length > 0 ? JSON.stringify(msg.toolNames) : null,
                isSubagent: 1,
                projectPathEncoded,
                createdAt: now
              })
              .run()
          }
        }
      }

      // Store main progress events (ON CONFLICT DO NOTHING via unique index)
      for (const ts of parsed.progressTimestamps) {
        tx.run(
          sql`INSERT OR IGNORE INTO progress_events (source_file, timestamp, is_subagent) VALUES (${parsed.sourceFile}, ${ts}, ${0})`
        )
      }

      // Store subagent progress events
      for (const ts of parsed.subagentProgressTimestamps ?? []) {
        tx.run(
          sql`INSERT OR IGNORE INTO progress_events (source_file, timestamp, is_subagent) VALUES (${parsed.sourceFile}, ${ts}, ${1})`
        )
      }
    })

    // Normal scans commit offsets with reconciliation; backfill persists here.
    if (!persistOffsets) continue

    // Persist consumed byte offsets (main + subagent files) so the next scan
    // parses only appended data. Parsers without incremental support report no
    // fileOffsets — fall back to the stat size for the main file, as before.
    const offsetEntries: [string, number][] = parsed.fileOffsets
      ? Object.entries(parsed.fileOffsets)
      : []
    if (offsetEntries.length === 0) {
      try {
        const fileStat = await stat(parsed.sourceFile)
        offsetEntries.push([parsed.sourceFile, fileStat.size])
      } catch {
        // File may not exist (e.g., in tests)
      }
    }
    const scanNow = new Date().toISOString()
    for (const [filePath, consumed] of offsetEntries) {
      if (typeof consumed !== 'number') continue
      db.insert(scanState)
        .values({
          filePath,
          lastModifiedAt: scanNow,
          lastScannedAt: scanNow,
          sessionCount: 0,
          lastFileSize: consumed
        })
        .onConflictDoUpdate({
          target: scanState.filePath,
          set: { lastFileSize: consumed }
        })
        .run()
    }
  }
}

/**
 * Filter files to only those that are new or modified since last scan.
 * Also detects compaction (file size shrinks) and includes those files.
 *
 * `offsets` carries every known consumed byte offset from scan_state (main AND
 * subagent files) so parsers can read only appended data. A compacted file's
 * offset is forced to 0 — the file was rewritten, so a full re-parse is needed
 * (raw-message dedup absorbs the overlap).
 */
async function filterChangedFiles(filePaths: string[]): Promise<{
  files: string[]
  mtimes: Map<string, string>
  fileSizes: Map<string, number>
  offsets: Record<string, number>
}> {
  const db = getDb()
  const files: string[] = []
  const mtimes = new Map<string, string>()
  const fileSizes = new Map<string, number>()

  // One query for all scan_state rows instead of one per discovered file
  const records = new Map(
    db
      .select()
      .from(scanState)
      .all()
      .map((r) => [r.filePath, r] as const)
  )
  const offsets: Record<string, number> = {}
  for (const [filePath, r] of records) offsets[filePath] = r.lastFileSize

  for (const filePath of filePaths) {
    try {
      const fileStat = await stat(filePath)
      const mtime = fileStat.mtime.toISOString()

      const record = records.get(filePath)

      const isNew = !record
      const isModified = record && mtime > record.lastScannedAt
      // Windows can keep mtime unchanged while an open transcript keeps growing.
      const hasAppendedBytes = record && fileStat.size > record.lastFileSize
      const isCompacted = record && fileStat.size < record.lastFileSize

      if (isNew || isModified || hasAppendedBytes || isCompacted) {
        if (isCompacted) {
          log.info(
            `Compaction detected for ${filePath}: ${record!.lastFileSize} → ${fileStat.size}`
          )
          offsets[filePath] = 0
        }
        files.push(filePath)
        mtimes.set(filePath, mtime)
        fileSizes.set(filePath, fileStat.size)
      }
    } catch (err) {
      log.warn(`Cannot stat file ${filePath}, skipping:`, err)
    }
  }

  return { files, mtimes, fileSizes, offsets }
}
