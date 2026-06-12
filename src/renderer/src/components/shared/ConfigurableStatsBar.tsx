import { useCallback, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DragDropProvider } from '@dnd-kit/react'
import { useSortable } from '@dnd-kit/react/sortable'
import { SlidersHorizontal } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'

/** One stat card definition supplied by the page. */
export interface StatCardDef {
  id: string
  label: string
  value: string | number
  accent?: boolean
  /** When false the card is skipped even if enabled (e.g. zero commits) */
  available?: boolean
}

interface StatsBarLayout {
  /** Display order of card ids (superset-tolerant; unknown ids ignored) */
  order: string[]
  /** Card ids the user switched off */
  hidden: string[]
}

function parseStatsLayout(json: string | null | undefined): StatsBarLayout {
  if (!json) return { order: [], hidden: [] }
  try {
    const parsed = JSON.parse(json)
    return {
      order: Array.isArray(parsed?.order) ? parsed.order.filter((v: unknown) => typeof v === 'string') : [],
      hidden: Array.isArray(parsed?.hidden) ? parsed.hidden.filter((v: unknown) => typeof v === 'string') : []
    }
  } catch {
    return { order: [], hidden: [] }
  }
}

/** Persisted enable/disable + ordering for a stats bar, stored in app settings. */
function useStatsBarLayout(storageKey: string): {
  layout: StatsBarLayout
  toggle: (id: string) => void
  reorder: (orderedVisibleIds: string[], fromIndex: number, toIndex: number) => void
} {
  const queryClient = useQueryClient()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const { data: layout } = useQuery({
    queryKey: ['settings', storageKey],
    queryFn: async () => {
      const result = await window.api.settings.get(storageKey)
      return parseStatsLayout(result.success ? result.data : null)
    }
  })

  const save = useCallback(
    (newLayout: StatsBarLayout) => {
      queryClient.setQueryData(['settings', storageKey], newLayout)
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        window.api.settings.set(storageKey, JSON.stringify(newLayout))
      }, 300)
    },
    [queryClient, storageKey]
  )

  const getLayout = useCallback(
    (): StatsBarLayout =>
      queryClient.getQueryData(['settings', storageKey]) ?? { order: [], hidden: [] },
    [queryClient, storageKey]
  )

  const toggle = useCallback(
    (id: string) => {
      const cur = getLayout()
      const hidden = cur.hidden.includes(id)
        ? cur.hidden.filter((h) => h !== id)
        : [...cur.hidden, id]
      save({ ...cur, hidden })
    },
    [getLayout, save]
  )

  const reorder = useCallback(
    (orderedVisibleIds: string[], fromIndex: number, toIndex: number) => {
      const next = [...orderedVisibleIds]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      const cur = getLayout()
      // Persist full order: moved visible ids first, then any hidden/unknown ids keep
      // their relative position at the end so they reappear where expected.
      const rest = cur.order.filter((id) => !next.includes(id))
      save({ ...cur, order: [...next, ...rest] })
    },
    [getLayout, save]
  )

  return { layout: layout ?? { order: [], hidden: [] }, toggle, reorder }
}

function orderDefs(defs: StatCardDef[], order: string[]): StatCardDef[] {
  if (order.length === 0) return defs
  const pos = new Map(order.map((id, i) => [id, i]))
  return [...defs].sort((a, b) => {
    const pa = pos.get(a.id) ?? order.length + defs.indexOf(a)
    const pb = pos.get(b.id) ?? order.length + defs.indexOf(b)
    return pa - pb
  })
}

function SortableStatCard({
  def,
  index
}: {
  def: StatCardDef
  index: number
}): React.JSX.Element {
  const { ref, handleRef, isDragging } = useSortable({ id: def.id, index, transition: null })
  return (
    <div ref={ref} style={{ opacity: isDragging ? 0.5 : 1 }}>
      <Card
        ref={handleRef as React.Ref<HTMLDivElement>}
        aria-label={`Drag to reorder ${def.label}`}
        className="cursor-grab bg-[var(--background-elevated)] border-[var(--surface-border)]"
      >
        <CardContent className="px-4 py-3">
          <p className="text-[11px] font-normal uppercase tracking-wider text-[var(--text-muted)]">
            {def.label}
          </p>
          <p
            className={`mt-1 font-mono text-2xl font-bold ${def.accent ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}
          >
            {def.value}
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

function StatCardSkeleton(): React.JSX.Element {
  return (
    <Card className="bg-[var(--background-elevated)] border-[var(--surface-border)]">
      <CardContent className="px-4 py-3">
        <Skeleton className="h-3 w-20 bg-[var(--surface-border)]" />
        <Skeleton className="mt-2 h-7 w-16 bg-[var(--surface-border)]" />
      </CardContent>
    </Card>
  )
}

interface ConfigurableStatsBarProps {
  /** Settings key the layout persists under (unique per page) */
  storageKey: string
  defs: StatCardDef[]
  isLoading: boolean
  skeletonCount?: number
  /** Minimum card width for the responsive grid */
  minCardWidth?: number
}

export function ConfigurableStatsBar({
  storageKey,
  defs,
  isLoading,
  skeletonCount = 4,
  minCardWidth = 160
}: ConfigurableStatsBarProps): React.JSX.Element {
  const { layout, toggle, reorder } = useStatsBarLayout(storageKey)

  if (isLoading) {
    return (
      <div
        className="grid gap-3 p-4"
        style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${minCardWidth}px, 1fr))` }}
      >
        {Array.from({ length: skeletonCount }, (_, i) => (
          <StatCardSkeleton key={i} />
        ))}
      </div>
    )
  }

  const hidden = new Set(layout.hidden)
  const ordered = orderDefs(defs, layout.order)
  const visible = ordered.filter((d) => d.available !== false && !hidden.has(d.id))
  const visibleIds = visible.map((d) => d.id)

  return (
    <div className="group/statsbar relative">
      <DragDropProvider
        onDragEnd={(event) => {
          if (event.canceled) return
          const source = event.operation.source
          if (!source) return
          const { initialIndex, index } = source as unknown as {
            initialIndex?: number
            index?: number
          }
          if (initialIndex != null && index != null && initialIndex !== index) {
            reorder(visibleIds, initialIndex, index)
          }
        }}
      >
        <div
          className="grid gap-3 p-4"
          style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${minCardWidth}px, 1fr))` }}
        >
          {visible.map((def, i) => (
            <SortableStatCard key={def.id} def={def} index={i} />
          ))}
        </div>
      </DragDropProvider>
      <div className="absolute right-1 top-1 opacity-0 transition-opacity group-hover/statsbar:opacity-100">
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-[var(--text-muted)]"
              aria-label="Customize stat cards"
            >
              <SlidersHorizontal size={13} />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-56 border-[var(--surface-border)] bg-[var(--background-elevated)] p-2 text-[var(--text-primary)]"
          >
            <div className="space-y-1">
              {ordered.map((def) => (
                <div
                  key={def.id}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5"
                >
                  <span className="flex-1 text-xs">{def.label}</span>
                  <Switch
                    checked={!hidden.has(def.id)}
                    onCheckedChange={() => toggle(def.id)}
                    aria-label={`Toggle ${def.label}`}
                  />
                </div>
              ))}
            </div>
            <p className="mt-2 px-2 text-[10px] text-[var(--text-muted)]">
              Drag cards to reorder
            </p>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
