import { ipcMain } from 'electron'
import log from 'electron-log/main.js'
import { credentialService } from '../services/credential-service'
import { stripeService, clearStripeCache } from '../services/stripe-service'
import { invoiceService } from '../services/invoice-service'
import { ipcSuccess, ipcError, type IpcResult } from '../../shared/types/ipc'
import type {
  StripeCustomerInfo,
  CreateInvoiceRequest,
  DraftInvoice,
  InvoiceStatus,
  GeneratedLineItem,
  LocalInvoice,
  LocalInvoiceDetail,
  InvoiceOverlap
} from '../../shared/types/invoice'

export function registerInvoiceHandlers(): void {
  // ── Stripe Key Management ──

  ipcMain.handle(
    'invoice:hasStripeKey',
    async (): Promise<IpcResult<boolean>> => {
      try {
        return ipcSuccess(credentialService.hasStripeKey())
      } catch (error) {
        log.error('IPC invoice:hasStripeKey failed:', error)
        return ipcError('STRIPE_HAS_KEY_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'invoice:isTestMode',
    async (): Promise<IpcResult<boolean>> => {
      try {
        return ipcSuccess(credentialService.isStripeTestMode())
      } catch (error) {
        log.error('IPC invoice:isTestMode failed:', error)
        return ipcError('STRIPE_TEST_MODE_ERROR', String(error))
      }
    }
  )

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

  ipcMain.handle(
    'invoice:removeStripeKey',
    async (): Promise<IpcResult<void>> => {
      try {
        credentialService.removeStripeKey()
        clearStripeCache()
        return ipcSuccess(undefined)
      } catch (error) {
        log.error('IPC invoice:removeStripeKey failed:', error)
        return ipcError('STRIPE_REMOVE_KEY_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'invoice:testConnection',
    async (): Promise<IpcResult<boolean>> => {
      try {
        const result = await stripeService.testConnection()
        return ipcSuccess(result)
      } catch (error) {
        log.error('IPC invoice:testConnection failed:', error)
        return ipcError('STRIPE_CONNECTION_ERROR', String(error))
      }
    }
  )

  // ── Customer & Invoice Operations ──

  ipcMain.handle(
    'invoice:syncCustomer',
    async (_event, clientId: number): Promise<IpcResult<StripeCustomerInfo>> => {
      try {
        const result = await stripeService.syncCustomer(clientId)
        return ipcSuccess(result)
      } catch (error) {
        log.error('IPC invoice:syncCustomer failed:', error)
        return ipcError('STRIPE_SYNC_CUSTOMER_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'invoice:createDraftInvoice',
    async (_event, request: CreateInvoiceRequest): Promise<IpcResult<DraftInvoice>> => {
      try {
        const result = await stripeService.createDraftInvoice(request)

        // Persist locally
        invoiceService.saveInvoice({
          clientId: request.clientId,
          stripeInvoiceId: result.invoiceId,
          status: result.status,
          amountDueCents: result.amountDueCents,
          amountPaidCents: 0,
          currency: result.currency,
          memo: request.memo,
          hostedUrl: result.hostedUrl,
          periodStart: request.periodStart,
          periodEnd: request.periodEnd,
          lineItems: request.lineItems.map((item, i) => ({
            lineDate: request.lineMeta?.[i]?.lineDate,
            description: item.description,
            amountCents: item.amountCents * item.quantity,
            durationMinutes: request.lineMeta?.[i]?.durationMinutes,
            sessionIds: request.lineMeta?.[i]?.sessionIds,
            sortOrder: i
          }))
        })

        return ipcSuccess(result)
      } catch (error) {
        log.error('IPC invoice:createDraftInvoice failed:', error)
        return ipcError('STRIPE_CREATE_INVOICE_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'invoice:sendInvoice',
    async (_event, invoiceId: string): Promise<IpcResult<InvoiceStatus>> => {
      try {
        const result = await stripeService.sendInvoice(invoiceId)

        // Update local status
        const db = (await import('../db')).getDb()
        const { invoices } = await import('../db/schema/invoices')
        const { eq } = await import('drizzle-orm')
        db.update(invoices)
          .set({
            status: result.status,
            hostedUrl: result.hostedUrl,
            dueDate: result.dueDate,
            updatedAt: new Date().toISOString()
          })
          .where(eq(invoices.stripeInvoiceId, invoiceId))
          .run()

        return ipcSuccess(result)
      } catch (error) {
        log.error('IPC invoice:sendInvoice failed:', error)
        return ipcError('STRIPE_SEND_INVOICE_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'invoice:getInvoiceStatus',
    async (_event, invoiceId: string): Promise<IpcResult<InvoiceStatus>> => {
      try {
        const result = await stripeService.getInvoiceStatus(invoiceId)
        return ipcSuccess(result)
      } catch (error) {
        log.error('IPC invoice:getInvoiceStatus failed:', error)
        return ipcError('STRIPE_GET_STATUS_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'invoice:voidInvoice',
    async (_event, invoiceId: string): Promise<IpcResult<InvoiceStatus>> => {
      try {
        const result = await stripeService.voidInvoice(invoiceId)

        // Update local status
        const db = (await import('../db')).getDb()
        const { invoices } = await import('../db/schema/invoices')
        const { eq } = await import('drizzle-orm')
        db.update(invoices)
          .set({ status: result.status, updatedAt: new Date().toISOString() })
          .where(eq(invoices.stripeInvoiceId, invoiceId))
          .run()

        return ipcSuccess(result)
      } catch (error) {
        log.error('IPC invoice:voidInvoice failed:', error)
        return ipcError('STRIPE_VOID_INVOICE_ERROR', String(error))
      }
    }
  )

  // ── Phase 2: Local Invoice History & Generation ──

  ipcMain.handle(
    'invoice:generateLineItems',
    async (
      _event,
      request: { clientId: number; startDate: string; endDate: string }
    ): Promise<IpcResult<GeneratedLineItem[]>> => {
      try {
        const result = await invoiceService.generateLineItems(
          request.clientId,
          request.startDate,
          request.endDate
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
      filters?: { clientId?: number; status?: string }
    ): Promise<IpcResult<LocalInvoice[]>> => {
      try {
        return ipcSuccess(invoiceService.getAll(filters))
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

  ipcMain.handle(
    'invoice:syncAllStatuses',
    async (): Promise<IpcResult<number>> => {
      try {
        const count = await invoiceService.syncAllStatuses()
        return ipcSuccess(count)
      } catch (error) {
        log.error('IPC invoice:syncAllStatuses failed:', error)
        return ipcError('INVOICE_SYNC_ALL_ERROR', String(error))
      }
    }
  )

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
