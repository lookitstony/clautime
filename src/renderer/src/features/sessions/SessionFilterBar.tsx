import { useState } from 'react'
import { X, CalendarDays } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Calendar } from '@/components/ui/calendar'
import { useFilterStore } from '@/stores/use-filter-store'
import {
  formatShortDate,
  resolveClientName,
  resolveProjectName,
  type DatePreset
} from '@/lib/format'
import { usePresentationMode } from '../settings/use-presentation-mode'
import { PROVIDERS } from '../../../../shared/providers'
import type { Client, Project } from '../../../../shared/types/client-project'
import type { SessionTool } from '../../../../shared/types/session'

interface SessionFilterBarProps {
  clients: Client[]
  projects: Project[]
}

const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'this-week', label: 'This Week' },
  { value: 'last-week', label: 'Last Week' },
  { value: 'this-month', label: 'This Month' }
]

export function SessionFilterBar({ clients, projects }: SessionFilterBarProps): React.JSX.Element {
  const {
    datePreset,
    startDate,
    endDate,
    clientId,
    projectId,
    tool,
    setDatePreset,
    setCustomRange,
    setClientId,
    setProjectId,
    setTool,
    clearFilters,
    hasActiveFilters
  } = useFilterStore()

  const presentationMode = usePresentationMode()
  const [customOpen, setCustomOpen] = useState(false)
  const isCustomRange = datePreset == null && (startDate != null || endDate != null)

  const filteredProjects =
    clientId != null ? projects.filter((p) => p.clientId === clientId) : projects

  const handlePresetClick = (preset: DatePreset): void => {
    if (datePreset === preset) {
      setDatePreset(null)
    } else {
      setDatePreset(preset)
    }
  }

  const handleCustomSelect = (range: { from?: Date; to?: Date } | undefined): void => {
    if (range?.from && range?.to) {
      const start = new Date(range.from.getFullYear(), range.from.getMonth(), range.from.getDate())
      const end = new Date(
        range.to.getFullYear(),
        range.to.getMonth(),
        range.to.getDate(),
        23,
        59,
        59,
        999
      )
      setCustomRange(start.toISOString(), end.toISOString())
      setCustomOpen(false)
    } else if (range?.from) {
      // Single day selected so far — wait for second date
    }
  }

  const customRangeLabel =
    isCustomRange && startDate && endDate
      ? `${formatShortDate(startDate)} – ${formatShortDate(endDate)}`
      : 'Custom'

  const selectedRange =
    isCustomRange && startDate && endDate
      ? { from: new Date(startDate), to: new Date(endDate) }
      : undefined

  return (
    <div
      role="toolbar"
      aria-label="Session filters"
      className="flex flex-wrap items-center gap-2 border-b border-[var(--surface-border)] bg-[var(--background-primary)] px-4 py-2"
    >
      {/* Date presets */}
      {DATE_PRESETS.map((preset) => (
        <Button
          key={preset.value}
          variant="ghost"
          size="sm"
          onClick={() => handlePresetClick(preset.value)}
          className={
            datePreset === preset.value ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : ''
          }
          aria-pressed={datePreset === preset.value}
        >
          {preset.label}
        </Button>
      ))}

      {/* Custom date range */}
      <Popover open={customOpen} onOpenChange={setCustomOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={isCustomRange ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : ''}
            aria-pressed={isCustomRange}
          >
            <CalendarDays className="mr-1 h-3.5 w-3.5" />
            {customRangeLabel}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="range"
            selected={selectedRange}
            onSelect={handleCustomSelect}
            numberOfMonths={2}
          />
        </PopoverContent>
      </Popover>

      {/* Client dropdown */}
      {clients.length > 0 && (
        <Select
          value={clientId != null ? String(clientId) : '__all__'}
          onValueChange={(val) => setClientId(val === '__all__' ? null : Number(val))}
        >
          <SelectTrigger size="sm" className="h-8 min-w-[120px]" aria-label="Filter by client">
            <SelectValue placeholder="All Clients" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All Clients</SelectItem>
            {clients.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>
                {resolveClientName(c, presentationMode)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* Project dropdown */}
      {filteredProjects.length > 0 && (
        <Select
          value={projectId != null ? String(projectId) : '__all__'}
          onValueChange={(val) => setProjectId(val === '__all__' ? null : Number(val))}
        >
          <SelectTrigger size="sm" className="h-8 min-w-[120px]" aria-label="Filter by project">
            <SelectValue placeholder="All Projects" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All Projects</SelectItem>
            {filteredProjects.map((p) => (
              <SelectItem key={p.id} value={String(p.id)}>
                {resolveProjectName(p, presentationMode)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* Tool dropdown */}
      <Select
        value={tool ?? '__all__'}
        onValueChange={(val) => setTool(val === '__all__' ? null : (val as SessionTool))}
      >
        <SelectTrigger size="sm" className="h-8 min-w-[110px]" aria-label="Filter by tool">
          <SelectValue placeholder="All Tools" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">All Tools</SelectItem>
          {PROVIDERS.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.shortLabel}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Clear filters */}
      {hasActiveFilters() && (
        <Button
          variant="ghost"
          size="sm"
          onClick={clearFilters}
          className="ml-auto text-[var(--text-muted)]"
          aria-label="Clear all filters"
        >
          <X className="mr-1 h-3.5 w-3.5" />
          Clear
        </Button>
      )}
    </div>
  )
}
