import Stripe from 'stripe'
import { eq } from 'drizzle-orm'
import log from 'electron-log/main.js'
import { credentialService } from './credential-service'
import { getDb } from '../db'
import { clients } from '../db/schema/clients'
import { AppError } from '../../shared/types/ipc'
import type { StripeCustomerInfo, CreateInvoiceRequest } from '../../shared/types/invoice'
import { isSyncUuid } from './folder-sync-protocol'
import {
  createDraftInvoiceOperation,
  ensureCustomer,
  observedStatus,
  readStripeContext,
  responseDate,
  retainedInvoiceRequest,
  sendInvoiceOperation,
  voidInvoiceOperation,
  type CreatedDraft,
  type InvoiceClient,
  type ProviderStatusRead
} from './stripe-operation-service'
import {
  checkBeforeSend,
  checkNewInvoiceBilling,
  importBeforeInvoiceWrite
} from './invoice-preflight'
import { retainProviderOperation } from './provider-operation-store'
import { checkSavedInvoiceAccount, bindRetrievedInvoiceAccount } from './invoice-provider-scope'
import { findClientByPortableId, portableIdOfClientRow } from './folder-sync-builtin-client'
import type { ProviderAccount } from './provider-operation-store'
import { requestFromFrozenInvoice } from './pending-invoice-operations'
import { completeInvoiceLines, refreshClientStripeInvoices } from './invoice-stripe-import'
import { cancelInvoiceOperation, type CancellationProof } from './invoice-operation-resolution'

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

/** Client fields a Stripe operation freezes; the portable identity, not the local row ID. */
function invoiceClient(clientId: number): InvoiceClient {
  const db = getDb()
  const client = db.select().from(clients).where(eq(clients.id, clientId)).get()
  if (!client) {
    throw new AppError('CLIENT_NOT_FOUND', `Client ${clientId} not found`)
  }
  if (!client.email) {
    throw new AppError('CLIENT_EMAIL_REQUIRED', 'Client email is required for invoicing')
  }
  // In test mode, override email with test email if configured
  const email = credentialService.isStripeTestMode()
    ? credentialService.getStripeTestEmail() || client.email
    : client.email
  return {
    localId: client.id,
    // The identity every computer shares, including an explicit join link.
    syncId: portableIdOfClientRow(db, client),
    name: client.name,
    email,
    stripeCustomerId: client.stripeCustomerId
  }
}

/**
 * Only the renderer's draft fields. Anything else (for example an injected `portableBilling`)
 * is dropped; a resumed operation's billing comes from its retained request alone.
 */
export function plainCreateRequest(request: CreateInvoiceRequest): CreateInvoiceRequest {
  if (!request || typeof request !== 'object')
    throw new AppError('INVALID_PROVIDER_OPERATION', 'Invalid invoice request')
  return {
    operationId: request.operationId,
    clientId: request.clientId,
    lineItems: request.lineItems,
    memo: request.memo,
    daysUntilDue: request.daysUntilDue,
    periodStart: request.periodStart,
    periodEnd: request.periodEnd,
    achOnly: request.achOnly,
    lineMeta: request.lineMeta
  }
}

