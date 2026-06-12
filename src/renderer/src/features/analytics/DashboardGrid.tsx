import { DragDropProvider } from '@dnd-kit/react'
import { useSortable } from '@dnd-kit/react/sortable'
import { GripVertical, Maximize2, Square } from 'lucide-react'
import { WIDGET_REGISTRY, SIZE_CONFIG, type WidgetSize, type WidgetProps } from './widget-registry'
import type { DashboardLayout } from './widget-registry'

interface DashboardGridProps {
  sessionData: WidgetProps['sessionData']
  summaryData: WidgetProps['summaryData']
  filters?: WidgetProps['filters']
  layout: DashboardLayout
  onReorder: (fromIndex: number, toIndex: number) => void
  onResize: (id: string, size: WidgetSize) => void
}

const SIZE_CYCLE: WidgetSize[] = ['medium', 'large']
const SIZE_ICONS: Record<WidgetSize, typeof Square> = {
  small: Square,
  medium: Square,
  large: Maximize2
}

function SortableWidget({
  widgetId,
  size,
  index,
  sessionData,
  summaryData,
  filters,
  onResize
}: {
  widgetId: string
  size: WidgetSize
  index: number
  sessionData: WidgetProps['sessionData']
  summaryData: WidgetProps['summaryData']
  filters?: WidgetProps['filters']
  onResize: (id: string, size: WidgetSize) => void
}): React.JSX.Element | null {
  const config = WIDGET_REGISTRY.find((w) => w.id === widgetId)
  const { ref, handleRef, isDragging } = useSortable({ id: widgetId, index, transition: null })

  if (!config || !config.component) return null

  const { colSpan, height } = SIZE_CONFIG[size]
  const Component = config.component
  const SizeIcon = SIZE_ICONS[size]
  const nextSize = SIZE_CYCLE[(SIZE_CYCLE.indexOf(size) + 1) % SIZE_CYCLE.length]

  return (
    <div
      ref={ref}
      className="flex flex-col overflow-hidden rounded-lg border border-[var(--surface-border)] bg-[var(--background-elevated)]"
      style={{
        gridColumn: `span ${colSpan}`,
        height: `${height}px`,
        opacity: isDragging ? 0.5 : 1
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--surface-border)] px-3 py-1.5">
        <button
          ref={handleRef}
          className="cursor-grab text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          aria-label={`Drag to reorder ${config.title}`}
        >
          <GripVertical size={14} />
        </button>
        <span className="flex-1 text-xs font-medium text-[var(--text-primary)]">
          {config.title}
        </span>
        <button
          onClick={() => onResize(widgetId, nextSize)}
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          aria-label={`Resize to ${nextSize}`}
          title={`Switch to ${nextSize}`}
        >
          <SizeIcon size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 p-2">
        <Component sessionData={sessionData} summaryData={summaryData} filters={filters} />
      </div>
    </div>
  )
}

export function DashboardGrid({
  sessionData,
  summaryData,
  filters,
  layout,
  onReorder,
  onResize
}: DashboardGridProps): React.JSX.Element {
  return (
    <DragDropProvider
      onDragEnd={(event) => {
        if (event.canceled) return
        const source = event.operation.source
        if (!source) return

        // Sortable items track their own start/end positions — more reliable than
        // resolving the drop target, which can be null when dropping over gaps.
        // dnd-kit optimistically reorders the DOM during drag, so a missed state
        // update here leaves the visual order out of sync until the next remount.
        const { initialIndex, index } = source as unknown as {
          initialIndex?: number
          index?: number
        }
        if (initialIndex != null && index != null && initialIndex !== index) {
          onReorder(initialIndex, index)
        }
      }}
    >
      <div
        className="grid gap-4 p-4"
        style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}
        role="list"
        aria-label="Dashboard widgets"
      >
        {layout.widgets.map((w, i) => (
          <SortableWidget
            key={w.id}
            widgetId={w.id}
            size={w.size}
            index={i}
            sessionData={sessionData}
            summaryData={summaryData}
            filters={filters}
            onResize={onResize}
          />
        ))}
      </div>
    </DragDropProvider>
  )
}
