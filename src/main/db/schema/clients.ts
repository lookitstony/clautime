import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

export const clients = sqliteTable(
  'clients',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull().unique(),
    color: text('color').notNull(),
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
