import { useQuery } from '@tanstack/react-query'
import { Plus, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { LocalInvoice } from '../../../../shared/types/invoice'

const STATUS_STYLES: Record<string, string> = {
  paid: 'bg-green-500/20 text-green-400',
  open: 'bg-blue-500/20 text-blue-400',
  draft: 'bg-gray-500/20 text-gray-400',
  void: 'bg-red-500/20 text-red-400',
  uncollectible: 'bg-red-500/20 text-red-400',
  overdue: 'bg-amber-500/20 text-amber-400'
}

function getDisplayStatus(inv: LocalInvoice): string {
  if (inv.status === 'open' && inv.dueDate && new Date(inv.dueDate) < new Date()) {
    return 'overdue'
  }
  return inv.status
}

interface InvoiceListViewProps {
  onCreateNew: () => void
  onSelectInvoice: (id: number) => void
}

export function InvoiceListView({ onCreateNew, onSelectInvoice }: InvoiceListViewProps): React.JSX.Element {
  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ['invoices'],
    queryFn: async () => {
      // Auto-sync non-terminal invoice statuses from Stripe, then fetch all
      await window.api.invoice.syncAllStatuses().catch(() => {})
      const r = await window.api.invoice.getAll()
      return r.success ? r.data : []
    },
    staleTime: 30_000  // Re-sync at most every 30s
  })

  if (isLoading) {
    return <div className="p-6 text-center text-[var(--text-muted)]">Loading invoices...</div>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">Invoices</h2>
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={onCreateNew}
            className="bg-[var(--accent)] text-white hover:brightness-[1.15]"
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> New Invoice
          </Button>
        </div>
      </div>

      {invoices.length === 0 ? (
        <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--background-elevated)] p-8 text-center">
          <p className="text-[14px] text-[var(--text-primary)]">No invoices yet</p>
          <p className="mt-1 text-[12px] text-[var(--text-muted)]">Create your first invoice to get started.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--background-elevated)]">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-[var(--surface-border)] text-left text-[11px] font-medium text-[var(--text-muted)]">
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2">Client</th>
                <th className="px-4 py-2">Period</th>
                <th className="px-4 py-2 text-right">Amount</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv: LocalInvoice) => {
                const displayStatus = getDisplayStatus(inv)
                return (
                  <tr
                    key={inv.id}
                    onClick={() => onSelectInvoice(inv.id)}
                    className="cursor-pointer border-b border-[var(--surface-border)] last:border-b-0 hover:bg-[var(--background-primary)] transition-colors"
                  >
                    <td className="px-4 py-2.5 text-[var(--text-secondary)]">
                      {new Date(inv.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-primary)]">{inv.clientName}</td>
                    <td className="px-4 py-2.5 text-[var(--text-secondary)]">
                      {inv.periodStart && inv.periodEnd
                        ? `${new Date(inv.periodStart).toLocaleDateString()} – ${new Date(inv.periodEnd).toLocaleDateString()}`
                        : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right text-[var(--text-primary)]">
                      ${(inv.amountDueCents / 100).toFixed(2)}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', STATUS_STYLES[displayStatus] ?? STATUS_STYLES.draft)}>
                        {displayStatus}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      {inv.hostedUrl && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            const url = inv.hostedUrl!
                            if (url.startsWith('https://invoice.stripe.com/') || url.startsWith('https://pay.stripe.com/')) {
                              window.open(url, '_blank')
                            }
                          }}
                          className="text-[var(--text-muted)] hover:text-[var(--accent)]"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
