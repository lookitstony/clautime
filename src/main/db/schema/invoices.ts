import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core'
import { clients } from './clients'

export const invoices = sqliteTable(
  'invoices',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id),
    stripeInvoiceId: text('stripe_invoice_id').notNull().unique(),
    providerAccountId: text('provider_account_id'),
    operationId: text('operation_id').unique(),
    /** Visibility is local; retained invoices continue excluding their billed activity. */
    hidden: integer('hidden').notNull().default(0),
    status: text('status')
      .notNull()
      .$type<'draft' | 'open' | 'paid' | 'void' | 'uncollectible'>()
      .default('draft'),
    amountDueCents: integer('amount_due_cents').notNull().default(0),
    amountPaidCents: integer('amount_paid_cents').notNull().default(0),
    currency: text('currency').notNull().default('usd'),
    memo: text('memo'),
    hostedUrl: text('hosted_url'),
    invoicePdf: text('invoice_pdf'),
    dueDate: text('due_date'),
    paidAt: text('paid_at'),
    periodStart: text('period_start'),
    periodEnd: text('period_end'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    testMode: integer('test_mode').notNull().default(0),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString())
  },
  (table) => [
    index('idx_invoices_client_id').on(table.clientId),
    index('idx_invoices_status').on(table.status),
    index('idx_invoices_test_mode').on(table.testMode)
  ]
)

export const invoiceLineItems = sqliteTable(
  'invoice_line_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    invoiceId: integer('invoice_id')
      .notNull()
      .references(() => invoices.id),
    lineDate: text('line_date'),
    description: text('description').notNull(),
    amountCents: integer('amount_cents').notNull(),
    durationMinutes: integer('duration_minutes'),
    sessionIds: text('session_ids'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString())
  },
  (table) => [index('idx_invoice_line_items_invoice_id').on(table.invoiceId)]
)

export type InvoiceRow = typeof invoices.$inferSelect
export type NewInvoiceRow = typeof invoices.$inferInsert
export type InvoiceLineItemRow = typeof invoiceLineItems.$inferSelect
export type NewInvoiceLineItemRow = typeof invoiceLineItems.$inferInsert

/** A customer reference is usable only with its verified account and mode. */
export const clientProviderReferences = sqliteTable(
  'client_provider_references',
  {
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id),
    accountId: text('account_id').notNull(),
    testMode: integer('test_mode').notNull(),
    customerId: text('customer_id').notNull()
  },
  (table) => [primaryKey({ columns: [table.clientId, table.accountId, table.testMode] })]
)
