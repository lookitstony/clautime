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

interface ConfirmDialogProps {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'default' | 'destructive'
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  onConfirm,
  onCancel
}: ConfirmDialogProps): React.JSX.Element {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onCancel()
      }}
    >
      <AlertDialogContent
        size="sm"
        className="border-[var(--surface-border)] bg-[var(--background-elevated)]"
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="text-[var(--text-primary)]">{title}</AlertDialogTitle>
          <AlertDialogDescription className="text-[var(--text-muted)]">
            {description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={onCancel}
            className="border-[var(--surface-border)] bg-transparent text-[var(--text-secondary)] hover:bg-[var(--surface-border)]/50"
          >
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            variant={variant}
            className={
              variant === 'destructive'
                ? 'bg-red-500/90 text-white hover:bg-red-500'
                : 'bg-[var(--accent)] text-white hover:brightness-[1.15]'
            }
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
