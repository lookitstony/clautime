import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, basename, dirname } from 'node:path'
import { eq, and, gte, lte, inArray, notInArray, sql, or, isNull, type SQL } from 'drizzle-orm'
import log from 'electron-log/main.js'
import { getDb } from '../db'
import { sessions } from '../db/schema/sessions'
import { scanState } from '../db/schema/scan-state'
import { aiSummaries } from '../db/schema/ai-summaries'
import { gitCommits } from '../db/schema/git-commits'
import { rawMessages } from '../db/schema/raw-messages'
import { progressEvents } from '../db/schema/raw-messages'
import { settingsService } from './settings-service'
import { clientProjectService } from './client-project-service'
import { discoverSessionFiles, parseSessionFile } from '../parsers'
import { detectSessionsFromMultiple } from './session-detector'
import type {
  SessionFilters,
  ScanResult,
  PromptTiming,
  UpdateSession,
  GapAnalysis,
  TimeBreakdownDay
} from '../../shared/types/session'
import type { ParsedSessionData, ParsedMessage, TokenUsage } from '../parsers/types'

const DEFAULT_IDLE_TIMEOUT_MINUTES = 15
const DEFAULT_CLAUDE_DIR = join(homedir(), '.claude')

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
    const dir = claudeDir ?? settingsService.getSetting('claude_dir') ?? DEFAULT_CLAUDE_DIR

    const idleTimeoutStr = settingsService.getSetting('idle_timeout_minutes')
    const parsed = idleTimeoutStr ? parseInt(idleTimeoutStr, 10) : NaN
    const idleTimeoutMinutes = Number.isNaN(parsed) ? DEFAULT_IDLE_TIMEOUT_MINUTES : parsed

    log.info(`Starting session scan in: ${dir} (idle timeout: ${idleTimeoutMinutes}min)`)

    // 1. Discover session files (optionally filtered to specific projects)
    const allFiles = await discoverSessionFiles(dir, projectFilter)
    log.info(`Discovered ${allFiles.length} total session files`)

    // Backfill raw_messages on first scan if table is empty
    await this._backfillIfNeeded(dir, projectFilter)

    // 2. Filter to only new/changed files (also collects file mtimes and sizes)
    const { files: filesToProcess, mtimes, fileSizes } = await filterChangedFiles(allFiles)
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

    // 3. Parse changed files
    const parsedSessions: ParsedSessionData[] = []
    for (const filePath of filesToProcess) {
      const p = await parseSessionFile(filePath)
      if (p) {
        parsedSessions.push(p)
      }
    }

    // 4. Store raw messages in DB (with dedup)
    await storeRawMessages(parsedSessions)

    // 5. Detect sessions from parsed data
    const detected = detectSessionsFromMultiple(parsedSessions, idleTimeoutMinutes)
    log.info(`Detected ${detected.length} sessions from ${parsedSessions.length} parsed files`)

    // 6. Store in DB — batch operations in a transaction
    const db = getDb()
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

      // Batch insert detected sessions
      if (detected.length > 0) {
        const now = new Date().toISOString()
        tx.insert(sessions)
          .values(
            detected.map((d) => ({
              projectPath: d.projectPath,
              startedAt: d.startedAt,
              endedAt: d.endedAt,
              durationMinutes: d.durationMinutes,
              source: 'auto' as const,
              status: 'completed' as const,
              claudeSessionId: d.claudeSessionId,
              promptCount: d.promptCount,
              inputTokens: d.inputTokens,
              outputTokens: d.outputTokens,
              sourceFile: d.sourceFile,
              createdAt: now,
              updatedAt: now
            }))
          )
          .run()
      }

      // Update scan_state records
      const scanNow = new Date().toISOString()
      for (const filePath of filesToProcess) {
        const fileMtime = mtimes.get(filePath) ?? scanNow
        const sessionCount = detected.filter((d) => d.sourceFile === filePath).length
        const fileSize = fileSizes.get(filePath) ?? 0
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

    // 1. Query all raw messages grouped by sourceFile
    const allRawMessages = db
      .select()
      .from(rawMessages)
      .orderBy(rawMessages.sourceFile, rawMessages.timestamp)
      .all()
    const allProgressEvents = db
      .select()
      .from(progressEvents)
      .orderBy(progressEvents.sourceFile, progressEvents.timestamp)
      .all()

    if (allRawMessages.length === 0) {
      log.info('No raw messages to rebuild from')
      return {
        newSessions: 0,
        updatedFiles: 0,
        totalFiles: 0,
        durationMs: Date.now() - startTime,
        attributedCount: 0
      }
    }

    // 2. Group by sourceFile (main messages only, isSubagent=0)
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
          rm.inputTokens ||
          rm.outputTokens ||
          rm.cacheCreationInputTokens ||
          rm.cacheReadInputTokens
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
                sm.inputTokens || sm.outputTokens
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
          tx.insert(sessions)
            .values({
              projectPath: d.projectPath,
              startedAt: d.startedAt,
              endedAt: d.endedAt,
              durationMinutes: d.durationMinutes,
              source: 'auto' as const,
              status: 'completed' as const,
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
            .run()
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
    const dir = claudeDir ?? settingsService.getSetting('claude_dir') ?? DEFAULT_CLAUDE_DIR

    const allFiles = await discoverSessionFiles(dir, projectFilter)
    log.info(`Backfill: parsing ${allFiles.length} JSONL files`)

    for (const filePath of allFiles) {
      const p = await parseSessionFile(filePath)
      if (p) {
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

    db.transaction((tx) => {
      // FK cleanup before deleting original session
      tx.delete(aiSummaries).where(eq(aiSummaries.sessionId, id)).run()
      tx.update(gitCommits).set({ sessionId: null }).where(eq(gitCommits.sessionId, id)).run()

      // Delete original
      tx.delete(sessions).where(eq(sessions.id, id)).run()

      // Insert two new sessions
      tx.insert(sessions)
        .values([
          {
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
          },
          {
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
          }
        ])
        .run()
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
    const parsed = await parseSessionFile(session.sourceFile)
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

/**
 * Store raw messages and progress events in DB with dedup.
 */
async function storeRawMessages(parsedSessions: ParsedSessionData[]): Promise<void> {
  const db = getDb()

  for (const parsed of parsedSessions) {
    db.transaction((tx) => {
      const now = new Date().toISOString()
      const projectPathEncoded = parsed.projectPathEncoded

      // Store main messages
      for (const msg of parsed.messages) {
        if (msg.uuid) {
          // Use INSERT OR IGNORE — partial unique index on (source_file, uuid) WHERE uuid IS NOT NULL
          tx.run(
            sql`INSERT OR IGNORE INTO raw_messages (source_file, claude_session_id, type, timestamp, cwd, git_branch, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, uuid, parent_uuid, is_tool_result, has_tool_use, tool_names, is_subagent, project_path_encoded, created_at) VALUES (${parsed.sourceFile}, ${msg.sessionId || null}, ${msg.type}, ${msg.timestamp}, ${msg.cwd}, ${msg.gitBranch}, ${msg.model}, ${msg.usage?.inputTokens ?? 0}, ${msg.usage?.outputTokens ?? 0}, ${msg.usage?.cacheCreationInputTokens ?? 0}, ${msg.usage?.cacheReadInputTokens ?? 0}, ${msg.uuid}, ${msg.parentUuid}, ${msg.isToolResult ? 1 : 0}, ${msg.hasToolUse ? 1 : 0}, ${msg.toolNames.length > 0 ? JSON.stringify(msg.toolNames) : null}, ${0}, ${projectPathEncoded}, ${now})`
          )
        } else {
          // Null-uuid: check for existing match on (sourceFile, timestamp, type, parentUuid)
          const existing = tx
            .select({ id: rawMessages.id })
            .from(rawMessages)
            .where(
              and(
                eq(rawMessages.sourceFile, parsed.sourceFile),
                eq(rawMessages.timestamp, msg.timestamp),
                eq(rawMessages.type, msg.type),
                msg.parentUuid
                  ? eq(rawMessages.parentUuid, msg.parentUuid)
                  : sql`${rawMessages.parentUuid} IS NULL`
              )
            )
            .get()

          if (!existing) {
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
            sql`INSERT OR IGNORE INTO raw_messages (source_file, claude_session_id, type, timestamp, cwd, git_branch, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, uuid, parent_uuid, is_tool_result, has_tool_use, tool_names, is_subagent, project_path_encoded, created_at) VALUES (${subSourceFile}, ${msg.sessionId || null}, ${msg.type}, ${msg.timestamp}, ${msg.cwd}, ${msg.gitBranch}, ${msg.model}, ${msg.usage?.inputTokens ?? 0}, ${msg.usage?.outputTokens ?? 0}, ${msg.usage?.cacheCreationInputTokens ?? 0}, ${msg.usage?.cacheReadInputTokens ?? 0}, ${msg.uuid}, ${msg.parentUuid}, ${msg.isToolResult ? 1 : 0}, ${msg.hasToolUse ? 1 : 0}, ${msg.toolNames.length > 0 ? JSON.stringify(msg.toolNames) : null}, ${1}, ${projectPathEncoded}, ${now})`
          )
        } else {
          const existing = tx
            .select({ id: rawMessages.id })
            .from(rawMessages)
            .where(
              and(
                eq(rawMessages.sourceFile, subSourceFile),
                eq(rawMessages.timestamp, msg.timestamp),
                eq(rawMessages.type, msg.type),
                msg.parentUuid
                  ? eq(rawMessages.parentUuid, msg.parentUuid)
                  : sql`${rawMessages.parentUuid} IS NULL`
              )
            )
            .get()

          if (!existing) {
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

    // Update lastFileSize for this file
    try {
      const fileStat = await stat(parsed.sourceFile)
      db.insert(scanState)
        .values({
          filePath: parsed.sourceFile,
          lastModifiedAt: fileStat.mtime.toISOString(),
          lastScannedAt: new Date().toISOString(),
          sessionCount: 0,
          lastFileSize: fileStat.size
        })
        .onConflictDoUpdate({
          target: scanState.filePath,
          set: { lastFileSize: fileStat.size }
        })
        .run()
    } catch {
      // File may not exist (e.g., in tests)
    }
  }
}

/**
 * Filter files to only those that are new or modified since last scan.
 * Also detects compaction (file size shrinks) and includes those files.
 */
async function filterChangedFiles(
  filePaths: string[]
): Promise<{ files: string[]; mtimes: Map<string, string>; fileSizes: Map<string, number> }> {
  const db = getDb()
  const files: string[] = []
  const mtimes = new Map<string, string>()
  const fileSizes = new Map<string, number>()

  for (const filePath of filePaths) {
    try {
      const fileStat = await stat(filePath)
      const mtime = fileStat.mtime.toISOString()

      const record = db.select().from(scanState).where(eq(scanState.filePath, filePath)).get()

      const isNew = !record
      const isModified = record && mtime > record.lastScannedAt
      const isCompacted = record && fileStat.size < record.lastFileSize

      if (isNew || isModified || isCompacted) {
        if (isCompacted) {
          log.info(
            `Compaction detected for ${filePath}: ${record!.lastFileSize} → ${fileStat.size}`
          )
        }
        files.push(filePath)
        mtimes.set(filePath, mtime)
        fileSizes.set(filePath, fileStat.size)
      }
    } catch (err) {
      log.warn(`Cannot stat file ${filePath}, skipping:`, err)
    }
  }

  return { files, mtimes, fileSizes }
}
