import { eq, and, gte, lte, or, isNull, notInArray, type SQL } from 'drizzle-orm'
import log from 'electron-log/main.js'
import { getDb } from '../db'
import { sessions } from '../db/schema/sessions'
import { projects } from '../db/schema/projects'
import { clients } from '../db/schema/clients'
import { getProjectName } from '../../shared/paths'
import { computeEarnings } from '../../shared/earnings'
import { clientAlias, projectAlias } from '../../shared/presentation-alias'
import { clientProjectService } from './client-project-service'
import { settingsService } from './settings-service'
import type {
  ReportFilters,
  ReportFormat,
  ReportResult,
  ReportSummary,
  SessionLineItem,
  DailySummaryItem,
  PeriodProjectItem,
  PeriodSummary
} from '../../shared/types/report'

function getDateKey(isoString: string): string {
  const d = new Date(isoString)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatDateLabel(isoString: string): string {
  const d = new Date(isoString)
  return d.toLocaleDateString([], {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

export const reportService = {
  generateReport(filters: ReportFilters, format: ReportFormat): ReportResult {
    const startTime = Date.now()
    const db = getDb()
    const rangeStartMs = new Date(filters.startDate).getTime()
    const rangeEndMs = new Date(filters.endDate).getTime()

    // Include any session that overlaps the date range
    // (started before range end AND ended after range start)
    const conditions: SQL[] = [
      lte(sessions.startedAt, filters.endDate),
      gte(sessions.endedAt, filters.startDate)
    ]

    // Exclude inactive projects
    const excludedIds = clientProjectService.getExcludedProjectIds()
    if (excludedIds.length > 0) {
      conditions.push(or(isNull(sessions.projectId), notInArray(sessions.projectId, excludedIds))!)
    }

    if (filters.clientId != null) {
      conditions.push(eq(sessions.clientId, filters.clientId))
    }
    if (filters.projectId != null) {
      conditions.push(eq(sessions.projectId, filters.projectId))
    }
    if (filters.billableFilter === 'billable') {
      conditions.push(eq(sessions.billable, 1))
    } else if (filters.billableFilter === 'non-billable') {
      conditions.push(eq(sessions.billable, 0))
    }

    // Fetch sessions and pro-rate those that extend beyond the filter range
    let rows = db
      .select()
      .from(sessions)
      .where(and(...conditions))
      .orderBy(sessions.startedAt)
      .all()
      .map((row) => {
        const sMs = new Date(row.startedAt).getTime()
        const eMs = new Date(row.endedAt).getTime()
        const clampedStart = Math.max(sMs, rangeStartMs)
        const clampedEnd = Math.min(eMs, rangeEndMs)
        const clampedMinutes = Math.round(Math.max(0, clampedEnd - clampedStart) / 60_000)
        // Only modify if session actually extends beyond range
        if (sMs < rangeStartMs || eMs > rangeEndMs) {
          const ratio = row.durationMinutes > 0 ? clampedMinutes / row.durationMinutes : 1
          return {
            ...row,
            startedAt: new Date(clampedStart).toISOString(),
            endedAt: new Date(clampedEnd).toISOString(),
            durationMinutes: clampedMinutes,
            // Pro-rate tokens and prompts proportionally
            promptCount: Math.round(row.promptCount * ratio),
            inputTokens: Math.round(row.inputTokens * ratio),
            outputTokens: Math.round(row.outputTokens * ratio)
          }
        }
        return row
      })

    // After-hours filter: exclude sessions starting between 7am–6pm
    if (filters.afterHoursOnly) {
      rows = rows.filter((row) => {
        const hour = new Date(row.startedAt).getHours()
        return hour < 7 || hour >= 18
      })
    }

    // Build lookup maps for project and client names/rates
    const presentationMode = settingsService.getSetting('presentation_mode') === 'true'
    const projectMap = new Map<
      number,
      { name: string; stageName: string | null; clientId: number; hourlyRate: number | null }
    >()
    const clientMap = new Map<number, string>()
    const clientRateMap = new Map<number, number>()

    const allProjects = db.select().from(projects).all()
    for (const p of allProjects) {
      projectMap.set(p.id, {
        name: p.name,
        stageName: p.stageName ?? null,
        clientId: p.clientId,
        hourlyRate: p.hourlyRate ?? null
      })
    }
    const allClients = db.select().from(clients).all()
    for (const c of allClients) {
      clientMap.set(c.id, presentationMode ? c.stageName || clientAlias(c.id) : c.name)
      if (c.billableRate != null) clientRateMap.set(c.id, c.billableRate)
    }

    const getProjectInfo = (row: (typeof rows)[0]) => {
      if (row.projectId != null) {
        const proj = projectMap.get(row.projectId)
        const rawName = proj?.name ?? getProjectName(row.projectPath)
        const projName = presentationMode
          ? proj?.stageName || projectAlias(row.projectId)
          : rawName
        const clientName = row.clientId != null ? (clientMap.get(row.clientId) ?? null) : null
        return { projectName: projName, clientName }
      }
      return { projectName: getProjectName(row.projectPath), clientName: null }
    }

    const result: ReportResult = {
      format,
      filters,
      generatedAt: new Date().toISOString(),
      summary: null as unknown as ReportSummary // computed after format switch
    }

    switch (format) {
      case 'session-breakdown': {
        const items: SessionLineItem[] = rows.map((row) => {
          const { projectName, clientName } = getProjectInfo(row)
          return {
            date: formatDateLabel(row.startedAt),
            projectName,
            clientName,
            startedAt: row.startedAt,
            endedAt: row.endedAt,
            durationMinutes: row.durationMinutes,
            promptCount: row.promptCount,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            description: row.description,
            source: row.source as 'auto' | 'manual'
          }
        })
        result.sessionBreakdown = items
        break
      }

      case 'daily-summary': {
        const dayMap = new Map<
          string,
          {
            sessionCount: number
            totalDuration: number
            totalPrompts: number
            totalInput: number
            totalOutput: number
            projects: Set<string>
            breakdown: Map<
              string,
              {
                clientName: string | null
                projectName: string
                sessionCount: number
                totalDuration: number
                totalPrompts: number
                totalInput: number
                totalOutput: number
              }
            >
          }
        >()

        for (const row of rows) {
          const key = getDateKey(row.startedAt)
          const existing = dayMap.get(key) ?? {
            sessionCount: 0,
            totalDuration: 0,
            totalPrompts: 0,
            totalInput: 0,
            totalOutput: 0,
            projects: new Set<string>(),
            breakdown: new Map()
          }
          const { projectName, clientName } = getProjectInfo(row)
          existing.sessionCount++
          existing.totalDuration += row.durationMinutes
          existing.totalPrompts += row.promptCount
          existing.totalInput += row.inputTokens
          existing.totalOutput += row.outputTokens
          existing.projects.add(projectName)

          const bKey = `${clientName ?? ''}::${projectName}`
          const bp = existing.breakdown.get(bKey) ?? {
            clientName,
            projectName,
            sessionCount: 0,
            totalDuration: 0,
            totalPrompts: 0,
            totalInput: 0,
            totalOutput: 0
          }
          bp.sessionCount++
          bp.totalDuration += row.durationMinutes
          bp.totalPrompts += row.promptCount
          bp.totalInput += row.inputTokens
          bp.totalOutput += row.outputTokens
          existing.breakdown.set(bKey, bp)

          dayMap.set(key, existing)
        }

        const items: DailySummaryItem[] = Array.from(dayMap.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, data]) => ({
            date: formatDateLabel(date + 'T12:00:00'),
            sessionCount: data.sessionCount,
            totalDurationMinutes: data.totalDuration,
            totalPrompts: data.totalPrompts,
            totalInputTokens: data.totalInput,
            totalOutputTokens: data.totalOutput,
            projects: Array.from(data.projects),
            breakdown: Array.from(data.breakdown.values())
              .sort(
                (a, b) =>
                  (a.clientName ?? '').localeCompare(b.clientName ?? '') ||
                  a.projectName.localeCompare(b.projectName)
              )
              .map((bp) => ({
                clientName: bp.clientName,
                projectName: bp.projectName,
                sessionCount: bp.sessionCount,
                totalDurationMinutes: bp.totalDuration,
                totalPrompts: bp.totalPrompts,
                totalInputTokens: bp.totalInput,
                totalOutputTokens: bp.totalOutput
              }))
          }))

        result.dailySummary = items
        break
      }

      case 'period-summary': {
        const projectAgg = new Map<
          string,
          {
            clientName: string | null
            sessionCount: number
            totalDuration: number
            totalPrompts: number
            totalInput: number
            totalOutput: number
          }
        >()

        for (const row of rows) {
          const { projectName, clientName } = getProjectInfo(row)
          const existing = projectAgg.get(projectName) ?? {
            clientName,
            sessionCount: 0,
            totalDuration: 0,
            totalPrompts: 0,
            totalInput: 0,
            totalOutput: 0
          }
          existing.sessionCount++
          existing.totalDuration += row.durationMinutes
          existing.totalPrompts += row.promptCount
          existing.totalInput += row.inputTokens
          existing.totalOutput += row.outputTokens
          projectAgg.set(projectName, existing)
        }

        const projectItems: PeriodProjectItem[] = Array.from(projectAgg.entries())
          .sort(([, a], [, b]) => b.totalDuration - a.totalDuration)
          .map(([name, data]) => ({
            projectName: name,
            clientName: data.clientName,
            sessionCount: data.sessionCount,
            totalDurationMinutes: data.totalDuration,
            totalPrompts: data.totalPrompts,
            totalInputTokens: data.totalInput,
            totalOutputTokens: data.totalOutput
          }))

        const summary: PeriodSummary = {
          startDate: filters.startDate,
          endDate: filters.endDate,
          totalSessions: rows.length,
          totalDurationMinutes: rows.reduce((s, r) => s + r.durationMinutes, 0),
          totalPrompts: rows.reduce((s, r) => s + r.promptCount, 0),
          totalInputTokens: rows.reduce((s, r) => s + r.inputTokens, 0),
          totalOutputTokens: rows.reduce((s, r) => s + r.outputTokens, 0),
          projects: projectItems
        }
        result.periodSummary = summary
        break
      }
    }

    // Compute summary with billing
    const billedAgg = new Map<number, { clientName: string; minutes: number; rate: number }>()
    for (const row of rows) {
      if (row.clientId != null && clientRateMap.has(row.clientId)) {
        const existing = billedAgg.get(row.clientId)
        if (existing) {
          existing.minutes += row.durationMinutes
        } else {
          billedAgg.set(row.clientId, {
            clientName: clientMap.get(row.clientId) ?? 'Unknown',
            minutes: row.durationMinutes,
            rate: clientRateMap.get(row.clientId)!
          })
        }
      }
    }

    const billedByClient = Array.from(billedAgg.values()).map((b) => {
      const hours = Math.round((b.minutes / 60) * 100) / 100
      return {
        clientName: b.clientName,
        hours,
        rate: b.rate,
        cost: Math.round(hours * b.rate * 100) / 100
      }
    })

    const totalEarned = computeEarnings(rows, allProjects, allClients)

    result.summary = {
      totalSessions: rows.length,
      totalDurationMinutes: rows.reduce((s, r) => s + r.durationMinutes, 0),
      totalPrompts: rows.reduce((s, r) => s + r.promptCount, 0),
      totalInputTokens: rows.reduce((s, r) => s + r.inputTokens, 0),
      totalOutputTokens: rows.reduce((s, r) => s + r.outputTokens, 0),
      totalBilledCost: billedByClient.reduce((s, b) => s + b.cost, 0),
      billedByClient,
      totalEarned: Math.round(totalEarned * 100) / 100
    }

    const durationMs = Date.now() - startTime
    log.info(`Report generated (${format}) in ${durationMs}ms: ${rows.length} sessions`)

    return result
  }
}
