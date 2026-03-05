import log from 'electron-log/main.js'
import { registerSettingsHandlers } from './settings-handlers'
import { registerSessionHandlers } from './session-handlers'
import { registerDialogHandlers } from './dialog-handlers'
import { registerClientProjectHandlers } from './client-project-handlers'

/** Register all IPC handlers. Call after database initialization. */
export function registerIpcHandlers(): void {
  log.info('Registering IPC handlers')
  registerSettingsHandlers()
  registerSessionHandlers()
  registerDialogHandlers()
  registerClientProjectHandlers()
  log.info('IPC handlers registered')
}
