import log from 'electron-log/main.js'
import { registerSettingsHandlers } from './settings-handlers'

/** Register all IPC handlers. Call after database initialization. */
export function registerIpcHandlers(): void {
  log.info('Registering IPC handlers')
  registerSettingsHandlers()
  log.info('IPC handlers registered')
}
