import { stat } from 'node:fs/promises'
import { join, basename, dirname } from 'node:path'
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
import { aiSummaries } from '../db/schema/ai-summaries'
import { gitCommits } from '../db/schema/git-commits'
import { rawMessages } from '../db/schema/raw-messages'
import { progressEvents } from '../db/schema/raw-messages'
import { sessionModelUsage } from '../db/schema/session-model-usage'
import { invoiceLineItems } from '../db/schema/invoices'
import { settingsService } from './settings-service'
import { clientProjectService } from './client-project-service'
import { detectSessionsFromMultiple } from './session-detector'
import { parseSessionFiles } from './parse-orchestrator'
import { enabledProviders, providerForFile, providerRegistry } from '../providers'
import { isExcludedProjectDir, isExcludedProjectPath } from '../../shared/paths'
import { isProviderEnabled } from './provider-tracking'
import type {
  SessionFilters,
  ScanResult,
  PromptTiming,
  UpdateSession,
  GapAnalysis,
  TimeBreakdownDay,
  DetectedSession,
  ModelUsageAggregate,
  ModelUsageFilters,
  SessionTool
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
 * Remove a provider's auto-detected sessions (used when its tracking toggle is
 * turned off, so already-imported history disappears too). Raw messages stay,
 * so re-enabling and rescanning rebuilds the sessions.
 */
function purgeSessionsForTool(db: ReturnType<typeof getDb>, tool: SessionTool): void {
  // Drop this tool's scan_state too, so re-enabling the provider re-scans its
  // files from disk. Without this a plain background scan sees no size/mtime
  // change on the (unchanged) files and never re-detects — restoration would
  // depend entirely on a rebuild happening to run. Raw messages stay, so a
  // rebuild still recovers any files the CLI has since pruned.
  const staleScan = db
    .select({ filePath: scanState.filePath })
    .from(scanState)
    .all()
    .filter((r) => providerForFile(r.filePath).id === tool)
    .map((r) => r.filePath)
  if (staleScan.length > 0) {
    db.delete(scanState).where(inArray(scanState.filePath, staleScan)).run()
  }

  const ids = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.source, 'auto'), eq(sessions.tool, tool)))
    .all()
    .map((r) => r.id)
  if (ids.length === 0) return

  db.transaction((tx) => {
    tx.delete(aiSummaries).where(inArray(aiSummaries.sessionId, ids)).run()
    tx.delete(sessionModelUsage).where(inArray(sessionModelUsage.sessionId, ids)).run()
    tx.update(gitCommits).set({ sessionId: null }).where(inArray(gitCommits.sessionId, ids)).run()
    tx.delete(sessions).where(inArray(sessions.id, ids)).run()
  })
  log.info(`Purged ${ids.length} ${tool} sessions (tracking disabled)`)
}

/**
 * Purge auto sessions for every provider whose tracking is currently off.
 * Iterates the provider registry (the single source of truth for which
 * providers exist) so a newly-added provider is purged and discovered from the
 * same list — no parallel hand-synced array to drift out of sync.
 */
function purgeDisabledProviders(db: ReturnType<typeof getDb>): void {
  for (const p of providerRegistry) {
    if (!isProviderEnabled(p.id)) purgeSessionsForTool(db, p.id)
  }
}

/**
 * Delete lingering auto sessions from excluded directories (rows created
 * before an exclusion rule existed — e.g. piped scratch dirs, worktrees).
 * Spared: manual sessions, sessions the user described, and sessions already
 * on an invoice line item (the audit trail behind billed amounts).
 * Exported for tests; production callers go through scanSessions.
 */
