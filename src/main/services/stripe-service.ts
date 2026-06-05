import Stripe from 'stripe'
import { eq } from 'drizzle-orm'
import log from 'electron-log/main.js'
import { credentialService } from './credential-service'
import { clientProjectService } from './client-project-service'
import { getDb } from '../db'
import { clients } from '../db/schema/clients'
import { AppError } from '../../shared/types/ipc'
import {
  INVOICE_STATUSES,
  type StripeCustomerInfo,
  type CreateInvoiceRequest,
  type DraftInvoice,
  type InvoiceStatus
} from '../../shared/types/invoice'

let cachedStripe: Stripe | null = null
let cachedKey: string | null = null

function getStripeClient(): Stripe {
  const key = credentialService.getStripeKey()
  if (!key) {
    throw new AppError('STRIPE_NO_KEY', 'No Stripe API key configured. Add one in Settings.')
  }
  if (cachedStripe && cachedKey === key) return cachedStripe
  cachedStripe = new Stripe(key)
  cachedKey = key
  return cachedStripe
}

/** Clear the cached Stripe client (call when key changes). */
export function clearStripeCache(): void {
  cachedStripe = null
  cachedKey = null
}

function validateInvoiceId(invoiceId: string): void {
  if (!invoiceId || !/^in_[a-zA-Z0-9]+$/.test(invoiceId)) {
    throw new AppError('INVALID_INVOICE_ID', 'Invalid Stripe invoice ID format')
  }
}

function mapInvoiceStatus(inv: Stripe.Invoice): InvoiceStatus {
  const status = INVOICE_STATUSES.has(inv.status as InvoiceStatus['status'])
    ? (inv.status as InvoiceStatus['status'])
    : 'draft'
  return {
    invoiceId: inv.id,
    status,
    amountDueCents: inv.amount_due,
    amountPaidCents: inv.amount_paid,
    currency: inv.currency,
    hostedUrl: inv.hosted_invoice_url ?? null,
    invoicePdf: inv.invoice_pdf ?? null,
    dueDate: inv.due_date ? new Date(inv.due_date * 1000).toISOString() : null,
    paidAt: inv.status_transitions?.paid_at
      ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
      : null
  }
}

