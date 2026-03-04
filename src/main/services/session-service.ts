import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { eq, and, gte, lte, type SQL } from 'drizzle-orm'
import log from 'electron-log/main.js'
import { getDb } from '../db'
import { sessions } from '../db/schema/sessions'
import { scanState } from '../db/schema/scan-state'
import { settingsService } from './settings-service'
import { discoverSessionFiles, parseSessionFile } from '../parsers'
import { detectSessionsFromMultiple } from './session-detector'
import type { SessionFilters, ScanResult } from '../../shared/types/session'
import type { ParsedSessionData } from '../parsers/types'

const DEFAULT_IDLE_TIMEOUT_MINUTES = 10
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
  async scanSessions(claudeDir?: string): Promise<ScanResult> {
    const startTime = Date.now()
    const dir = claudeDir ?? settingsService.getSetting('claude_dir') ?? DEFAULT_CLAUDE_DIR

    const idleTimeoutStr = settingsService.getSetting('idle_timeout_minutes')
    const parsed = idleTimeoutStr ? parseInt(idleTimeoutStr, 10) : NaN
    const idleTimeoutMinutes = Number.isNaN(parsed) ? DEFAULT_IDLE_TIMEOUT_MINUTES : parsed

    log.info(`Starting session scan in: ${dir} (idle timeout: ${idleTimeoutMinutes}min)`)

    // 1. Discover all session files
    const allFiles = await discoverSessionFiles(dir)
    log.info(`Discovered ${allFiles.length} total session files`)

    // 2. Filter to only new/changed files (also collects file mtimes)
    const { files: filesToProcess, mtimes } = await filterChangedFiles(allFiles)
    log.info(`${filesToProcess.length} files need processing (new or changed)`)

    if (filesToProcess.length === 0) {
      const durationMs = Date.now() - startTime
      log.info(`Scan complete (no changes) in ${durationMs}ms`)
      return { newSessions: 0, updatedFiles: 0, totalFiles: allFiles.length, durationMs }
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
      if (sourceFiles.length > 0) {
        for (const sf of sourceFiles) {
          tx.delete(sessions)
            .where(and(eq(sessions.source, 'auto'), eq(sessions.sourceFile, sf)))
            .run()
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
      durationMs
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
