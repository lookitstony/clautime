import { primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { projects } from './projects'

/** Device-local configuration. Never export these rows as shared project settings. */
export const projectFolderMappings = sqliteTable(
  'project_folder_mappings',
  {
    deviceId: text('device_id').notNull(),
    projectSyncId: text('project_sync_id')
      .notNull()
      .references(() => projects.syncId, { onDelete: 'cascade' }),
    directoryPath: text('directory_path').notNull(),
    directoryKey: text('directory_key').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.deviceId, table.projectSyncId] }),
    uniqueIndex('project_folder_mappings_device_directory_unique').on(
      table.deviceId,
      table.directoryKey
    )
  ]
)
