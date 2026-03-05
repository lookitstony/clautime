import pkg from 'electron-updater'
const { autoUpdater } = pkg
import { BrowserWindow } from 'electron'
import log from 'electron-log/main.js'

autoUpdater.logger = log
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true

let updateAvailable = false

export const updaterService = {
  /**
   * Check for updates. Non-blocking — sends IPC messages to renderer on events.
   * Safe to call when offline — catches network errors silently.
   */
  checkForUpdates(): void {
    try {
      autoUpdater.checkForUpdates().catch((err) => {
        log.warn('Update check failed (likely offline):', err?.message)
      })
    } catch (err) {
      log.warn('Update check error:', err)
    }
  },

  /** Start periodic update checks (every 4 hours) */
  startPeriodicChecks(): void {
    // Check on startup after a short delay
    setTimeout(() => this.checkForUpdates(), 10_000)
    // Check every 4 hours
    setInterval(() => this.checkForUpdates(), 4 * 60 * 60 * 1000)
  },

  /** Download and install the update */
  downloadAndInstall(): void {
    if (updateAvailable) {
      autoUpdater.downloadUpdate().catch((err) => {
        log.error('Update download failed:', err)
      })
    }
  },

  isUpdateAvailable(): boolean {
    return updateAvailable
  },

  getVersion(): string {
    return autoUpdater.currentVersion.version
  },

  /** Set up auto-updater event listeners */
  initialize(): void {
    autoUpdater.on('update-available', (info) => {
      log.info('Update available:', info.version)
      updateAvailable = true
      // Notify renderer
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        win.webContents.send('updater:update-available', {
          version: info.version,
          releaseDate: info.releaseDate
        })
      }
    })

    autoUpdater.on('update-not-available', () => {
      log.info('App is up to date')
      updateAvailable = false
    })

    autoUpdater.on('download-progress', (progress) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        win.webContents.send('updater:download-progress', {
          percent: progress.percent,
          bytesPerSecond: progress.bytesPerSecond
        })
      }
    })

    autoUpdater.on('update-downloaded', () => {
      log.info('Update downloaded, will install on quit')
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        win.webContents.send('updater:update-downloaded')
      }
    })

    autoUpdater.on('error', (err) => {
      log.warn('Auto-updater error:', err?.message)
    })
  }
}
