// electron-log MUST be initialized before any BrowserWindow creation
import log from 'electron-log/main.js'
log.initialize()

// Configure log levels and file rotation
log.transports.file.level = 'info'
log.transports.file.maxSize = 10 * 1024 * 1024 // 10MB
log.transports.console.level = 'debug'

import { app, shell, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { initializeDatabase, closeDatabase } from './db'
import { registerIpcHandlers } from './ipc'
import { updaterService } from './services/updater-service'
import { trayService } from './services/tray-service'
import { liveMonitorService } from './services/live-monitor-service'
import { fileWatcherService } from './services/file-watcher-service'
import { widgetService } from './services/widget-service'

let mainWindow: BrowserWindow | null = null
let isQuitting = false

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
    ...(process.platform === 'linux' ? { icon } : {}),
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

  mainWindow.on('close', (e) => {
    if (!isQuitting && mainWindow) {
      e.preventDefault()
      dialog
        .showMessageBox(mainWindow, {
          type: 'question',
          buttons: ['Minimize to Tray', 'Quit'],
          defaultId: 0,
          cancelId: 0,
          title: 'ClawdTime',
          message: 'What would you like to do?'
        })
        .then(({ response }) => {
          if (response === 1) {
            isQuitting = true
            app.quit()
          } else {
            mainWindow?.hide()
          }
        })
    }
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
  electronApp.setAppUserModelId('com.clawdtime.app')

  // Initialize database BEFORE any window is created
  initializeDatabase()

  // Register IPC handlers after database is ready
  registerIpcHandlers()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  // Initialize tray, live monitor, and file watcher
  trayService.initialize(mainWindow!)
  liveMonitorService.startMonitoring(5000)
  fileWatcherService.start(mainWindow!)

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

  log.info('ClawdTime started')
})

app.on('window-all-closed', () => {
  // App lives in tray — do not quit when windows close
  // Quitting happens via tray menu or Cmd+Q/Alt+F4
})

app.on('will-quit', () => {
  widgetService.destroy()
  fileWatcherService.stop()
  liveMonitorService.stopMonitoring()
  trayService.destroy()
  closeDatabase()
})
