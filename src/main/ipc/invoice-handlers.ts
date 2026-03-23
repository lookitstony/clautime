import { ipcMain } from 'electron'
import log from 'electron-log/main.js'
import { credentialService } from '../services/credential-service'
import { stripeService, clearStripeCache } from '../services/stripe-service'
import { ipcSuccess, ipcError, type IpcResult } from '../../shared/types/ipc'
import type {
  StripeCustomerInfo,
  CreateInvoiceRequest,
  DraftInvoice,
  InvoiceStatus
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
        return ipcSuccess(result)
      } catch (error) {
        log.error('IPC invoice:voidInvoice failed:', error)
        return ipcError('STRIPE_VOID_INVOICE_ERROR', String(error))
      }
    }
  )
}
