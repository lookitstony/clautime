import { useState, useCallback, useMemo, useEffect } from 'react'
import { FileBarChart, Download, Loader2, ChevronRight, Sparkles, GitCommit } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/shared/EmptyState'
import { formatDuration, formatCompactNumber, getDateRangeForPreset, type DatePreset } from '@/lib/format'
import { useClients } from '../clients/use-clients'
import { useProjects } from '../clients/use-projects'
import { useGenerateReport } from './use-reports'
import type { ReportFormat, ReportResult, ReportSummary, SessionLineItem, DailySummaryItem, PeriodProjectItem } from '../../../../shared/types/report'

type ReportDatePreset = DatePreset | 'last-month' | 'custom' | 'all-time'

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
                {formatTimeOnly(item.startedAt)}{'\u2013'}{formatTimeOnly(item.endedAt)}
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

function ReportFooter({
  summary,
  workSummary,
  onGenerateSummary,
  isGenerating,
  hasApiKey
}: {
  summary: ReportSummary
  workSummary: string | null
  onGenerateSummary: (useAi: boolean) => void
  isGenerating: boolean
  hasApiKey: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const hasBilling = summary.billedByClient.length > 0

  // Auto-expand when summary arrives
  useEffect(() => {
    if (workSummary) setExpanded(true)
  }, [workSummary])

  return (
    <div className="border-t border-[var(--surface-border)] bg-[var(--background-primary)]">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex flex-1 items-center gap-4 px-3 py-2 text-[12px] transition-colors hover:bg-[var(--background-elevated)]"
        >
          <ChevronRight
            size={12}
            className={cn('shrink-0 text-[var(--text-muted)] transition-transform duration-200', expanded && 'rotate-90')}
          />
          <span className="font-mono font-semibold text-[var(--accent)]">{formatDuration(summary.totalDurationMinutes)}</span>
          <span className="text-[var(--text-muted)]">{summary.totalSessions} sessions</span>
          <span className="text-[var(--text-muted)]">{summary.totalPrompts.toLocaleString()} prompts</span>
          <span className="text-[var(--text-muted)]">{formatCompactNumber(summary.totalInputTokens + summary.totalOutputTokens)} tokens</span>
          {hasBilling && (
            <span className="ml-auto font-mono font-semibold text-[var(--accent)]">${summary.totalBilledCost.toFixed(2)}</span>
          )}
        </button>
      </div>
      {expanded && (
        <div className="space-y-3 px-3 pb-3">
          {hasBilling && (
            <div className="rounded-md border border-[var(--surface-border)] bg-[var(--background-elevated)] p-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Billing
              </div>
              <div className="space-y-1">
                {summary.billedByClient.map((b) => (
                  <div key={b.clientName} className="flex items-center justify-between text-[12px]">
                    <span className="text-[var(--text-secondary)]">{b.clientName}</span>
                    <span className="font-mono text-[var(--text-secondary)]">
                      {b.hours}h {'\u00d7'} ${b.rate}/hr = <span className="font-semibold text-[var(--accent)]">${b.cost.toFixed(2)}</span>
                    </span>
                  </div>
                ))}
              </div>
              {summary.billedByClient.length > 1 && (
                <div className="mt-2 flex items-center justify-between border-t border-[var(--surface-border)] pt-2 text-[13px] font-semibold">
                  <span className="text-[var(--text-primary)]">Total</span>
                  <span className="font-mono text-[var(--accent)]">${summary.totalBilledCost.toFixed(2)}</span>
                </div>
              )}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <SummaryCard label="Duration" value={formatDuration(summary.totalDurationMinutes)} accent />
            <SummaryCard label="Sessions" value={String(summary.totalSessions)} />
            <SummaryCard label="Prompts" value={summary.totalPrompts.toLocaleString()} />
            <SummaryCard label="Tokens" value={formatCompactNumber(summary.totalInputTokens + summary.totalOutputTokens)} />
          </div>

          {/* Work Summary */}
          <div className="rounded-md border border-[var(--surface-border)] bg-[var(--background-elevated)] p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Work Summary
              </div>
              <div className="flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={(e) => { e.stopPropagation(); onGenerateSummary(false) }}
                  disabled={isGenerating}
                  className="h-6 px-2 text-[11px]"
                >
                  <GitCommit className="mr-1 h-3 w-3" />
                  Git Summary
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={(e) => { e.stopPropagation(); onGenerateSummary(true) }}
                  disabled={isGenerating || !hasApiKey}
                  title={hasApiKey ? 'Summarize with AI' : 'Add an API key in Settings to enable'}
                  className="h-6 px-2 text-[11px]"
                >
                  <Sparkles className="mr-1 h-3 w-3" />
                  AI Summary
                </Button>
              </div>
            </div>
            {workSummary ? (
              <div className="space-y-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                {workSummary.split('\n').map((line, i) => {
                  const trimmed = line.trim()
                  if (!trimmed) return null
                  if (trimmed.startsWith('## ') || (trimmed.startsWith('**') && trimmed.endsWith('**') && !trimmed.includes('- '))) {
                    return (
                      <p key={i} className="mt-2 text-[11px] font-semibold text-[var(--text-primary)]">
                        {trimmed.replace(/^##\s*/, '').replace(/\*\*/g, '')}
                      </p>
                    )
                  }
                  if (trimmed.startsWith('- ')) {
                    return (
                      <div key={i} className="flex gap-2 pl-2">
                        <span className="shrink-0 text-[var(--accent)]">{'\u2022'}</span>
                        <span>{trimmed.slice(2).replace(/\*\*/g, '')}</span>
                      </div>
                    )
                  }
                  return <p key={i}>{trimmed.replace(/\*\*/g, '')}</p>
                })}
              </div>
            ) : (
              <p className="text-[11px] text-[var(--text-muted)]">
                Generate a work summary from git commits or use AI to create a polished summary.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function reportToMarkdown(report: ReportResult, aiSummary?: string | null): string {
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

  // Summary footer
  const s = report.summary
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push(`**Sessions:** ${s.totalSessions} | **Duration:** ${formatDuration(s.totalDurationMinutes)} | **Prompts:** ${s.totalPrompts.toLocaleString()} | **Tokens:** ${formatCompactNumber(s.totalInputTokens + s.totalOutputTokens)}`)

  if (s.billedByClient.length > 0) {
    lines.push('')
    lines.push('### Billing')
    lines.push('')
    for (const b of s.billedByClient) {
      lines.push(`- **${b.clientName}:** ${b.hours}h \u00d7 $${b.rate}/hr = **$${b.cost.toFixed(2)}**`)
    }
    lines.push('')
    lines.push(`**Total Billed: $${s.totalBilledCost.toFixed(2)}**`)
  }

  if (aiSummary) {
    lines.push('')
    lines.push('### Work Summary')
    lines.push('')
    lines.push(aiSummary)
  }

  return lines.join('\n')
}

function reportToCsv(report: ReportResult): string {
  const rows: string[][] = []

  if (report.sessionBreakdown) {
    rows.push(['Date', 'Project', 'Client', 'Start', 'End', 'Duration (min)', 'Prompts', 'Input Tokens', 'Output Tokens', 'Source'])
    for (const item of report.sessionBreakdown) {
      rows.push([
        item.date, item.projectName, item.clientName ?? '', formatTimeOnly(item.startedAt),
        formatTimeOnly(item.endedAt), String(item.durationMinutes), String(item.promptCount),
        String(item.inputTokens), String(item.outputTokens), item.source
      ])
    }
  }

  if (report.dailySummary) {
    rows.push(['Date', 'Sessions', 'Duration (min)', 'Prompts', 'Input Tokens', 'Output Tokens', 'Projects'])
    for (const item of report.dailySummary) {
      rows.push([
        item.date, String(item.sessionCount), String(item.totalDurationMinutes),
        String(item.totalPrompts), String(item.totalInputTokens), String(item.totalOutputTokens),
        item.projects.join('; ')
      ])
    }
  }

  if (report.periodSummary) {
    rows.push(['Project', 'Client', 'Sessions', 'Duration (min)', 'Prompts', 'Input Tokens', 'Output Tokens'])
    for (const p of report.periodSummary.projects) {
      rows.push([
        p.projectName, p.clientName ?? '', String(p.sessionCount), String(p.totalDurationMinutes),
        String(p.totalPrompts), String(p.totalInputTokens), String(p.totalOutputTokens)
      ])
    }
  }

  return rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n')
}

function reportToHtml(report: ReportResult, aiSummary?: string | null): string {
  const startDate = new Date(report.filters.startDate).toLocaleDateString()
  const endDate = new Date(report.filters.endDate).toLocaleDateString()
  const s = report.summary

  let tableHtml = ''

  if (report.sessionBreakdown) {
    tableHtml = `<table><thead><tr><th>Date</th><th>Project</th><th>Client</th><th>Time</th><th>Duration</th><th>Prompts</th><th>Tokens</th><th>Source</th></tr></thead><tbody>`
    for (const item of report.sessionBreakdown) {
      tableHtml += `<tr><td>${item.date}</td><td>${item.projectName}</td><td>${item.clientName ?? '\u2014'}</td><td>${formatTimeOnly(item.startedAt)}\u2013${formatTimeOnly(item.endedAt)}</td><td><strong>${formatDuration(item.durationMinutes)}</strong></td><td>${item.promptCount}</td><td>${formatCompactNumber(item.inputTokens + item.outputTokens)}</td><td>${item.source}</td></tr>`
    }
    tableHtml += '</tbody></table>'
  }

  if (report.dailySummary) {
    tableHtml = `<table><thead><tr><th>Date</th><th>Sessions</th><th>Duration</th><th>Prompts</th><th>Tokens</th><th>Projects</th></tr></thead><tbody>`
    for (const item of report.dailySummary) {
      tableHtml += `<tr><td>${item.date}</td><td>${item.sessionCount}</td><td><strong>${formatDuration(item.totalDurationMinutes)}</strong></td><td>${item.totalPrompts}</td><td>${formatCompactNumber(item.totalInputTokens + item.totalOutputTokens)}</td><td>${item.projects.join(', ')}</td></tr>`
    }
    tableHtml += '</tbody></table>'
  }

  if (report.periodSummary) {
    tableHtml = `<table><thead><tr><th>Project</th><th>Client</th><th>Sessions</th><th>Duration</th><th>Prompts</th><th>Tokens</th></tr></thead><tbody>`
    for (const p of report.periodSummary.projects) {
      tableHtml += `<tr><td>${p.projectName}</td><td>${p.clientName ?? '\u2014'}</td><td>${p.sessionCount}</td><td><strong>${formatDuration(p.totalDurationMinutes)}</strong></td><td>${p.totalPrompts}</td><td>${formatCompactNumber(p.totalInputTokens + p.totalOutputTokens)}</td></tr>`
    }
    tableHtml += '</tbody></table>'
  }

  let billingHtml = ''
  if (s.billedByClient.length > 0) {
    billingHtml = '<h3>Billing</h3><table><thead><tr><th>Client</th><th>Hours</th><th>Rate</th><th>Cost</th></tr></thead><tbody>'
    for (const b of s.billedByClient) {
      billingHtml += `<tr><td>${b.clientName}</td><td>${b.hours}h</td><td>$${b.rate}/hr</td><td><strong>$${b.cost.toFixed(2)}</strong></td></tr>`
    }
    billingHtml += `</tbody></table><p style="text-align:right"><strong>Total Billed: $${s.totalBilledCost.toFixed(2)}</strong></p>`
  }

  let summaryHtml = ''
  if (aiSummary) {
    summaryHtml = '<h3>Work Summary</h3>'
    const lines = aiSummary.split('\n')
    let inList = false
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) {
        if (inList) { summaryHtml += '</ul>'; inList = false }
        continue
      }
      // Markdown headers
      if (trimmed.startsWith('## ')) {
        if (inList) { summaryHtml += '</ul>'; inList = false }
        summaryHtml += `<h4>${trimmed.slice(3).replace(/\*\*/g, '')}</h4>`
      } else if (trimmed.startsWith('**') && trimmed.endsWith('**') && !trimmed.startsWith('**-')) {
        // Bold-only line = subheading
        if (inList) { summaryHtml += '</ul>'; inList = false }
        summaryHtml += `<h4>${trimmed.replace(/\*\*/g, '')}</h4>`
      } else if (trimmed.startsWith('- ')) {
        if (!inList) { summaryHtml += '<ul>'; inList = true }
        summaryHtml += `<li>${trimmed.slice(2).replace(/\*\*/g, '<strong>').replace(/<strong>([^<]*)<strong>/g, '<strong>$1</strong>')}</li>`
      } else {
        if (inList) { summaryHtml += '</ul>'; inList = false }
        summaryHtml += `<p>${trimmed.replace(/\*\*/g, '')}</p>`
      }
    }
    if (inList) summaryHtml += '</ul>'
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Time Report</title><style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:11px;color:#222;margin:20px;line-height:1.4}
h1{font-size:16px;margin-bottom:4px}h2{font-size:13px;margin-top:16px}h3{font-size:12px;margin-top:14px}
table{width:100%;border-collapse:collapse;margin:8px 0}
th,td{border:1px solid #ddd;padding:4px 6px;text-align:left}
th{background:#f5f5f5;font-weight:600;font-size:10px;text-transform:uppercase}
.meta{color:#666;font-size:10px;margin-bottom:12px}
.stats{margin:12px 0;padding:8px;background:#f9f9f9;border-radius:4px;font-size:11px}
</style></head><body>
<h1>Time Report: ${startDate} \u2013 ${endDate}</h1>
<div class="meta">Generated: ${new Date(report.generatedAt).toLocaleString()}</div>
${tableHtml}
<div class="stats"><strong>Sessions:</strong> ${s.totalSessions} | <strong>Duration:</strong> ${formatDuration(s.totalDurationMinutes)} | <strong>Prompts:</strong> ${s.totalPrompts.toLocaleString()} | <strong>Tokens:</strong> ${formatCompactNumber(s.totalInputTokens + s.totalOutputTokens)}</div>
${billingHtml}${summaryHtml}
</body></html>`
}

type TimesheetRow = { date: string; client: string; project: string; hours: string }

function buildTimesheetRows(report: ReportResult): TimesheetRow[] {
  // Aggregate by date + client + project
  const key = (date: string, client: string, project: string) => `${date}|${client}|${project}`
  const agg = new Map<string, { date: string; client: string; project: string; minutes: number }>()

  if (report.sessionBreakdown) {
    for (const item of report.sessionBreakdown) {
      const k = key(item.date, item.clientName ?? '\u2014', item.projectName)
      const existing = agg.get(k)
      if (existing) {
        existing.minutes += item.durationMinutes
      } else {
        agg.set(k, { date: item.date, client: item.clientName ?? '\u2014', project: item.projectName, minutes: item.durationMinutes })
      }
    }
  } else if (report.dailySummary) {
    for (const item of report.dailySummary) {
      for (const proj of item.projects) {
        const k = key(item.date, '\u2014', proj)
        const existing = agg.get(k)
        if (existing) {
          existing.minutes += item.totalDurationMinutes / item.projects.length
        } else {
          agg.set(k, { date: item.date, client: '\u2014', project: proj, minutes: item.totalDurationMinutes / item.projects.length })
        }
      }
    }
  } else if (report.periodSummary) {
    const startDate = new Date(report.filters.startDate).toLocaleDateString()
    const endDate = new Date(report.filters.endDate).toLocaleDateString()
    const dateLabel = `${startDate} \u2013 ${endDate}`
    for (const p of report.periodSummary.projects) {
      agg.set(key(dateLabel, p.clientName ?? '\u2014', p.projectName), {
        date: dateLabel, client: p.clientName ?? '\u2014', project: p.projectName, minutes: p.totalDurationMinutes
      })
    }
  }

  return Array.from(agg.values()).map((r) => ({
    date: r.date,
    client: r.client,
    project: r.project,
    hours: (Math.round((r.minutes / 60) * 100) / 100).toFixed(2)
  }))
}

function timesheetToMarkdown(rows: TimesheetRow[], report: ReportResult, aiSummary?: string | null): string {
  const startDate = new Date(report.filters.startDate).toLocaleDateString()
  const endDate = new Date(report.filters.endDate).toLocaleDateString()
  const s = report.summary
  const lines: string[] = []
  lines.push(`# Timesheet: ${startDate} \u2013 ${endDate}`)
  lines.push('')
  lines.push('| Date | Client | Project | Hours |')
  lines.push('|------|--------|---------|-------|')
  let totalHours = 0
  for (const r of rows) {
    lines.push(`| ${r.date} | ${r.client} | ${r.project} | ${r.hours} |`)
    totalHours += parseFloat(r.hours)
  }
  lines.push('')
  lines.push(`**Total Hours: ${totalHours.toFixed(2)}**`)
  if (s.billedByClient.length > 0) {
    lines.push('')
    lines.push('### Billing')
    lines.push('')
    for (const b of s.billedByClient) {
      lines.push(`- **${b.clientName}:** ${b.hours}h \u00d7 $${b.rate}/hr = **$${b.cost.toFixed(2)}**`)
    }
    lines.push('')
    lines.push(`**Total Billed: $${s.totalBilledCost.toFixed(2)}**`)
  }
  if (aiSummary) {
    lines.push('')
    lines.push('### Work Summary')
    lines.push('')
    lines.push(aiSummary)
  }
  return lines.join('\n')
}

function timesheetToCsv(rows: TimesheetRow[]): string {
  const csvRows: string[][] = [['Date', 'Client', 'Project', 'Hours']]
  for (const r of rows) {
    csvRows.push([r.date, r.client, r.project, r.hours])
  }
  return csvRows.map((row) => row.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n')
}

function timesheetToHtml(rows: TimesheetRow[], report: ReportResult, aiSummary?: string | null): string {
  const startDate = new Date(report.filters.startDate).toLocaleDateString()
  const endDate = new Date(report.filters.endDate).toLocaleDateString()
  const s = report.summary
  let totalHours = 0
  let tableHtml = '<table><thead><tr><th>Date</th><th>Client</th><th>Project</th><th>Hours</th></tr></thead><tbody>'
  for (const r of rows) {
    tableHtml += `<tr><td>${r.date}</td><td>${r.client}</td><td>${r.project}</td><td><strong>${r.hours}</strong></td></tr>`
    totalHours += parseFloat(r.hours)
  }
  tableHtml += `</tbody></table><p><strong>Total Hours: ${totalHours.toFixed(2)}</strong></p>`

  let billingHtml = ''
  if (s.billedByClient.length > 0) {
    billingHtml = '<h3>Billing</h3><table><thead><tr><th>Client</th><th>Hours</th><th>Rate</th><th>Cost</th></tr></thead><tbody>'
    for (const b of s.billedByClient) {
      billingHtml += `<tr><td>${b.clientName}</td><td>${b.hours}h</td><td>$${b.rate}/hr</td><td><strong>$${b.cost.toFixed(2)}</strong></td></tr>`
    }
    billingHtml += `</tbody></table><p style="text-align:right"><strong>Total Billed: $${s.totalBilledCost.toFixed(2)}</strong></p>`
  }

  let summaryHtml = ''
  if (aiSummary) {
    summaryHtml = '<h3>Work Summary</h3>'
    for (const line of aiSummary.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (trimmed.startsWith('## ') || (trimmed.startsWith('**') && trimmed.endsWith('**'))) {
        summaryHtml += `<h4>${trimmed.replace(/^##\s*/, '').replace(/\*\*/g, '')}</h4>`
      } else if (trimmed.startsWith('- ')) {
        summaryHtml += `<li>${trimmed.slice(2).replace(/\*\*/g, '')}</li>`
      } else {
        summaryHtml += `<p>${trimmed.replace(/\*\*/g, '')}</p>`
      }
    }
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Timesheet</title><style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:11px;color:#222;margin:20px;line-height:1.4}
h1{font-size:16px;margin-bottom:4px}h3{font-size:12px;margin-top:14px}h4{font-size:11px;margin-top:10px}
table{width:100%;border-collapse:collapse;margin:8px 0}
th,td{border:1px solid #ddd;padding:4px 6px;text-align:left}
th{background:#f5f5f5;font-weight:600;font-size:10px;text-transform:uppercase}
li{margin:2px 0}
</style></head><body>
<h1>Timesheet: ${startDate} \u2013 ${endDate}</h1>
${tableHtml}${billingHtml}${summaryHtml}
</body></html>`
}

type ExportContentType = 'timesheet' | 'full'
type ExportFormat = 'csv' | 'markdown' | 'pdf'
type SummaryOption = 'none' | 'git' | 'ai'

function RadioOption({
  selected,
  onClick,
  label,
  description,
  disabled
}: {
  selected: boolean
  onClick: () => void
  label: string
  description: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 transition-colors',
        disabled && 'cursor-not-allowed opacity-50',
        selected
          ? 'border-[var(--accent)] bg-[var(--accent)]/10'
          : 'border-[var(--surface-border)] hover:border-[var(--text-muted)]'
      )}
      onClick={disabled ? undefined : onClick}
    >
      <div className={cn(
        'h-3.5 w-3.5 rounded-full border-2 flex items-center justify-center',
        selected ? 'border-[var(--accent)]' : 'border-[var(--text-muted)]'
      )}>
        {selected && <div className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />}
      </div>
      <div>
        <div className="text-[13px] font-medium">{label}</div>
        <div className="text-[11px] text-[var(--text-muted)]">{description}</div>
      </div>
    </label>
  )
}

function ExportModal({
  open,
  onOpenChange,
  report,
  reportFilename
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  report: ReportResult
  reportFilename: string
}): React.JSX.Element {
  const [contentType, setContentType] = useState<ExportContentType>('timesheet')
  const [summaryOption, setSummaryOption] = useState<SummaryOption>('none')
  const [exportFormat, setExportFormat] = useState<ExportFormat>('pdf')
  const [isExporting, setIsExporting] = useState(false)

  const { data: hasApiKey } = useQuery({
    queryKey: ['ai', 'hasKey'],
    queryFn: async () => {
      const r = await window.api.ai.hasApiKey()
      return r.success ? r.data : false
    }
  })

  const generateSummary = useCallback(async (useAi: boolean): Promise<string | null> => {
    const result = await window.api.ai.generateReportSummary(report.filters, useAi)
    return result.success ? result.data : null
  }, [report.filters])

  const handleExport = useCallback(async () => {
    setIsExporting(true)
    try {
      // Resolve summary based on selected option
      let summary: string | null = null
      if (summaryOption === 'ai') {
        summary = await generateSummary(true)
        if (!summary) toast.error('AI summary failed. Exporting without it.')
      } else if (summaryOption === 'git') {
        summary = await generateSummary(false)
        if (!summary) toast.error('No git commits found for summary.')
      }

      const doExport = (content: string, type: string, ext: string) => {
        const blob = new Blob([content], { type })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${reportFilename}.${ext}`
        a.click()
        URL.revokeObjectURL(url)
      }

      if (contentType === 'timesheet') {
        const rows = buildTimesheetRows(report)
        switch (exportFormat) {
          case 'csv':
            doExport(timesheetToCsv(rows), 'text/csv', 'csv')
            toast.success('CSV exported')
            break
          case 'markdown':
            doExport(timesheetToMarkdown(rows, report, summary), 'text/markdown', 'md')
            toast.success('Markdown exported')
            break
          case 'pdf': {
            const result = await window.api.reports.exportPdf(timesheetToHtml(rows, report, summary), reportFilename)
            if (result.success && result.data) toast.success('PDF exported')
            break
          }
        }
      } else {
        switch (exportFormat) {
          case 'csv':
            doExport(reportToCsv(report), 'text/csv', 'csv')
            toast.success('CSV exported')
            break
          case 'markdown':
            doExport(reportToMarkdown(report, summary), 'text/markdown', 'md')
            toast.success('Markdown exported')
            break
          case 'pdf': {
            const result = await window.api.reports.exportPdf(reportToHtml(report, summary), reportFilename)
            if (result.success && result.data) toast.success('PDF exported')
            break
          }
        }
      }
      onOpenChange(false)
    } catch {
      toast.error('Export failed')
    } finally {
      setIsExporting(false)
    }
  }, [contentType, exportFormat, summaryOption, report, reportFilename, generateSummary, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[var(--background-primary)] border-[var(--surface-border)] text-[var(--text-primary)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[var(--text-primary)]">Export Report</DialogTitle>
          <DialogDescription className="text-[var(--text-muted)]">
            Choose what to include and the export format.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Content type */}
          <div className="space-y-2">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Content
            </label>
            <div className="space-y-2">
              <RadioOption
                selected={contentType === 'timesheet'}
                onClick={() => setContentType('timesheet')}
                label="Timesheet Only"
                description="Date, client, project, and total hours"
              />
              <RadioOption
                selected={contentType === 'full'}
                onClick={() => setContentType('full')}
                label="Full Report"
                description="All columns including prompts, tokens, and billing"
              />
            </div>
          </div>

          {/* Work Summary */}
          <div className="space-y-2">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Work Summary
            </label>
            <div className="space-y-2">
              <RadioOption
                selected={summaryOption === 'none'}
                onClick={() => setSummaryOption('none')}
                label="None"
                description="Export without a work summary"
              />
              <RadioOption
                selected={summaryOption === 'git'}
                onClick={() => setSummaryOption('git')}
                label="Git Summary"
                description="Aggregate commit messages grouped by project"
              />
              <RadioOption
                selected={summaryOption === 'ai'}
                onClick={() => !hasApiKey ? undefined : setSummaryOption('ai')}
                label="AI Summary"
                description={hasApiKey
                  ? 'Summarize git commits using Claude AI'
                  : 'Add an API key in Settings to enable'}
                disabled={!hasApiKey}
              />
            </div>
            {exportFormat === 'csv' && summaryOption !== 'none' && (
              <p className="text-[11px] text-[var(--text-muted)]">
                Note: Work summary cannot be included in CSV format.
              </p>
            )}
          </div>

          {/* Format */}
          <div className="space-y-2">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Format
            </label>
            <Select value={exportFormat} onValueChange={(v) => setExportFormat(v as ExportFormat)}>
              <SelectTrigger className="h-9 border-[var(--surface-border)] bg-[var(--background-elevated)] text-[var(--text-primary)]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value="csv">CSV (.csv)</SelectItem>
                <SelectItem value="markdown">Markdown (.md)</SelectItem>
                <SelectItem value="pdf">PDF (.pdf)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            className="text-[var(--text-secondary)]"
          >
            Cancel
          </Button>
          <Button
            onClick={handleExport}
            disabled={isExporting}
            className="bg-[var(--accent)] text-white hover:brightness-[1.15]"
          >
            {isExporting ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="mr-1.5 h-3.5 w-3.5" />
            )}
            {isExporting ? 'Exporting...' : 'Export'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function buildReportFilename(report: ReportResult, clients?: { id: number; name: string }[], projects?: { id: number; name: string }[]): string {
  const fmtDate = (iso: string) => {
    const d = new Date(iso)
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  }
  const parts = [`${fmtDate(report.filters.startDate)}-${fmtDate(report.filters.endDate)}`]

  // Collect client names from report data
  const clientNames = new Set<string>()
  const projectNames = new Set<string>()

  if (report.filters.clientId != null && clients) {
    const c = clients.find((cl) => cl.id === report.filters.clientId)
    if (c) clientNames.add(c.name)
  }
  if (report.filters.projectId != null && projects) {
    const p = projects.find((pr) => pr.id === report.filters.projectId)
    if (p) projectNames.add(p.name)
  }

  // If no filter was set, derive from report data
  if (clientNames.size === 0) {
    if (report.sessionBreakdown) {
      for (const item of report.sessionBreakdown) {
        if (item.clientName) clientNames.add(item.clientName)
      }
    }
    if (report.periodSummary) {
      for (const p of report.periodSummary.projects) {
        if (p.clientName) clientNames.add(p.clientName)
      }
    }
  }
  if (projectNames.size === 0) {
    if (report.sessionBreakdown) {
      for (const item of report.sessionBreakdown) projectNames.add(item.projectName)
    }
    if (report.periodSummary) {
      for (const p of report.periodSummary.projects) projectNames.add(p.projectName)
    }
    if (report.dailySummary) {
      for (const item of report.dailySummary) {
        for (const p of item.projects) projectNames.add(p)
      }
    }
  }

  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9-]/g, '')
  if (clientNames.size > 0) parts.push(Array.from(clientNames).map(sanitize).join('-'))
  if (projectNames.size > 0) parts.push(Array.from(projectNames).map(sanitize).join('-'))
  parts.push('Report')

  return parts.join('_')
}

export function ReportsPage(): React.JSX.Element {
  const [datePreset, setDatePreset] = useState<ReportDatePreset>('this-week')
  const [format, setFormat] = useState<ReportFormat>('session-breakdown')
  const [clientId, setClientId] = useState<string>('__all__')
  const [projectId, setProjectId] = useState<string>('__all__')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [report, setReport] = useState<ReportResult | null>(null)
  const [aiSummary, setAiSummary] = useState<string | null>(null)
  const [isGeneratingAi, setIsGeneratingAi] = useState(false)
  const [exportModalOpen, setExportModalOpen] = useState(false)

  const { data: clients } = useClients()
  const { data: allProjects } = useProjects()
  const generateMutation = useGenerateReport()

  const { data: settingsData } = useQuery({
    queryKey: ['settings', 'all'],
    queryFn: async () => {
      const r = await window.api.settings.getAll()
      return r.success ? r.data : {}
    }
  })
  const afterHoursMode = settingsData?.['after_hours_mode'] === 'true'

  const dateRange = useMemo(() => {
    if (datePreset === 'all-time') {
      return {
        startDate: new Date(2020, 0, 1).toISOString(),
        endDate: new Date().toISOString()
      }
    }
    if (datePreset === 'last-month') return getLastMonthRange()
    if (datePreset === 'custom') {
      if (!customStart || !customEnd) return null
      return {
        startDate: new Date(customStart + 'T00:00:00').toISOString(),
        endDate: new Date(customEnd + 'T23:59:59.999').toISOString()
      }
    }
    return getDateRangeForPreset(datePreset as DatePreset)
  }, [datePreset, customStart, customEnd])

  const handleGenerate = useCallback(() => {
    if (!dateRange) return
    const filters = {
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      ...(clientId !== '__all__' ? { clientId: Number(clientId) } : {}),
      ...(projectId !== '__all__' ? { projectId: Number(projectId) } : {}),
      ...(afterHoursMode ? { afterHoursOnly: true } : {})
    }
    generateMutation.mutate(
      { filters, format },
      {
        onSuccess: (data) => {
          setReport(data)
          setAiSummary(null)
        }
      }
    )
  }, [dateRange, clientId, projectId, format, afterHoursMode, generateMutation])

  const { data: hasApiKey } = useQuery({
    queryKey: ['ai', 'hasKey'],
    queryFn: async () => {
      const r = await window.api.ai.hasApiKey()
      return r.success ? r.data : false
    }
  })

  const handleGenerateSummary = useCallback(async (useAi: boolean): Promise<string | null> => {
    if (!report) return null
    setIsGeneratingAi(true)
    try {
      const result = await window.api.ai.generateReportSummary(report.filters, useAi)
      if (result.success && result.data) {
        setAiSummary(result.data)
        toast.success(useAi ? 'AI summary generated' : 'Git summary generated')
        return result.data
      } else {
        toast.error(useAi
          ? 'Could not generate AI summary. Check your API key in Settings.'
          : 'No git commits found for this time range.')
        return null
      }
    } catch {
      toast.error('Failed to generate summary')
      return null
    } finally {
      setIsGeneratingAi(false)
    }
  }, [report])

  const reportFilename = useMemo(() => {
    if (!report) return 'report'
    return buildReportFilename(report, clients ?? undefined, allProjects ?? undefined)
  }, [report, clients, allProjects])

  const isEmpty = report && (!report.summary || report.summary.totalSessions === 0)

  return (
    <div className="flex h-full flex-col">
      {/* Filter bar */}
      <div className="border-b border-[var(--surface-border)]">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
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
            <SelectItem value="all-time">All Time</SelectItem>
            <SelectItem value="custom">Custom Range</SelectItem>
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
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-8 text-[12px]"
            onClick={() => setExportModalOpen(true)}
          >
            <Download className="mr-1 h-3 w-3" />
            Export
          </Button>
        )}
        </div>

        {datePreset === 'custom' && (
          <div className="flex items-center gap-2 px-4 pb-3">
            <input
              type="date"
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
              className="h-8 rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-2 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              style={{ colorScheme: 'dark' }}
            />
            <span className="text-[12px] text-[var(--text-muted)]">{'\u2013'}</span>
            <input
              type="date"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
              className="h-8 rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-2 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              style={{ colorScheme: 'dark' }}
            />
          </div>
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

      {/* Footer - flush to bottom */}
      {report && !isEmpty && report.summary && (
        <ReportFooter
          summary={report.summary}
          workSummary={aiSummary}
          onGenerateSummary={handleGenerateSummary}
          isGenerating={isGeneratingAi}
          hasApiKey={hasApiKey ?? false}
        />
      )}

      {/* Export modal */}
      {report && (
        <ExportModal
          open={exportModalOpen}
          onOpenChange={setExportModalOpen}
          report={report}
          reportFilename={reportFilename}
        />
      )}
    </div>
  )
}
