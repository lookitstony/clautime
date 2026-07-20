/**
 * Browser mock of the preload `window.api` bridge, backed by the sample
 * dataset in mock-data.ts. Mutations (edit session, create client, draft an
 * invoice, redact a secret…) update in-memory state, so the demo behaves like
 * the real app until the page is reloaded. Nothing leaves the browser.
 */
import { ipcSuccess, ipcError, type IpcResult } from '../../../shared/types/ipc'
import type {
  Session,
  SessionFilters,
  PromptTiming,
  ScanResult,
  UpdateSession,
  TimeBreakdownDay,
  GapAnalysis,
  ModelUsageAggregate,
  ModelUsageFilters
} from '../../../shared/types/session'
import type {
  Client,
  NewClient,
  UpdateClient,
  Project,
  NewProject,
  UpdateProject
} from '../../../shared/types/client-project'
import type {
  ReportFilters,
  ReportFormat,
  ReportResult,
  SessionLineItem,
  DailySummaryItem,
  DailyProjectBreakdown,
  PeriodProjectItem
} from '../../../shared/types/report'
import type {
  CreateInvoiceRequest,
  DraftInvoice,
  InvoiceStatus,
  GeneratedLineItem,
  GenerateLineItemsResult,
  LocalInvoice,
  LocalInvoiceDetail,
  InvoiceOverlap
} from '../../../shared/types/invoice'
import type { TodayStats, ProjectLiveStatus, ProjectAlertConfig } from '../../../shared/types/live'
import type { CustomSecretPattern, PatternTestResult, SecretScanSummary } from '../../../shared/types/secret-scan'
import {
  clients,
  projects,
  sessions,
  sessionModelUsage,
  aiSummaries,
  gitCommits,
  settings,
  secretFindings,
  customPatterns,
  invoices,
  seedInvoicePeriod,
  availableSounds,
  effectiveRate
} from './mock-data'

const ok = <T,>(data: T): Promise<IpcResult<T>> => Promise.resolve(ipcSuccess(data))
const noop = (): void => undefined

// ── helpers ──

