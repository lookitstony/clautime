import { Tray, Menu, app, nativeImage, Notification, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import log from 'electron-log/main.js'
import { secretScanService } from './secret-scan-service'

let tray: Tray | null = null
let mainWindowRef: BrowserWindow | null = null
let timerStartedAt: string | null = null
let timerProjectName: string | null = null
let tickInterval: ReturnType<typeof setInterval> | null = null

function formatElapsed(startedAt: string): string {
  const ms = Date.now() - Date.parse(startedAt)
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

function updateTitleAndTray(): void {
  if (!timerStartedAt || !timerProjectName) {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.setTitle('ClauTime')
    }
    if (tray) {
      tray.setToolTip('ClauTime')
    }
    return
  }

  const elapsed = formatElapsed(timerStartedAt)
  const title = `${elapsed} - ${timerProjectName} | ClauTime`
  const tooltip = `${timerProjectName}: ${elapsed}`

  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.setTitle(title)
  }
  if (tray) {
    tray.setToolTip(tooltip)
  }
}

function startTick(): void {
  stopTick()
  updateTitleAndTray()
  tickInterval = setInterval(updateTitleAndTray, 1000)
}

function stopTick(): void {
  if (tickInterval) {
    clearInterval(tickInterval)
    tickInterval = null
  }
}

export const trayService = {
  initialize(mainWindow: BrowserWindow): void {
    mainWindowRef = mainWindow

    const iconPath = join(__dirname, '../../resources/tray-icon.png')
    const icon = nativeImage.createFromPath(iconPath)

    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
    tray.setToolTip('ClauTime')

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show ClauTime',
        click: (): void => {
          if (mainWindowRef && !mainWindowRef.isDestroyed()) {
            mainWindowRef.show()
            mainWindowRef.focus()
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Scan for Secrets',
        click: async (): Promise<void> => {
          try {
            const result = await secretScanService.runScan()
            if (result.newFindings > 0) {
              // Show notification and open app to settings
              new Notification({
                title: 'ClauTime — Secrets Found',
                body: `${result.newFindings} new finding${result.newFindings === 1 ? '' : 's'} detected in ${result.filesScanned} files.`
              })
                .on('click', () => {
                  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                    mainWindowRef.show()
                    mainWindowRef.focus()
                  }
                })
                .show()
            } else {
              new Notification({
                title: 'ClauTime — Scan Complete',
                body: `${result.filesScanned} files scanned, no new findings.`
              }).show()
            }
          } catch (err) {
            log.error('Tray secret scan failed:', err)
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: (): void => {
          app.quit()
        }
      }
    ])

    tray.setContextMenu(contextMenu)

    // On Windows/Linux, click toggles window visibility
    if (process.platform !== 'darwin') {
      tray.on('click', () => {
        if (!mainWindowRef || mainWindowRef.isDestroyed()) return
        if (mainWindowRef.isVisible()) {
          mainWindowRef.hide()
        } else {
          mainWindowRef.show()
          mainWindowRef.focus()
        }
      })
    }

    log.info('Tray service initialized')
  },

  setTimer(projectName: string, startedAt: string): void {
    timerProjectName = projectName
    timerStartedAt = startedAt
    startTick()
  },

  clearTimer(): void {
    timerProjectName = null
    timerStartedAt = null
    stopTick()
    updateTitleAndTray()
  },

  destroy(): void {
    stopTick()
    if (tray) {
      tray.destroy()
      tray = null
    }
    mainWindowRef = null
    log.info('Tray service destroyed')
  }
}
