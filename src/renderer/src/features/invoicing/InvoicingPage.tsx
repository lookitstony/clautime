import { useState, useCallback } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Plus, Trash2, Send, ExternalLink, RefreshCw, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { cn } from '@/lib/utils'
import type { Client } from '../../../../shared/types/client-project'
import type { InvoiceStatus } from '../../../../shared/types/invoice'

interface LineItem {
  id: number
  description: string
  amount: string // dollars as string for input
}

let nextLineItemId = 1

export function InvoicingPage(): React.JSX.Element {
  const [selectedClientId, setSelectedClientId] = useState<number | null>(null)
  const [lineItems, setLineItems] = useState<LineItem[]>([{ id: nextLineItemId++, description: '', amount: '' }])
  const [memo, setMemo] = useState('')
  const [lastInvoice, setLastInvoice] = useState<InvoiceStatus | null>(null)
  const [statusCheckId, setStatusCheckId] = useState('')
  const [confirmSend, setConfirmSend] = useState(false)

  // Check if Stripe key is configured
  const { data: hasStripeKey, isLoading: loadingKey } = useQuery({
    queryKey: ['stripe', 'hasKey'],
    queryFn: async () => {
      const r = await window.api.invoice.hasStripeKey()
      return r.success ? r.data : false
    }
  })

  // Load clients
  const { data: clients = [] } = useQuery({
    queryKey: ['clients'],
    queryFn: async () => {
      const r = await window.api.clients.getAll()
      return r.success ? r.data : []
    }
  })

  const selectedClient = clients.find((c: Client) => c.id === selectedClientId) ?? null

  // Clients eligible for invoicing: have email and billable rate
  const invoiceableClients = clients.filter((c: Client) => c.email && c.billableRate && c.isActive)

  const addLineItem = useCallback(() => {
    setLineItems((prev) => [...prev, { id: nextLineItemId++, description: '', amount: '' }])
  }, [])

  const removeLineItem = useCallback((index: number) => {
    setLineItems((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const updateLineItem = useCallback((index: number, field: keyof LineItem, value: string) => {
    setLineItems((prev) => prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)))
  }, [])

  const totalAmount = lineItems.reduce((sum, item) => {
    const val = parseFloat(item.amount)
    return sum + (isNaN(val) ? 0 : val)
  }, 0)

  const isValid =
    selectedClientId !== null &&
    lineItems.length > 0 &&
    lineItems.every((item) => item.description.trim() && parseFloat(item.amount) > 0)

  // Create and send invoice
  const sendInvoice = useMutation({
    mutationFn: async () => {
      if (!selectedClientId) throw new Error('No client selected')

      const items = lineItems.map((item) => ({
        description: item.description.trim(),
        amountCents: Math.round(parseFloat(item.amount) * 100),
        quantity: 1
      }))

      // Create draft
      const draftResult = await window.api.invoice.createDraftInvoice({
        clientId: selectedClientId,
        lineItems: items,
        memo: memo.trim() || undefined
      })
      if (!draftResult.success) throw new Error(draftResult.error.message)

      // Send it
      const sendResult = await window.api.invoice.sendInvoice(draftResult.data.invoiceId)
      if (!sendResult.success) throw new Error(sendResult.error.message)

      return sendResult.data
    },
    onSuccess: (data) => {
      setLastInvoice(data)
      toast.success(`Invoice sent! Total: $${(data.amountDueCents / 100).toFixed(2)}`)
      // Reset form
      setLineItems([{ id: nextLineItemId++, description: '', amount: '' }])
      setMemo('')
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to send invoice')
    }
  })

  // Check invoice status
  const checkStatus = useMutation({
    mutationFn: async (invoiceId: string) => {
      const r = await window.api.invoice.getInvoiceStatus(invoiceId)
      if (!r.success) throw new Error(r.error.message)
      return r.data
    },
    onSuccess: (data) => {
      setLastInvoice(data)
      toast.success(`Invoice status: ${data.status}`)
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to check status')
    }
  })

  if (loadingKey) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderCircle className="h-6 w-6 animate-spin text-[var(--text-muted)]" />
      </div>
    )
  }

  if (!hasStripeKey) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <h1 className="mb-4 text-[18px] font-bold text-[var(--text-primary)]">Invoicing</h1>
        <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--background-elevated)] p-6 text-center">
          <p className="mb-2 text-[14px] text-[var(--text-primary)]">
            Stripe API key required
          </p>
          <p className="text-[12px] text-[var(--text-muted)]">
            Go to Settings and add your Stripe secret key to enable invoicing.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <h1 className="text-[18px] font-bold text-[var(--text-primary)]">Invoicing</h1>

      {/* Client Selection */}
      <section className="rounded-lg border border-[var(--surface-border)] bg-[var(--background-elevated)] p-4">
        <label className="mb-2 block text-[12px] font-semibold text-[var(--text-primary)]">
          Client
        </label>
        {invoiceableClients.length === 0 ? (
          <p className="text-[12px] text-[var(--text-muted)]">
            No clients with email and billable rate configured. Update a client in the Projects page first.
          </p>
        ) : (
          <select
            value={selectedClientId ?? ''}
            onChange={(e) => setSelectedClientId(e.target.value ? Number(e.target.value) : null)}
            className="w-full rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          >
            <option value="">Select a client...</option>
            {invoiceableClients.map((c: Client) => (
              <option key={c.id} value={c.id}>
                {c.name} — {c.email} — ${c.billableRate}/hr
              </option>
            ))}
          </select>
        )}
        {selectedClient && !selectedClient.email && (
          <p className="mt-1 text-[11px] text-amber-400">
            This client needs an email address before you can invoice them.
          </p>
        )}
      </section>

      {/* Line Items */}
      <section className="rounded-lg border border-[var(--surface-border)] bg-[var(--background-elevated)] p-4">
        <div className="mb-3 flex items-center justify-between">
          <label className="text-[12px] font-semibold text-[var(--text-primary)]">
            Line Items
          </label>
          <Button size="sm" variant="ghost" onClick={addLineItem} className="h-7 text-[11px]">
            <Plus className="mr-1 h-3 w-3" /> Add Item
          </Button>
        </div>
        <div className="space-y-2">
          {lineItems.map((item, index) => (
            <div key={item.id} className="flex items-start gap-2">
              <input
                type="text"
                value={item.description}
                onChange={(e) => updateLineItem(index, 'description', e.target.value)}
                placeholder="03/22/26 ProjectName: TICKET-123: Description of work"
                className="flex-1 rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
              />
              <div className="flex items-center gap-1">
                <span className="text-[13px] text-[var(--text-muted)]">$</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={item.amount}
                  onChange={(e) => updateLineItem(index, 'amount', e.target.value)}
                  placeholder="0.00"
                  className="w-24 rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
                />
              </div>
              {lineItems.length > 1 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => removeLineItem(index)}
                  className="h-9 w-9 p-0 text-[var(--text-muted)] hover:text-[var(--destructive)]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ))}
        </div>

        {/* Memo */}
        <div className="mt-3">
          <input
            type="text"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="Invoice memo (optional)"
            className="w-full rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
          />
        </div>

        {/* Total & Send */}
        <div className="mt-4 flex items-center justify-between border-t border-[var(--surface-border)] pt-3">
          <div className="text-[14px] font-semibold text-[var(--text-primary)]">
            Total: ${totalAmount.toFixed(2)}
          </div>
          <Button
            onClick={() => setConfirmSend(true)}
            disabled={!isValid || sendInvoice.isPending}
            className="bg-[var(--accent)] text-white hover:brightness-[1.15]"
          >
            {sendInvoice.isPending ? (
              <>
                <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Send className="mr-2 h-4 w-4" />
                Send Invoice
              </>
            )}
          </Button>
        </div>
      </section>

      {/* Last Invoice Status */}
      {lastInvoice && (
        <section className="rounded-lg border border-[var(--surface-border)] bg-[var(--background-elevated)] p-4">
          <label className="mb-2 block text-[12px] font-semibold text-[var(--text-primary)]">
            Last Invoice
          </label>
          <div className="space-y-1 text-[13px]">
            <div className="flex items-center gap-2">
              <span className="text-[var(--text-muted)]">ID:</span>
              <span className="font-mono text-[var(--text-primary)]">{lastInvoice.invoiceId}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[var(--text-muted)]">Status:</span>
              <span
                className={cn(
                  'rounded px-1.5 py-0.5 text-[11px] font-medium',
                  lastInvoice.status === 'paid' && 'bg-green-500/20 text-green-400',
                  lastInvoice.status === 'open' && 'bg-blue-500/20 text-blue-400',
                  lastInvoice.status === 'draft' && 'bg-gray-500/20 text-gray-400',
                  lastInvoice.status === 'void' && 'bg-red-500/20 text-red-400',
                  lastInvoice.status === 'uncollectible' && 'bg-red-500/20 text-red-400'
                )}
              >
                {lastInvoice.status}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[var(--text-muted)]">Amount:</span>
              <span className="text-[var(--text-primary)]">
                ${(lastInvoice.amountDueCents / 100).toFixed(2)}
              </span>
            </div>
            {lastInvoice.dueDate && (
              <div className="flex items-center gap-2">
                <span className="text-[var(--text-muted)]">Due:</span>
                <span className="text-[var(--text-primary)]">
                  {new Date(lastInvoice.dueDate).toLocaleDateString()}
                </span>
              </div>
            )}
            {lastInvoice.paidAt && (
              <div className="flex items-center gap-2">
                <span className="text-[var(--text-muted)]">Paid:</span>
                <span className="text-green-400">
                  {new Date(lastInvoice.paidAt).toLocaleDateString()}
                </span>
              </div>
            )}
            <div className="flex gap-2 pt-2">
              {lastInvoice.hostedUrl && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const url = lastInvoice.hostedUrl!
                    if (url.startsWith('https://invoice.stripe.com/') || url.startsWith('https://pay.stripe.com/')) {
                      window.open(url, '_blank')
                    } else {
                      toast.error('Unexpected invoice URL')
                    }
                  }}
                  className="text-[11px]"
                >
                  <ExternalLink className="mr-1 h-3 w-3" /> View on Stripe
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => checkStatus.mutate(lastInvoice.invoiceId)}
                disabled={checkStatus.isPending}
                className="text-[11px]"
              >
                <RefreshCw className={cn('mr-1 h-3 w-3', checkStatus.isPending && 'animate-spin')} />
                Refresh Status
              </Button>
            </div>
          </div>
        </section>
      )}

      {/* Check Status by ID */}
      <section className="rounded-lg border border-[var(--surface-border)] bg-[var(--background-elevated)] p-4">
        <label className="mb-2 block text-[12px] font-semibold text-[var(--text-primary)]">
          Check Invoice Status
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={statusCheckId}
            onChange={(e) => setStatusCheckId(e.target.value)}
            placeholder="in_xxxxxxxx (Stripe invoice ID)"
            className="flex-1 rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 font-mono text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
          />
          <Button
            size="sm"
            onClick={() => statusCheckId && checkStatus.mutate(statusCheckId)}
            disabled={!statusCheckId || checkStatus.isPending}
            className="bg-[var(--accent)] text-white hover:brightness-[1.15]"
          >
            {checkStatus.isPending ? 'Checking...' : 'Check'}
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={confirmSend}
        title="Send Invoice"
        description={`Send invoice for $${totalAmount.toFixed(2)} to ${selectedClient?.name ?? 'client'}? This will email a real invoice via Stripe.`}
        confirmLabel="Send"
        cancelLabel="Cancel"
        onConfirm={() => {
          setConfirmSend(false)
          sendInvoice.mutate()
        }}
        onCancel={() => setConfirmSend(false)}
      />
    </div>
  )
}
