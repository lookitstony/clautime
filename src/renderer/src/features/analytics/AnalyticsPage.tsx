import { useState, useMemo, useEffect, Suspense } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { getDateRangeForPreset, type DatePreset } from '@/lib/format'
import { useClients } from '../clients/use-clients'
import { useProjects } from '../clients/use-projects'
import { useAnalyticsData, useDashboardLayout } from './use-analytics'
import { DashboardGrid } from './DashboardGrid'
import { WidgetPanel } from './WidgetPanel'
import type { ReportFilters } from '../../../../shared/types/report'

type AnalyticsDatePreset = DatePreset | 'last-month' | 'custom' | 'all-time'

function getLastMonthRange(): { startDate: string; endDate: string } {
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const last = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)
  return { startDate: first.toISOString(), endDate: last.toISOString() }
}

export function AnalyticsPage(): React.JSX.Element {
  const [datePreset, setDatePreset] = useState<AnalyticsDatePreset>('this-week')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [clientId, setClientId] = useState('__all__')
  const [projectId, setProjectId] = useState('__all__')

  const { data: clients } = useClients()
  const { data: allProjects } = useProjects()

  const filteredProjects = useMemo(() => {
    if (!allProjects || clientId === '__all__') return allProjects
    return allProjects.filter((p) => p.clientId === Number(clientId))
  }, [allProjects, clientId])

  // Reset project filter when client changes and current project doesn't belong to new client
  useEffect(() => {
    if (projectId !== '__all__' && filteredProjects && !filteredProjects.some((p) => String(p.id) === projectId)) {
      setProjectId('__all__')
    }
  }, [clientId, filteredProjects, projectId])
  const { layout, toggleWidget, reorderWidgets, resizeWidget } = useDashboardLayout()

  const { data: settingsData } = useQuery({
    queryKey: ['settings', 'all'],
    queryFn: async () => {
      const r = await window.api.settings.getAll()
      return r.success ? r.data : {}
    }
  })
  const afterHoursMode = settingsData?.['after_hours_mode'] === 'true'
  const weekStartDay = parseInt(settingsData?.['week_start_day'] ?? '1', 10)

  const filters = useMemo((): ReportFilters | null => {
    let dateRange: { startDate: string; endDate: string } | null = null

    if (datePreset === 'all-time') {
      dateRange = { startDate: new Date(2020, 0, 1).toISOString(), endDate: new Date().toISOString() }
    } else if (datePreset === 'last-month') {
      dateRange = getLastMonthRange()
    } else if (datePreset === 'custom') {
      if (!customStart || !customEnd) return null
      dateRange = {
        startDate: new Date(customStart + 'T00:00:00').toISOString(),
        endDate: new Date(customEnd + 'T23:59:59.999').toISOString()
      }
    } else {
      dateRange = getDateRangeForPreset(datePreset as DatePreset, weekStartDay)
    }

    return {
      ...dateRange,
      ...(clientId !== '__all__' ? { clientId: Number(clientId) } : {}),
      ...(projectId !== '__all__' ? { projectId: Number(projectId) } : {}),
      ...(afterHoursMode ? { afterHoursOnly: true } : {})
    }
  }, [datePreset, customStart, customEnd, clientId, projectId, afterHoursMode, weekStartDay])

  const { sessionData, summaryData, isLoading, isError } = useAnalyticsData(filters)

  return (
    <div className="flex h-full flex-col">
      {/* Filter bar */}
      <div className="border-b border-[var(--surface-border)]">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <Select value={datePreset} onValueChange={(v) => setDatePreset(v as AnalyticsDatePreset)}>
            <SelectTrigger className="h-8 w-[140px] text-[12px]">
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

          {datePreset === 'custom' && (
            <>
              <input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                className="h-8 rounded-md border border-[var(--surface-border)] bg-[var(--background-elevated)] px-2 text-[12px] text-[var(--text-primary)]"
              />
              <input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                className="h-8 rounded-md border border-[var(--surface-border)] bg-[var(--background-elevated)] px-2 text-[12px] text-[var(--text-primary)]"
              />
            </>
          )}

          <Select value={clientId} onValueChange={setClientId}>
            <SelectTrigger className="h-8 w-[140px] text-[12px]">
              <SelectValue placeholder="All Clients" />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="__all__">All Clients</SelectItem>
              {clients?.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger className="h-8 w-[140px] text-[12px]">
              <SelectValue placeholder="All Projects" />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="__all__">All Projects</SelectItem>
              {filteredProjects?.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="ml-auto">
            <WidgetPanel layout={layout} onToggle={toggleWidget} />
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--text-muted)]" />
          </div>
        ) : isError ? (
          <div className="flex h-full items-center justify-center text-sm text-red-400">
            Failed to load analytics data
          </div>
        ) : sessionData.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
            No sessions found for this period
          </div>
        ) : (
          <Suspense fallback={<div className="flex h-32 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" /></div>}>
          <DashboardGrid
            sessionData={sessionData}
            summaryData={summaryData}
            layout={layout}
            onReorder={reorderWidgets}
            onResize={resizeWidget}
          />
          </Suspense>
        )}
      </div>
    </div>
  )
}
