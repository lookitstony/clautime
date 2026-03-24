import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowLeft, RefreshCw, ExternalLink, XCircle, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import type { LocalInvoiceDetail } from '../../../../shared/types/invoice'

const STATUS_STYLES: Record<string, string> = {
  paid: 'bg-green-500/20 text-green-400',
  open: 'bg-blue-500/20 text-blue-400',
  draft: 'bg-gray-500/20 text-gray-400',
  void: 'bg-red-500/20 text-red-400',
  uncollectible: 'bg-red-500/20 text-red-400',
  overdue: 'bg-amber-500/20 text-amber-400'
}

function getDisplayStatus(inv: LocalInvoiceDetail): string {
  if (inv.status === 'open' && inv.dueDate && new Date(inv.dueDate) < new Date()) {
    return 'overdue'
  }
  return inv.status
}

interface InvoiceDetailViewProps {
  invoiceId: number
  onBack: () => void
}

export function InvoiceDetailView({ invoiceId, onBack }: InvoiceDetailViewProps): React.JSX.Element {
  const queryClient = useQueryClient()
  const [confirmVoid, setConfirmVoid] = useState(false)
  const [confirmSend, setConfirmSend] = useState(false)

  const { data: invoice, isLoading } = useQuery({
    queryKey: ['invoices', invoiceId],
    queryFn: async () => {
      const r = await window.api.invoice.getById(invoiceId)
      return r.success ? r.data : null
    }
  })

  const syncStatus = useMutation({
    mutationFn: async () => {
      const r = await window.api.invoice.syncLocalStatus(invoiceId)
      if (!r.success) throw new Error(r.error.message)
      return r.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
      toast.success('Status updated')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Sync failed')
  })

  const voidInvoice = useMutation({
    mutationFn: async () => {
      if (!invoice) throw new Error('No invoice')
      const r = await window.api.invoice.voidInvoice(invoice.stripeInvoiceId)
      if (!r.success) throw new Error(r.error.message)
      return r.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
      toast.success('Invoice voided')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Void failed')
  })

  const sendInvoice = useMutation({
    mutationFn: async () => {
      if (!invoice) throw new Error('No invoice')
      const r = await window.api.invoice.sendInvoice(invoice.stripeInvoiceId)
      if (!r.success) throw new Error(r.error.message)
      return r.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
      toast.success('Invoice sent')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Send failed')
  })

  if (isLoading || !invoice) {
    return <div className="p-6 text-center text-[var(--text-muted)]">Loading invoice...</div>
  }

  const displayStatus = getDisplayStatus(invoice)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack} className="h-7 px-2">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">Invoice Detail</h2>
      </div>

      {/* Invoice Info */}
      <section className="rounded-lg border border-[var(--surface-border)] bg-[var(--background-elevated)] p-4">
        <div className="grid grid-cols-2 gap-3 text-[13px]">
          <div>
            <span className="text-[var(--text-muted)]">Client</span>
            <p className="text-[var(--text-primary)]">{invoice.clientName}</p>
          </div>
          <div>
            <span className="text-[var(--text-muted)]">Status</span>
            <p>
              <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', STATUS_STYLES[displayStatus] ?? STATUS_STYLES.draft)}>
                {displayStatus}
              </span>
            </p>
          </div>
          <div>
            <span className="text-[var(--text-muted)]">Amount</span>
            <p className="text-[var(--text-primary)] font-semibold">${(invoice.amountDueCents / 100).toFixed(2)}</p>
          </div>
          {invoice.amountPaidCents > 0 && (
            <div>
              <span className="text-[var(--text-muted)]">Paid</span>
              <p className="text-green-400">${(invoice.amountPaidCents / 100).toFixed(2)}</p>
            </div>
          )}
          {invoice.periodStart && invoice.periodEnd && (
            <div>
              <span className="text-[var(--text-muted)]">Period</span>
              <p className="text-[var(--text-primary)]">
                {new Date(invoice.periodStart).toLocaleDateString()} – {new Date(invoice.periodEnd).toLocaleDateString()}
              </p>
            </div>
          )}
          {invoice.dueDate && (
            <div>
              <span className="text-[var(--text-muted)]">Due</span>
              <p className="text-[var(--text-primary)]">{new Date(invoice.dueDate).toLocaleDateString()}</p>
            </div>
          )}
          {invoice.paidAt && (
            <div>
              <span className="text-[var(--text-muted)]">Paid At</span>
              <p className="text-green-400">{new Date(invoice.paidAt).toLocaleDateString()}</p>
            </div>
          )}
          <div>
            <span className="text-[var(--text-muted)]">Stripe ID</span>
            <p className="font-mono text-[12px] text-[var(--text-secondary)]">{invoice.stripeInvoiceId}</p>
          </div>
        </div>

        {invoice.memo && (
          <div className="mt-3 border-t border-[var(--surface-border)] pt-3">
            <span className="text-[12px] text-[var(--text-muted)]">Memo</span>
            <p className="text-[13px] text-[var(--text-primary)]">{invoice.memo}</p>
          </div>
        )}

        {/* Actions */}
        <div className="mt-4 flex gap-2 border-t border-[var(--surface-border)] pt-3">
          {invoice.status === 'draft' && (
            <Button size="sm" onClick={() => setConfirmSend(true)} disabled={sendInvoice.isPending} className="bg-[var(--accent)] text-white hover:brightness-[1.15]">
              <Send className="mr-1 h-3 w-3" /> Send
            </Button>
          )}
          {(invoice.status === 'draft' || invoice.status === 'open') && (
            <Button size="sm" variant="ghost" onClick={() => setConfirmVoid(true)} disabled={voidInvoice.isPending} className="text-[var(--destructive)]">
              <XCircle className="mr-1 h-3 w-3" /> Void
            </Button>
          )}
          {invoice.status !== 'void' && invoice.status !== 'paid' && (
            <Button size="sm" variant="ghost" onClick={() => syncStatus.mutate()} disabled={syncStatus.isPending}>
              <RefreshCw className={cn('mr-1 h-3 w-3', syncStatus.isPending && 'animate-spin')} /> Refresh
            </Button>
          )}
          {invoice.hostedUrl && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const url = invoice.hostedUrl!
                if (url.startsWith('https://invoice.stripe.com/') || url.startsWith('https://pay.stripe.com/')) {
                  window.open(url, '_blank')
                }
              }}
            >
              <ExternalLink className="mr-1 h-3 w-3" /> View on Stripe
            </Button>
          )}
        </div>
      </section>

      {/* Line Items */}
      {invoice.lineItems.length > 0 && (
        <section className="rounded-lg border border-[var(--surface-border)] bg-[var(--background-elevated)] p-4">
          <label className="mb-2 block text-[12px] font-semibold text-[var(--text-primary)]">
            Line Items ({invoice.lineItems.length})
          </label>
          <div className="space-y-2">
            {invoice.lineItems.map((item) => (
              <div key={item.id} className="flex items-start justify-between rounded border border-[var(--surface-border)] bg-[var(--background-primary)] p-3">
                <div className="flex-1">
                  <p className="text-[13px] text-[var(--text-primary)]">{item.description}</p>
                  {item.lineDate && (
                    <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                      {new Date(item.lineDate).toLocaleDateString()}
                      {item.durationMinutes ? ` · ${(item.durationMinutes / 60).toFixed(1)}h` : ''}
                    </p>
                  )}
                </div>
                <span className="ml-3 text-[13px] font-medium text-[var(--text-primary)]">
                  ${(item.amountCents / 100).toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <ConfirmDialog
        open={confirmVoid}
        title="Void Invoice"
        description={`Void this invoice for $${(invoice.amountDueCents / 100).toFixed(2)} to ${invoice.clientName}? This cannot be undone.`}
        confirmLabel="Void"
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={() => { setConfirmVoid(false); voidInvoice.mutate() }}
        onCancel={() => setConfirmVoid(false)}
      />

      <ConfirmDialog
        open={confirmSend}
        title="Send Invoice"
        description={`Send this invoice for $${(invoice.amountDueCents / 100).toFixed(2)} to ${invoice.clientName}?`}
        confirmLabel="Send"
        cancelLabel="Cancel"
        onConfirm={() => { setConfirmSend(false); sendInvoice.mutate() }}
        onCancel={() => setConfirmSend(false)}
      />
    </div>
  )
}
