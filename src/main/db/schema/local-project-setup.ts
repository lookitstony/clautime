import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Local configuration; never include this in a portable history export. */
export const localProjectSetup = sqliteTable('local_project_setup', {
  deviceId: text('device_id').primaryKey(),
  completedAt: text('completed_at').notNull()
})
