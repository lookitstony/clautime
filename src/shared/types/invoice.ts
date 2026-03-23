/** Info about a synced Stripe customer */
export interface StripeCustomerInfo {
  stripeCustomerId: string
  email: string
  name: string
}

/** A single line item for an invoice */
export interface InvoiceLineItem {
  description: string
  /** Amount in cents (integer) */
  amountCents: number
  /** Quantity — defaults to 1 */
  quantity: number
}

/** Request to create a draft invoice */
export interface CreateInvoiceRequest {
  clientId: number
  lineItems: InvoiceLineItem[]
  /** Optional memo/note on the invoice */
  memo?: string
  /** Days until due — default 30 */
  daysUntilDue?: number
}

/** A draft invoice returned after creation */
export interface DraftInvoice {
  invoiceId: string
  stripeCustomerId: string
  status: InvoiceStatus['status']
  amountDueCents: number
  currency: string
  hostedUrl: string | null
  createdAt: string
}

/** Invoice status info */
export interface InvoiceStatus {
  invoiceId: string
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible'
  amountDueCents: number
  amountPaidCents: number
  currency: string
  hostedUrl: string | null
  dueDate: string | null
  paidAt: string | null
}
