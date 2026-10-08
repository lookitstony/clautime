import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { activityObservations } from './activity-evidence'

/** Original registration label, not a claim of historical activity ownership. */
export const sourceMachines = sqliteTable('source_machines', {
  deviceId: text('device_id').primaryKey(),
  initialName: text('initial_name').notNull()
})

/** Multiple computers may observe one fact; these rows never contribute to usage totals. */
export const activityObservers = sqliteTable(
  'activity_observers',
  {
    observationId: text('observation_id')
      .notNull()
      .references(() => activityObservations.id),
    deviceId: text('device_id')
      .notNull()
      .references(() => sourceMachines.deviceId),
    basis: text('basis').notNull().$type<'observed' | 'imported'>()
  },
  (table) => [
    primaryKey({ columns: [table.observationId, table.deviceId, table.basis] }),
    index('idx_activity_observers_device').on(table.deviceId)
  ]
)

/** Local migration queue. Never export or populate this during shared-history import. */
export const activityProvenanceImports = sqliteTable('activity_provenance_imports', {
  observationId: text('observation_id')
    .primaryKey()
    .references(() => activityObservations.id)
})