/** Compatibility cache; verified account-specific references are retained separately. */
function rememberCustomer(clientId: number, customerId: string): void {
  getDb()
    .update(clients)
    .set({ stripeCustomerId: customerId, updatedAt: new Date().toISOString() })
    .where(eq(clients.id, clientId))
    .run()
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
   * Find or create the Stripe Customer for a ClauTime client as an explicit operation.
   * Stores the stripe_customer_id back on the client row.
   */
  async syncCustomer(clientId: number, operationId: string): Promise<StripeCustomerInfo> {
    if (!isSyncUuid(operationId)) {
      throw new AppError('INVALID_PROVIDER_OPERATION', 'Customer sync needs a stable operation ID.')
    }
    const client = invoiceClient(clientId)
    const stripe = getStripeClient()
    const testMode = credentialService.isStripeTestMode()
    const db = getDb()
    const context = await readStripeContext(stripe, testMode)
    retainProviderOperation(db, {
      id: operationId,
      accountId: context.accountId,
      testMode: context.testMode,
      kind: 'sync-customer',
      request: { clientSyncId: client.syncId, email: client.email, name: client.name }
    })
    const customerId = await ensureCustomer(db, stripe, testMode, operationId, client, context)
    rememberCustomer(clientId, customerId)
    log.info(`Synced Stripe customer ${customerId} for client ${clientId}`)
    return { stripeCustomerId: customerId, email: client.email, name: client.name }
  },

  /**
   * Create a draft invoice with line items under the request's operation ID.
   * Does NOT finalize or send — call sendInvoice to finalize and send.
   * Always imports available shared history first. A NEW operation then refreshes this
   * client's Stripe invoices with the captured account and checks billed work before it is
   * retained; a retained one resumes exactly as saved.
   */
  async createDraftInvoice(request: CreateInvoiceRequest): Promise<CreatedDraft> {
    const db = getDb()
    const testMode = credentialService.isStripeTestMode()
    const plain = plainCreateRequest(request)
    await importBeforeInvoiceWrite(db)
    const created = await createDraftInvoiceOperation(
      db,
      getStripeClient(),
      testMode,
      plain,
      invoiceClient(plain.clientId),
      {
        refresh: (stripe, context) =>
          refreshClientStripeInvoices(db, stripe, context, plain.clientId),
        preflight: (tx, frozen, localBilling) =>
          checkNewInvoiceBilling(tx, plain.clientId, frozen, localBilling, testMode)
      }
    )
    rememberCustomer(plain.clientId, created.draft.stripeCustomerId)
    log.info(`Created draft invoice ${created.draft.invoiceId} for client ${plain.clientId}`)
    return created
  },

  async resumeDraftInvoice(operationId: string): Promise<CreatedDraft & { clientId: number }> {
    const db = getDb()
    if (!isSyncUuid(operationId))
      throw new AppError(
        'INVOICE_OPERATION_NOT_FOUND',
        'This saved invoice operation is unavailable.'
      )
    // Results, rejections or a cancellation recorded on the other computer arrive first.
    await importBeforeInvoiceWrite(db)
    // Strict allowlist read of the retained (possibly imported) request; never re-derived.
    const frozen = retainedInvoiceRequest(db, operationId)
    if (!frozen)
      throw new AppError(
        'INVOICE_OPERATION_NOT_FOUND',
        'This saved invoice operation is unavailable.'
      )
    const local = findClientByPortableId(db, frozen.clientSyncId)
    if (!local)
      throw new AppError(
        'CLIENT_NOT_FOUND',
        'Import the saved invoice client before resuming this draft.'
      )
    const created = await createDraftInvoiceOperation(
      db,
      getStripeClient(),
      credentialService.isStripeTestMode(),
      requestFromFrozenInvoice(operationId, local.id, frozen),
      {
        localId: local.id,
        syncId: frozen.clientSyncId,
        name: frozen.customer.name,
        email: frozen.customer.email,
        stripeCustomerId: local.stripeCustomerId
      },
      { resume: true }
    )
    rememberCustomer(local.id, created.draft.stripeCustomerId)
    return { ...created, clientId: local.id }
  },

  /**
   * Cancel an unfinished draft only with proof that it left no effect (Stripe definitely
   * rejected it, or its deleted draft is verified gone). Imports shared history first so a
   * result recorded on another computer is known. Reads only.
   */
  async cancelInvoiceOperation(operationId: string): Promise<CancellationProof> {
    const db = getDb()
    if (!isSyncUuid(operationId))
      throw new AppError(
        'INVOICE_OPERATION_NOT_FOUND',
        'This saved invoice operation is unavailable.'
      )
    await importBeforeInvoiceWrite(db)
    const provider = credentialService.hasStripeKey()
      ? { stripe: getStripeClient(), expectedTestMode: credentialService.isStripeTestMode() }
      : null
    const proof = await cancelInvoiceOperation(db, operationId, provider)
    log.info(`Cancelled invoice operation ${operationId} (${proof.basis})`)
    return proof
  },

  /**
   * Finalize and send an invoice. Returns the retrieved status with its provenance. Shared
   * history is imported first; until a send attempt starts, the invoice's saved and shared
   * records, its draft operation and the current Stripe draft are checked.
   */
  async sendInvoice(invoiceId: string): Promise<ProviderStatusRead> {
    validateInvoiceId(invoiceId)
    const db = getDb()
    await importBeforeInvoiceWrite(db)
    const status = await sendInvoiceOperation(
      db,
      getStripeClient(),
      credentialService.isStripeTestMode(),
      invoiceId,
      (invoice, context) => checkBeforeSend(db, invoice, context)
    )
    log.info(`Sent invoice ${invoiceId}`)
    return status
  },

  /**
   * Get the current status of an invoice.
   */
  async getInvoiceStatus(invoiceId: string): Promise<ProviderStatusRead> {
    validateInvoiceId(invoiceId)
    const stripe = getStripeClient()
    const context = await readStripeContext(stripe, credentialService.isStripeTestMode())
    checkSavedInvoiceAccount(getDb(), invoiceId, context)
    const invoice = await stripe.invoices.retrieve(invoiceId)
    if (invoice.livemode !== !context.testMode)
      throw new AppError(
        'STRIPE_ACCOUNT_MISMATCH',
        'This invoice belongs to a different Stripe mode.'
      )
    bindRetrievedInvoiceAccount(getDb(), invoiceId, context)
    return observedStatus(invoice, context)
  },

  /**
   * Void an open invoice.
   */
  async voidInvoice(invoiceId: string): Promise<ProviderStatusRead> {
    const status = await voidInvoiceOperation(
      getDb(),
      getStripeClient(),
      credentialService.isStripeTestMode(),
      invoiceId
    )
    log.info(`Voided invoice ${invoiceId}`)
    return status
  },

  /**
   * List recent invoices from Stripe (up to 100).
   */
  async listInvoices(limit = 100): Promise<{
    account: ProviderAccount
    providerDate: string | null
    invoices: Stripe.Invoice[]
  }> {
    const stripe = getStripeClient()
    const account = await readStripeContext(stripe, credentialService.isStripeTestMode())
    const result = await stripe.invoices.list({ limit, expand: ['data.lines'] })
    const providerDate = responseDate(result) ?? (account.providerDate || null)
    if (result.has_more) {
      log.warn(
        `Stripe has more than ${limit} invoices — only the most recent ${limit} were fetched`
      )
    }
    for (const invoice of result.data) {
      if (invoice.livemode !== !account.testMode)
        throw new AppError(
          'STRIPE_ACCOUNT_MISMATCH',
          'Stripe returned an invoice from another mode.'
        )
      checkSavedInvoiceAccount(getDb(), invoice.id, account)
      await completeInvoiceLines(stripe, invoice)
    }
    return {
      account: { accountId: account.accountId, testMode: account.testMode },
      providerDate,
      invoices: result.data
    }
  }
}
