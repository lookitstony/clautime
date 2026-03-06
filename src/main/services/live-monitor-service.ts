import { open, stat, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Notification, shell } from 'electron'
import { eq, gte, count } from 'drizzle-orm'
import log from 'electron-log/main.js'
import { getDb } from '../db'
import { sessions } from '../db/schema/sessions'
import { projects } from '../db/schema/projects'
import { clients } from '../db/schema/clients'
import { projectAlertConfig } from '../db/schema/project-alert-config'
import { gitCommits } from '../db/schema/git-commits'
import { settingsService } from './settings-service'
import { decodeProjectPath } from './session-detector'
import { widgetService } from './widget-service'
import type { TodayStats, ProjectLiveStatus, ProjectAlertConfig } from '../../shared/types/live'

const DEFAULT_IDLE_TIMEOUT_MINUTES = 15

function getTodayMidnightISO(): string {
  const now = new Date()
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return midnight.toISOString()
}

function formatDuration(minutes: number): string {
  if (minutes <= 0) return '0m'
  const hours = Math.floor(minutes / 60)
  const mins = Math.round(minutes % 60)
  if (hours === 0) return `${mins}m`
  if (mins === 0) return `${hours}h`
  return `${hours}h ${mins}m`
}

/**
 * Merge overlapping time intervals and return total wall-clock minutes.
 * Same algorithm as computeHumanMinutes in renderer use-sessions.ts.
 */
function computeHumanMinutes(
  intervals: { startedAt: string; endedAt: string }[]
): number {
  if (intervals.length === 0) return 0

  const sorted = intervals
    .map((s) => ({
      start: new Date(s.startedAt).getTime(),
      end: new Date(s.endedAt).getTime()
    }))
    .sort((a, b) => a.start - b.start)

  let totalMs = 0
  let curStart = sorted[0].start
  let curEnd = sorted[0].end

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start <= curEnd) {
      curEnd = Math.max(curEnd, sorted[i].end)
    } else {
      totalMs += curEnd - curStart
      curStart = sorted[i].start
      curEnd = sorted[i].end
    }
  }
  totalMs += curEnd - curStart

  return Math.round(totalMs / 60_000)
}

