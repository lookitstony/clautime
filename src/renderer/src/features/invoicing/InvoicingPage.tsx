import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { LoaderCircle } from 'lucide-react'
import { InvoiceListView } from './InvoiceListView'
import { InvoiceCreateFlow } from './InvoiceCreateFlow'
import { InvoiceDetailView } from './InvoiceDetailView'
import { useStripeMode } from './use-stripe-mode'

type View = { type: 'list' } | { type: 'create' } | { type: 'detail'; invoiceId: number }

export function InvoicingPage(): React.JSX.Element {
  const [view, setView] = useState<View>({ type: 'list' })
  const { isTestMode } = useStripeMode()

  const { data: hasStripeKey, isLoading: loadingKey } = useQuery({
    queryKey: ['stripe', 'hasKey'],
    queryFn: async () => {
      const r = await window.api.invoice.hasStripeKey()
      return r.success ? r.data : false
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
          <p className="mb-2 text-[14px] text-[var(--text-primary)]">Stripe API key required</p>
          <p className="text-[12px] text-[var(--text-muted)]">
            Go to Settings and add your Stripe secret key to enable invoicing.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-[18px] font-bold text-[var(--text-primary)]">Invoicing</h1>
          {isTestMode && (
            <span className="rounded bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-amber-400">
              SANDBOX
            </span>
          )}
        </div>
        <button
          onClick={() => window.open('https://donate.stripe.com/3cI8wH4fJ2N86AQdZp4Vy00', '_blank')}
          className="flex items-center gap-1.5 rounded-md border border-green-500/30 bg-green-500/10 px-3 py-1.5 text-[12px] text-green-400 transition-colors hover:bg-green-500/20"
        >
          🥭 Saved Money?
        </button>
      </div>

      {view.type === 'list' && (
        <InvoiceListView
          onCreateNew={() => setView({ type: 'create' })}
          onSelectInvoice={(id) => setView({ type: 'detail', invoiceId: id })}
        />
      )}

      {view.type === 'create' && (
        <InvoiceCreateFlow
          onBack={() => setView({ type: 'list' })}
          onInvoiceCreated={(draft) => setView({ type: 'detail', invoiceId: draft.localId })}
        />
      )}

      {view.type === 'detail' && (
        <InvoiceDetailView
          invoiceId={view.invoiceId}
          onBack={() => setView({ type: 'list' })}
        />
      )}
    </div>
  )
}
