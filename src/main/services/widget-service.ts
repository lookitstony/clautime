import { BrowserWindow, screen, app } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { is } from '@electron-toolkit/utils'
import log from 'electron-log/main.js'

const widgets = new Map<number, BrowserWindow>()
let isDestroying = false

interface WidgetBounds { x: number; y: number; width: number; height: number }
interface WidgetState { positions: Record<string, WidgetBounds>; openIds: number[] }
let savedState: WidgetState = { positions: {}, openIds: [] }
const stateFile = join(app.getPath('userData'), 'widget-positions.json')

function loadState(): void {
  try {
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8'))
    // Support old format (just positions) and new format (positions + openIds)
    if (raw.positions) {
      savedState = { positions: raw.positions, openIds: raw.openIds ?? [] }
    } else {
      // Old format: the whole object is positions
      savedState = { positions: raw, openIds: [] }
    }
  } catch {
    savedState = { positions: {}, openIds: [] }
  }
}

function saveState(): void {
  try {
    mkdirSync(join(stateFile, '..'), { recursive: true })
    savedState.openIds = [...widgets.keys()]
    writeFileSync(stateFile, JSON.stringify(savedState, null, 2))
  } catch {
    // Best effort
  }
}

// Load once at import time
loadState()

export const widgetService = {
  isOpen(projectId: number): boolean {
    const w = widgets.get(projectId)
    return w != null && !w.isDestroyed()
  },

  toggle(projectId: number): void {
    if (this.isOpen(projectId)) {
      this.close(projectId)
    } else {
      this.open(projectId)
    }
  },

  open(projectId: number): void {
    if (this.isOpen(projectId)) {
      widgets.get(projectId)!.focus()
      return
    }

    // Restore saved position or place near cursor
    const saved = savedState.positions[String(projectId)]
    let x: number, y: number, width: number, height: number

    if (saved) {
      // Validate saved position is still on a visible display
      const display = screen.getDisplayNearestPoint({ x: saved.x, y: saved.y })
      const wa = display.workArea
      x = Math.max(wa.x, Math.min(saved.x, wa.x + wa.width - saved.width))
      y = Math.max(wa.y, Math.min(saved.y, wa.y + wa.height - saved.height))
      width = saved.width
      height = saved.height
    } else {
      const cursor = screen.getCursorScreenPoint()
      const display = screen.getDisplayNearestPoint(cursor)
      const offset = widgets.size * 40
      x = Math.min(cursor.x + 20 + offset, display.workArea.x + display.workArea.width - 220)
      y = Math.min(cursor.y + 20 + offset, display.workArea.y + display.workArea.height - 80)
      width = 240
      height = 110
    }

    const win = new BrowserWindow({
      width,
      height,
      minWidth: 200,
      minHeight: 90,
      x,
      y,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      hasShadow: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.mjs'),
        sandbox: false,
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    const hash = `widget/${projectId}`
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${hash}`)
    } else {
      win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
    }

    // Fade in: start transparent, then quickly fade to full opacity
    win.setOpacity(0)
    win.webContents.once('did-finish-load', () => {
      let opacity = 0
      const fadeIn = setInterval(() => {
        opacity += 0.15
        if (opacity >= 1) {
          opacity = 1
          clearInterval(fadeIn)
        }
        if (!win.isDestroyed()) win.setOpacity(opacity)
      }, 30)
    })

    // Save position on move/resize (debounced)
    let saveTimeout: ReturnType<typeof setTimeout> | null = null
    const persistBounds = (): void => {
      if (win.isDestroyed()) return
      const bounds = win.getBounds()
      savedState.positions[String(projectId)] = bounds
      if (saveTimeout) clearTimeout(saveTimeout)
      saveTimeout = setTimeout(saveState, 500)
    }
    win.on('move', persistBounds)
    win.on('resize', persistBounds)

    win.on('closed', () => {
      widgets.delete(projectId)
    })

    widgets.set(projectId, win)
    saveState()
    log.info(`Widget opened for project ${projectId}`)
  },

  close(projectId: number): void {
    const w = widgets.get(projectId)
    widgets.delete(projectId)
    if (!isDestroying) saveState()
    if (w && !w.isDestroyed()) {
      w.destroy()
    }
  },

  notifyAlert(projectName: string): void {
    for (const w of widgets.values()) {
      try {
        if (!w.isDestroyed()) {
          w.webContents.send('widget:alert', { projectName })
        }
      } catch {
        // Window may be closing
      }
    }
  },

  restoreAll(): void {
    const ids = savedState.openIds
    if (ids.length === 0) return
    log.info(`Restoring ${ids.length} widget(s)`)
    for (const id of ids) {
      this.open(id)
    }
  },

  destroy(): void {
    isDestroying = true
    for (const [id] of widgets) {
      this.close(id)
    }
  }
}
