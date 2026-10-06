import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core'
import { clients } from './clients'
import { randomUUID } from 'node:crypto'

export const projects = sqliteTable(
  'projects',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Portable identity, independent of this computer's directory path. */
    syncId: text('sync_id')
      .notNull()
      .unique()
      .$defaultFn(() => randomUUID()),
    clientId: integer('client_id')
      .notNull()
      .references(() => clients.id),
    name: text('name').notNull(),
    /** Legacy setup suggestion only. Local folders live in project_folder_mappings. */
    directoryPath: text('directory_path'),
    invoiceName: text('invoice_name'),
    /** Optional display name used while presentation mode is on (streaming/demos). */
    stageName: text('stage_name'),
    /** Per-project hourly rate in dollars. Null = fall back to the client's rate. */
    hourlyRate: real('hourly_rate'),
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