function fmtDur(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  const h = Math.floor(m / 60)
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`
}

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Parse a filter date; bare YYYY-MM-DD end dates are treated as inclusive. */
function parseStart(s: string): number {
  return new Date(s.length <= 10 ? `${s}T00:00:00` : s).getTime()
}
function parseEnd(s: string): number {
  if (s.length <= 10) return new Date(`${s}T00:00:00`).getTime() + 86_400_000
  return new Date(s).getTime()
}

function projectFor(s: Session): Project | undefined {
  return projects.find((p) => p.id === s.projectId)
}
function projectName(s: Session): string {
  return projectFor(s)?.name ?? s.projectPath.split(/[/\\]/).pop() ?? s.projectPath
}
function clientName(s: Session): string | null {
  return clients.find((c) => c.id === s.clientId)?.name ?? null
}

function isAfterHours(s: Session): boolean {
  const d = new Date(s.startedAt)
  const dow = d.getDay()
  return dow === 0 || dow === 6 || d.getHours() < 8 || d.getHours() >= 18
}

function filterSessions(f?: {
  startDate?: string
  endDate?: string
  clientId?: number
  projectId?: number
  projectPath?: string
  source?: 'auto' | 'manual'
  afterHoursOnly?: boolean
  billableFilter?: 'all' | 'billable' | 'non-billable'
  sessionIds?: number[]
}): Session[] {
  return sessions.filter((s) => {
    if (f?.startDate && new Date(s.startedAt).getTime() < parseStart(f.startDate)) return false
    if (f?.endDate && new Date(s.startedAt).getTime() >= parseEnd(f.endDate)) return false
    if (f?.clientId != null && s.clientId !== f.clientId) return false
    if (f?.projectId != null && s.projectId !== f.projectId) return false
    if (f?.projectPath && s.projectPath !== f.projectPath) return false
    if (f?.source && s.source !== f.source) return false
    if (f?.afterHoursOnly && !isAfterHours(s)) return false
    if (f?.billableFilter === 'billable' && !s.billable) return false
    if (f?.billableFilter === 'non-billable' && s.billable) return false
    if (f?.sessionIds && !f.sessionIds.includes(s.id)) return false
    return true
  })
}

function todaySessions(): Session[] {
  const key = localDateKey(new Date())
  return sessions.filter((s) => localDateKey(new Date(s.startedAt)) === key)
}

// ── report generation (mirrors report-service output shapes) ──

function buildReport(filters: ReportFilters, format: ReportFormat): ReportResult {
  const rows = filterSessions(filters).sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
  )

  const billedMap = new Map<string, { hours: number; rate: number; cost: number }>()
  let totalBilled = 0
  for (const s of rows) {
    if (!s.billable) continue
    const rate = effectiveRate(s.projectId, s.clientId)
    if (rate == null) continue
    const name = clientName(s) ?? 'Unknown'
    const entry = billedMap.get(name) ?? { hours: 0, rate, cost: 0 }
    entry.hours += s.durationMinutes / 60
    entry.cost += (s.durationMinutes / 60) * rate
    billedMap.set(name, entry)
    totalBilled += (s.durationMinutes / 60) * rate
  }

  const summary = {
    totalSessions: rows.length,
    totalDurationMinutes: rows.reduce((a, s) => a + s.durationMinutes, 0),
    totalPrompts: rows.reduce((a, s) => a + s.promptCount, 0),
    totalInputTokens: rows.reduce((a, s) => a + s.inputTokens, 0),
    totalOutputTokens: rows.reduce((a, s) => a + s.outputTokens, 0),
    totalBilledCost: totalBilled,
    billedByClient: [...billedMap.entries()].map(([name, e]) => ({
      clientName: name,
      hours: e.hours,
      rate: e.rate,
      cost: e.cost
    })),
    totalEarned: totalBilled
  }

  const result: ReportResult = {
    format,
    filters,
    generatedAt: new Date().toISOString(),
    summary
  }

  if (format === 'session-breakdown') {
    result.sessionBreakdown = rows.map(
      (s): SessionLineItem => ({
        date: localDateKey(new Date(s.startedAt)),
        projectName: projectName(s),
        clientName: clientName(s),
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationMinutes: s.durationMinutes,
        promptCount: s.promptCount,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        description: s.description ?? aiSummaries.get(s.id) ?? null,
        source: s.source
      })
    )
  } else if (format === 'daily-summary') {
    const byDay = new Map<string, Session[]>()
    for (const s of rows) {
      const key = localDateKey(new Date(s.startedAt))
      byDay.set(key, [...(byDay.get(key) ?? []), s])
    }
    result.dailySummary = [...byDay.entries()].map(([date, list]): DailySummaryItem => {
      const byProject = new Map<string, Session[]>()
      for (const s of list) {
        const key = `${clientName(s) ?? ''}|${projectName(s)}`
        byProject.set(key, [...(byProject.get(key) ?? []), s])
      }
      const breakdown: DailyProjectBreakdown[] = [...byProject.values()].map((group) => ({
        clientName: clientName(group[0]),
        projectName: projectName(group[0]),
        sessionCount: group.length,
        totalDurationMinutes: group.reduce((a, s) => a + s.durationMinutes, 0),
        totalPrompts: group.reduce((a, s) => a + s.promptCount, 0),
        totalInputTokens: group.reduce((a, s) => a + s.inputTokens, 0),
        totalOutputTokens: group.reduce((a, s) => a + s.outputTokens, 0)
      }))
      return {
        date,
        sessionCount: list.length,
        totalDurationMinutes: list.reduce((a, s) => a + s.durationMinutes, 0),
        totalPrompts: list.reduce((a, s) => a + s.promptCount, 0),
        totalInputTokens: list.reduce((a, s) => a + s.inputTokens, 0),
        totalOutputTokens: list.reduce((a, s) => a + s.outputTokens, 0),
        projects: [...new Set(list.map((s) => projectName(s)))],
        breakdown
      }
    })
  } else {
    const byProject = new Map<string, Session[]>()
    for (const s of rows) {
      const key = `${clientName(s) ?? ''}|${projectName(s)}`
      byProject.set(key, [...(byProject.get(key) ?? []), s])
    }
    result.periodSummary = {
      startDate: filters.startDate,
      endDate: filters.endDate,
      totalSessions: rows.length,
      totalDurationMinutes: summary.totalDurationMinutes,
      totalPrompts: summary.totalPrompts,
      totalInputTokens: summary.totalInputTokens,
      totalOutputTokens: summary.totalOutputTokens,
      projects: [...byProject.values()].map(
        (group): PeriodProjectItem => ({
          projectName: projectName(group[0]),
          clientName: clientName(group[0]),
          sessionCount: group.length,
          totalDurationMinutes: group.reduce((a, s) => a + s.durationMinutes, 0),
          totalPrompts: group.reduce((a, s) => a + s.promptCount, 0),
          totalInputTokens: group.reduce((a, s) => a + s.inputTokens, 0),
          totalOutputTokens: group.reduce((a, s) => a + s.outputTokens, 0)
        })
      )
    }
  }
  return result
}

// ── invoice generation ──

function generateLineItems(req: {
  clientId: number
  startDate: string
  endDate: string
  projectId?: number
}): GenerateLineItemsResult {
  const rows = filterSessions({
    startDate: req.startDate,
    endDate: req.endDate,
    clientId: req.clientId,
    projectId: req.projectId,
    billableFilter: 'billable'
  })
  const byDay = new Map<string, Session[]>()
  for (const s of rows) {
    const key = localDateKey(new Date(s.startedAt))
    byDay.set(key, [...(byDay.get(key) ?? []), s])
  }
  const lineItems: GeneratedLineItem[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([lineDate, list]) => {
      const minutes = list.reduce((a, s) => a + s.durationMinutes, 0)
      const amountCents = list.reduce((a, s) => {
        const rate = effectiveRate(s.projectId, s.clientId) ?? 0
        return a + Math.round((s.durationMinutes / 60) * rate * 100)
      }, 0)
      const names = [...new Set(list.map((s) => projectName(s)))]
      const desc =
        list.map((s) => aiSummaries.get(s.id)).find(Boolean) ??
        list.find((s) => s.description)?.description ??
        'Development work'
      const [m, d, y] = [lineDate.slice(5, 7), lineDate.slice(8, 10), lineDate.slice(2, 4)]
      return {
        lineDate,
        description: `${m}/${d}/${y} ${names.join(', ')}: ${desc}`,
        amountCents,
        durationMinutes: minutes,
        sessionIds: list.map((s) => s.id),
        projectNames: names
      }
    })
  const client = clients.find((c) => c.id === req.clientId)
  const memo = lineItems.length
    ? `Development services for ${client?.name ?? 'client'}, ${req.startDate} through ${req.endDate}. Includes feature work, code review, and deployment support tracked automatically from Claude Code sessions.`
    : null
  return { lineItems, memo }
}

let nextInvoiceId = 1
let stripeSeq = 4821
function createLocalInvoice(
  req: CreateInvoiceRequest,
  status: InvoiceStatus['status'],
  createdAt: string,
  paidAt: string | null = null
): LocalInvoiceDetail {
  const client = clients.find((c) => c.id === req.clientId)
  const amount = req.lineItems.reduce((a, li) => a + li.amountCents, 0)
  const created = new Date(createdAt)
  const due = new Date(created.getTime() + (req.daysUntilDue ?? 30) * 86_400_000)
  const inv: LocalInvoiceDetail = {
    id: nextInvoiceId++,
    clientId: req.clientId,
    clientName: client?.name ?? 'Unknown',
    stripeInvoiceId: `in_1Demo${(stripeSeq++).toString(36).toUpperCase().padStart(10, 'X')}`,
    status,
    amountDueCents: amount,
    amountPaidCents: status === 'paid' ? amount : 0,
    currency: 'usd',
    memo: req.memo ?? null,
    hostedUrl: null,
    invoicePdf: null,
    dueDate: status === 'draft' ? null : due.toISOString(),
    paidAt,
    periodStart: req.periodStart ?? null,
    periodEnd: req.periodEnd ?? null,
    testMode: true,
    createdAt,
    lineItems: req.lineItems.map((li, i) => ({
      id: i + 1,
      lineDate: req.lineMeta?.[i]?.lineDate ?? null,
      description: li.description,
      amountCents: li.amountCents,
      durationMinutes: req.lineMeta?.[i]?.durationMinutes ?? null,
      sessionIds: req.lineMeta?.[i]?.sessionIds ?? null,
      sortOrder: i
    }))
  }
  invoices.unshift(inv)
  return inv
}

// Seed invoice history: last month billed for both clients.
for (const [clientId, status, paidDaysAgo] of [
  [1, 'paid', 6],
  [2, 'open', null]
] as [number, InvoiceStatus['status'], number | null][]) {
  const gen = generateLineItems({
    clientId,
    startDate: seedInvoicePeriod.start,
    endDate: seedInvoicePeriod.end
  })
  if (!gen.lineItems.length) continue
  const createdAt = new Date(new Date(`${seedInvoicePeriod.end}T17:00:00`).getTime() + 2 * 86_400_000)
  createLocalInvoice(
    {
      clientId,
      lineItems: gen.lineItems.map((li) => ({ description: li.description, amountCents: li.amountCents })),
      memo: gen.memo ?? undefined,
      periodStart: seedInvoicePeriod.start,
      periodEnd: seedInvoicePeriod.end,
      lineMeta: gen.lineItems.map((li) => ({
        lineDate: li.lineDate,
        durationMinutes: li.durationMinutes,
        sessionIds: li.sessionIds
      }))
    },
    status,
    createdAt.toISOString(),
    paidDaysAgo != null ? new Date(Date.now() - paidDaysAgo * 86_400_000).toISOString() : null
  )
}

const toLocalInvoice = (inv: LocalInvoiceDetail): LocalInvoice => {
  const { lineItems: _li, ...rest } = inv
  return { ...rest }
}
const toStatus = (inv: LocalInvoiceDetail): InvoiceStatus => ({
  invoiceId: inv.stripeInvoiceId,
  status: inv.status,
  amountDueCents: inv.amountDueCents,
  amountPaidCents: inv.amountPaidCents,
  currency: inv.currency,
  hostedUrl: inv.hostedUrl,
  invoicePdf: inv.invoicePdf,
  dueDate: inv.dueDate,
  paidAt: inv.paidAt
})

// ── live state ──

const watchState = new Map<number, { isWatching: boolean; alertSound: string }>([
  [1, { isWatching: true, alertSound: 'system' }],
  [2, { isWatching: true, alertSound: 'chime.wav' }],
  [3, { isWatching: false, alertSound: 'system' }],
  [4, { isWatching: true, alertSound: 'system' }],
  [5, { isWatching: false, alertSound: 'system' }]
])

function liveStatuses(): ProjectLiveStatus[] {
  const today = todaySessions()
  return projects.map((p) => {
    const list = today.filter((s) => s.projectId === p.id)
    const client = clients.find((c) => c.id === p.clientId)
    const state = watchState.get(p.id) ?? { isWatching: false, alertSound: 'system' }
    const allForProject = sessions.filter((s) => s.projectId === p.id)
    const lastEnd = allForProject.length
      ? allForProject.reduce((max, s) => (s.endedAt > max ? s.endedAt : max), allForProject[0].endedAt)
      : null
    // checkout-api looks actively worked on; the rest show their real last activity
    const lastPromptAt =
      p.id === 1 ? new Date(Date.now() - 90_000).toISOString() : (lastEnd ?? null)
    const isProcessing = p.id === 1 && Math.floor(Date.now() / 1000) % 45 < 28
    return {
      projectId: p.id,
      projectName: p.name,
      projectPath: p.directoryPath,
      clientName: client?.name ?? null,
      clientId: p.clientId,
      lastPromptAt,
      isProcessing,
      isWatching: state.isWatching,
      alertSound: state.alertSound,
      totalHours: fmtDur(list.reduce((a, s) => a + s.durationMinutes, 0)),
      sessionCount: list.length,
      totalPrompts: list.reduce((a, s) => a + s.promptCount, 0),
      totalTokens: list.reduce((a, s) => a + s.inputTokens + s.outputTokens, 0),
      totalCommits: gitCommits.filter(
        (c) => c.projectId === p.id && localDateKey(new Date(c.committedAt)) === localDateKey(new Date())
      ).length
    }
  })
}

function todayStats(): TodayStats {
  const today = todaySessions()
  const minutes = today.reduce((a, s) => a + s.durationMinutes, 0)
  const earned = today.reduce((a, s) => {
    if (!s.billable) return a
    const rate = effectiveRate(s.projectId, s.clientId)
    return rate == null ? a : a + (s.durationMinutes / 60) * rate
  }, 0)
  return {
    humanHours: fmtDur(minutes),
    agentHours: fmtDur(Math.round(minutes * 1.7)),
    totalSessions: today.length,
    totalPrompts: today.reduce((a, s) => a + s.promptCount, 0),
    totalTokens: today.reduce((a, s) => a + s.inputTokens + s.outputTokens, 0),
    totalCommits: gitCommits.filter(
      (c) => localDateKey(new Date(c.committedAt)) === localDateKey(new Date())
    ).length,
    earnedToday: earned
  }
}

// ── file download helper (report export in the browser) ──

function downloadText(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

// ── the api ──

let nextSessionId = Math.max(...sessions.map((s) => s.id)) + 1
let nextClientId = Math.max(...clients.map((c) => c.id)) + 1
let nextProjectId = Math.max(...projects.map((p) => p.id)) + 1

const emptyScan: ScanResult = {
  newSessions: 0,
  updatedFiles: 0,
  totalFiles: 128,
  durationMs: 412,
  attributedCount: 0
}

export const mockApi = {
  dialog: {
    openFolder: () => ok<string | null>('/Users/demo/work/new-project'),
    discoverProjects: () =>
      ok([
        {
          projectPath: '/Users/demo/work/new-project',
          projectName: 'new-project',
          encodedName: '-Users-demo-work-new-project',
          hasClaudeDir: true
        }
      ])
  },

  settings: {
    get: (key: string) => ok<string | null>(settings[key] ?? null),
    set: (key: string, value: string) => {
      settings[key] = value
      return ok(undefined)
    },
    getAll: () => ok<Record<string, string>>({ ...settings })
  },

  sessions: {
    scan: () => ok(emptyScan),
    reset: () => ok(undefined),
    rebuild: () => ok(emptyScan),
    scanAndRebuild: () => ok(emptyScan),
    getAll: (filters?: SessionFilters) =>
      ok(
        filterSessions(filters).sort(
          (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
        )
      ),
    getById: (id: number) => ok<Session | null>(sessions.find((s) => s.id === id) ?? null),
    getPromptTimings: (sessionId: number) => {
      const s = sessions.find((x) => x.id === sessionId)
      if (!s) return ok<PromptTiming[]>([])
      const seed = (sessionId * 2654435761) % 97
      const start = new Date(s.startedAt).getTime()
      const span = (s.durationMinutes * 60_000) / Math.max(1, s.promptCount)
      const timings: PromptTiming[] = Array.from({ length: s.promptCount }, (_, i) => {
        const promptAt = start + i * span + ((seed + i * 13) % 30) * 1000
        const latency = 20 + ((seed * (i + 3)) % 160)
        return {
          promptAt: new Date(promptAt).toISOString(),
          responseAt: new Date(promptAt + latency * 1000).toISOString(),
          latencySeconds: latency
        }
      })
      return ok(timings)
    },
    update: (id: number, data: UpdateSession) => {
      const s = sessions.find((x) => x.id === id)
      if (!s) return Promise.resolve(ipcError('NOT_FOUND', 'Session not found'))
      Object.assign(s, data, { updatedAt: new Date().toISOString() })
      if (data.projectId !== undefined) {
        const p = projects.find((x) => x.id === data.projectId)
        if (p) s.clientId = p.clientId
      }
      return ok({ ...s })
    },
    delete: (id: number) => {
      const i = sessions.findIndex((s) => s.id === id)
      if (i >= 0) sessions.splice(i, 1)
      return ok(undefined)
    },
    split: (id: number, splitAt: string) => {
      const s = sessions.find((x) => x.id === id)
      if (!s) return Promise.resolve(ipcError('NOT_FOUND', 'Session not found'))
      const splitMs = new Date(splitAt).getTime()
      const startMs = new Date(s.startedAt).getTime()
      const endMs = new Date(s.endedAt).getTime()
      if (splitMs <= startMs || splitMs >= endMs)
        return Promise.resolve(ipcError('INVALID', 'Split point outside session'))
      const firstMin = Math.round((splitMs - startMs) / 60000)
      const second: Session = {
        ...s,
        id: nextSessionId++,
        startedAt: splitAt,
        durationMinutes: s.durationMinutes - firstMin,
        promptCount: Math.floor(s.promptCount / 2),
        inputTokens: Math.floor(s.inputTokens / 2),
        outputTokens: Math.floor(s.outputTokens / 2)
      }
      s.endedAt = splitAt
      s.durationMinutes = firstMin
      s.promptCount -= second.promptCount
      s.inputTokens -= second.inputTokens
      s.outputTokens -= second.outputTokens
      sessions.push(second)
      return ok([{ ...s }, { ...second }])
    },
    getTimeBreakdown: (startDate: string, endDate: string) => {
      const rows = filterSessions({ startDate, endDate })
      const byDay = new Map<string, number>()
      for (const s of rows) {
        const key = localDateKey(new Date(s.startedAt))
        byDay.set(key, (byDay.get(key) ?? 0) + s.durationMinutes)
      }
      const days: TimeBreakdownDay[] = [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, work]) => {
          const idle = Math.round(work * (0.2 + ((date.charCodeAt(9) * 7) % 20) / 100))
          return { date, workMinutes: work, idleMinutes: idle, totalMinutes: work + idle }
        })
      return ok(days)
    },
    getGapAnalysis: () => {
      const gaps: GapAnalysis = {
        gaps: [
          { minMinutes: 0, maxMinutes: 5, count: 312 },
          { minMinutes: 5, maxMinutes: 10, count: 84 },
          { minMinutes: 10, maxMinutes: 15, count: 41 },
          { minMinutes: 15, maxMinutes: 30, count: 33 },
          { minMinutes: 30, maxMinutes: 60, count: 18 },
          { minMinutes: 60, maxMinutes: 999, count: 26 }
        ],
        sessionCounts: [5, 10, 15, 20, 30, 45, 60].map((timeoutMinutes, i) => ({
          timeoutMinutes,
          estimatedSessions: [212, 158, 131, 118, 104, 96, 91][i],
          workMinutes: [4820, 5210, 5480, 5660, 5890, 6080, 6210][i],
          idleMinutes: [0, 390, 660, 840, 1070, 1260, 1390][i],
          totalTrackedMinutes: [4820, 5600, 6140, 6500, 6960, 7340, 7600][i]
        })),
        totalMessages: 5140
      }
      return ok(gaps)
    },
    getModelUsage: (filters?: ModelUsageFilters) => {
      const rows = filterSessions(filters)
      const byModel = new Map<string, ModelUsageAggregate>()
      for (const s of rows) {
        for (const u of sessionModelUsage.get(s.id) ?? []) {
          const agg = byModel.get(u.model) ?? {
            model: u.model,
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            sessionCount: 0
          }
          agg.inputTokens += u.inputTokens
          agg.outputTokens += u.outputTokens
          agg.cacheCreationInputTokens += u.cacheCreationInputTokens
          agg.cacheReadInputTokens += u.cacheReadInputTokens
          agg.sessionCount += 1
          byModel.set(u.model, agg)
        }
      }
      return ok([...byModel.values()].sort((a, b) => b.outputTokens - a.outputTokens))
    },
    create: (data: {
      projectPath: string
      startedAt: string
      endedAt: string
      durationMinutes: number
      description?: string
      projectId?: number | null
      clientId?: number | null
    }) => {
      const s: Session = {
        id: nextSessionId++,
        projectPath: data.projectPath,
        startedAt: data.startedAt,
        endedAt: data.endedAt,
        durationMinutes: data.durationMinutes,
        source: 'manual',
        description: data.description ?? null,
        status: 'completed',
        tool: 'claude',
        claudeSessionId: null,
        promptCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        sourceFile: null,
        billable: true,
        projectId: data.projectId ?? null,
        clientId: data.clientId ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
      sessions.push(s)
      return ok({ ...s })
    }
  },

  clients: {
    getAll: () => ok(clients.map((c) => ({ ...c }))),
    create: (data: NewClient) => {
      const c: Client = {
        id: nextClientId++,
        name: data.name,
        stageName: data.stageName ?? null,
        color: data.color ?? `var(--project-${((nextClientId - 1) % 8) + 1})`,
        billableRate: data.billableRate ?? null,
        email: data.email ?? null,
        stripeCustomerId: null,
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
      clients.push(c)
      return ok({ ...c })
    },
    update: (id: number, data: UpdateClient) => {
      const c = clients.find((x) => x.id === id)
      if (!c) return Promise.resolve(ipcError('NOT_FOUND', 'Client not found'))
      Object.assign(c, data, { updatedAt: new Date().toISOString() })
      return ok({ ...c })
    },
    delete: (id: number) => {
      const i = clients.findIndex((c) => c.id === id)
      if (i >= 0) clients.splice(i, 1)
      return ok(undefined)
    }
  },

  ai: {
    getMethod: () => ok('api-key'),
    setMethod: () => ok(undefined),
    hasApiKey: () => ok(true),
    storeApiKey: () => ok(undefined),
    removeApiKey: () => ok(undefined),
    testConnection: () => ok(true),
    getSummary: (sessionId: number) => {
      const ai = aiSummaries.get(sessionId)
      if (ai) return ok({ summary: ai, tier: 'ai' })
      const commits = gitCommits.filter((c) => c.sessionId === sessionId)
      if (commits.length)
        return ok({ summary: commits.map((c) => `• ${c.message}`).join('\n'), tier: 'commits' })
      return ok({ summary: '', tier: 'none' })
    },
    generateSummary: (sessionId: number) => {
      const s = sessions.find((x) => x.id === sessionId)
      const generated = `Worked on ${s ? projectName(s) : 'the project'}: implemented and tested changes across ${s?.promptCount ?? 'several'} prompts, iterating on review feedback and committing incremental progress.`
      aiSummaries.set(sessionId, generated)
      return ok<string | null>(generated)
    },
    generateBatch: (sessionIds: number[]) => {
      for (const id of sessionIds) {
        if (!aiSummaries.has(id))
          aiSummaries.set(
            id,
            'Implemented planned changes, ran the test suite, and addressed review feedback before wrapping up.'
          )
      }
      return ok(sessionIds.length)
    },
    generateReportSummary: (filters: { startDate: string; endDate: string }) =>
      ok<string | null>(
        `Across ${filters.startDate} – ${filters.endDate}, work focused on the Acme checkout platform (OAuth refresh, webhook idempotency, CSV export) and Northwind's data pipeline (batching improvements that cut nightly runs by more than half). Roughly a third of tracked time went to test coverage and review cycles, with steady daily momentum and no large idle gaps.`
      )
  },

  git: {
    scan: () => ok({ newCommits: 0, projectsScanned: projects.length, correlated: 0 }),
    getCommitsForSession: (sessionId: number) =>
      ok(gitCommits.filter((c) => c.sessionId === sessionId).map((c) => ({ ...c }))),
    getCommitsForProject: (projectId: number) =>
      ok(gitCommits.filter((c) => c.projectId === projectId).map((c) => ({ ...c }))),
    detectIdentity: () => ok({ name: 'Alex Rivera', email: 'alex@rivera.dev' }),
    getIdentity: () => ok({ name: 'Alex Rivera', email: 'alex@rivera.dev' }),
    setIdentity: () => ok(undefined),
    findUnconfiguredEmails: () => ok([]),
    correlate: () => ok(0),
    getSessionIdsWithCommits: () =>
      ok([...new Set(gitCommits.map((c) => c.sessionId).filter((x): x is number => x != null))]),
    getRemoteUrl: (projectId: number) => {
      const p = projects.find((x) => x.id === projectId)
      return ok<string | null>(p && p.id !== 5 ? `https://github.com/demo/${p.name}` : null)
    }
  },

  updater: {
    checkForUpdates: () => ok(undefined),
    downloadAndInstall: () => ok(undefined),
    installAndRestart: () => ok(undefined),
    getVersion: () => ok('1.4.0 (demo)'),
    onUpdateAvailable: noop,
    onUpdateNotAvailable: noop,
    onUpdateDownloaded: noop,
    onUpdateError: noop
  },

  reports: {
    generate: (filters: ReportFilters, format: ReportFormat) => ok(buildReport(filters, format)),
    exportPdf: (html: string, filename?: string) => {
      downloadText(html, filename ?? 'clautime-report.html')
      return ok<string | null>(filename ?? 'clautime-report.html')
    },
    exportFile: (content: string, defaultFilename: string) => {
      downloadText(content, defaultFilename)
      return ok<string | null>(defaultFilename)
    },
    openFile: () => ok(true)
  },

  live: {
    getTodayStats: () => ok(todayStats()),
    getProjectStatuses: () => ok(liveStatuses()),
    setWatching: (projectId: number, enabled: boolean) => {
      const s = watchState.get(projectId) ?? { isWatching: false, alertSound: 'system' }
      s.isWatching = enabled
      watchState.set(projectId, s)
      return ok(undefined)
    },
    getAlertConfig: (projectId: number) => {
      const s = watchState.get(projectId) ?? { isWatching: false, alertSound: 'system' }
      return ok<ProjectAlertConfig>({ projectId, alertSound: s.alertSound, isWatching: s.isWatching })
    },
    setAlertConfig: (projectId: number, alertSound: string) => {
      const s = watchState.get(projectId) ?? { isWatching: false, alertSound: 'system' }
      s.alertSound = alertSound
      watchState.set(projectId, s)
      return ok(undefined)
    },
    getAvailableSounds: () => ok(availableSounds),
    playTestSound: () => ok(undefined),
    selectCustomSound: () => ok<string | null>(null),
    onSessionsUpdated: noop,
    onNewProject: noop,
    timerStarted: () => ok(undefined),
    timerStopped: () => ok(undefined),
    // Widget windows don't exist in the browser — the landing page listens for
    // these messages and shows/hides a floating iframe of ./demo/#widget/<id>.
    toggleWidget: (projectId: number) => {
      window.parent.postMessage({ type: 'clautime-demo-widget', action: 'toggle', projectId }, '*')
      return ok(undefined)
    },
    showAllWidgets: (projectIds: number[]) => {
      window.parent.postMessage({ type: 'clautime-demo-widget', action: 'show-all', projectIds }, '*')
      return ok(undefined)
    },
    hideAllWidgets: () => {
      window.parent.postMessage({ type: 'clautime-demo-widget', action: 'hide-all' }, '*')
      return ok(undefined)
    },
    showStopDialog: () => ok(undefined),
    getWidgetHotkey: () => ok('CommandOrControl+Shift+W'),
    setWidgetHotkey: () => ok(undefined),
    onWidgetAlert: noop,
    onOpenStopDialog: noop
  },

  invoice: {
    hasStripeKey: () => ok(true),
    isTestMode: () => ok(true),
    storeStripeKey: () => ok(undefined),
    removeStripeKey: () => ok(undefined),
    testConnection: () => ok(true),
    syncCustomer: (clientId: number) => {
      const c = clients.find((x) => x.id === clientId)
      if (!c) return Promise.resolve(ipcError('NOT_FOUND', 'Client not found'))
      if (!c.stripeCustomerId) c.stripeCustomerId = `cus_Demo${c.id}${Date.now().toString(36)}`
      return ok({ stripeCustomerId: c.stripeCustomerId, email: c.email ?? '', name: c.name })
    },
    createDraftInvoice: (request: CreateInvoiceRequest) => {
      const inv = createLocalInvoice(request, 'draft', new Date().toISOString())
      const draft: DraftInvoice = {
        localId: inv.id,
        invoiceId: inv.stripeInvoiceId,
        stripeCustomerId: clients.find((c) => c.id === inv.clientId)?.stripeCustomerId ?? 'cus_Demo',
        status: inv.status,
        amountDueCents: inv.amountDueCents,
        currency: inv.currency,
        hostedUrl: inv.hostedUrl,
        invoicePdf: inv.invoicePdf,
        createdAt: inv.createdAt
      }
      return ok(draft)
    },
    sendInvoice: (invoiceId: string) => {
      const inv = invoices.find((i) => i.stripeInvoiceId === invoiceId)
      if (!inv) return Promise.resolve(ipcError('NOT_FOUND', 'Invoice not found'))
      inv.status = 'open'
      inv.dueDate = new Date(Date.now() + 30 * 86_400_000).toISOString()
      return ok(toStatus(inv))
    },
    getInvoiceStatus: (invoiceId: string) => {
      const inv = invoices.find((i) => i.stripeInvoiceId === invoiceId)
      if (!inv) return Promise.resolve(ipcError('NOT_FOUND', 'Invoice not found'))
      return ok(toStatus(inv))
    },
    voidInvoice: (invoiceId: string) => {
      const inv = invoices.find((i) => i.stripeInvoiceId === invoiceId)
      if (!inv) return Promise.resolve(ipcError('NOT_FOUND', 'Invoice not found'))
      inv.status = 'void'
      return ok(toStatus(inv))
    },
    generateLineItems: (request: { clientId: number; startDate: string; endDate: string; projectId?: number }) =>
      ok(generateLineItems(request)),
    getAll: (filters?: { clientId?: number; status?: string }) =>
      ok(
        invoices
          .filter(
            (i) =>
              (filters?.clientId == null || i.clientId === filters.clientId) &&
              (!filters?.status || i.status === filters.status)
          )
          .map(toLocalInvoice)
      ),
    getById: (localId: number) =>
      ok<LocalInvoiceDetail | null>(invoices.find((i) => i.id === localId) ?? null),
    syncLocalStatus: (localId: number) => {
      const inv = invoices.find((i) => i.id === localId)
      if (!inv) return Promise.resolve(ipcError('NOT_FOUND', 'Invoice not found'))
      return ok(toLocalInvoice(inv))
    },
    syncAllStatuses: () => ok(0),
    delete: (localId: number) => {
      const i = invoices.findIndex((x) => x.id === localId)
      if (i >= 0) invoices.splice(i, 1)
      return ok(undefined)
    },
    getStripeMode: () => ok<'live' | 'test'>('test'),
    setStripeMode: () => ok(undefined),
    hasStripeKeyForMode: (mode: 'live' | 'test') => ok(mode === 'test'),
    removeStripeKeyForMode: () => ok(undefined),
    importFromStripe: () => ok(0),
    getStripeTestEmail: () => ok<string | null>('demo+test@clautime.dev'),
    setStripeTestEmail: () => ok(undefined),
    checkOverlap: (request: { clientId: number; startDate: string; endDate: string }) => {
      const overlaps: InvoiceOverlap[] = invoices
        .filter(
          (i) =>
            i.clientId === request.clientId &&
            i.status !== 'void' &&
            i.periodStart != null &&
            i.periodEnd != null &&
            i.periodStart <= request.endDate &&
            i.periodEnd >= request.startDate
        )
        .map((i) => ({
          invoiceId: i.id,
          stripeInvoiceId: i.stripeInvoiceId,
          periodStart: i.periodStart!,
          periodEnd: i.periodEnd!,
          amountDueCents: i.amountDueCents,
          createdAt: i.createdAt
        }))
      return ok(overlaps)
    }
  },

  secretScan: {
    run: () =>
      ok({
        filesScanned: 128,
        filesSkipped: 3,
        newFindings: secretFindings.filter((f) => f.status === 'found').length,
        redacted: 0,
        errors: 0
      }),
    cancel: () => ok(undefined),
    getFindings: (limit?: number, offset?: number) =>
      ok(secretFindings.slice(offset ?? 0, (offset ?? 0) + (limit ?? secretFindings.length)).map((f) => ({ ...f }))),
    getSummary: () => {
      const summary: SecretScanSummary = {
        total: secretFindings.length,
        found: secretFindings.filter((f) => f.status === 'found').length,
        redacted: secretFindings.filter((f) => f.status === 'redacted').length,
        ignored: secretFindings.filter((f) => f.status === 'ignored').length,
        bySeverity: {
          critical: secretFindings.filter((f) => f.severity === 'critical').length,
          high: secretFindings.filter((f) => f.severity === 'high').length,
          medium: secretFindings.filter((f) => f.severity === 'medium').length
        }
      }
      return ok(summary)
    },
    ignoreFinding: (id: number) => {
      const f = secretFindings.find((x) => x.id === id)
      if (f) f.status = 'ignored'
      return ok(undefined)
    },
    redactFinding: (id: number) => {
      const f = secretFindings.find((x) => x.id === id)
      if (f) {
        f.status = 'redacted'
        f.redactedAt = new Date().toISOString()
      }
      return ok(undefined)
    },
    redactAll: () => {
      let n = 0
      for (const f of secretFindings) {
        if (f.status === 'found') {
          f.status = 'redacted'
          f.redactedAt = new Date().toISOString()
          n++
        }
      }
      return ok(n)
    },
    getCustomPatterns: () => ok(customPatterns.map((p) => ({ ...p }))),
    upsertCustomPattern: (pattern: CustomSecretPattern) => {
      const i = customPatterns.findIndex((p) => p.id === pattern.id)
      if (i >= 0) customPatterns[i] = pattern
      else customPatterns.push(pattern)
      return ok({ success: true, warnings: [] as string[] })
    },
    deleteCustomPattern: (id: string) => {
      const i = customPatterns.findIndex((p) => p.id === id)
      if (i >= 0) customPatterns.splice(i, 1)
      return ok(undefined)
    },
    testPattern: (source: string, flags: string, testString: string) => {
      try {
        const re = new RegExp(source, flags.includes('g') ? flags : flags + 'g')
        const matches = [...testString.matchAll(re)].map((m) => m[0]).slice(0, 50)
        const result: PatternTestResult = { matches, matchCount: matches.length, warnings: [] }
        return ok(result)
      } catch (e) {
        return Promise.resolve(ipcError('INVALID_PATTERN', e instanceof Error ? e.message : 'Invalid regex'))
      }
    }
  },

  window: {
    minimize: () => ok(undefined),
    maximize: () => ok(undefined),
    close: () => ok(undefined),
    hide: () => ok(undefined),
    quit: () => ok(undefined),
    isMaximized: () => Promise.resolve(false),
    onMaximizedChanged: noop,
    onCloseRequested: noop
  },

  projects: {
    getAll: (clientId?: number) =>
      ok(projects.filter((p) => clientId == null || p.clientId === clientId).map((p) => ({ ...p }))),
    create: (data: NewProject) => {
      const p: Project = {
        id: nextProjectId++,
        clientId: data.clientId,
        name: data.name,
        invoiceName: null,
        stageName: data.stageName ?? null,
        hourlyRate: data.hourlyRate ?? null,
        directoryPath: data.directoryPath,
        isBillable: data.isBillable ?? true,
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
      projects.push(p)
      return ok({ ...p })
    },
    update: (id: number, data: UpdateProject) => {
      const p = projects.find((x) => x.id === id)
      if (!p) return Promise.resolve(ipcError('NOT_FOUND', 'Project not found'))
      Object.assign(p, data, { updatedAt: new Date().toISOString() })
      return ok({ ...p })
    },
    delete: (id: number) => {
      const i = projects.findIndex((p) => p.id === id)
      if (i >= 0) projects.splice(i, 1)
      return ok(undefined)
    },
    attributeSessions: () => ok(0)
  }
}

