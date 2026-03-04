import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString())
})

export type AppSetting = typeof appSettings.$inferSelect
export type NewAppSetting = typeof appSettings.$inferInsert
