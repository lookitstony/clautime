import { cn } from '@/lib/utils'
import { usePresentationMode } from '@/features/settings/use-presentation-mode'

interface RedactedProps {
  children: React.ReactNode
  className?: string
}

/**
 * Blurs its content while presentation mode is on — for text that can't be
 * swapped for a stage name (AI memos, invoice line descriptions) but would
 * still expose a client on stream.
 */
export function Redacted({ children, className }: RedactedProps): React.JSX.Element {
  const presentationMode = usePresentationMode()
  if (!presentationMode) return <>{children}</>
  return <span className={cn('inline-block blur-[5px] select-none', className)}>{children}</span>
}
