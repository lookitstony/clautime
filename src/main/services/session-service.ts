import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { eq, and, gte, lte, inArray, type SQL } from 'drizzle-orm'
import log from 'electron-log/main.js'
import { getDb } from '../db'
import { sessions } from '../db/schema/sessions'
import { scanState } from '../db/schema/scan-state'
import { aiSummaries } from '../db/schema/ai-summaries'
import { gitCommits } from '../db/schema/git-commits'
import { settingsService } from './settings-service'
import { discoverSessionFiles, parseSessionFile } from '../parsers'
import { detectSessionsFromMultiple } from './session-detector'
import type { SessionFilters, ScanResult, PromptTiming, UpdateSession } from '../../shared/types/session'
import type { ParsedSessionData } from '../parsers/types'

const DEFAULT_IDLE_TIMEOUT_MINUTES = 15
const DEFAULT_CLAUDE_DIR = join(homedir(), '.claude')

/**
 * SessionService orchestrates: discover → filter → parse → detect → store.
 * All database operations use batch inserts in transactions (NFR18, NFR20).
 */
export const sessionService = {
  /**
   * Scan for new/changed session files, detect sessions, and store in DB.
   * Only processes files modified since last scan (incremental - FR5).
   */
  async scanSessions(claudeDir?: string, projectFilter?: string[]): Promise<ScanResult> {
    const startTime = Date.now()
    const dir = claudeDir ?? settingsService.getSetting('claude_dir') ?? DEFAULT_CLAUDE_DIR

    const idleTimeoutStr = settingsService.getSetting('idle_timeout_minutes')
    const parsed = idleTimeoutStr ? parseInt(idleTimeoutStr, 10) : NaN
    const idleTimeoutMinutes = Number.isNaN(parsed) ? DEFAULT_IDLE_TIMEOUT_MINUTES : parsed

    log.info(`Starting session scan in: ${dir} (idle timeout: ${idleTimeoutMinutes}min)`)

    // 1. Discover session files (optionally filtered to specific projects)
    const allFiles = await discoverSessionFiles(dir, projectFilter)
    log.info(`Discovered ${allFiles.length} total session files`)

    // 2. Filter to only new/changed files (also collects file mtimes)
    const { files: filesToProcess, mtimes } = await filterChangedFiles(allFiles)
    log.info(`${filesToProcess.length} files need processing (new or changed)`)

    if (filesToProcess.length === 0) {
      const durationMs = Date.now() - startTime
      log.info(`Scan complete (no changes) in ${durationMs}ms`)
      return { newSessions: 0, updatedFiles: 0, totalFiles: allFiles.length, durationMs, attributedCount: 0 }
    }

    // 3. Parse changed files
    const parsedSessions: ParsedSessionData[] = []
    for (const filePath of filesToProcess) {
      const parsed = await parseSessionFile(filePath)
      if (parsed) {
        parsedSessions.push(parsed)
      }
    }

    // 4. Detect sessions from parsed data
    const detected = detectSessionsFromMultiple(parsedSessions, idleTimeoutMinutes)
    log.info(`Detected ${detected.length} sessions from ${parsedSessions.length} parsed files`)

    // 5. Store in DB — batch operations in a transaction
    const db = getDb()
    const sourceFiles = [...new Set(filesToProcess)]

    db.transaction((tx) => {
      // Delete stale auto sessions for re-scanned files
      // Must first remove FK references from ai_summaries and git_commits
      if (sourceFiles.length > 0) {
        for (const sf of sourceFiles) {
          // Find session IDs about to be deleted
          const staleIds = tx
            .select({ id: sessions.id })
            .from(sessions)
            .where(and(eq(sessions.source, 'auto'), eq(sessions.sourceFile, sf)))
            .all()
            .map((r) => r.id)

          if (staleIds.length > 0) {
            // Remove AI summaries referencing these sessions
            tx.delete(aiSummaries)
              .where(inArray(aiSummaries.sessionId, staleIds))
              .run()
            // Unlink git commits (nullable FK — set to null, don't delete)
            tx.update(gitCommits)
              .set({ sessionId: null })
              .where(inArray(gitCommits.sessionId, staleIds))
              .run()
            // Now safe to delete the sessions
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

      // Update scan_state records (lastModifiedAt = actual file mtime, lastScannedAt = now)
      const scanNow = new Date().toISOString()
      for (const filePath of filesToProcess) {
        const fileMtime = mtimes.get(filePath) ?? scanNow
        const sessionCount = detected.filter((d) => d.sourceFile === filePath).length
        tx.insert(scanState)
          .values({
            filePath,
            lastModifiedAt: fileMtime,
            lastScannedAt: scanNow,
            sessionCount
          })
          .onConflictDoUpdate({
            target: scanState.filePath,
            set: {
              lastModifiedAt: fileMtime,
              lastScannedAt: scanNow,
              sessionCount
            }
          })
          .run()
      }
    })

    // 6. Update global last scan timestamp
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
   * Query sessions from DB with optional filters.
   */
  getAllSessions(filters?: SessionFilters) {
    const db = getDb()
    const conditions: SQL[] = []

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
  splitSession(id: number, splitAt: string): [typeof sessions.$inferSelect, typeof sessions.$inferSelect] {
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
   * Extract prompt timings for a session by re-parsing its source JSONL file.
   * Returns human prompt → assistant response pairs with latency.
   */
  async getPromptTimings(sessionId: number): Promise<PromptTiming[]> {
    const session = this.getSessionById(sessionId)
    if (!session?.sourceFile) return []

    const parsed = await parseSessionFile(session.sourceFile)
    if (!parsed) return []

    // Filter messages to this session's time window
    const startMs = new Date(session.startedAt).getTime()
    const endMs = new Date(session.endedAt).getTime()
    const msgs = parsed.messages
      .filter((m) => {
        if (!m.timestamp) return false
        const t = new Date(m.timestamp).getTime()
        return t >= startMs && t <= endMs
      })
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))

    const timings: PromptTiming[] = []
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]
      if (msg.type !== 'user' || msg.isToolResult) continue

      // Find the next assistant message
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
}

/**
 * Filter files to only those that are new or modified since last scan.
 * Compares file mtime against scan_state records.
 * Returns both the changed file list and a Map of filePath → mtime ISO strings.
 */
async function filterChangedFiles(
  filePaths: string[]
): Promise<{ files: string[]; mtimes: Map<string, string> }> {
  const db = getDb()
  const files: string[] = []
  const mtimes = new Map<string, string>()

  for (const filePath of filePaths) {
    try {
      const fileStat = await stat(filePath)
      const mtime = fileStat.mtime.toISOString()

      const record = db
        .select()
        .from(scanState)
        .where(eq(scanState.filePath, filePath))
        .get()

      if (!record || mtime > record.lastScannedAt) {
        files.push(filePath)
        mtimes.set(filePath, mtime)
      }
    } catch (err) {
      log.warn(`Cannot stat file ${filePath}, skipping:`, err)
    }
  }

  return { files, mtimes }
}
