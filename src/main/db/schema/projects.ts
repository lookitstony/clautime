import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { clients } from './clients'

export const projects = sqliteTable(
  'projects',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id),
    name: text('name').notNull(),
    directoryPath: text('directory_path').notNull().unique(),
    invoiceName: text('invoice_name'),
    isBillable: integer('is_billable', { mode: 'boolean' }).notNull().default(true),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString())
  },
  (table) => [
    index('idx_projects_client_id').on(table.clientId),
    index('idx_projects_directory_path').on(table.directoryPath)
  ]
)

export type ProjectRow = typeof projects.$inferSelect
export type NewProjectRow = typeof projects.$inferInsert
