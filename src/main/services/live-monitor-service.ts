import { open, stat, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { Notification, shell } from 'electron'
import { eq, gte, and, count, or, isNull, notInArray } from 'drizzle-orm'
import log from 'electron-log/main.js'
import { getDb } from '../db'
import { sessions } from '../db/schema/sessions'
import { projects } from '../db/schema/projects'
import { clients } from '../db/schema/clients'
import { projectAlertConfig } from '../db/schema/project-alert-config'
import { gitCommits } from '../db/schema/git-commits'
import { settingsService } from './settings-service'
import { clientProjectService } from './client-project-service'
import { getClaudeConfigDirs } from './discovery-service'
import { encodeProjectPath } from './session-detector'
import {
  getCodexSessionsDir,
  readCodexSessionMeta,
  tailReadCodexState
} from '../parsers/codex-parser'
import { normalizePath } from '../../shared/paths'
import { isProviderEnabled } from './provider-tracking'
import { widgetService } from './widget-service'
import { computeEarnings } from '../../shared/earnings'
import { clientAlias, projectAlias } from '../../shared/presentation-alias'
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
function computeHumanMinutes(intervals: { startedAt: string; endedAt: string }[]): number {
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
  _promptTimestampCache: new Map<
    string,
    {
      mtime: number
      lastPromptAt: string
      awaitingResponse: boolean
      state: 'idle' | 'awaiting' | 'tool-pending' | 'processing'
    }
  >(),
  // Track when each file's mtime last changed — to detect active writing vs stale
  _lastMtimeChange: new Map<string, { prevMtime: number; changedAt: number }>(),
  _lastEvictionDate: '', // ISO date string for cache eviction on date rollover
  // Track when each project stopped processing — idle time starts from here, not from lastPromptAt
  _idleSince: new Map<number, number>(),
  _wasProcessing: new Map<number, boolean>(),
  // Processing holdover: bridges brief gaps (e.g. during compaction) where no files are written
  _lastActiveAt: new Map<string, number>(),
  // Short-lived shared result for the (expensive) prompt-timestamp FS walk. The
  // monitor interval, the renderer poll, and every widget poll all call this;
  // without sharing they each walk 100+ project dirs across every profile,
  // saturating the main thread. In-flight + TTL dedup collapses overlapping and
  // rapid calls into one walk. Safe: this is seconds-granularity display data.
  _promptTsCache: null as {
    at: number
    value: Map<string, { lastPromptAt: string; isProcessing: boolean }>
  } | null,
  _promptTsInflight: null as Promise<
    Map<string, { lastPromptAt: string; isProcessing: boolean }>
  > | null,

  _escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  },

  getTodayStats(): TodayStats {
    const db = getDb()
    const todayMidnight = getTodayMidnightISO()

    const excludedIds = clientProjectService.getExcludedProjectIds()
    const excludeCondition =
      excludedIds.length > 0
        ? or(isNull(sessions.projectId), notInArray(sessions.projectId, excludedIds))
        : undefined

    const todayFilter = or(
      gte(sessions.startedAt, todayMidnight),
      gte(sessions.endedAt, todayMidnight)
    )
    let todaySessions = db
      .select()
      .from(sessions)
      .where(excludeCondition ? and(todayFilter, excludeCondition) : todayFilter)
      .all()

    // Respect after-hours mode: only keep sessions outside 7am-6pm
    if (settingsService.getSetting('after_hours_mode') === 'true') {
      todaySessions = todaySessions.filter((s) => {
        const hour = new Date(s.startedAt).getHours()
        return hour < 7 || hour >= 18
      })
    }

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
        totalCommits,
        earnedToday: 0
      }
    }

    // Pro-rate sessions that span midnight — only count the portion after today's midnight
    const midnightMs = new Date(todayMidnight).getTime()
    const totalMinutes = todaySessions.reduce((sum, s) => {
      const startMs = new Date(s.startedAt).getTime()
      if (startMs >= midnightMs) return sum + s.durationMinutes
      const endMs = new Date(s.endedAt).getTime()
      return sum + Math.round(Math.max(0, endMs - midnightMs) / 60_000)
    }, 0)
    const totalPrompts = todaySessions.reduce((sum, s) => sum + (s.promptCount ?? 0), 0)
    const totalTokens = todaySessions.reduce(
      (sum, s) => sum + (s.inputTokens ?? 0) + (s.outputTokens ?? 0),
      0
    )
    // Clamp session start times to midnight for human-minutes overlap calculation
    const clampedSessions = todaySessions.map((s) => {
      const startMs = new Date(s.startedAt).getTime()
      if (startMs >= midnightMs) return s
      return { ...s, startedAt: todayMidnight }
    })
    const humanMinutes = computeHumanMinutes(clampedSessions)

    // Earned today: billable human hours × effective (project-or-client) rate.
    const allProjects = db.select().from(projects).all()
    const allClients = db.select().from(clients).all()
    const earnedToday =
      Math.round(computeEarnings(clampedSessions, allProjects, allClients) * 100) / 100

    return {
      humanHours: formatDuration(humanMinutes),
      agentHours: formatDuration(totalMinutes),
      totalSessions: todaySessions.length,
      totalPrompts,
      totalTokens,
      totalCommits,
      earnedToday
    }
  },

  async getProjectLiveStatuses(): Promise<ProjectLiveStatus[]> {
    const db = getDb()
    const todayMidnight = getTodayMidnightISO()

    // Get latest prompt timestamps + processing state from JSONL files
    const timestamps = await this.getLatestPromptTimestamps()

    // Get all active projects with their client info and alert config
    const allProjects = db
      .select({
        projectId: projects.id,
        projectName: projects.name,
        stageName: projects.stageName,
        projectPath: projects.directoryPath,
        clientName: clients.name,
        clientStageName: clients.stageName,
        clientId: projects.clientId,
        alertSound: projectAlertConfig.alertSound,
        isWatching: projectAlertConfig.isWatching
      })
      .from(projects)
      .leftJoin(clients, eq(projects.clientId, clients.id))
      .leftJoin(projectAlertConfig, eq(projects.id, projectAlertConfig.projectId))
      .where(eq(projects.isActive, true))
      .all()

    const presentationMode = settingsService.getSetting('presentation_mode') === 'true'

    // Get today's sessions grouped by projectId to find which projects have activity.
    const afterHoursOnly = settingsService.getSetting('after_hours_mode') === 'true'
    let todaySessions = db
      .select()
      .from(sessions)
      .where(or(gte(sessions.startedAt, todayMidnight), gte(sessions.endedAt, todayMidnight)))
      .all()

    // Respect after-hours mode: only keep sessions outside 7am-6pm
    if (afterHoursOnly) {
      todaySessions = todaySessions.filter((s) => {
        const hour = new Date(s.startedAt).getHours()
        return hour < 7 || hour >= 18
      })
    }

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

    // Build result: projects with today sessions OR active JSONL files
    const results: ProjectLiveStatus[] = []

    for (const p of allProjects) {
      const projectSessions = projectSessionMap.get(p.projectId) ?? []
      // Match JSONL timestamp data by encoded project path
      let lastPromptAt: string | null = null
      let isProcessing = false
      const encodedProjectPath = encodeProjectPath(p.projectPath)
      for (const [key, value] of timestamps) {
        if (key === encodedProjectPath) {
          lastPromptAt = value.lastPromptAt
          isProcessing = value.isProcessing
          break
        }
      }

      const hasDbSessions = projectSessions.length > 0
      const hasLiveJsonl = lastPromptAt !== null

      // Skip projects with no DB sessions AND no active JSONL
      if (!hasDbSessions && !hasLiveJsonl) continue

      // Fall back to session endedAt if no JSONL match
      if (!lastPromptAt && projectSessions.length > 0) {
        const sorted = projectSessions.sort(
          (a, b) => new Date(b.endedAt).getTime() - new Date(a.endedAt).getTime()
        )
        lastPromptAt = sorted[0].endedAt
      }

      // Pro-rate sessions that span midnight — only count the portion after today's midnight
      const midnightMs = new Date(todayMidnight).getTime()
      const totalMinutes = projectSessions.reduce((sum, s) => {
        const startMs = new Date(s.startedAt).getTime()
        if (startMs >= midnightMs) return sum + s.durationMinutes
        // Session started before midnight — only count from midnight to endedAt
        const endMs = new Date(s.endedAt).getTime()
        const todayPortionMs = Math.max(0, endMs - midnightMs)
        return sum + Math.round(todayPortionMs / 60_000)
      }, 0)
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
        projectName: presentationMode ? p.stageName || projectAlias(p.projectId) : p.projectName,
        projectPath: p.projectPath,
        clientName: presentationMode
          ? p.clientStageName || (p.clientId != null ? clientAlias(p.clientId) : p.clientName)
          : p.clientName,
        clientId: p.clientId,
        lastPromptAt,
        isProcessing,
        isWatching: p.isWatching === 1,
        alertSound: !p.alertSound || p.alertSound === 'default' ? 'system' : p.alertSound,
        totalHours: formatDuration(totalMinutes),
        sessionCount: projectSessions.length,
        totalPrompts,
        totalTokens,
        totalCommits: todayCommits.length
      })
    }

    return results
  },

  /** ~4s in-flight + TTL dedup wrapper around the FS walk (see _promptTsCache). */
  async getLatestPromptTimestamps(): Promise<
    Map<string, { lastPromptAt: string; isProcessing: boolean }>
  > {
    const CACHE_TTL_MS = 4000
    const cached = this._promptTsCache
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
    if (this._promptTsInflight) return this._promptTsInflight

    const inflight = this._computeLatestPromptTimestamps()
    this._promptTsInflight = inflight
    try {
      const t0 = Date.now()
      const value = await inflight
      const ms = Date.now() - t0
      if (ms > 200) log.warn(`[DIAG] computeLatestPromptTimestamps: ${ms}ms`)
      this._promptTsCache = { at: Date.now(), value }
      return value
    } finally {
      this._promptTsInflight = null
    }
  },

  async _computeLatestPromptTimestamps(): Promise<
    Map<string, { lastPromptAt: string; isProcessing: boolean }>
  > {
    const result = new Map<string, { lastPromptAt: string; isProcessing: boolean }>()

    // Claude tracking off — skip its live scan (and the readdir of home that
    // getClaudeConfigDirs does) entirely rather than resolving dirs first.
    if (!isProviderEnabled('claude')) return result

    const override = settingsService.getSetting('claude_dir')
    const configDirs = override ? [override] : await getClaudeConfigDirs()

    // The same encoded project dir can surface from multiple sources — several
    // config profiles (one account per client), or Claude and Codex running in
    // the same directory. Merge rather than overwrite: keep the most recent
    // prompt time, but mark the project processing if ANY source is active, so a
    // more-recent idle session never masks another source that's still working.
    const setResult = (
      name: string,
      value: { lastPromptAt: string; isProcessing: boolean }
    ): void => {
      const existing = result.get(name)
      if (!existing) {
        result.set(name, value)
        return
      }
      result.set(name, {
        lastPromptAt:
          value.lastPromptAt > existing.lastPromptAt ? value.lastPromptAt : existing.lastPromptAt,
        isProcessing: existing.isProcessing || value.isProcessing
      })
    }

    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const todayDate = now.toISOString().slice(0, 10)

    // Evict stale caches on date rollover to prevent unbounded growth
    if (this._lastEvictionDate !== todayDate) {
      this._promptTimestampCache.clear()
      this._lastMtimeChange.clear()
      this._idleSince.clear()
      this._wasProcessing.clear()
      this._lastActiveAt.clear()
      this._codexCwdCache.clear()
      this._lastEvictionDate = todayDate
    }

    for (const configDir of configDirs) {
      const projectsDir = join(configDir, 'projects')
      log.debug(`getLatestPromptTimestamps: scanning ${projectsDir}`)

      let projectDirs: import('node:fs').Dirent<string>[]
      try {
        projectDirs = await readdir(projectsDir, { withFileTypes: true, encoding: 'utf8' })
      } catch {
        continue
      }

      for (const dir of projectDirs) {
        if (!dir.isDirectory()) continue

        const projectPath = join(projectsDir, dir.name)
        try {
          const entries = await readdir(projectPath, { withFileTypes: true, encoding: 'utf8' })
          const jsonlFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl'))

          // Also scan subagent JSONL files (in {conversation-id}/subagents/ dirs).
          // These include Agent tool subagents AND compaction sidechains, which write
          // to separate files while the main conversation JSONL stays idle.
          for (const entry of entries) {
            if (!entry.isDirectory()) continue
            try {
              const subagentsDir = join(projectPath, entry.name, 'subagents')
              const subEntries = await readdir(subagentsDir, {
                withFileTypes: true,
                encoding: 'utf8'
              })
              for (const sub of subEntries) {
                if (sub.isFile() && sub.name.endsWith('.jsonl')) {
                  const composedName = join(entry.name, 'subagents', sub.name)
                  // Push with adjusted path info for stat checking below
                  jsonlFiles.push({ ...sub, name: composedName } as typeof sub)
                }
              }
            } catch {
              // No subagents dir — normal
            }
          }

          // Check ALL today's JSONL files for activity (not just the latest).
          // When Agent subagents or compaction run, they write to separate JSONL files.
          // We need to detect activity across ALL files in the project dir tree.
          let latestFile: string | null = null
          let latestMtime = 0
          let latestAnyMtime = 0 // Across ALL files including subagents
          let anyRecentlyWritten = false
          let subagentRecentlyWritten = false

          for (const entry of jsonlFiles) {
            const fp = join(projectPath, entry.name)
            const isSubagentFile = entry.name.includes('/') || entry.name.includes('\\')
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
              if (now.getTime() - lastChanged < 30_000) {
                anyRecentlyWritten = true
                if (isSubagentFile) subagentRecentlyWritten = true
              }

              // Track most recent mtime across ALL files (including subagents)
              if (mtime > latestAnyMtime) latestAnyMtime = mtime

              // Only track top-level JSONL files as "latest" for state machine reading.
              // Subagent files contribute to anyRecentlyWritten but not awaitingResponse.
              if (!isSubagentFile) {
                if (mtime > latestMtime) {
                  latestMtime = mtime
                  latestFile = fp
                }
              }
            } catch {
              continue
            }
          }

          if (!latestFile) continue

          // Use latestAnyMtime (includes subagent files) for staleness — covers gaps
          // where main JSONL is old but subagent files were written recently.
          // 3min window bridges compaction gaps (sidechain finishes before main JSONL rewrite).
          // Post-compaction false positives handled by consecutive user-prompt detection in tailRead.
          const recentlyModifiedAny = now.getTime() - latestAnyMtime < 3 * 60_000

          // Check cache — only reuse if mtime unchanged
          const cacheKey = latestFile
          const cached = this._promptTimestampCache.get(cacheKey)
          if (cached && cached.mtime === latestMtime) {
            // Show processing if ANY of these are true:
            // 1. Main JSONL was written to in the last 30s (active tool calls)
            // 2. State machine says awaiting/processing AND file modified recently
            //    - tool-pending uses 30s window (permission prompts should go green quickly)
            //    - awaiting/processing uses 3min window (bridges compaction gaps)
            // 3. A subagent file is actively being written (background agents/compaction)
            const awaitingWindow =
              cached.state === 'tool-pending' ? anyRecentlyWritten : recentlyModifiedAny
            let fileIsActive =
              anyRecentlyWritten ||
              (cached.awaitingResponse && awaitingWindow) ||
              subagentRecentlyWritten
            // Processing holdover: if we were active within last 15s, stay active to bridge gaps (e.g. compaction pauses)
            if (fileIsActive) {
              this._lastActiveAt.set(dir.name, now.getTime())
            } else {
              const lastActive = this._lastActiveAt.get(dir.name)
              if (lastActive && now.getTime() - lastActive < 15_000) {
                fileIsActive = true
              }
            }
            setResult(dir.name, { lastPromptAt: cached.lastPromptAt, isProcessing: fileIsActive })
            continue
          }

          // Tail-read last chunk — use 64KB to handle large assistant responses
          const { lastPromptAt, awaitingResponse, state } = await tailReadLastPrompt(latestFile)
          // Fall back to file mtime if user-prompt not found in tail chunk
          // (happens when assistant/tool messages are so large they fill the 512KB window)
          const effectivePromptAt = lastPromptAt ?? new Date(latestMtime).toISOString()
          if (lastPromptAt || awaitingResponse || anyRecentlyWritten || subagentRecentlyWritten) {
            this._promptTimestampCache.set(cacheKey, {
              mtime: latestMtime,
              lastPromptAt: effectivePromptAt,
              awaitingResponse,
              state
            })
            // tool-pending with no recent writes = permission prompt (use 30s window)
            // awaiting/processing = Claude actively working (use 3min window for compaction gaps)
            const awaitingWindow =
              state === 'tool-pending' ? anyRecentlyWritten : recentlyModifiedAny
            let fileIsActive =
              anyRecentlyWritten || (awaitingResponse && awaitingWindow) || subagentRecentlyWritten
            // Processing holdover: if we were active within last 15s, stay active to bridge gaps (e.g. compaction pauses)
            if (fileIsActive) {
              this._lastActiveAt.set(dir.name, now.getTime())
            } else {
              const lastActive = this._lastActiveAt.get(dir.name)
              if (lastActive && now.getTime() - lastActive < 15_000) {
                fileIsActive = true
              }
            }
            setResult(dir.name, { lastPromptAt: effectivePromptAt, isProcessing: fileIsActive })
          }
        } catch (err) {
          log.debug(`getLatestPromptTimestamps: error scanning ${dir.name}:`, err)
          continue
        }
      }
    }

    // ---- Codex live activity ----
    if (isProviderEnabled('codex')) {
      try {
        await this._collectCodexTimestamps(setResult, todayStart, now)
      } catch (err) {
        log.debug('getLatestPromptTimestamps: codex pass failed:', err)
      }
    }

    return result
  },

  // cwd never changes within a rollout file — cache the head-of-file read
  _codexCwdCache: new Map<string, string | null>(),

  /**
   * Scan today's (and, for sessions spanning midnight, yesterday's) Codex
   * rollout folders and fold their activity into the live timestamp map.
   * Codex folders are keyed by session START date, so a session that began
   * yesterday keeps writing to yesterday's folder after midnight.
   */
  async _collectCodexTimestamps(
    setResult: (name: string, value: { lastPromptAt: string; isProcessing: boolean }) => void,
    todayStart: number,
    now: Date
  ): Promise<void> {
    const sessionsRoot = getCodexSessionsDir()
    const dayDirs: string[] = []
    for (const daysAgo of [0, 1]) {
      const d = new Date(todayStart)
      d.setDate(d.getDate() - daysAgo)
      const yyyy = String(d.getFullYear())
      const mm = String(d.getMonth() + 1).padStart(2, '0')
      const dd = String(d.getDate()).padStart(2, '0')
      dayDirs.push(join(sessionsRoot, yyyy, mm, dd))
    }

    for (const dayDir of dayDirs) {
      let entries: import('node:fs').Dirent<string>[]
      try {
        entries = await readdir(dayDir, { withFileTypes: true, encoding: 'utf8' })
      } catch {
        continue // folder for that day doesn't exist
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        const fp = join(dayDir, entry.name)
        try {
          const s = await stat(fp)
          const mtime = s.mtime.getTime()
          if (mtime < todayStart) continue // idle since before today

          // Track mtime changes to detect active writing (same window as Claude)
          const prev = this._lastMtimeChange.get(fp)
          if (!prev || prev.prevMtime !== mtime) {
            this._lastMtimeChange.set(fp, { prevMtime: mtime, changedAt: now.getTime() })
          }
          const recentlyWritten = now.getTime() - this._lastMtimeChange.get(fp)!.changedAt < 30_000
          const recentlyModified = now.getTime() - mtime < 3 * 60_000

          let cwd = this._codexCwdCache.get(fp)
          if (cwd === undefined) {
            const meta = await readCodexSessionMeta(fp)
            cwd = meta?.cwd ?? null
            this._codexCwdCache.set(fp, cwd)
          }
          if (!cwd) continue
          const encoded = encodeProjectPath(normalizePath(cwd))

          // Reuse the shared per-file cache when the file hasn't changed
          const cached = this._promptTimestampCache.get(fp)
          if (cached && cached.mtime === mtime) {
            const awaitingWindow =
              cached.state === 'tool-pending' ? recentlyWritten : recentlyModified
            const isActive = recentlyWritten || (cached.awaitingResponse && awaitingWindow)
            setResult(encoded, { lastPromptAt: cached.lastPromptAt, isProcessing: isActive })
            continue
          }

          const { lastPromptAt, awaitingResponse, state } = await tailReadCodexState(fp)
          const effectivePromptAt = lastPromptAt ?? new Date(mtime).toISOString()
          this._promptTimestampCache.set(fp, {
            mtime,
            lastPromptAt: effectivePromptAt,
            awaitingResponse,
            state
          })
          const awaitingWindow = state === 'tool-pending' ? recentlyWritten : recentlyModified
          const isActive = recentlyWritten || (awaitingResponse && awaitingWindow)
          setResult(encoded, { lastPromptAt: effectivePromptAt, isProcessing: isActive })
        } catch (err) {
          log.debug(`_collectCodexTimestamps: error for ${entry.name}:`, err)
          continue
        }
      }
    }
  },

  startMonitoring(intervalMs: number): void {
    if (this._monitorInterval) return

    log.info(`Starting live monitor (interval: ${intervalMs}ms)`)

    this._monitorInterval = setInterval(async () => {
      const tickStart = Date.now()
      try {
        // Sync widgets: auto-hide inactive projects, auto-show active ones
        const syncDb = getDb()
        const todayMidnight = getTodayMidnightISO()
        const todaySessionRows = syncDb
          .select({ projectId: sessions.projectId })
          .from(sessions)
          .where(or(gte(sessions.startedAt, todayMidnight), gte(sessions.endedAt, todayMidnight)))
          .all()
        const activeProjectIds = new Set(
          todaySessionRows.map((s) => s.projectId).filter((id): id is number => id != null)
        )
        const tWidget = Date.now()
        widgetService.syncWithActiveProjects(activeProjectIds)
        const widgetMs = Date.now() - tWidget
        if (widgetMs > 200) log.warn(`[DIAG] widget syncWithActiveProjects: ${widgetMs}ms`)

        const timestamps = await this.getLatestPromptTimestamps()

        const idleTimeoutStr = settingsService.getSetting('idle_timeout_minutes')
        const parsed = idleTimeoutStr ? parseInt(idleTimeoutStr, 10) : NaN
        const idleTimeoutMinutes = Number.isNaN(parsed) ? DEFAULT_IDLE_TIMEOUT_MINUTES : parsed

        // Hide widgets that have been idle for 1 hour (matches widget "idle" text threshold)
        if (settingsService.getSetting('hide_inactive_widgets') !== 'false') {
          const now = Date.now()
          const WIDGET_IDLE_MS = 3600_000 // 1 hour — same as FloatingWidget's "idle" cutoff
          const notIdleIds = new Set<number>()
          const db2 = getDb()
          const allProjects = db2
            .select({ id: projects.id, directoryPath: projects.directoryPath })
            .from(projects)
            .where(eq(projects.isActive, true))
            .all()
          for (const p of allProjects) {
            const encoded = encodeProjectPath(p.directoryPath)
            const ts = timestamps.get(encoded)
            if (!ts) continue
            if (ts.isProcessing) {
              notIdleIds.add(p.id)
            } else {
              const idleStart = this._idleSince.get(p.id) ?? new Date(ts.lastPromptAt).getTime()
              if (now - idleStart < WIDGET_IDLE_MS) {
                notIdleIds.add(p.id)
              }
            }
          }
          const tIdle = Date.now()
          widgetService.syncIdleState(notIdleIds)
          const idleMs = Date.now() - tIdle
          if (idleMs > 200) log.warn(`[DIAG] widget syncIdleState: ${idleMs}ms`)
        }
        {
          const tickMs = Date.now() - tickStart
          if (tickMs > 500) log.warn(`[DIAG] monitor tick (pre-alert phase): ${tickMs}ms`)
        }

        // Check if desktop alerts are enabled globally
        const alertsEnabled = settingsService.getSetting('desktop_alerts_enabled') !== 'false'
        if (!alertsEnabled) return

        // Respect alert threshold mode setting
        const alertMode = settingsService.getSetting('alert_threshold_mode') ?? 'percent'
        let thresholdMs: number
        if (alertMode === 'minutes') {
          const alertMin =
            parseInt(settingsService.getSetting('alert_threshold_minutes') ?? '5', 10) || 5
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

        log.debug(
          `Alert check: ${watchedConfigs.length} watched, ${timestamps.size} timestamps, threshold ${Math.round(thresholdMs / 1000)}s`
        )

        for (const config of watchedConfigs) {
          // Match encoded .claude/projects/ dir name against project's directoryPath
          let lastPromptAt: string | null = null
          let isProcessing = false
          const encodedConfigPath = encodeProjectPath(config.directoryPath)
          for (const [key, value] of timestamps) {
            if (key === encodedConfigPath) {
              lastPromptAt = value.lastPromptAt
              isProcessing = value.isProcessing
              break
            }
          }

          if (!lastPromptAt) continue

          // Don't alert while AI is actively processing — it's not idle
          if (isProcessing) {
            this._wasProcessing.set(config.projectId, true)
            continue
          }

          // Track processing → idle transition to get accurate idle start time
          const prevWasProcessing = this._wasProcessing.get(config.projectId) ?? false
          if (prevWasProcessing) {
            this._wasProcessing.set(config.projectId, false)
            this._idleSince.set(config.projectId, now)
            this._alertedGaps.delete(config.projectId) // reset alert for new idle period
          }
          // New prompt resets idle tracking
          const prevAlertPrompt = this._alertedGaps.get(config.projectId)
          if (prevAlertPrompt && prevAlertPrompt !== lastPromptAt) {
            this._idleSince.set(config.projectId, new Date(lastPromptAt).getTime())
            this._alertedGaps.delete(config.projectId)
          }
          if (!this._idleSince.has(config.projectId)) {
            this._idleSince.set(config.projectId, now)
          }

          const elapsed = now - this._idleSince.get(config.projectId)!
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
            const elapsedSec = Math.round(elapsed / 1000)
            const idleText = elapsedSec < 60 ? `${elapsedSec}s` : `${Math.round(elapsedSec / 60)}m`
            log.info(
              `Alert: ${projectName} idle ${idleText} (threshold ${Math.round(thresholdMs / 60_000)}m)`
            )

            if (Notification.isSupported()) {
              const useSystemSound = config.alertSound === 'system'
              const notification = new Notification({
                title: `⏳ ${projectName}`,
                body: `Prompt ready — idle ${idleText}`,
                silent: !useSystemSound
              })
              notification.on('show', () => log.info(`Notification displayed for ${projectName}`))
              notification.on('failed', (_e, err) =>
                log.warn(`Notification failed for ${projectName}:`, err)
              )
              notification.show()
            } else {
              log.warn('Notifications not supported on this system')
            }

            if (config.alertSound !== 'system') {
              this.playSound(config.alertSound)
            }
            // Notify floating widget
            try {
              widgetService.notifyAlert(projectName)
            } catch {
              /* widget may not be open */
            }
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
      alertSound: !row?.alertSound || row.alertSound === 'default' ? 'system' : row.alertSound,
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
async function tailReadLastPrompt(filePath: string): Promise<{
  lastPromptAt: string | null
  awaitingResponse: boolean
  state: 'idle' | 'awaiting' | 'tool-pending' | 'processing'
}> {
  let fh: Awaited<ReturnType<typeof open>> | null = null
  try {
    fh = await open(filePath, 'r')
    const fileStat = await fh.stat()
    const fileSize = fileStat.size

    // Read backwards in chunks to find the last user prompt.
    // Start with 64KB, double if no user prompt found (up to 512KB).
    let lastPromptAt: string | null = null
    let lines: string[] = []
    for (let chunkSize = 65536; chunkSize <= 524288; chunkSize *= 2) {
      const readSize = Math.min(chunkSize, fileSize)
      const position = Math.max(0, fileSize - readSize)
      const buffer = Buffer.alloc(readSize)

      await fh.read(buffer, 0, readSize, position)
      const content = buffer.toString('utf-8')

      const allLines = content.split('\n').filter((l) => l.trim())
      // Skip the first line if we didn't read from the start — it's likely truncated
      lines = position > 0 ? allLines.slice(1) : allLines

      // Check if we found a user prompt in this chunk
      const hasUserPrompt = lines.some((l) => {
        try {
          const obj = JSON.parse(l)
          return obj.type === 'user' && !obj.toolUseResult && obj.timestamp
        } catch {
          return false
        }
      })
      if (hasUserPrompt || readSize >= fileSize) break
    }
    // Track session state to detect if Claude is actively working:
    // 'idle'         = Claude gave a final response, ball is in user's court → isProcessing=false (green/yellow/red glow)
    // 'awaiting'     = User sent a prompt, Claude hasn't responded yet → isProcessing=true (purple glow)
    // 'tool-pending' = Claude called a tool, waiting for result → isProcessing=true (purple glow)
    // 'processing'   = Tool result returned, Claude generating next response → isProcessing=true (purple glow)
    let lastMessageState: 'idle' | 'awaiting' | 'tool-pending' | 'processing' = 'idle'
    const recentTransitions: string[] = []
    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'user' && !obj.toolUseResult && obj.timestamp) {
          lastPromptAt = obj.timestamp
          lastMessageState = 'awaiting'
          recentTransitions.push(`user-prompt(${obj.timestamp})`)
        } else if (obj.type === 'user' && obj.toolUseResult) {
          // Tool result returned — Claude is about to generate next response
          lastMessageState = 'processing'
          recentTransitions.push('tool-result')
        } else if (obj.type === 'assistant') {
          const hasToolUse =
            Array.isArray(obj.message?.content) &&
            obj.message.content.some((b: { type?: string }) => b.type === 'tool_use')
          lastMessageState = hasToolUse ? 'tool-pending' : 'idle'
          recentTransitions.push(hasToolUse ? 'assistant-tools' : 'assistant-idle')
        }
      } catch {
        continue
      }
    }

    // Detect post-compaction state: after /compact rewrites the JSONL, the tail
    // contains multiple consecutive user-prompt entries (compacted context chunks)
    // with no assistant messages between them. This makes the state machine report
    // 'awaiting' even though Claude already responded. Detect 3+ consecutive
    // user-prompts at the end and treat as idle.
    if (lastMessageState === 'awaiting') {
      let consecutiveUserPrompts = 0
      for (let i = recentTransitions.length - 1; i >= 0; i--) {
        if (recentTransitions[i].startsWith('user-prompt')) {
          consecutiveUserPrompts++
        } else {
          break
        }
      }
      if (consecutiveUserPrompts >= 3) {
        lastMessageState = 'idle'
        recentTransitions.push('→compaction-detected-idle')
      }
    }

    // Session is active if Claude is processing, awaiting, or has a pending tool
    const awaitingResponse = lastMessageState !== 'idle'

    return { lastPromptAt, awaitingResponse, state: lastMessageState }
  } catch (err) {
    log.debug(`tailReadLastPrompt error for ${filePath}:`, err)
    return { lastPromptAt: null, awaitingResponse: false, state: 'idle' }
  } finally {
    await fh?.close()
  }
}
