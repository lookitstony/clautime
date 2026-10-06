import { primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Device-local folder choices. Never export as shared project settings. */
export const localFolderDiscoveryBlocks = sqliteTable(
  'local_folder_discovery_blocks',
  {
    deviceId: text('device_id').notNull(),
    directoryKey: text('directory_key').notNull()
  },
  (table) => [primaryKey({ columns: [table.deviceId, table.directoryKey] })]
)
