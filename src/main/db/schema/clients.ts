import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core'

export const clients = sqliteTable(
  'clients',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull().unique(),
    /** Optional display name used while presentation mode is on (streaming/demos). */
    stageName: text('stage_name'),
    color: text('color').notNull(),
    billableRate: real('billable_rate'),
    email: text('email'),
    stripeCustomerId: text('stripe_customer_id'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString())
  },
  (table) => [index('idx_clients_name').on(table.name)]
)

export type ClientRow = typeof clients.$inferSelect
export type NewClientRow = typeof clients.$inferInsert
