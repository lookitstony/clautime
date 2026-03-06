import { useCallback, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReportFilters } from '../../../../shared/types/report'
import { DEFAULT_LAYOUT, WIDGET_REGISTRY, isValidWidgetSize, type DashboardLayout, type WidgetSize } from './widget-registry'

const LAYOUT_KEY = 'analytics_dashboard_layout'

export function useAnalyticsData(filters: ReportFilters | null) {
  const query = useQuery({
    queryKey: ['analytics', filters],
    queryFn: async () => {
      const result = await window.api.reports.generate(filters!, 'session-breakdown')
      if (!result.success) throw new Error(result.error.message)
      return result.data
    },
    enabled: !!filters
  })

  return {
    sessionData: query.data?.sessionBreakdown ?? [],
    summaryData: query.data?.summary ?? null,
    isLoading: query.isLoading,
    isError: query.isError
  }
}

function parseLayout(json: string | undefined | null): DashboardLayout {
  if (!json) return DEFAULT_LAYOUT
  try {
    const parsed = JSON.parse(json)
    if (!parsed?.widgets || !Array.isArray(parsed.widgets)) return DEFAULT_LAYOUT
    const validIds = new Set(WIDGET_REGISTRY.map((w) => w.id))
    const widgets = parsed.widgets.filter(
      (w: unknown): w is { id: string; size: WidgetSize } =>
        typeof w === 'object' && w !== null &&
        typeof (w as Record<string, unknown>).id === 'string' &&
        validIds.has((w as Record<string, unknown>).id as string) &&
        isValidWidgetSize((w as Record<string, unknown>).size)
    )
    return widgets.length > 0 ? { widgets } : DEFAULT_LAYOUT
  } catch {
    return DEFAULT_LAYOUT
  }
}

export function useDashboardLayout() {
  const queryClient = useQueryClient()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const { data: layout } = useQuery({
    queryKey: ['settings', LAYOUT_KEY],
    queryFn: async () => {
      const result = await window.api.settings.get(LAYOUT_KEY)
      return parseLayout(result.success ? result.data : null)
    }
  })

  const saveLayout = useCallback(
    (newLayout: DashboardLayout) => {
      // Optimistic update
      queryClient.setQueryData(['settings', LAYOUT_KEY], newLayout)
      // Debounce persistence
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        window.api.settings.set(LAYOUT_KEY, JSON.stringify(newLayout))
      }, 300)
    },
    [queryClient]
  )

  const currentLayout = layout ?? DEFAULT_LAYOUT

  const getLayout = useCallback(
    (): DashboardLayout => queryClient.getQueryData(['settings', LAYOUT_KEY]) ?? DEFAULT_LAYOUT,
    [queryClient]
  )

  const toggleWidget = useCallback(
    (id: string) => {
      const cur = getLayout()
      const exists = cur.widgets.some((w) => w.id === id)
      const newWidgets = exists
        ? cur.widgets.filter((w) => w.id !== id)
        : [...cur.widgets, { id, size: 'medium' as const }]
      saveLayout({ widgets: newWidgets })
    },
    [getLayout, saveLayout]
  )

  const reorderWidgets = useCallback(
    (fromIndex: number, toIndex: number) => {
      const cur = getLayout()
      const widgets = [...cur.widgets]
      const [moved] = widgets.splice(fromIndex, 1)
      widgets.splice(toIndex, 0, moved)
      saveLayout({ widgets })
    },
    [getLayout, saveLayout]
  )

  const resizeWidget = useCallback(
    (id: string, size: WidgetSize) => {
      const cur = getLayout()
      const widgets = cur.widgets.map((w) => (w.id === id ? { ...w, size } : w))
      saveLayout({ widgets })
    },
    [getLayout, saveLayout]
  )

  return {
    layout: currentLayout,
    saveLayout,
    toggleWidget,
    reorderWidgets,
    resizeWidget
  }
}