export const liveMonitorService = {
  _monitorInterval: null as ReturnType<typeof setInterval> | null,
  _alertedGaps: new Map<number, string>(),
  _promptTimestampCache: new Map<string, { mtime: number; lastPromptAt: string; awaitingResponse: boolean }>(),
  // Track when each file's mtime last changed — to detect active writing vs stale
  _lastMtimeChange: new Map<string, { prevMtime: number; changedAt: number }>(),

  _escapeXml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  },

  getTodayStats(): TodayStats {
    const db = getDb()
    const todayMidnight = getTodayMidnightISO()

    const todaySessions = db
      .select()
      .from(sessions)
      .where(gte(sessions.startedAt, todayMidnight))
      .all()

    const commitCount = db
      .select({ count: count() })
      .from(gitCommits)
      .where(gte(gitCommits.committedAt, todayMidnight))
      .get()

    const totalCommits = commitCount?.count ?? 0

    if (todaySessions.length === 0) {
      return {
        humanHours: '0m',
        agentHours: '0m',
        totalSessions: 0,
        totalPrompts: 0,
        totalTokens: 0,
        totalCommits
      }
    }

    const totalMinutes = todaySessions.reduce((sum, s) => sum + s.durationMinutes, 0)
    const totalPrompts = todaySessions.reduce((sum, s) => sum + (s.promptCount ?? 0), 0)
    const totalTokens = todaySessions.reduce(
      (sum, s) => sum + (s.inputTokens ?? 0) + (s.outputTokens ?? 0),
      0
    )
    const humanMinutes = computeHumanMinutes(todaySessions)

    return {
      humanHours: formatDuration(humanMinutes),
      agentHours: formatDuration(totalMinutes),
      totalSessions: todaySessions.length,
      totalPrompts,
      totalTokens,
      totalCommits
    }
  },

  async getProjectLiveStatuses(): Promise<ProjectLiveStatus[]> {
    const db = getDb()
    const todayMidnight = getTodayMidnightISO()

    // Get latest prompt timestamps + processing state from JSONL files
    const timestamps = await this.getLatestPromptTimestamps()

    // Get all projects with their client info and alert config
    const allProjects = db
      .select({
        projectId: projects.id,
        projectName: projects.name,
        projectPath: projects.directoryPath,
        clientName: clients.name,
        clientId: projects.clientId,
        alertSound: projectAlertConfig.alertSound,
        isWatching: projectAlertConfig.isWatching
      })
      .from(projects)
      .leftJoin(clients, eq(projects.clientId, clients.id))
      .leftJoin(projectAlertConfig, eq(projects.id, projectAlertConfig.projectId))
      .all()

    // Get today's sessions grouped by projectId to find which projects have activity
    const todaySessions = db
      .select()
      .from(sessions)
      .where(gte(sessions.startedAt, todayMidnight))
      .all()

    // Match sessions to projects by projectId OR by projectPath
    const projectSessionMap = new Map<number, typeof todaySessions>()
    for (const p of allProjects) {
      const matched = todaySessions.filter(
        (s) =>
          s.projectId === p.projectId ||
          (s.projectId == null && s.projectPath.toLowerCase() === p.projectPath.toLowerCase())
      )
      if (matched.length > 0) {
        projectSessionMap.set(p.projectId, matched)
      }
    }

    // Build result: projects with today activity OR that are being watched
    const results: ProjectLiveStatus[] = []

    for (const p of allProjects) {
      const projectSessions = projectSessionMap.get(p.projectId) ?? []
      const hasActivity = projectSessions.length > 0
      const watching = p.isWatching === 1
      if (!hasActivity && !watching) continue
      // Match JSONL timestamp data by encoded project path
      let lastPromptAt: string | null = null
      let isProcessing = false
      for (const [key, value] of timestamps) {
        const decoded = decodeProjectPath(key)
        if (decoded === p.projectPath || p.projectPath.endsWith(decoded)) {
          lastPromptAt = value.lastPromptAt
          isProcessing = value.isProcessing
          break
        }
      }
      // Fall back to session endedAt if no JSONL match
      if (!lastPromptAt && projectSessions.length > 0) {
        const sorted = projectSessions.sort(
          (a, b) => new Date(b.endedAt).getTime() - new Date(a.endedAt).getTime()
        )
        lastPromptAt = sorted[0].endedAt
      }

      const totalMinutes = projectSessions.reduce((sum, s) => sum + s.durationMinutes, 0)
      const totalPrompts = projectSessions.reduce((sum, s) => sum + (s.promptCount ?? 0), 0)
      const totalTokens = projectSessions.reduce(
        (sum, s) => sum + (s.inputTokens ?? 0) + (s.outputTokens ?? 0),
        0
      )

      const todayCommits = db
        .select()
        .from(gitCommits)
        .where(eq(gitCommits.projectId, p.projectId))
        .all()
        .filter((c) => c.committedAt >= todayMidnight)

      results.push({
        projectId: p.projectId,
        projectName: p.projectName,
        projectPath: p.projectPath,
        clientName: p.clientName,
        clientId: p.clientId,
        lastPromptAt,
        isProcessing,
        isWatching: watching,
        alertSound: (!p.alertSound || p.alertSound === 'default') ? 'system' : p.alertSound,
        totalHours: formatDuration(totalMinutes),
        sessionCount: projectSessions.length,
        totalPrompts,
        totalTokens,
        totalCommits: todayCommits.length
      })
    }

    return results
  },

  async getLatestPromptTimestamps(): Promise<Map<string, { lastPromptAt: string; isProcessing: boolean }>> {
    const claudeDir = settingsService.getSetting('claude_dir') ?? join(homedir(), '.claude')
    const projectsDir = join(claudeDir, 'projects')
    log.debug(`getLatestPromptTimestamps: scanning ${projectsDir}`)
    const result = new Map<string, { lastPromptAt: string; isProcessing: boolean }>()

    let projectDirs: Awaited<ReturnType<typeof readdir>>
    try {
      projectDirs = await readdir(projectsDir, { withFileTypes: true })
    } catch {
      return result
    }

    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()

    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue

      const projectPath = join(projectsDir, dir.name)
      try {
        const entries = await readdir(projectPath, { withFileTypes: true })
        const jsonlFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl'))

        // Check ALL today's JSONL files for activity (not just the latest).
        // When Agent subagents run, they write to separate JSONL files.
        // We need to detect activity across ALL files in the project dir.
        let latestFile: string | null = null
        let latestMtime = 0
        let anyRecentlyWritten = false

        for (const entry of jsonlFiles) {
          const fp = join(projectPath, entry.name)
          try {
            const s = await stat(fp)
            const mtime = s.mtime.getTime()
            if (mtime < todayStart) continue

            // Track mtime changes for EACH file to detect active writing
            const prev = this._lastMtimeChange.get(fp)
            if (!prev || prev.prevMtime !== mtime) {
              this._lastMtimeChange.set(fp, { prevMtime: mtime, changedAt: now.getTime() })
            }
            const lastChanged = this._lastMtimeChange.get(fp)!.changedAt
            if ((now.getTime() - lastChanged) < 15_000) {
              anyRecentlyWritten = true
            }

            if (mtime > latestMtime) {
              latestMtime = mtime
              latestFile = fp
            }
          } catch {
            continue
          }
        }

        if (!latestFile) continue

        const recentlyModified = (now.getTime() - latestMtime) < 5 * 60_000

        // Check cache — only reuse if mtime unchanged
        const cacheKey = latestFile
        const cached = this._promptTimestampCache.get(cacheKey)
        if (cached && cached.mtime === latestMtime) {
          const fileIsActive = anyRecentlyWritten || (recentlyModified && cached.awaitingResponse)
          result.set(dir.name, { lastPromptAt: cached.lastPromptAt, isProcessing: fileIsActive })
          continue
        }

        // Tail-read last chunk — use 64KB to handle large assistant responses
        const { lastPromptAt, awaitingResponse } = await tailReadLastPrompt(latestFile)
        if (lastPromptAt) {
          this._promptTimestampCache.set(cacheKey, {
            mtime: latestMtime,
            lastPromptAt,
            awaitingResponse
          })
          const fileIsActive = anyRecentlyWritten || (recentlyModified && awaitingResponse)
          result.set(dir.name, { lastPromptAt, isProcessing: fileIsActive })
        }
      } catch (err) {
        log.debug(`getLatestPromptTimestamps: error scanning ${dir.name}:`, err)
        continue
      }
    }

    return result
  },

  startMonitoring(intervalMs: number): void {
    if (this._monitorInterval) return

    log.info(`Starting live monitor (interval: ${intervalMs}ms)`)

    this._monitorInterval = setInterval(async () => {
      try {
        const timestamps = await this.getLatestPromptTimestamps()
        const idleTimeoutStr = settingsService.getSetting('idle_timeout_minutes')
        const parsed = idleTimeoutStr ? parseInt(idleTimeoutStr, 10) : NaN
        const idleTimeoutMinutes = Number.isNaN(parsed)
          ? DEFAULT_IDLE_TIMEOUT_MINUTES
          : parsed

        // Respect alert threshold mode setting
        const alertMode = settingsService.getSetting('alert_threshold_mode') ?? 'percent'
        let thresholdMs: number
        if (alertMode === 'minutes') {
          const alertMin = parseInt(settingsService.getSetting('alert_threshold_minutes') ?? '5', 10) || 5
          thresholdMs = alertMin * 60_000
        } else {
          thresholdMs = idleTimeoutMinutes * 60_000 * 0.75
        }

        // Get watched projects from DB
        const db = getDb()
        const watchedConfigs = db
          .select({
            projectId: projectAlertConfig.projectId,
            alertSound: projectAlertConfig.alertSound,
            directoryPath: projects.directoryPath
          })
          .from(projectAlertConfig)
          .innerJoin(projects, eq(projectAlertConfig.projectId, projects.id))
          .where(eq(projectAlertConfig.isWatching, 1))
          .all()

        const now = Date.now()

        log.debug(`Alert check: ${watchedConfigs.length} watched, ${timestamps.size} timestamps, threshold ${Math.round(thresholdMs / 1000)}s`)

        for (const config of watchedConfigs) {
          // Match encoded .claude/projects/ dir name against project's directoryPath
          let lastPromptAt: string | null = null
          for (const [key, value] of timestamps) {
            const decoded = decodeProjectPath(key)
            if (decoded === config.directoryPath || config.directoryPath.endsWith(decoded)) {
              lastPromptAt = value.lastPromptAt
              break
            }
          }

          if (!lastPromptAt) continue

          const elapsed = now - new Date(lastPromptAt).getTime()
          if (elapsed >= thresholdMs) {
            const alreadyAlerted = this._alertedGaps.get(config.projectId)
            if (alreadyAlerted === lastPromptAt) continue

            // Fire notification
            const projectRow = db
              .select({ name: projects.name })
              .from(projects)
              .where(eq(projects.id, config.projectId))
              .get()

            const projectName = projectRow?.name ?? 'Unknown project'
            const minutesAgo = Math.round(elapsed / 60_000)
            log.info(`Alert: ${projectName} idle ${minutesAgo}m (threshold ${Math.round(thresholdMs / 60_000)}m)`)

            if (Notification.isSupported()) {
              const useSystemSound = config.alertSound === 'system'
              const notification = new Notification({
                title: `⏳ ${projectName}`,
                body: `Prompt waiting for ${minutesAgo} min`,
                silent: !useSystemSound
              })
              notification.on('show', () => log.info(`Notification displayed for ${projectName}`))
              notification.on('failed', (_e, err) => log.warn(`Notification failed for ${projectName}:`, err))
              notification.show()
            } else {
              log.warn('Notifications not supported on this system')
            }

            if (config.alertSound !== 'system') {
              this.playSound(config.alertSound)
            }
            // Notify floating widget
            try { widgetService.notifyAlert(projectName) } catch { /* widget may not be open */ }
            this._alertedGaps.set(config.projectId, lastPromptAt)
          }
        }
      } catch (err) {
        log.warn('Live monitor tick failed:', err)
      }
    }, intervalMs)
  },

  stopMonitoring(): void {
    if (this._monitorInterval) {
      clearInterval(this._monitorInterval)
      this._monitorInterval = null
      log.info('Live monitor stopped')
    }
  },

  setWatching(projectId: number, enabled: boolean): void {
    const db = getDb()
    db.insert(projectAlertConfig)
      .values({
        projectId,
        isWatching: enabled ? 1 : 0,
        alertSound: 'system'
      })
      .onConflictDoUpdate({
        target: projectAlertConfig.projectId,
        set: { isWatching: enabled ? 1 : 0 }
      })
      .run()

    if (!enabled) {
      this._alertedGaps.delete(projectId)
    }
  },

  getAlertConfig(projectId: number): ProjectAlertConfig {
    const db = getDb()
    const row = db
      .select()
      .from(projectAlertConfig)
      .where(eq(projectAlertConfig.projectId, projectId))
      .get()

    return {
      projectId,
      alertSound: (!row?.alertSound || row.alertSound === 'default') ? 'system' : row.alertSound,
      isWatching: row?.isWatching === 1
    }
  },

  setAlertConfig(projectId: number, alertSound: string): void {
    const db = getDb()
    db.insert(projectAlertConfig)
      .values({
        projectId,
        alertSound,
        isWatching: 0
      })
      .onConflictDoUpdate({
        target: projectAlertConfig.projectId,
        set: { alertSound }
      })
      .run()
  },

  playSound(soundName: string): void {
    if (soundName === 'silent') return

    let soundPath: string
    if (!soundName.includes('/') && !soundName.includes('\\')) {
      // Bundled sound
      const filename = `${soundName}.wav`
      soundPath = join(__dirname, '../../resources/sounds/', filename)
    } else {
      // Custom absolute path
      soundPath = soundName
    }

    // Read volume setting (0-100, default 50)
    const volStr = settingsService.getSetting('notification_volume')
    const volParsed = volStr ? parseInt(volStr, 10) : NaN
    const volumePct = Number.isNaN(volParsed) ? 50 : Math.max(0, Math.min(100, volParsed))
    if (volumePct === 0) return

    const volume = (volumePct / 100).toFixed(2)

    try {
      if (process.platform === 'win32') {
        // Use MediaPlayer for all files — supports volume control
        const escapedPath = soundPath.replace(/'/g, "''")
        const psCommand = `Add-Type -AssemblyName PresentationCore; $p = [System.Windows.Media.MediaPlayer]::new(); $p.Open([Uri]::new('${escapedPath}')); $p.Volume = ${volume}; Start-Sleep -Milliseconds 200; $p.Play(); Start-Sleep -Seconds 3`
        const encoded = Buffer.from(psCommand, 'utf16le').toString('base64')
        execFile('powershell', ['-NoProfile', '-EncodedCommand', encoded], (err) => {
          if (err) log.warn('Sound playback failed:', err)
        })
      } else if (process.platform === 'darwin') {
        // afplay supports --volume (0 = silent, 1 = normal, 255 = max)
        const afVol = Math.round((volumePct / 100) * 255)
        execFile('afplay', ['--volume', String(afVol), soundPath], (err) => {
          if (err) log.warn('Sound playback failed:', err)
        })
      } else {
        const isWav = soundPath.toLowerCase().endsWith('.wav')
        const cmd = isWav ? 'aplay' : 'mpv'
        const args = isWav ? [soundPath] : ['--no-video', `--volume=${volumePct}`, soundPath]
        execFile(cmd, args, (err) => {
          if (err) log.warn('Sound playback failed:', err)
        })
      }
    } catch (err) {
      log.warn('Sound playback failed, falling back to beep:', err)
      shell.beep()
    }
  }
}

