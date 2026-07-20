import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'

interface DangerConfirmDialogProps {
  open: boolean
  title: string
  /** Rich warning body — spell out exactly what is lost. */
  warning: React.ReactNode
  /** Exact phrase the user must type to arm the confirm button. */
  phrase: string
  confirmLabel?: string
  loading?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * A last-resort confirmation for irreversible, destructive actions. Beyond a
 * normal confirm, it forces the user to type an exact phrase, so the action can
 * never be triggered by a stray click or muscle-memory Enter.
 */
export function DangerConfirmDialog({
  open,
  title,
  warning,
  phrase,
  confirmLabel = 'Delete everything',
  loading = false,
  onConfirm,
  onCancel
}: DangerConfirmDialogProps): React.JSX.Element {
  const [typed, setTyped] = useState('')

  // Clear the field on every close/confirm so the phrase must be re-typed each
  // time — a previous confirmation never leaves the button armed.
  const handleCancel = (): void => {
    setTyped('')
    onCancel()
  }

  const armed = typed.trim() === phrase && !loading

  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) handleCancel()
      }}
    >
      <AlertDialogContent
        size="sm"
        className="border-red-500/40 bg-[var(--background-elevated)]"
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="text-red-400">{title}</AlertDialogTitle>
          {/* Link the warning as the dialog's accessible description so screen
              readers announce what is lost, not just the title. */}
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-[12px] leading-relaxed text-[var(--text-secondary)]">
              {warning}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 text-[12px] leading-relaxed text-[var(--text-secondary)]">
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-[var(--text-primary)]">
              Type <span className="font-mono text-red-400">{phrase}</span> to confirm
            </label>
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={phrase}
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-red-500/60"
            />
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={handleCancel}
            className="border-[var(--surface-border)] bg-transparent text-[var(--text-secondary)] hover:bg-[var(--surface-border)]/50"
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              // Keep the dialog logic in control of when confirm fires.
              if (!armed) {
                e.preventDefault()
                return
              }
              setTyped('')
              onConfirm()
            }}
            disabled={!armed}
            variant="destructive"
            className="bg-red-500/90 text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
