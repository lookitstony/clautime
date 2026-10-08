import { registerFolderSyncConflictHandlers } from './folder-sync-conflict-handlers'
import log from 'electron-log/main.js'
import { registerFolderSyncHandlers } from './folder-sync-handlers'
import { registerMachineHandlers } from './machine-handlers'
import { registerSettingsHandlers } from './settings-handlers'
import { registerWorkspaceHandlers } from './workspace-handlers'
import { registerSessionHandlers } from './session-handlers'
import { registerDialogHandlers } from './dialog-handlers'
import { registerClientProjectHandlers } from './client-project-handlers'
import { registerGitHandlers } from './git-handlers'
import { registerAiHandlers } from './ai-handlers'
import { registerReportHandlers } from './report-handlers'
import { registerUpdaterHandlers } from './updater-handlers'
import { registerLiveHandlers } from './live-handlers'
import { registerSecretScanHandlers } from './secret-scan-handlers'
import { registerInvoiceHandlers } from './invoice-handlers'

/** Register all IPC handlers. Call after database initialization. */
export function registerIpcHandlers(): void {
  log.info('Registering IPC handlers')
  registerSettingsHandlers()
  registerMachineHandlers()
  registerFolderSyncHandlers()
  registerFolderSyncConflictHandlers()
  registerWorkspaceHandlers()
  registerSessionHandlers()
  registerDialogHandlers()
  registerClientProjectHandlers()
  registerGitHandlers()
  registerAiHandlers()
  registerReportHandlers()
  registerUpdaterHandlers()
  registerLiveHandlers()
  registerSecretScanHandlers()
  registerInvoiceHandlers()
  log.info('IPC handlers registered')
}