export function purgeExcludedSessions(db: ReturnType<typeof getDb>): void {
  // invoice-service stores session_ids comma-separated (item.sessionIds.join(',')).
  // A malformed value fails CLOSED — better to leave stale rows than purge a
  // session that may be backing a billed invoice amount.
  const invoicedIds = new Set<number>()
  for (const r of db
    .select({ sessionIds: invoiceLineItems.sessionIds })
    .from(invoiceLineItems)
    .all()) {
    if (!r.sessionIds) continue
    const parsed = r.sessionIds.split(',').map(Number)
    if (parsed.some((n) => !Number.isFinite(n))) {
      log.error(`Skipping excluded-session purge: malformed invoice session_ids "${r.sessionIds}"`)
      return
    }
    parsed.forEach((n) => invoicedIds.add(n))
  }

  const stale = db
    .select({ id: sessions.id, projectPath: sessions.projectPath, sourceFile: sessions.sourceFile })
    .from(sessions)
    .where(and(eq(sessions.source, 'auto'), isNull(sessions.description)))
    .all()
    .filter((r) => isExcludedProjectPath(r.projectPath) && !invoicedIds.has(r.id))
  if (stale.length === 0) return

  const ids = stale.map((r) => r.id)
  const sourceFiles = [...new Set(stale.map((r) => r.sourceFile).filter((f): f is string => !!f))]

  db.transaction((tx) => {
    tx.delete(aiSummaries).where(inArray(aiSummaries.sessionId, ids)).run()
    tx.delete(sessionModelUsage).where(inArray(sessionModelUsage.sessionId, ids)).run()
    tx.update(gitCommits).set({ sessionId: null }).where(inArray(gitCommits.sessionId, ids)).run()
    tx.delete(sessions).where(inArray(sessions.id, ids)).run()

    // Excluded files are never rescanned, so their scan_state / raw content
    // would otherwise linger forever. Only drop file-level rows once no
    // session (spared or otherwise) references the file anymore.
    for (const sf of sourceFiles) {
      const remaining = tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.sourceFile, sf))
        .all()
      if (remaining.length > 0) continue
      tx.delete(scanState).where(eq(scanState.filePath, sf)).run()
      tx.delete(rawMessages).where(eq(rawMessages.sourceFile, sf)).run()
      tx.delete(progressEvents).where(eq(progressEvents.sourceFile, sf)).run()
    }
  })
  log.info(`Purged ${ids.length} sessions from excluded directories`)
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

  const allRawMessages = db
    .select()
    .from(rawMessages)
    .where(fileList ? inArray(rawMessages.sourceFile, fileList) : undefined)
    .orderBy(rawMessages.sourceFile, rawMessages.timestamp)
    .all()
  const allProgressEvents = db
    .select()
    .from(progressEvents)
    .where(fileList ? inArray(progressEvents.sourceFile, fileList) : undefined)
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
    // Skip piped-swarm worktree dirs so a rebuild also purges any already-stored pipe sessions
    if (isExcludedProjectDir(projectPathEncoded)) continue
    // Honor the per-provider tracking toggle on rebuild too — raw messages stay, sessions don't
    if (!isProviderEnabled(providerForFile(sourceFile).id)) continue
    const projectDirectory = msgs.find((m) => m.cwd)?.cwd || null
    if (projectDirectory && isExcludedProjectPath(projectDirectory)) continue

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
    const sessionDir = join(dirname(sourceFile), sessionId, 'subagents')
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
 * SessionService orchestrates: discover → filter → parse → store raw → detect → store sessions.
 * All database operations use batch inserts in transactions (NFR18, NFR20).
 */
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

    const idleTimeoutStr = settingsService.getSetting('idle_timeout_minutes')
    const parsed = idleTimeoutStr ? parseInt(idleTimeoutStr, 10) : NaN
    const idleTimeoutMinutes = Number.isNaN(parsed) ? DEFAULT_IDLE_TIMEOUT_MINUTES : parsed

    log.info(`Starting session scan (idle timeout: ${idleTimeoutMinutes}min)`)

    // 1. Discover session files from every enabled provider (optionally filtered)
    const perProvider = await discoverFilesByProvider(claudeDir, projectFilter)
    purgeDisabledProviders(getDb())
    purgeExcludedSessions(getDb())
    const purgedProjects = clientProjectService.purgeExcludedProjects()
    if (purgedProjects > 0) log.info(`Purged ${purgedProjects} excluded auto-created project(s)`)
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
      const durationMs = Date.now() - startTime
      log.info(`Scan complete (no changes) in ${durationMs}ms`)
      return {
        newSessions: 0,
        updatedFiles: 0,
        totalFiles: allFiles.length,
        durationMs,
        attributedCount: 0
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
    await storeRawMessages(parsedSessions)

    // 5. Detect sessions from the full per-file history in raw_messages (the
    // freshly stored tail plus everything already known for these files)
    const reconstructed = reconstructParsedFromRaw(db, {
      mainFiles: parsedSessions.map((p) => p.sourceFile),
      subFiles: parsedSessions.flatMap((p) =>
        Object.keys(p.fileOffsets ?? {}).filter((f) => f !== p.sourceFile)
      )
    })
    const detected = detectSessionsFromMultiple(reconstructed, idleTimeoutMinutes)
    log.info(`Detected ${detected.length} sessions from ${parsedSessions.length} parsed files`)

    // 6. Store in DB — batch operations in a transaction
    const sourceFiles = [...new Set(filesToProcess)]

    db.transaction((tx) => {
      // Delete stale auto sessions for re-scanned files
      // Must first remove FK references from ai_summaries and git_commits
      if (sourceFiles.length > 0) {
        for (const sf of sourceFiles) {
          const staleIds = tx
            .select({ id: sessions.id })
            .from(sessions)
            .where(and(eq(sessions.source, 'auto'), eq(sessions.sourceFile, sf)))
            .all()
            .map((r) => r.id)

          if (staleIds.length > 0) {
            tx.delete(aiSummaries).where(inArray(aiSummaries.sessionId, staleIds)).run()
            tx.delete(sessionModelUsage).where(inArray(sessionModelUsage.sessionId, staleIds)).run()
            tx.update(gitCommits)
              .set({ sessionId: null })
              .where(inArray(gitCommits.sessionId, staleIds))
              .run()
            tx.delete(sessions)
              .where(and(eq(sessions.source, 'auto'), eq(sessions.sourceFile, sf)))
              .run()
          }
        }
      }

      // Insert detected sessions (per-row to capture ids for model usage rows)
      if (detected.length > 0) {
        const now = new Date().toISOString()
        for (const d of detected) {
          const inserted = tx
            .insert(sessions)
            .values({
              projectPath: d.projectPath,
              startedAt: d.startedAt,
              endedAt: d.endedAt,
              durationMinutes: d.durationMinutes,
              source: 'auto' as const,
              status: 'completed' as const,
              tool: d.tool,
              claudeSessionId: d.claudeSessionId,
              promptCount: d.promptCount,
              inputTokens: d.inputTokens,
              outputTokens: d.outputTokens,
              sourceFile: d.sourceFile,
              createdAt: now,
              updatedAt: now
            })
            .returning({ id: sessions.id })
            .get()
          insertModelUsage(tx, inserted.id, d)
        }
      }

      // Update scan_state records. lastFileSize records the CONSUMED byte
      // offset (through the last complete line) when the parser reports one —
      // that's the resume point for the next incremental parse. Stat size is
      // the fallback for parsers without incremental support.
      const consumedByFile = new Map<string, number>()
      for (const p of parsedSessions) {
        const consumed = p.fileOffsets?.[p.sourceFile]
        if (consumed != null) consumedByFile.set(p.sourceFile, consumed)
      }
      const scanNow = new Date().toISOString()
      for (const filePath of filesToProcess) {
        const fileMtime = mtimes.get(filePath) ?? scanNow
        const sessionCount = detected.filter((d) => d.sourceFile === filePath).length
        const fileSize = consumedByFile.get(filePath) ?? fileSizes.get(filePath) ?? 0
        tx.insert(scanState)
          .values({
            filePath,
            lastModifiedAt: fileMtime,
            lastScannedAt: scanNow,
            sessionCount,
            lastFileSize: fileSize
          })
          .onConflictDoUpdate({
            target: scanState.filePath,
            set: {
              lastModifiedAt: fileMtime,
              lastScannedAt: scanNow,
              sessionCount,
              lastFileSize: fileSize
            }
          })
          .run()
      }
    })

    // 7. Update global last scan timestamp
    settingsService.setSetting('last_scan_at', new Date().toISOString())

    const durationMs = Date.now() - startTime
    log.info(
      `Scan complete: ${detected.length} sessions from ${filesToProcess.length} files in ${durationMs}ms`
    )

    return {
      newSessions: detected.length,
      updatedFiles: filesToProcess.length,
      totalFiles: allFiles.length,
      durationMs,
      attributedCount: 0
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

  _doRebuild(): ScanResult {
    const startTime = Date.now()
    const db = getDb()

    const idleTimeoutStr = settingsService.getSetting('idle_timeout_minutes')
    const parsedTimeout = idleTimeoutStr ? parseInt(idleTimeoutStr, 10) : NaN
    const idleTimeoutMinutes = Number.isNaN(parsedTimeout)
      ? DEFAULT_IDLE_TIMEOUT_MINUTES
      : parsedTimeout

    log.info(`Rebuilding sessions from raw messages (idle timeout: ${idleTimeoutMinutes}min)`)

    const reconstructed = reconstructParsedFromRaw(db)

    if (reconstructed.length === 0) {
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
    const detected = detectSessionsFromMultiple(reconstructed, idleTimeoutMinutes)
    log.info(`Rebuild detected ${detected.length} sessions from ${reconstructed.length} files`)
    // 5. Preserve user edits from existing auto sessions
    const existingAuto = db.select().from(sessions).where(eq(sessions.source, 'auto')).all()
    const editsMap = new Map<
      string,
      { projectId: number | null; clientId: number | null; description: string | null }
    >()
    for (const s of existingAuto) {
      if (s.projectId != null || s.clientId != null || s.description != null) {
        const key = `${s.claudeSessionId}|${s.startedAt}`
        editsMap.set(key, {
          projectId: s.projectId,
          clientId: s.clientId,
          description: s.description
        })
      }
    }

    // 6. Replace auto sessions in a transaction
    const autoIds = existingAuto.map((s) => s.id)

    db.transaction((tx) => {
      if (autoIds.length > 0) {
        // FK cleanup before deleting auto sessions
        tx.delete(aiSummaries).where(inArray(aiSummaries.sessionId, autoIds)).run()
        tx.delete(sessionModelUsage).where(inArray(sessionModelUsage.sessionId, autoIds)).run()
        tx.update(gitCommits)
          .set({ sessionId: null })
          .where(inArray(gitCommits.sessionId, autoIds))
          .run()
        tx.delete(sessions).where(eq(sessions.source, 'auto')).run()
      }

      if (detected.length > 0) {
        const now = new Date().toISOString()
        for (const d of detected) {
          const key = `${d.claudeSessionId}|${d.startedAt}`
          const edits = editsMap.get(key)
          const inserted = tx
            .insert(sessions)
            .values({
              projectPath: d.projectPath,
              startedAt: d.startedAt,
              endedAt: d.endedAt,
              durationMinutes: d.durationMinutes,
              source: 'auto' as const,
              status: 'completed' as const,
              tool: d.tool,
              claudeSessionId: d.claudeSessionId,
              promptCount: d.promptCount,
              inputTokens: d.inputTokens,
              outputTokens: d.outputTokens,
              sourceFile: d.sourceFile,
              projectId: edits?.projectId ?? null,
              clientId: edits?.clientId ?? null,
              description: edits?.description ?? null,
              createdAt: now,
              updatedAt: now
            })
            .returning({ id: sessions.id })
            .get()
          insertModelUsage(tx, inserted.id, d)
        }
      }
    })

    const durationMs = Date.now() - startTime
    log.info(`Rebuild complete: ${detected.length} sessions in ${durationMs}ms`)

    return {
      newSessions: detected.length,
      updatedFiles: 0,
      totalFiles: reconstructed.length,
      durationMs,
      attributedCount: 0
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

    // Synthesize records for compacted files (existing DB sessions with no raw_messages)
    const existingAutoSessions = db.select().from(sessions).where(eq(sessions.source, 'auto')).all()
    const filesWithRaw = new Set(
      db
        .select({ sf: rawMessages.sourceFile })
        .from(rawMessages)
        .all()
        .map((r) => r.sf)
    )

    const compactedSessions = existingAutoSessions.filter(
      (s) => s.sourceFile && !filesWithRaw.has(s.sourceFile)
    )

    if (compactedSessions.length > 0) {
      log.info(`Backfill: synthesizing records for ${compactedSessions.length} compacted sessions`)
      const now = new Date().toISOString()

      db.transaction((tx) => {
        for (let i = 0; i < compactedSessions.length; i++) {
          const s = compactedSessions[i]
          if (!s.sourceFile) continue

          const projectPathEncoded = basename(dirname(s.sourceFile))
          const inputTokensUser = Math.round(s.inputTokens * 0.7)
          const inputTokensAssistant = s.inputTokens - inputTokensUser
          const outputTokensUser = 0
          const outputTokensAssistant = s.outputTokens

          // Synthesize user message at startedAt
          tx.insert(rawMessages)
            .values({
              sourceFile: s.sourceFile,
              claudeSessionId: s.claudeSessionId,
              type: 'user',
              timestamp: s.startedAt,
              inputTokens: inputTokensUser,
              outputTokens: outputTokensUser,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
              isSubagent: 0,
              projectPathEncoded,
              isToolResult: 0,
              hasToolUse: 0,
              createdAt: now
            })
            .run()

          // Synthesize assistant message at endedAt (with ms offset to avoid collisions)
          const endDate = new Date(s.endedAt)
          endDate.setMilliseconds(endDate.getMilliseconds() + i)
          tx.insert(rawMessages)
            .values({
              sourceFile: s.sourceFile,
              claudeSessionId: s.claudeSessionId,
              type: 'assistant',
              timestamp: endDate.toISOString(),
              inputTokens: inputTokensAssistant,
              outputTokens: outputTokensAssistant,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
              isSubagent: 0,
              projectPathEncoded,
              isToolResult: 0,
              hasToolUse: 0,
              createdAt: now
            })
            .run()
        }
      })
    }

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
    const conditions: SQL[] = []

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
      conditions.push(lte(sessions.endedAt, filters.endDate))
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

    if (conditions.length === 0) {
      return db.select().from(sessions).orderBy(sessions.startedAt).all()
    }

    return db
      .select()
      .from(sessions)
      .where(and(...conditions))
      .orderBy(sessions.startedAt)
      .all()
  },

  /**
   * Get a single session by ID.
   */
  getSessionById(id: number) {
    const db = getDb()
    return db.select().from(sessions).where(eq(sessions.id, id)).get() ?? null
  },

  /**
   * Update a session's fields (time, project, description).
   */
  updateSession(id: number, data: UpdateSession) {
    const db = getDb()
    const existing = db.select().from(sessions).where(eq(sessions.id, id)).get()
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

    db.update(sessions).set(updates).where(eq(sessions.id, id)).run()

    return db.select().from(sessions).where(eq(sessions.id, id)).get()!
  },

  /**
   * Delete a session by ID.
   */
  deleteSession(id: number) {
    const db = getDb()
    const existing = db.select().from(sessions).where(eq(sessions.id, id)).get()
    if (!existing) {
      throw new Error(`Session ${id} not found`)
    }

    // FK cleanup before delete
    db.delete(aiSummaries).where(eq(aiSummaries.sessionId, id)).run()
    db.delete(sessionModelUsage).where(eq(sessionModelUsage.sessionId, id)).run()
    db.update(gitCommits).set({ sessionId: null }).where(eq(gitCommits.sessionId, id)).run()
    db.delete(sessions).where(eq(sessions.id, id)).run()
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
    db.insert(sessions)
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
      .run()

    // Return the newly created session
    return db.select().from(sessions).orderBy(sessions.id).all().pop()!
  },

  /**
   * Split a session into two at the given split point.
   * Returns both new sessions. The original is deleted.
   */
  splitSession(
    id: number,
    splitAt: string
  ): [typeof sessions.$inferSelect, typeof sessions.$inferSelect] {
    const db = getDb()
    const existing = db.select().from(sessions).where(eq(sessions.id, id)).get()
    if (!existing) {
      throw new Error(`Session ${id} not found`)
    }

    const startMs = new Date(existing.startedAt).getTime()
    const endMs = new Date(existing.endedAt).getTime()
    const splitMs = new Date(splitAt).getTime()

    if (splitMs <= startMs || splitMs >= endMs) {
      throw new Error('Split point must be between session start and end')
    }

    const now = new Date().toISOString()
    const dur1 = Math.round((splitMs - startMs) / 60_000)
    const dur2 = Math.round((endMs - splitMs) / 60_000)

    // Estimate prompt and token split proportionally
    const ratio = (splitMs - startMs) / (endMs - startMs)
    const prompts1 = Math.round(existing.promptCount * ratio)
    const prompts2 = existing.promptCount - prompts1
    const inputTokens1 = Math.round(existing.inputTokens * ratio)
    const inputTokens2 = existing.inputTokens - inputTokens1
    const outputTokens1 = Math.round(existing.outputTokens * ratio)
    const outputTokens2 = existing.outputTokens - outputTokens1

    // Existing per-model usage, to be split proportionally between the halves
    const existingUsage = db
      .select()
      .from(sessionModelUsage)
      .where(eq(sessionModelUsage.sessionId, id))
      .all()

    db.transaction((tx) => {
      // FK cleanup before deleting original session
      tx.delete(aiSummaries).where(eq(aiSummaries.sessionId, id)).run()
      tx.delete(sessionModelUsage).where(eq(sessionModelUsage.sessionId, id)).run()
      tx.update(gitCommits).set({ sessionId: null }).where(eq(gitCommits.sessionId, id)).run()

      // Delete original
      tx.delete(sessions).where(eq(sessions.id, id)).run()

      // Insert two new sessions
      const first = tx
        .insert(sessions)
        .values({
          projectPath: existing.projectPath,
          startedAt: existing.startedAt,
          endedAt: splitAt,
          durationMinutes: dur1,
          source: existing.source as 'auto' | 'manual',
          description: existing.description,
          status: 'completed' as const,
          claudeSessionId: existing.claudeSessionId,
          promptCount: prompts1,
          inputTokens: inputTokens1,
          outputTokens: outputTokens1,
          sourceFile: existing.sourceFile,
          projectId: existing.projectId,
          clientId: existing.clientId,
          createdAt: now,
          updatedAt: now
        })
        .returning({ id: sessions.id })
        .get()
      const second = tx
        .insert(sessions)
        .values({
          projectPath: existing.projectPath,
          startedAt: splitAt,
          endedAt: existing.endedAt,
          durationMinutes: dur2,
          source: existing.source as 'auto' | 'manual',
          description: existing.description,
          status: 'completed' as const,
          claudeSessionId: existing.claudeSessionId,
          promptCount: prompts2,
          inputTokens: inputTokens2,
          outputTokens: outputTokens2,
          sourceFile: existing.sourceFile,
          projectId: existing.projectId,
          clientId: existing.clientId,
          createdAt: now,
          updatedAt: now
        })
        .returning({ id: sessions.id })
        .get()

      // Split per-model usage by the same time ratio as prompts/tokens
      for (const u of existingUsage) {
        const in1 = Math.round(u.inputTokens * ratio)
        const out1 = Math.round(u.outputTokens * ratio)
        const cc1 = Math.round(u.cacheCreationInputTokens * ratio)
        const cr1 = Math.round(u.cacheReadInputTokens * ratio)
        tx.insert(sessionModelUsage)
          .values([
            {
              sessionId: first.id,
              model: u.model,
              inputTokens: in1,
              outputTokens: out1,
              cacheCreationInputTokens: cc1,
              cacheReadInputTokens: cr1
            },
            {
              sessionId: second.id,
              model: u.model,
              inputTokens: u.inputTokens - in1,
              outputTokens: u.outputTokens - out1,
              cacheCreationInputTokens: u.cacheCreationInputTokens - cc1,
              cacheReadInputTokens: u.cacheReadInputTokens - cr1
            }
          ])
          .run()
      }
    })

    // Return the two new sessions (most recent inserts)
    const all = db.select().from(sessions).orderBy(sessions.id).all()
    return [all[all.length - 2], all[all.length - 1]]
  },

  /**
   * Extract prompt timings for a session.
   * Tries raw_messages DB first, falls back to JSONL file parsing.
   */
  async getPromptTimings(sessionId: number): Promise<PromptTiming[]> {
    const session = this.getSessionById(sessionId)
    if (!session?.sourceFile) return []

    const db = getDb()

    // Try DB first
    const dbMessages = db
      .select()
      .from(rawMessages)
      .where(
        and(
          eq(rawMessages.sourceFile, session.sourceFile),
          gte(rawMessages.timestamp, session.startedAt),
          lte(rawMessages.timestamp, session.endedAt),
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

    const startMs = new Date(session.startedAt).getTime()
    const endMs = new Date(session.endedAt).getTime()
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

    for (const session of sessionRows) {
      const date = session.startedAt.slice(0, 10)

      // Get messages for this session's time window and source file
      const conditions: SQL[] = [
        gte(rawMessages.timestamp, session.startedAt),
        lte(rawMessages.timestamp, session.endedAt)
      ]
      if (session.sourceFile) {
        conditions.push(eq(rawMessages.sourceFile, session.sourceFile))
      }

      const msgs = db
        .select({ timestamp: rawMessages.timestamp })
        .from(rawMessages)
        .where(and(...conditions))
        .orderBy(rawMessages.timestamp)
        .all()

      let workMin = 0
      let idleMin = 0

      if (msgs.length >= 2) {
        for (let i = 1; i < msgs.length; i++) {
          const gap =
            (new Date(msgs[i].timestamp).getTime() - new Date(msgs[i - 1].timestamp).getTime()) /
            60_000
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
    const conditions: SQL[] = []

    const excludedIds = clientProjectService.getExcludedProjectIds()
    if (excludedIds.length > 0) {
      conditions.push(or(isNull(sessions.projectId), notInArray(sessions.projectId, excludedIds))!)
    }
    if (filters?.startDate) conditions.push(gte(sessions.startedAt, filters.startDate))
    if (filters?.endDate) conditions.push(lte(sessions.endedAt, filters.endDate))
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
    const setting = settingsService.getSetting('idle_timeout_minutes')
    return setting
      ? parseInt(setting, 10) || DEFAULT_IDLE_TIMEOUT_MINUTES
      : DEFAULT_IDLE_TIMEOUT_MINUTES
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

/** Insert per-model usage rows for a freshly inserted session. */
function insertModelUsage(
  tx: Pick<ReturnType<typeof getDb>, 'insert'>,
  sessionId: number,
  d: DetectedSession
): void {
  if (!d.modelUsage || d.modelUsage.length === 0) return
  tx.insert(sessionModelUsage)
    .values(d.modelUsage.map((u) => ({ sessionId, ...u })))
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
async function storeRawMessages(parsedSessions: ParsedSessionData[]): Promise<void> {
  const db = getDb()

  const nullKey = (sf: string, ts: string, type: string, parentUuid: string | null): string =>
    `${sf}\u0000${ts}\u0000${type}\u0000${parentUuid ?? ''}`

  for (const parsed of parsedSessions) {
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
      const isCompacted = record && fileStat.size < record.lastFileSize

      if (isNew || isModified || isCompacted) {
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
