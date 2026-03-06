import { LayoutGrid } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { WIDGET_REGISTRY } from './widget-registry'
import type { DashboardLayout } from './widget-registry'

interface WidgetPanelProps {
  layout: DashboardLayout
  onToggle: (id: string) => void
}

export function WidgetPanel({ layout, onToggle }: WidgetPanelProps): React.JSX.Element {
  const activeIds = new Set(layout.widgets.map((w) => w.id))

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-[12px]">
          <LayoutGrid size={14} />
          Customize
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 border-[var(--surface-border)] bg-[var(--background-elevated)] p-2 text-[var(--text-primary)]">
        <div className="space-y-1">
          {WIDGET_REGISTRY.map((widget) => {
            const Icon = widget.icon
            return (
              <div key={widget.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--background-elevated)]">
                <Icon size={16} className="shrink-0 text-[var(--text-muted)]" />
                <span className="flex-1 text-xs">{widget.title}</span>
                <Switch
                  checked={activeIds.has(widget.id)}
                  onCheckedChange={() => onToggle(widget.id)}
                  aria-label={`Toggle ${widget.title}`}
                />
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
