import { eq, and, gte, lte, type SQL } from 'drizzle-orm'
import log from 'electron-log/main.js'
import { getDb } from '../db'
import { sessions } from '../db/schema/sessions'
import { projects } from '../db/schema/projects'
import { clients } from '../db/schema/clients'
import { getProjectName } from '../../shared/paths'
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
  return d.toLocaleDateString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
}

export const reportService = {
  generateReport(filters: ReportFilters, format: ReportFormat): ReportResult {
    const startTime = Date.now()
    const db = getDb()

    // Build query conditions
    const conditions: SQL[] = [
      gte(sessions.startedAt, filters.startDate),
      lte(sessions.endedAt, filters.endDate)
    ]
    if (filters.clientId != null) {
      conditions.push(eq(sessions.clientId, filters.clientId))
    }
    if (filters.projectId != null) {
      conditions.push(eq(sessions.projectId, filters.projectId))
    }

    // Fetch sessions
    let rows = db
      .select()
      .from(sessions)
      .where(and(...conditions))
      .orderBy(sessions.startedAt)
      .all()

    // After-hours filter: exclude sessions starting between 7am–6pm
    if (filters.afterHoursOnly) {
      rows = rows.filter((row) => {
        const hour = new Date(row.startedAt).getHours()
        return hour < 7 || hour >= 18
      })
    }

    // Build lookup maps for project and client names/rates
    const projectMap = new Map<number, { name: string; clientId: number | null }>()
    const clientMap = new Map<number, string>()
    const clientRateMap = new Map<number, number>()

    const allProjects = db.select().from(projects).all()
    for (const p of allProjects) {
      projectMap.set(p.id, { name: p.name, clientId: p.clientId })
    }
    const allClients = db.select().from(clients).all()
    for (const c of allClients) {
      clientMap.set(c.id, c.name)
      if (c.billableRate != null) clientRateMap.set(c.id, c.billableRate)
    }

    const getProjectInfo = (row: typeof rows[0]) => {
      if (row.projectId != null) {
        const proj = projectMap.get(row.projectId)
        const projName = proj?.name ?? getProjectName(row.projectPath)
        const clientName = row.clientId != null ? clientMap.get(row.clientId) ?? null : null
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
        const dayMap = new Map<string, {
          sessionCount: number
          totalDuration: number
          totalPrompts: number
          totalInput: number
          totalOutput: number
          projects: Set<string>
        }>()

        for (const row of rows) {
          const key = getDateKey(row.startedAt)
          const existing = dayMap.get(key) ?? {
            sessionCount: 0,
            totalDuration: 0,
            totalPrompts: 0,
            totalInput: 0,
            totalOutput: 0,
            projects: new Set<string>()
          }
          existing.sessionCount++
          existing.totalDuration += row.durationMinutes
          existing.totalPrompts += row.promptCount
          existing.totalInput += row.inputTokens
          existing.totalOutput += row.outputTokens
          existing.projects.add(getProjectInfo(row).projectName)
          dayMap.set(key, existing)
        }

        const items: DailySummaryItem[] = Array.from(dayMap.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, data]) => ({
            date: formatDateLabel(date + 'T00:00:00Z'),
            sessionCount: data.sessionCount,
            totalDurationMinutes: data.totalDuration,
            totalPrompts: data.totalPrompts,
            totalInputTokens: data.totalInput,
            totalOutputTokens: data.totalOutput,
            projects: Array.from(data.projects)
          }))

        result.dailySummary = items
        break
      }

      case 'period-summary': {
        const projectAgg = new Map<string, {
          clientName: string | null
          sessionCount: number
          totalDuration: number
          totalPrompts: number
          totalInput: number
          totalOutput: number
        }>()

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
      return { clientName: b.clientName, hours, rate: b.rate, cost: Math.round(hours * b.rate * 100) / 100 }
    })

    result.summary = {
      totalSessions: rows.length,
      totalDurationMinutes: rows.reduce((s, r) => s + r.durationMinutes, 0),
      totalPrompts: rows.reduce((s, r) => s + r.promptCount, 0),
      totalInputTokens: rows.reduce((s, r) => s + r.inputTokens, 0),
      totalOutputTokens: rows.reduce((s, r) => s + r.outputTokens, 0),
      totalBilledCost: billedByClient.reduce((s, b) => s + b.cost, 0),
      billedByClient
    }

    const durationMs = Date.now() - startTime
    log.info(`Report generated (${format}) in ${durationMs}ms: ${rows.length} sessions`)

    return result
  }
}