export const stripeService = {
  /**
   * Validate the stored API key by retrieving the Stripe account.
   */
  async testConnection(): Promise<boolean> {
    const stripe = getStripeClient()
    await stripe.accounts.retrieve()
    return true
  },

  /**
   * Create or retrieve a Stripe Customer for the given ClauTime client.
   * Stores the stripe_customer_id back on the client row.
   */
  async syncCustomer(clientId: number): Promise<StripeCustomerInfo> {
    const client = clientProjectService.getClientById(clientId)
    if (!client) {
      throw new AppError('CLIENT_NOT_FOUND', `Client ${clientId} not found`)
    }
    if (!client.email) {
      throw new AppError('CLIENT_EMAIL_REQUIRED', 'Client email is required for invoicing')
    }

    // In test mode, override email with test email if configured
    const effectiveEmail = credentialService.isStripeTestMode()
      ? credentialService.getStripeTestEmail() || client.email
      : client.email

    const stripe = getStripeClient()

    // If we already have a Stripe customer ID, retrieve it
    if (client.stripeCustomerId) {
      try {
        const existing = await stripe.customers.retrieve(client.stripeCustomerId)
        if (!existing.deleted) {
          return {
            stripeCustomerId: existing.id,
            email: (existing as Stripe.Customer).email ?? client.email,
            name: (existing as Stripe.Customer).name ?? client.name
          }
        }
        log.warn(`Stripe customer ${client.stripeCustomerId} was deleted, creating new one`)
      } catch (_err: unknown) {
        // Customer doesn't exist (e.g. switching from test to live mode)
        log.warn(`Stripe customer ${client.stripeCustomerId} not found, creating new one`)
      }
    }

    // Search by email first to avoid duplicates
    const existing = await stripe.customers.list({ email: effectiveEmail, limit: 1 })
    let customerId: string

    if (existing.data.length > 0) {
      customerId = existing.data[0].id
      log.info(`Found existing Stripe customer ${customerId} for client ${clientId}`)
    } else {
      const created = await stripe.customers.create({
        email: effectiveEmail,
        name: client.name
      })
      customerId = created.id
      log.info(`Created Stripe customer ${customerId} for client ${clientId}`)
    }

    // Store the Stripe customer ID on the client row
    const db = getDb()
    db.update(clients)
      .set({ stripeCustomerId: customerId, updatedAt: new Date().toISOString() })
      .where(eq(clients.id, clientId))
      .run()

    return {
      stripeCustomerId: customerId,
      email: effectiveEmail,
      name: client.name
    }
  },

  /**
   * Create a draft invoice with line items.
   * Does NOT finalize or send — call sendInvoice to finalize and send.
   */
  async createDraftInvoice(request: CreateInvoiceRequest): Promise<Omit<DraftInvoice, 'localId'>> {
    if (request.lineItems.length === 0) {
      throw new AppError('INVOICE_NO_ITEMS', 'At least one line item is required')
    }

    // Ensure customer exists in Stripe
    const customer = await stripeService.syncCustomer(request.clientId)
    const stripe = getStripeClient()

    // Create the invoice
    const invoice = await stripe.invoices.create({
      customer: customer.stripeCustomerId,
      collection_method: 'send_invoice',
      days_until_due: request.daysUntilDue ?? 30,
      payment_settings: {
        payment_method_types: request.achOnly ? ['us_bank_account'] : ['ach_debit', 'card']
      },
      ...(request.memo && { description: request.memo.slice(0, 500) })
    })

    // Add line items
    for (const item of request.lineItems) {
      if (
        item.hours &&
        item.rateCents &&
        item.hours > 0 &&
        item.rateCents > 0 &&
        isFinite(item.hours) &&
        isFinite(item.rateCents)
      ) {
        // Decimal qty (hours) × unit rate (hourly rate in cents)
        // quantity_decimal exists in Stripe API but not yet in SDK v20 types — remove cast when upgraded
        await stripe.invoiceItems.create({
          customer: customer.stripeCustomerId,
          invoice: invoice.id,
          description: item.description,
          quantity_decimal: String(item.hours),
          unit_amount_decimal: String(item.rateCents),
          currency: 'usd'
        } as Parameters<typeof stripe.invoiceItems.create>[0])
      } else {
        await stripe.invoiceItems.create({
          customer: customer.stripeCustomerId,
          invoice: invoice.id,
          description: item.description,
          amount: item.amountCents,
          currency: 'usd'
        })
      }
    }

    // Retrieve the updated invoice to get totals
    const updated = await stripe.invoices.retrieve(invoice.id)

    log.info(`Created draft invoice ${invoice.id} for client ${request.clientId}`)

    return {
      invoiceId: updated.id,
      stripeCustomerId: customer.stripeCustomerId,
      status: (INVOICE_STATUSES.has(updated.status as InvoiceStatus['status'])
        ? updated.status
        : 'draft') as InvoiceStatus['status'],
      amountDueCents: updated.amount_due,
      currency: updated.currency,
      hostedUrl: updated.hosted_invoice_url ?? null,
      invoicePdf: updated.invoice_pdf ?? null,
      createdAt: new Date(updated.created * 1000).toISOString()
    }
  },

  /**
   * Finalize and send an invoice. Returns updated status.
   */
  async sendInvoice(invoiceId: string): Promise<InvoiceStatus> {
    validateInvoiceId(invoiceId)
    const stripe = getStripeClient()

    // Finalize the draft
    await stripe.invoices.finalizeInvoice(invoiceId)

    // Send it
    const sent = await stripe.invoices.sendInvoice(invoiceId)

    log.info(`Sent invoice ${invoiceId}`)
    return mapInvoiceStatus(sent)
  },

  /**
   * Get the current status of an invoice.
   */
  async getInvoiceStatus(invoiceId: string): Promise<InvoiceStatus> {
    validateInvoiceId(invoiceId)
    const stripe = getStripeClient()
    const invoice = await stripe.invoices.retrieve(invoiceId)
    return mapInvoiceStatus(invoice)
  },

  /**
   * Void an open invoice.
   */
  async voidInvoice(invoiceId: string): Promise<InvoiceStatus> {
    validateInvoiceId(invoiceId)
    const stripe = getStripeClient()
    const invoice = await stripe.invoices.voidInvoice(invoiceId)
    log.info(`Voided invoice ${invoiceId}`)
    return mapInvoiceStatus(invoice)
  },

  /**
   * List recent invoices from Stripe (up to 100).
   */
  async listInvoices(limit = 100): Promise<Stripe.Invoice[]> {
    const stripe = getStripeClient()
    const result = await stripe.invoices.list({ limit, expand: ['data.lines'] })
    if (result.has_more) {
      log.warn(
        `Stripe has more than ${limit} invoices — only the most recent ${limit} were fetched`
      )
    }
    return result.data
  }
}
