import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { projects } from './projects'

export const projectAlertConfig = sqliteTable(
  'project_alert_config',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    alertSound: text('alert_sound').notNull().default('system'),
    isWatching: integer('is_watching').notNull().default(0)
  },
  (table) => [uniqueIndex('idx_project_alert_config_project_id').on(table.projectId)]
)

export type ProjectAlertConfigRow = typeof projectAlertConfig.$inferSelect
export type NewProjectAlertConfigRow = typeof projectAlertConfig.$inferInsert
