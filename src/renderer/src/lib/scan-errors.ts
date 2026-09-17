import { toast } from 'sonner'
import { useRescanStore } from '@/stores/use-rescan-store'
import type { SessionScanError } from '../../../shared/types/session'

/** Keep partial scans visible without suppressing refreshes of committed work. */
export function reportScanErrors(errors?: SessionScanError[]): boolean {
  if (!errors?.length) return false
  useRescanStore.getState().markPending()
  toast.error(`${errors.length} source file(s) need history review. Other files were updated.`, {
    id: 'session-reconciliation-errors',
    description: errors.map((error) => error.message).join('\n'),
    duration: Infinity,
    closeButton: true
  })
  return true
}
