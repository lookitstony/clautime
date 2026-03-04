import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  action?: ReactNode
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action
}: EmptyStateProps): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-center">
        <Icon size={24} className="text-[var(--text-muted)]" />
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-[13px] text-[var(--text-muted)]">{description}</p>
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  )
}