/**
 * Tail-read a JSONL file to find the last human prompt timestamp
 * and whether the session is awaiting a response (no final assistant message).
 * Only reads the last ~64KB to minimize I/O.
 */
async function tailReadLastPrompt(filePath: string): Promise<{ lastPromptAt: string | null; awaitingResponse: boolean }> {
  let fh: Awaited<ReturnType<typeof open>> | null = null
  try {
    fh = await open(filePath, 'r')
    const fileStat = await fh.stat()
    const fileSize = fileStat.size

    const readSize = Math.min(65536, fileSize)
    const position = Math.max(0, fileSize - readSize)
    const buffer = Buffer.alloc(readSize)

    await fh.read(buffer, 0, readSize, position)
    const content = buffer.toString('utf-8')

    const allLines = content.split('\n').filter((l) => l.trim())
    // Skip the first line if we didn't read from the start — it's likely truncated
    const lines = position > 0 ? allLines.slice(1) : allLines

    let lastPromptAt: string | null = null
    // Track session state to detect if Claude is actively working:
    // 'idle'         = Claude gave a final response, waiting for user (purple)
    // 'awaiting'     = User sent a prompt, waiting for Claude to respond (green)
    // 'tool-pending' = Claude called a tool, waiting for result (green)
    // 'processing'   = Tool result returned, Claude is generating next response (green)
    let lastMessageState: 'idle' | 'awaiting' | 'tool-pending' | 'processing' = 'idle'
    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'user' && !obj.toolUseResult && obj.timestamp) {
          lastPromptAt = obj.timestamp
          lastMessageState = 'awaiting'
        } else if (obj.type === 'user' && obj.toolUseResult) {
          // Tool result returned — Claude is about to generate next response
          lastMessageState = 'processing'
        } else if (obj.type === 'assistant') {
          const hasToolUse = Array.isArray(obj.message?.content)
            && obj.message.content.some((b: { type?: string }) => b.type === 'tool_use')
          lastMessageState = hasToolUse ? 'tool-pending' : 'idle'
        } else if (obj.type === 'progress') {
          // Progress events prove active tool execution
          if (lastMessageState === 'tool-pending') {
            lastMessageState = 'tool-pending' // stays green
          }
        }
      } catch {
        continue
      }
    }

    // Session is active if Claude is processing, awaiting, or has a pending tool
    const awaitingResponse = lastMessageState !== 'idle'

    return { lastPromptAt, awaitingResponse }
  } catch (err) {
    log.debug(`tailReadLastPrompt error for ${filePath}:`, err)
    return { lastPromptAt: null, awaitingResponse: false }
  } finally {
    await fh?.close()
  }
}

