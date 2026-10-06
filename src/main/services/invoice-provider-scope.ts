import { and, eq, isNull } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { invoices, clientProviderReferences } from '../db/schema/invoices'
import { AppError } from '../../shared/types/ipc'
import { requireProviderAccount, type ProviderAccount } from './provider-operation-store'

export function checkSavedInvoiceAccount<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>,
  invoiceId: string,
  account: ProviderAccount
): void {
  const saved = db.select().from(invoices).where(eq(invoices.stripeInvoiceId, invoiceId)).get()
  if (!saved) return
  requireProviderAccount(account, {
    accountId: saved.providerAccountId ?? account.accountId,
    testMode: !!saved.testMode
  })
}

/** Only after a successful retrieval using the captured account's credential. */
export function bindRetrievedInvoiceAccount<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>,
  invoiceId: string,
  account: ProviderAccount
): void {
  db.transaction((tx) => {
    checkSavedInvoiceAccount(tx, invoiceId, account)
    tx.update(invoices)
      .set({ providerAccountId: account.accountId })
      .where(and(eq(invoices.stripeInvoiceId, invoiceId), isNull(invoices.providerAccountId)))
      .run()
  })
}

export function scopedCustomerReference<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>,
  clientId: number,
  account: ProviderAccount
): string | null {
  return (
    db
      .select()
      .from(clientProviderReferences)
      .where(
        and(
          eq(clientProviderReferences.clientId, clientId),
          eq(clientProviderReferences.accountId, account.accountId),
          eq(clientProviderReferences.testMode, Number(account.testMode))
        )
      )
      .get()?.customerId ?? null
  )
}

export function retainCustomerReference<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>,
  clientId: number,
  account: ProviderAccount,
  customerId: string
): void {
  if (!/^cus_[a-zA-Z0-9]+$/.test(customerId))
    throw new AppError('INVALID_CUSTOMER_ID', 'Invalid Stripe customer reference.')
  db.insert(clientProviderReferences)
    .values({
      clientId,
      accountId: account.accountId,
      testMode: Number(account.testMode),
      customerId
    })
    .onConflictDoUpdate({
      target: [
        clientProviderReferences.clientId,
        clientProviderReferences.accountId,
        clientProviderReferences.testMode
      ],
      set: { customerId }
    })
    .run()
}

/** A different account key must not silently start a second billing history for this client. */
export function checkClientProviderAccount<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>,
  clientId: number,
  account: ProviderAccount
): void {
  const known = new Set(
    [
      ...db
        .select({ accountId: clientProviderReferences.accountId })
        .from(clientProviderReferences)
        .where(
          and(
            eq(clientProviderReferences.clientId, clientId),
            eq(clientProviderReferences.testMode, Number(account.testMode))
          )
        )
        .all(),
      ...db
        .select({ accountId: invoices.providerAccountId })
        .from(invoices)
        .where(
          and(eq(invoices.clientId, clientId), eq(invoices.testMode, Number(account.testMode)))
        )
        .all()
    ].flatMap((row) => (row.accountId ? [row.accountId] : []))
  )
  if (known.size && !known.has(account.accountId))
    throw new AppError(
      'STRIPE_ACCOUNT_MISMATCH',
      'This client has saved billing history in a different Stripe account. Use that account key before invoicing.'
    )
}
