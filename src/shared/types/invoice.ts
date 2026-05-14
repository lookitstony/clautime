/** Info about a synced Stripe customer */
export interface StripeCustomerInfo {
  stripeCustomerId: string
  email: string
  name: string
}

/** A single line item for an invoice */
export interface InvoiceLineItem {
  description: string
  /** Total amount in cents (integer) — fallback when no hours/rate */
  amountCents: number
  /** Hours worked (decimal, e.g. 5.82) */
  hours?: number
  /** Hourly rate in cents (e.g. 9250 = $92.50/hr) */
  rateCents?: number
}

/** Request to create a draft invoice */
export interface CreateInvoiceRequest {
  clientId: number
  lineItems: InvoiceLineItem[]
  /** Optional memo/note on the invoice */
  memo?: string
  /** Days until due — default 30 */
  daysUntilDue?: number
  /** Billing period start (YYYY-MM-DD) */
  periodStart?: string
  /** Billing period end (YYYY-MM-DD) */
  periodEnd?: string
  /** Restrict payment to ACH only */
  achOnly?: boolean
  /** Metadata for each line item (parallel array to lineItems) */
  lineMeta?: Array<{
    lineDate?: string
    durationMinutes?: number
    sessionIds?: number[]
  }>
}

/** A draft invoice returned after creation */
export interface DraftInvoice {
  localId: number
  invoiceId: string
  stripeCustomerId: string
  status: InvoiceStatus['status']
  amountDueCents: number
  currency: string
  hostedUrl: string | null
  invoicePdf: string | null
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
  invoicePdf: string | null
  dueDate: string | null
  paidAt: string | null
}

/** Valid invoice statuses — shared between services */
export const INVOICE_STATUSES = new Set<InvoiceStatus['status']>(['draft', 'open', 'paid', 'void', 'uncollectible'])

// ── Phase 2: Local invoice history & generation ──

/** Request to generate line items from sessions */
export interface GenerateLineItemsRequest {
  clientId: number
  startDate: string  // YYYY-MM-DD
  endDate: string    // YYYY-MM-DD
  projectId?: number
}

/** A generated line item (before sending to Stripe) */
export interface GeneratedLineItem {
  /** The calendar date this covers (YYYY-MM-DD) */
  lineDate: string
  /** Pre-formatted: "MM/DD/YY ProjectName: Description" */
  description: string
  /** Computed from duration × billable rate */
  amountCents: number
  /** Total session minutes for this day */
  durationMinutes: number
  /** Session IDs that compose this line item */
  sessionIds: number[]
  /** Project name(s) for display */
  projectNames: string[]
}

/** Result of generating line items — includes items + auto-generated memo */
export interface GenerateLineItemsResult {
  lineItems: GeneratedLineItem[]
  /** AI-generated summary memo for the invoice */
  memo: string | null
}

/** Local invoice record (from DB, not Stripe) */
export interface LocalInvoice {
  id: number
  clientId: number
  clientName: string
  stripeInvoiceId: string
  status: InvoiceStatus['status']
  amountDueCents: number
  amountPaidCents: number
  currency: string
  memo: string | null
  hostedUrl: string | null
  invoicePdf: string | null
  dueDate: string | null
  paidAt: string | null
  periodStart: string | null
  periodEnd: string | null
  testMode: boolean
  createdAt: string
}

/** Local invoice with line items */
export interface LocalInvoiceDetail extends LocalInvoice {
  lineItems: Array<{
    id: number
    lineDate: string | null
    description: string
    amountCents: number
    durationMinutes: number | null
    sessionIds: number[] | null
    sortOrder: number
  }>
}

/** Overlap warning for duplicate invoice prevention */
export interface InvoiceOverlap {
  invoiceId: number
  stripeInvoiceId: string
  periodStart: string
  periodEnd: string
  amountDueCents: number
  createdAt: string
}
