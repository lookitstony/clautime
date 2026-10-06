import { ipcMain } from 'electron'
import log from 'electron-log/main.js'
import { credentialService } from '../services/credential-service'
import { stripeService, clearStripeCache } from '../services/stripe-service'
import { invoiceService } from '../services/invoice-service'
import { getDb } from '../db'
import { invoices } from '../db/schema/invoices'
import { eq } from 'drizzle-orm'
import { retainInvoiceBillingRefs } from '../services/session-billing'
import { requireProviderAccount } from '../services/provider-operation-store'
import { pendingInvoiceOperations } from '../services/pending-invoice-operations'
import { AppError, ipcSuccess, ipcError, type IpcResult } from '../../shared/types/ipc'
import {
  localInvoiceFromOperation,
  type CreatedDraft,
  type ProviderStatusRead
} from '../services/stripe-operation-service'
import { localBillingForSave } from '../services/invoice-portable-billing'
import {
  journalInvoiceRecordsSafely,
  recordProviderObservation
} from '../services/folder-sync-invoice-records'
import type {
  StripeCustomerInfo,
  CreateInvoiceRequest,
  DraftInvoice,
  InvoiceBillingRange,
  InvoiceStatus,
  GenerateLineItemsResult,
  LocalInvoice,
  LocalInvoiceDetail,
  InvoiceOverlap
} from '../../shared/types/invoice'

/** Keep operation codes (e.g. PROVIDER_OPERATION_UNCERTAIN) so the UI can explain them. */
function providerError(fallback: string, error: unknown): IpcResult<never> {
  return error instanceof AppError
    ? ipcError(error.code, error.message)
    : ipcError(fallback, String(error))
}

/**
 * Save the draft once. A retry after Stripe succeeded but local saving failed resumes the
 * same operation, receives the same invoice ID, and saves (or finds) it here. Billing is
 * resolved from the frozen portable request inside the transaction; the retrieved status
 * (amount paid included) is then recorded as a monotonic observation.
 */
export function persistDraft(clientId: number, created: CreatedDraft, operationId: string): number {
  const { draft, frozen, account, observation } = created
  if (observation.status.invoiceId !== draft.invoiceId)
    throw new AppError('PROVIDER_RESULT_CONFLICT', 'The Stripe status belongs to another invoice.')
  const db = getDb()
  const localId = db.transaction((tx) => {
    const existing = tx
      .select()
      .from(invoices)
      .where(eq(invoices.stripeInvoiceId, draft.invoiceId))
      .get()
    const localBilling = localBillingForSave(tx, frozen.billing, created.localBilling)
    if (!existing) {
      const status = observation.status
      return invoiceService.saveInvoice(
        {
          ...localInvoiceFromOperation(frozen, draft, clientId, account.testMode, localBilling),
          // A resumed invoice may already be open or paid: save what Stripe returned.
          status: status.status,
          amountDueCents: status.amountDueCents,
          amountPaidCents: status.amountPaidCents,
          currency: status.currency,
          hostedUrl: status.hostedUrl,
          invoicePdf: status.invoicePdf,
          dueDate: status.dueDate,
          paidAt: status.paidAt,
          providerAccountId: account.accountId,
          operationId
        },
        tx as unknown as ReturnType<typeof getDb>
      )
    }
    if (
      existing.clientId !== clientId ||
      (existing.operationId && existing.operationId !== operationId)
    )
      throw new AppError(
        'INVOICE_CLIENT_CONFLICT',
        'This Stripe invoice is already saved for a different client or operation.'
      )
    requireProviderAccount(account, {
      accountId: existing.providerAccountId ?? account.accountId,
      testMode: !!existing.testMode
    })
    // A Stripe or folder import may have arrived before the original local save. Attach the
    // frozen billed-work references without replacing the imported or issued line snapshots.
    const ranges = new Map<number, InvoiceBillingRange[]>()
    for (const line of localBilling.lines)
      for (const range of line.billedRanges ?? [])
        if (range.sessionId > 0)
          ranges.set(range.sessionId, [...(ranges.get(range.sessionId) ?? []), range])
    retainInvoiceBillingRefs(tx, {
      stripeInvoiceId: draft.invoiceId,
      ranges,
      testMode: account.testMode
    })
    const binding: { providerAccountId?: string; operationId?: string } = {}
    if (!existing.providerAccountId) binding.providerAccountId = account.accountId
    if (
      !existing.operationId &&
      !tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(eq(invoices.operationId, operationId))
        .get()
    )
      binding.operationId = operationId
    if (Object.keys(binding).length)
      tx.update(invoices).set(binding).where(eq(invoices.id, existing.id)).run()
    journalInvoiceRecordsSafely(tx as unknown as ReturnType<typeof getDb>, existing.id)
    return existing.id
  })
  try {
    recordProviderObservation(db, {
      providerInvoiceId: draft.invoiceId,
      account,
      providerDate: observation.providerDate,
      status: observation.status
    })
  } catch (error) {
    // The invoice and its billing are saved; the next status refresh records the observation.
    log.warn(`Could not record Stripe status for ${draft.invoiceId}:`, error)
  }
  return localId
}

