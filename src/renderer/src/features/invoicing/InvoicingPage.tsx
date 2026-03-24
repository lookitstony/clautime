import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { LoaderCircle } from 'lucide-react'
import { InvoiceListView } from './InvoiceListView'
import { InvoiceCreateFlow } from './InvoiceCreateFlow'
import { InvoiceDetailView } from './InvoiceDetailView'

type View = { type: 'list' } | { type: 'create' } | { type: 'detail'; invoiceId: number }

export function InvoicingPage(): React.JSX.Element {
  const [view, setView] = useState<View>({ type: 'list' })

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
      <h1 className="mb-4 text-[18px] font-bold text-[var(--text-primary)]">Invoicing</h1>

      {view.type === 'list' && (
        <InvoiceListView
          onCreateNew={() => setView({ type: 'create' })}
          onSelectInvoice={(id) => setView({ type: 'detail', invoiceId: id })}
        />
      )}

      {view.type === 'create' && (
        <InvoiceCreateFlow
          onBack={() => setView({ type: 'list' })}
          onInvoiceCreated={(id) => setView({ type: 'detail', invoiceId: id })}
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