/**
 * Wrap every api function with a small async delay so calls behave like real
 * IPC round-trips (instant microtask resolution lets query refetch cycles
 * starve the render loop). Also counts calls per method for debugging via
 * `window.__demoApiCalls`.
 */
const callCounts: Record<string, number> = {}
;(window as unknown as { __demoApiCalls: Record<string, number> }).__demoApiCalls = callCounts

function withLatency<T extends Record<string, Record<string, (...args: never[]) => unknown>>>(api: T): T {
  const wrapped = {} as Record<string, Record<string, unknown>>
  for (const [ns, methods] of Object.entries(api)) {
    wrapped[ns] = {}
    for (const [name, fn] of Object.entries(methods)) {
      wrapped[ns][name] = (...args: never[]): unknown => {
        callCounts[`${ns}.${name}`] = (callCounts[`${ns}.${name}`] ?? 0) + 1
        const result = fn(...args)
        if (result instanceof Promise) {
          return new Promise((resolve, reject) => {
            setTimeout(() => {
              result.then(resolve, reject)
            }, 5 + Math.random() * 20)
          })
        }
        return result
      }
    }
  }
  return wrapped as T
}

export function installMockApi(): void {
  ;(window as unknown as { api: typeof mockApi }).api = withLatency(mockApi)
}
