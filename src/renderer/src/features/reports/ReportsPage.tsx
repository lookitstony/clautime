import { useState, useCallback, useMemo } from 'react'
import { FileBarChart, Download, Copy, FileText, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/shared/EmptyState'
import { formatDuration, formatCompactNumber, getDateRangeForPreset, type DatePreset } from '@/lib/format'
import { useClients } from '../clients/use-clients'
import { useProjects } from '../clients/use-projects'
import { useGenerateReport } from './use-reports'
import type { ReportFormat, ReportResult, SessionLineItem, DailySummaryItem, PeriodProjectItem } from '../../../../shared/types/report'

type ReportDatePreset = DatePreset | 'last-month' | 'custom'

function getLastMonthRange(): { startDate: string; endDate: string } {
  const now = new Date()
  const firstDayLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const lastDayLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)
  return { startDate: firstDayLastMonth.toISOString(), endDate: lastDayLastMonth.toISOString() }
}

function formatTimeOnly(isoString: string): string {
  return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

function SessionBreakdownTable({ items }: { items: SessionLineItem[] }): React.JSX.Element {
  return (
    <div className="overflow-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-[var(--surface-border)] text-left text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
            <th className="px-3 py-2">Date</th>
            <th className="px-3 py-2">Project</th>
            <th className="px-3 py-2">Client</th>
            <th className="px-3 py-2 text-right">Time</th>
            <th className="px-3 py-2 text-right">Duration</th>
            <th className="px-3 py-2 text-right">Prompts</th>
            <th className="px-3 py-2 text-right">Tokens</th>
            <th className="px-3 py-2">Source</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--surface-border)]">
          {items.map((item, i) => (
            <tr key={i} className="hover:bg-[var(--background-elevated)]">
              <td className="whitespace-nowrap px-3 py-1.5">{item.date}</td>
              <td className="px-3 py-1.5 font-medium">{item.projectName}</td>
              <td className="px-3 py-1.5 text-[var(--text-muted)]">{item.clientName ?? '\u2014'}</td>
              <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono">
                {formatTimeOnly(item.startedAt)}\u2013{formatTimeOnly(item.endedAt)}
              </td>
              <td className="px-3 py-1.5 text-right font-mono font-semibold text-[var(--accent)]">
                {formatDuration(item.durationMinutes)}
              </td>
              <td className="px-3 py-1.5 text-right font-mono">{item.promptCount}</td>
              <td className="px-3 py-1.5 text-right font-mono">
                {formatCompactNumber(item.inputTokens + item.outputTokens)}
              </td>
              <td className="px-3 py-1.5 text-[var(--text-muted)]">
                {item.source === 'auto' ? 'Auto' : 'Manual'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DailySummaryTable({ items }: { items: DailySummaryItem[] }): React.JSX.Element {
  return (
    <div className="overflow-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-[var(--surface-border)] text-left text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
            <th className="px-3 py-2">Date</th>
            <th className="px-3 py-2 text-right">Sessions</th>
            <th className="px-3 py-2 text-right">Duration</th>
            <th className="px-3 py-2 text-right">Prompts</th>
            <th className="px-3 py-2 text-right">Tokens</th>
            <th className="px-3 py-2">Projects</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--surface-border)]">
          {items.map((item, i) => (
            <tr key={i} className="hover:bg-[var(--background-elevated)]">
              <td className="whitespace-nowrap px-3 py-1.5">{item.date}</td>
              <td className="px-3 py-1.5 text-right font-mono">{item.sessionCount}</td>
              <td className="px-3 py-1.5 text-right font-mono font-semibold text-[var(--accent)]">
                {formatDuration(item.totalDurationMinutes)}
              </td>
              <td className="px-3 py-1.5 text-right font-mono">{item.totalPrompts}</td>
              <td className="px-3 py-1.5 text-right font-mono">
                {formatCompactNumber(item.totalInputTokens + item.totalOutputTokens)}
              </td>
              <td className="px-3 py-1.5 text-[var(--text-muted)]">
                {item.projects.join(', ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PeriodSummaryView({ report }: { report: ReportResult }): React.JSX.Element {
  const summary = report.periodSummary!
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard label="Sessions" value={String(summary.totalSessions)} />
        <SummaryCard label="Duration" value={formatDuration(summary.totalDurationMinutes)} accent />
        <SummaryCard label="Prompts" value={summary.totalPrompts.toLocaleString()} />
        <SummaryCard label="Tokens" value={formatCompactNumber(summary.totalInputTokens + summary.totalOutputTokens)} />
      </div>
      <div className="overflow-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-[var(--surface-border)] text-left text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
              <th className="px-3 py-2">Project</th>
              <th className="px-3 py-2">Client</th>
              <th className="px-3 py-2 text-right">Sessions</th>
              <th className="px-3 py-2 text-right">Duration</th>
              <th className="px-3 py-2 text-right">Prompts</th>
              <th className="px-3 py-2 text-right">Tokens</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--surface-border)]">
            {summary.projects.map((item: PeriodProjectItem, i: number) => (
              <tr key={i} className="hover:bg-[var(--background-elevated)]">
                <td className="px-3 py-1.5 font-medium">{item.projectName}</td>
                <td className="px-3 py-1.5 text-[var(--text-muted)]">{item.clientName ?? '\u2014'}</td>
                <td className="px-3 py-1.5 text-right font-mono">{item.sessionCount}</td>
                <td className="px-3 py-1.5 text-right font-mono font-semibold text-[var(--accent)]">
                  {formatDuration(item.totalDurationMinutes)}
                </td>
                <td className="px-3 py-1.5 text-right font-mono">{item.totalPrompts}</td>
                <td className="px-3 py-1.5 text-right font-mono">
                  {formatCompactNumber(item.totalInputTokens + item.totalOutputTokens)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SummaryCard({ label, value, accent }: { label: string; value: string; accent?: boolean }): React.JSX.Element {
  return (
    <div className="rounded-md bg-[var(--background-elevated)] border border-[var(--surface-border)] px-3 py-2">
      <div className={`font-mono text-lg font-bold ${accent ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}>
        {value}
      </div>
      <div className="text-[11px] text-[var(--text-muted)]">{label}</div>
    </div>
  )
}

function reportToMarkdown(report: ReportResult): string {
  const lines: string[] = []
  const startDate = new Date(report.filters.startDate).toLocaleDateString()
  const endDate = new Date(report.filters.endDate).toLocaleDateString()
  lines.push(`# Time Report: ${startDate} \u2013 ${endDate}`)
  lines.push(`Generated: ${new Date(report.generatedAt).toLocaleString()}`)
  lines.push('')

  if (report.sessionBreakdown) {
    lines.push('## Session Breakdown')
    lines.push('')
    lines.push('| Date | Project | Client | Time | Duration | Prompts | Tokens | Source |')
    lines.push('|------|---------|--------|------|----------|---------|--------|--------|')
    for (const item of report.sessionBreakdown) {
      lines.push(
        `| ${item.date} | ${item.projectName} | ${item.clientName ?? '\u2014'} | ${formatTimeOnly(item.startedAt)}\u2013${formatTimeOnly(item.endedAt)} | ${formatDuration(item.durationMinutes)} | ${item.promptCount} | ${formatCompactNumber(item.inputTokens + item.outputTokens)} | ${item.source === 'auto' ? 'Auto' : 'Manual'} |`
      )
    }
  }

  if (report.dailySummary) {
    lines.push('## Daily Summary')
    lines.push('')
    lines.push('| Date | Sessions | Duration | Prompts | Tokens | Projects |')
    lines.push('|------|----------|----------|---------|--------|----------|')
    for (const item of report.dailySummary) {
      lines.push(
        `| ${item.date} | ${item.sessionCount} | ${formatDuration(item.totalDurationMinutes)} | ${item.totalPrompts} | ${formatCompactNumber(item.totalInputTokens + item.totalOutputTokens)} | ${item.projects.join(', ')} |`
      )
    }
  }

  if (report.periodSummary) {
    const s = report.periodSummary
    lines.push('## Period Summary')
    lines.push('')
    lines.push(`- **Sessions:** ${s.totalSessions}`)
    lines.push(`- **Total Duration:** ${formatDuration(s.totalDurationMinutes)}`)
    lines.push(`- **Total Prompts:** ${s.totalPrompts}`)
    lines.push(`- **Total Tokens:** ${formatCompactNumber(s.totalInputTokens + s.totalOutputTokens)}`)
    lines.push('')
    lines.push('### By Project')
    lines.push('')
    lines.push('| Project | Client | Sessions | Duration | Prompts | Tokens |')
    lines.push('|---------|--------|----------|----------|---------|--------|')
    for (const p of s.projects) {
      lines.push(
        `| ${p.projectName} | ${p.clientName ?? '\u2014'} | ${p.sessionCount} | ${formatDuration(p.totalDurationMinutes)} | ${p.totalPrompts} | ${formatCompactNumber(p.totalInputTokens + p.totalOutputTokens)} |`
      )
    }
  }

  return lines.join('\n')
}

export function ReportsPage(): React.JSX.Element {
  const [datePreset, setDatePreset] = useState<ReportDatePreset>('this-week')
  const [format, setFormat] = useState<ReportFormat>('session-breakdown')
  const [clientId, setClientId] = useState<string>('__all__')
  const [projectId, setProjectId] = useState<string>('__all__')
  const [report, setReport] = useState<ReportResult | null>(null)

  const { data: clients } = useClients()
  const { data: allProjects } = useProjects()
  const generateMutation = useGenerateReport()

  const dateRange = useMemo(() => {
    if (datePreset === 'last-month') return getLastMonthRange()
    if (datePreset === 'custom') return null
    return getDateRangeForPreset(datePreset as DatePreset)
  }, [datePreset])

  const handleGenerate = useCallback(() => {
    if (!dateRange) return
    const filters = {
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      ...(clientId !== '__all__' ? { clientId: Number(clientId) } : {}),
      ...(projectId !== '__all__' ? { projectId: Number(projectId) } : {})
    }
    generateMutation.mutate(
      { filters, format },
      {
        onSuccess: (data) => {
          setReport(data)
        }
      }
    )
  }, [dateRange, clientId, projectId, format, generateMutation])

  const handleCopyMarkdown = useCallback(() => {
    if (!report) return
    const md = reportToMarkdown(report)
    navigator.clipboard.writeText(md).then(() => {
      toast.success('Report copied to clipboard')
    })
  }, [report])

  const handleSaveMarkdown = useCallback(() => {
    if (!report) return
    const md = reportToMarkdown(report)
    const blob = new Blob([md], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `report-${new Date().toISOString().split('T')[0]}.md`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('Report saved')
  }, [report])

  const isEmpty = report && (
    (report.format === 'session-breakdown' && (!report.sessionBreakdown || report.sessionBreakdown.length === 0)) ||
    (report.format === 'daily-summary' && (!report.dailySummary || report.dailySummary.length === 0)) ||
    (report.format === 'period-summary' && (!report.periodSummary || report.periodSummary.totalSessions === 0))
  )

  return (
    <div className="flex h-full flex-col">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--surface-border)] px-4 py-3">
        <Select value={datePreset} onValueChange={(v) => setDatePreset(v as ReportDatePreset)}>
          <SelectTrigger size="sm" className="h-8 w-[140px] text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="today">Today</SelectItem>
            <SelectItem value="this-week">This Week</SelectItem>
            <SelectItem value="last-week">Last Week</SelectItem>
            <SelectItem value="this-month">This Month</SelectItem>
            <SelectItem value="last-month">Last Month</SelectItem>
          </SelectContent>
        </Select>

        <Select value={format} onValueChange={(v) => setFormat(v as ReportFormat)}>
          <SelectTrigger size="sm" className="h-8 w-[170px] text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="session-breakdown">Session Breakdown</SelectItem>
            <SelectItem value="daily-summary">Daily Summary</SelectItem>
            <SelectItem value="period-summary">Period Summary</SelectItem>
          </SelectContent>
        </Select>

        {clients && clients.length > 0 && (
          <Select value={clientId} onValueChange={setClientId}>
            <SelectTrigger size="sm" className="h-8 w-[140px] text-[12px]">
              <SelectValue placeholder="All Clients" />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="__all__">All Clients</SelectItem>
              {clients.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {allProjects && allProjects.length > 0 && (
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger size="sm" className="h-8 w-[140px] text-[12px]">
              <SelectValue placeholder="All Projects" />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="__all__">All Projects</SelectItem>
              {allProjects.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Button
          size="sm"
          className="h-8 bg-[var(--accent)] text-white hover:brightness-[1.15]"
          onClick={handleGenerate}
          disabled={generateMutation.isPending || !dateRange}
        >
          {generateMutation.isPending ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <FileBarChart className="mr-1 h-3 w-3" />
          )}
          Generate
        </Button>

        {report && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="ml-auto h-8 text-[12px]">
                <Download className="mr-1 h-3 w-3" />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleCopyMarkdown}>
                <Copy className="mr-2 h-3.5 w-3.5" />
                Copy as Markdown
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleSaveMarkdown}>
                <FileText className="mr-2 h-3.5 w-3.5" />
                Save as Markdown
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Report content */}
      <div className="flex-1 overflow-auto p-4">
        {!report && !generateMutation.isPending && (
          <EmptyState
            icon={FileBarChart}
            title="Generate a Report"
            description="Select a date range and format, then click Generate"
          />
        )}

        {generateMutation.isPending && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--accent)]" />
          </div>
        )}

        {isEmpty && (
          <EmptyState
            icon={FileBarChart}
            title="No Data"
            description="No sessions found for the selected filters"
          />
        )}

        {report && !isEmpty && report.format === 'session-breakdown' && report.sessionBreakdown && (
          <SessionBreakdownTable items={report.sessionBreakdown} />
        )}

        {report && !isEmpty && report.format === 'daily-summary' && report.dailySummary && (
          <DailySummaryTable items={report.dailySummary} />
        )}

        {report && !isEmpty && report.format === 'period-summary' && report.periodSummary && (
          <PeriodSummaryView report={report} />
        )}
      </div>
    </div>
  )
}
