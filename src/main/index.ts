// electron-log MUST be initialized before any BrowserWindow creation
import log from 'electron-log/main.js'
log.initialize()

// Configure log levels and file rotation
log.transports.file.level = 'info'
log.transports.file.maxSize = 10 * 1024 * 1024 // 10MB
log.transports.console.level = 'debug'

import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initializeDatabase, closeDatabase } from './db'
import { registerIpcHandlers } from './ipc'
import { updaterService } from './services/updater-service'
import { trayService } from './services/tray-service'
import { liveMonitorService } from './services/live-monitor-service'
import { fileWatcherService } from './services/file-watcher-service'
import { widgetService } from './services/widget-service'
import { secretScanService } from './services/secret-scan-service'
import { settingsService } from './services/settings-service'
import { applyExcludedPaths } from './services/excluded-paths'

// [DIAG] Temporary instrumentation to hunt main-thread stalls: log event-loop
// lag spikes and slow IPC handlers. Remove once the freeze source is found.
{
  let lastTick = Date.now()
  setInterval(() => {
    const now = Date.now()
    const lag = now - lastTick - 1000
    if (lag > 500) log.warn(`[DIAG] main event loop stalled ~${lag}ms`)
    lastTick = now
  }, 1000)

  type Handler = Parameters<typeof ipcMain.handle>[1]
  const origHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel: string, listener: Handler): void => {
    origHandle(channel, async (event, ...args) => {
      const t0 = Date.now()
      try {
        return await listener(event, ...args)
      } finally {
        const ms = Date.now() - t0
        if (ms > 250) log.warn(`[DIAG] slow IPC ${channel}: ${ms}ms`)
      }
    })
  }
}

// Single instance lock — prevent multiple instances
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.whenReady().then(() => {
    // The second-instance event on the first process will focus its window.
    // Just quit silently — the user will see the existing window come to focus.
    app.quit()
  })
}

// Resolve the window icon from outside asar in production. On Windows we use
// the multi-size .ico so the taskbar gets a crisp icon at every DPI — single-
// size PNGs often don't get picked up by the Windows taskbar at all. Other
// platforms use the PNG. Both files ship as extraResources.
const iconFile = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
const icon = app.isPackaged
  ? join(process.resourcesPath, iconFile)
  : join(__dirname, '../../', process.platform === 'win32' ? 'build' : 'resources', iconFile)

let mainWindow: BrowserWindow | null = null
let isQuitting = false

app.on('second-instance', () => {
  // Focus the existing window when a second instance tries to launch
  if (mainWindow) {
    if (!mainWindow.isVisible()) mainWindow.show()
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('before-quit', () => {
  isQuitting = true
})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      // sandbox: false required for @electron-toolkit/preload Node.js APIs
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  // Window control IPC for custom title bar
  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })
  ipcMain.handle('window:close', () => mainWindow?.close())
  ipcMain.handle('window:hide', () => mainWindow?.hide())
  ipcMain.handle('window:quit', () => {
    isQuitting = true
    // Destroy the window immediately to avoid freeze, then quit
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.destroy()
    }
    app.quit()
  })
  ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false)

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximized-changed', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximized-changed', false)
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow!.show()
  })

  mainWindow.on('close', () => {
    isQuitting = true
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  if (!gotLock) return // Second instance — dialog handler above will quit
  electronApp.setAppUserModelId('com.clautime.app')

  // Initialize database BEFORE any window is created
  initializeDatabase()

  // Apply user-configured excluded folders before anything scans
  applyExcludedPaths()

  // Register IPC handlers after database is ready
  registerIpcHandlers()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  // Initialize tray, live monitor, file watcher, and restore widgets
  trayService.initialize(mainWindow!)
  liveMonitorService.startMonitoring(10000)
  fileWatcherService.start(mainWindow!)
  widgetService.restoreAll()
  widgetService.registerHotkey(settingsService.getSetting('widget_toggle_hotkey') || undefined)
  secretScanService.startDailyScanning()

  // Initialize auto-updater (only in production)
  if (!is.dev) {
    updaterService.initialize()
    updaterService.startPeriodicChecks()
  }

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
    } else {
      createWindow()
    }
  })

  log.info('ClauTime started')
})

app.on('window-all-closed', () => {
  // If window was closed (not hidden), quit the app
  if (isQuitting) app.quit()
})

app.on('will-quit', () => {
  secretScanService.stopDailyScanning()
  widgetService.destroy()
  fileWatcherService.stop()
  liveMonitorService.stopMonitoring()
  trayService.destroy()
  closeDatabase()
})
