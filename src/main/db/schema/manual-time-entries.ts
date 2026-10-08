import { integer, sqliteTable, text, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { sessions } from './sessions'
import { sourceMachines } from './activity-observers'

/** Portable entry identity with a local session-row mapping; times/edits stay on the session. */
export const manualTimeEntries = sqliteTable('manual_time_entries', {
  id: text('id').primaryKey(),
  sessionId: integer('session_id')
    .notNull()
    .unique()
    .references(() => sessions.id),
  deviceId: text('device_id').references(() => sourceMachines.deviceId),
  basis: text('basis').notNull().$type<'created' | 'imported'>(),
  parentId: text('parent_id').references((): AnySQLiteColumn => manualTimeEntries.id)
})

/** Local upgrade queue only; not a rule for attributing incoming shared entries. */
export const manualEntryProvenanceImports = sqliteTable('manual_entry_provenance_imports', {
  entryId: text('entry_id')
    .primaryKey()
    .references(() => manualTimeEntries.id)
})