/** Record a successful read, then return only the renderer's status shape. */
function observed(read: ProviderStatusRead): InvoiceStatus {
  recordProviderObservation(getDb(), {
    providerInvoiceId: read.status.invoiceId,
    account: read.account,
    providerDate: read.providerDate,
    status: read.status
  })
  return read.status
}

export function registerInvoiceHandlers(): void {
  ipcMain.handle('invoice:getPendingOperations', () => {
    try {
      return ipcSuccess(pendingInvoiceOperations(getDb()))
    } catch (error) {
      return providerError('INVOICE_PENDING_ERROR', error)
    }
  })
  ipcMain.handle(
    'invoice:resumeDraftInvoice',
    async (_event, operationId: string): Promise<IpcResult<DraftInvoice>> => {
      try {
        const { clientId, ...created } = await stripeService.resumeDraftInvoice(operationId)
        const localId = persistDraft(clientId, created, operationId)
        return ipcSuccess({ ...created.draft, localId })
      } catch (error) {
        return providerError('INVOICE_RESUME_ERROR', error)
      }
    }
  )
  // Proof-gated; never a Stripe write.
  ipcMain.handle(
    'invoice:cancelInvoiceOperation',
    async (
      _event,
      operationId: string
    ): Promise<IpcResult<{ basis: 'rejected-before-invoice' | 'draft-deleted' }>> => {
      try {
        if (typeof operationId !== 'string')
          return ipcError(
            'INVOICE_OPERATION_NOT_FOUND',
            'This saved invoice operation is unavailable.'
          )
        const proof = await stripeService.cancelInvoiceOperation(operationId)
        return ipcSuccess({ basis: proof.basis })
      } catch (error) {
        log.error('IPC invoice:cancelInvoiceOperation failed:', error)
        return providerError('INVOICE_CANCEL_ERROR', error)
      }
    }
  )
  // ── Stripe Key Management ──

  ipcMain.handle('invoice:hasStripeKey', async (): Promise<IpcResult<boolean>> => {
    try {
      return ipcSuccess(credentialService.hasStripeKey())
    } catch (error) {
      log.error('IPC invoice:hasStripeKey failed:', error)
      return ipcError('STRIPE_HAS_KEY_ERROR', String(error))
    }
  })

  ipcMain.handle('invoice:isTestMode', async (): Promise<IpcResult<boolean>> => {
    try {
      return ipcSuccess(credentialService.isStripeTestMode())
    } catch (error) {
      log.error('IPC invoice:isTestMode failed:', error)
      return ipcError('STRIPE_TEST_MODE_ERROR', String(error))
    }
  })

  ipcMain.handle(
    'invoice:storeStripeKey',
    async (_event, key: string): Promise<IpcResult<void>> => {
      try {
        credentialService.storeStripeKey(key)
        clearStripeCache()
        return ipcSuccess(undefined)
      } catch (error) {
        log.error('IPC invoice:storeStripeKey failed:', error)
        return ipcError('STRIPE_STORE_KEY_ERROR', String(error))
      }
    }
  )

  ipcMain.handle('invoice:removeStripeKey', async (): Promise<IpcResult<void>> => {
    try {
      credentialService.removeStripeKey()
      clearStripeCache()
      return ipcSuccess(undefined)
    } catch (error) {
      log.error('IPC invoice:removeStripeKey failed:', error)
      return ipcError('STRIPE_REMOVE_KEY_ERROR', String(error))
    }
  })

  ipcMain.handle('invoice:testConnection', async (): Promise<IpcResult<boolean>> => {
    try {
      const result = await stripeService.testConnection()
      return ipcSuccess(result)
    } catch (error) {
      log.error('IPC invoice:testConnection failed:', error)
      return ipcError('STRIPE_CONNECTION_ERROR', String(error))
    }
  })

  ipcMain.handle('invoice:getStripeMode', async (): Promise<IpcResult<'live' | 'test'>> => {
    try {
      return ipcSuccess(credentialService.getStripeMode())
    } catch (error) {
      log.error('IPC invoice:getStripeMode failed:', error)
      return ipcError('STRIPE_MODE_ERROR', String(error))
    }
  })

  ipcMain.handle(
    'invoice:setStripeMode',
    async (_event, mode: 'live' | 'test'): Promise<IpcResult<void>> => {
      try {
        if (mode !== 'live' && mode !== 'test') {
          return ipcError('INVALID_MODE', 'Mode must be "live" or "test"')
        }
        credentialService.setStripeMode(mode)
        clearStripeCache()
        return ipcSuccess(undefined)
      } catch (error) {
        log.error('IPC invoice:setStripeMode failed:', error)
        return ipcError('STRIPE_SET_MODE_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'invoice:hasStripeKeyForMode',
    async (_event, mode: 'live' | 'test'): Promise<IpcResult<boolean>> => {
      try {
        if (mode !== 'live' && mode !== 'test') {
          return ipcError('INVALID_MODE', 'Mode must be "live" or "test"')
        }
        return ipcSuccess(credentialService.hasStripeKeyForMode(mode))
      } catch (error) {
        log.error('IPC invoice:hasStripeKeyForMode failed:', error)
        return ipcError('STRIPE_HAS_KEY_MODE_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'invoice:removeStripeKeyForMode',
    async (_event, mode: 'live' | 'test'): Promise<IpcResult<void>> => {
      try {
        if (mode !== 'live' && mode !== 'test') {
          return ipcError('INVALID_MODE', 'Mode must be "live" or "test"')
        }
        credentialService.removeStripeKey(mode)
        clearStripeCache()
        return ipcSuccess(undefined)
      } catch (error) {
        log.error('IPC invoice:removeStripeKeyForMode failed:', error)
        return ipcError('STRIPE_REMOVE_KEY_MODE_ERROR', String(error))
      }
    }
  )

  ipcMain.handle('invoice:getStripeTestEmail', async (): Promise<IpcResult<string | null>> => {
    try {
      return ipcSuccess(credentialService.getStripeTestEmail())
    } catch (error) {
      log.error('IPC invoice:getStripeTestEmail failed:', error)
      return ipcError('STRIPE_TEST_EMAIL_ERROR', String(error))
    }
  })

  ipcMain.handle(
    'invoice:setStripeTestEmail',
    async (_event, email: string): Promise<IpcResult<void>> => {
      try {
        credentialService.setStripeTestEmail(email)
        clearStripeCache()
        return ipcSuccess(undefined)
      } catch (error) {
        log.error('IPC invoice:setStripeTestEmail failed:', error)
        return ipcError('STRIPE_SET_TEST_EMAIL_ERROR', String(error))
      }
    }
  )

  // ── Customer & Invoice Operations ──

  ipcMain.handle(
    'invoice:syncCustomer',
    async (
      _event,
      clientId: number,
      operationId: string
    ): Promise<IpcResult<StripeCustomerInfo>> => {
      try {
        const result = await stripeService.syncCustomer(clientId, operationId)
        return ipcSuccess(result)
      } catch (error) {
        log.error('IPC invoice:syncCustomer failed:', error)
        return providerError('STRIPE_SYNC_CUSTOMER_ERROR', error)
      }
    }
  )

  ipcMain.handle(
    'invoice:createDraftInvoice',
    async (_event, request: CreateInvoiceRequest): Promise<IpcResult<DraftInvoice>> => {
      try {
        const created = await stripeService.createDraftInvoice(request)
        const localId = persistDraft(request.clientId, created, request.operationId)
        return ipcSuccess({ ...created.draft, localId })
      } catch (error) {
        log.error('IPC invoice:createDraftInvoice failed:', error)
        return providerError('STRIPE_CREATE_INVOICE_ERROR', error)
      }
    }
  )

  ipcMain.handle(
    'invoice:sendInvoice',
    async (_event, invoiceId: string): Promise<IpcResult<InvoiceStatus>> => {
      try {
        // Monotonic observation: never a raw overwrite of an imported paid/void status.
        return ipcSuccess(observed(await stripeService.sendInvoice(invoiceId)))
      } catch (error) {
        log.error('IPC invoice:sendInvoice failed:', error)
        return providerError('STRIPE_SEND_INVOICE_ERROR', error)
      }
    }
  )

  ipcMain.handle(
    'invoice:getInvoiceStatus',
    async (_event, invoiceId: string): Promise<IpcResult<InvoiceStatus>> => {
      try {
        return ipcSuccess(observed(await stripeService.getInvoiceStatus(invoiceId)))
      } catch (error) {
        log.error('IPC invoice:getInvoiceStatus failed:', error)
        return providerError('STRIPE_GET_STATUS_ERROR', error)
      }
    }
  )

  ipcMain.handle(
    'invoice:voidInvoice',
    async (_event, invoiceId: string): Promise<IpcResult<InvoiceStatus>> => {
      try {
        return ipcSuccess(observed(await stripeService.voidInvoice(invoiceId)))
      } catch (error) {
        log.error('IPC invoice:voidInvoice failed:', error)
        return providerError('STRIPE_VOID_INVOICE_ERROR', error)
      }
    }
  )

  // ── Phase 2: Local Invoice History & Generation ──

  ipcMain.handle(
    'invoice:generateLineItems',
    async (
      _event,
      request: { clientId: number; startDate: string; endDate: string; projectId?: number }
    ): Promise<IpcResult<GenerateLineItemsResult>> => {
      try {
        const result = await invoiceService.generateLineItems(
          request.clientId,
          request.startDate,
          request.endDate,
          request.projectId
        )
        return ipcSuccess(result)
      } catch (error) {
        log.error('IPC invoice:generateLineItems failed:', error)
        return ipcError('INVOICE_GENERATE_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'invoice:getAll',
    async (
      _event,
      filters?: { clientId?: number; status?: string; testMode?: boolean }
    ): Promise<IpcResult<LocalInvoice[]>> => {
      try {
        // Default to filtering by current mode
        const effectiveFilters = {
          ...filters,
          testMode: filters?.testMode ?? credentialService.isStripeTestMode()
        }
        return ipcSuccess(invoiceService.getAll(effectiveFilters))
      } catch (error) {
        log.error('IPC invoice:getAll failed:', error)
        return ipcError('INVOICE_GET_ALL_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'invoice:getById',
    async (_event, localId: number): Promise<IpcResult<LocalInvoiceDetail | null>> => {
      try {
        return ipcSuccess(invoiceService.getById(localId))
      } catch (error) {
        log.error('IPC invoice:getById failed:', error)
        return ipcError('INVOICE_GET_BY_ID_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'invoice:syncLocalStatus',
    async (_event, localId: number): Promise<IpcResult<LocalInvoice>> => {
      try {
        const result = await invoiceService.syncStatus(localId)
        return ipcSuccess(result)
      } catch (error) {
        log.error('IPC invoice:syncLocalStatus failed:', error)
        return ipcError('INVOICE_SYNC_STATUS_ERROR', String(error))
      }
    }
  )

  ipcMain.handle('invoice:syncAllStatuses', async (): Promise<IpcResult<number>> => {
    try {
      const count = await invoiceService.syncAllStatuses()
      return ipcSuccess(count)
    } catch (error) {
      log.error('IPC invoice:syncAllStatuses failed:', error)
      return ipcError('INVOICE_SYNC_ALL_ERROR', String(error))
    }
  })

  ipcMain.handle('invoice:delete', async (_event, localId: number): Promise<IpcResult<void>> => {
    try {
      if (typeof localId !== 'number' || localId <= 0) {
        return ipcError('INVALID_ID', 'Invalid invoice ID')
      }
      invoiceService.deleteInvoice(localId)
      return ipcSuccess(undefined)
    } catch (error) {
      log.error('IPC invoice:delete failed:', error)
      return ipcError('INVOICE_DELETE_ERROR', String(error))
    }
  })

  ipcMain.handle('invoice:importFromStripe', async (): Promise<IpcResult<number>> => {
    try {
      const count = await invoiceService.importFromStripe()
      return ipcSuccess(count)
    } catch (error) {
      log.error('IPC invoice:importFromStripe failed:', error)
      return ipcError('INVOICE_IMPORT_ERROR', String(error))
    }
  })

  ipcMain.handle(
    'invoice:checkOverlap',
    async (
      _event,
      request: { clientId: number; startDate: string; endDate: string }
    ): Promise<IpcResult<InvoiceOverlap[]>> => {
      try {
        return ipcSuccess(
          invoiceService.checkOverlap(request.clientId, request.startDate, request.endDate)
        )
      } catch (error) {
        log.error('IPC invoice:checkOverlap failed:', error)
        return ipcError('INVOICE_CHECK_OVERLAP_ERROR', String(error))
      }
    }
  )
}
