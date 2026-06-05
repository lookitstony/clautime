const PROJECT_COLORS = [
  'var(--project-1)',
  'var(--project-2)',
  'var(--project-3)',
  'var(--project-4)',
  'var(--project-5)',
  'var(--project-6)',
  'var(--project-7)',
  'var(--project-8)'
]

export function formatDuration(minutes: number): string {
  if (minutes <= 0) return '0m'
  const hours = Math.floor(minutes / 60)
  const mins = Math.round(minutes % 60)
  if (hours === 0) return `${mins}m`
  if (mins === 0) return `${hours}h`
  return `${hours}h ${mins}m`
}

export function formatTimeRange(startedAt: string, endedAt: string): string {
  const start = new Date(startedAt)
  const end = new Date(endedAt)
  const fmt = (d: Date): string =>
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${fmt(start)} \u2013 ${fmt(end)}`
}

export function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60_000)

  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin} min ago`

  const diffHours = Math.floor(diffMin / 60)
  if (diffHours < 24) return `${diffHours}h ago`

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return 'yesterday'

  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function formatDateLabel(isoString: string): string {
  const date = new Date(isoString)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86_400_000)

  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: 'long' })
  }
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

export function getDateKey(isoString: string): string {
  const d = new Date(isoString)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function getProjectColor(projectPath: string): string {
  let hash = 0
  for (const char of projectPath) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0
  }
  return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length]
}

export function getProjectName(projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  return segments[segments.length - 1] || projectPath
}

export function formatCompactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

export type DatePreset = 'today' | 'this-week' | 'last-week' | 'this-month'

/**
 * Compute start/end ISO date strings for a date preset.
 * @param weekStartDay 0 = Sunday, 1 = Monday (default)
 */
export function getDateRangeForPreset(
  preset: DatePreset,
  weekStartDay: number = 1
): { startDate: string; endDate: string } {
  const now = new Date()
  const startOfDay = (d: Date): string => {
    const s = new Date(d.getFullYear(), d.getMonth(), d.getDate())
    return s.toISOString()
  }
  const endOfDay = (d: Date): string => {
    const e = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)
    return e.toISOString()
  }

  // Calculate days since the start of the current week
  const daysSinceWeekStart = (now.getDay() - weekStartDay + 7) % 7

  switch (preset) {
    case 'today':
      return { startDate: startOfDay(now), endDate: endOfDay(now) }
    case 'this-week': {
      const weekStart = new Date(now)
      weekStart.setDate(now.getDate() - daysSinceWeekStart)
      return { startDate: startOfDay(weekStart), endDate: endOfDay(now) }
    }
    case 'last-week': {
      const thisWeekStart = new Date(now)
      thisWeekStart.setDate(now.getDate() - daysSinceWeekStart)
      const lastWeekStart = new Date(thisWeekStart)
      lastWeekStart.setDate(thisWeekStart.getDate() - 7)
      const lastWeekEnd = new Date(thisWeekStart)
      lastWeekEnd.setDate(thisWeekStart.getDate() - 1)
      return { startDate: startOfDay(lastWeekStart), endDate: endOfDay(lastWeekEnd) }
    }
    case 'this-month': {
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1)
      return { startDate: startOfDay(firstDay), endDate: endOfDay(now) }
    }
  }
}

/**
 * Format an ISO date string as a short display date (e.g., "Mar 5").
 */
export function formatShortDate(isoString: string): string {
  const d = new Date(isoString)
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/**
 * Format a YYYY-MM-DD date key as a short display date (e.g., "Mar 5").
 * Uses noon to avoid timezone-shift issues.
 */
export function formatDateKey(dateKey: string): string {
  const d = new Date(dateKey + 'T12:00:00')
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
