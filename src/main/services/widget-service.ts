import { BrowserWindow, screen, app, globalShortcut } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { is } from '@electron-toolkit/utils'
import log from 'electron-log/main.js'

const widgets = new Map<number, BrowserWindow>()
let isDestroying = false
let registeredAccelerator: string | null = null
const DEFAULT_WIDGET_HOTKEY = 'CommandOrControl+Shift+H'
const WIDGET_WIDTH = 240
const WIDGET_HEIGHT = 60
// Widgets auto-hidden because their project has no today activity.
// They'll auto-show when the project becomes active again.
const autoHiddenIds = new Set<number>()
// Widgets hidden because their project went idle (not processing).
// They'll auto-show when the project starts processing again.
const idleHiddenIds = new Set<number>()
// Widgets explicitly opened by the user — don't auto-hide these.
const userPinnedIds = new Set<number>()

interface WidgetPosition {
  x: number
  y: number
}
interface WidgetState {
  positions: Record<string, WidgetPosition>
  openIds: number[]
}
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
    // Save both open and auto-hidden widget IDs so they survive restarts
    savedState.openIds = [
      ...new Set([...widgets.keys(), ...autoHiddenIds, ...idleHiddenIds, ...userPinnedIds])
    ]
    writeFileSync(stateFile, JSON.stringify(savedState, null, 2))
  } catch {
    // Best effort
  }
}

// Load once at import time
loadState()

/** Project IDs whose widget window exists and is actually on screen */
function visibleIds(): number[] {
  return [...widgets.keys()].filter((id) => {
    const w = widgets.get(id)
    return w != null && !w.isDestroyed() && w.isVisible()
  })
}

/** Push the real widget visibility state to every renderer so icons stay in sync */
function broadcastState(): void {
  if (isDestroying) return
  const ids = visibleIds()
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('widget:stateChanged', ids)
    }
  } catch {
    // Window may be closing
  }
}

export const widgetService = {
  isOpen(projectId: number): boolean {
    const w = widgets.get(projectId)
    return w != null && !w.isDestroyed()
  },

  /** True only if the window exists AND is on screen (hidden widgets count as closed) */
  isVisible(projectId: number): boolean {
    const w = widgets.get(projectId)
    return w != null && !w.isDestroyed() && w.isVisible()
  },

  getVisibleIds(): number[] {
    return visibleIds()
  },

  toggle(projectId: number): void {
    // Decide on what the user can actually see: a widget hidden by idle-sync or
    // the global hotkey must re-show on click, not close silently.
    if (this.isVisible(projectId)) {
      this.close(projectId)
    } else {
      userPinnedIds.add(projectId)
      autoHiddenIds.delete(projectId)
      idleHiddenIds.delete(projectId)
      this.open(projectId)
    }
    broadcastState()
  },

  open(projectId: number): void {
    const existing = widgets.get(projectId)
    if (existing && !existing.isDestroyed()) {
      if (!existing.isVisible()) existing.show()
      existing.focus()
      broadcastState()
      return
    }

    // Restore saved position or place near cursor (size is always fixed)
    const saved = savedState.positions[String(projectId)]
    let x: number, y: number

    if (saved) {
      const display = screen.getDisplayNearestPoint({ x: saved.x, y: saved.y })
      const wa = display.workArea
      x = Math.max(wa.x, Math.min(saved.x, wa.x + wa.width - WIDGET_WIDTH))
      y = Math.max(wa.y, Math.min(saved.y, wa.y + wa.height - WIDGET_HEIGHT))
    } else {
      const cursor = screen.getCursorScreenPoint()
      const display = screen.getDisplayNearestPoint(cursor)
      const offset = widgets.size * 40
      x = Math.min(cursor.x + 20 + offset, display.workArea.x + display.workArea.width - 220)
      y = Math.min(cursor.y + 20 + offset, display.workArea.y + display.workArea.height - 80)
    }

    const win = new BrowserWindow({
      width: WIDGET_WIDTH,
      height: WIDGET_HEIGHT,
      x,
      y,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
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

    // Save position on move (debounced)
    let saveTimeout: ReturnType<typeof setTimeout> | null = null
    const persistBounds = (): void => {
      if (win.isDestroyed()) return
      const bounds = win.getBounds()
      savedState.positions[String(projectId)] = { x: bounds.x, y: bounds.y }
      if (saveTimeout) clearTimeout(saveTimeout)
      saveTimeout = setTimeout(saveState, 500)
    }
    win.on('move', persistBounds)

    win.on('closed', () => {
      widgets.delete(projectId)
      broadcastState()
    })

    widgets.set(projectId, win)
    saveState()
    log.info(`Widget opened for project ${projectId}`)
    broadcastState()
  },

  close(projectId: number): void {
    const w = widgets.get(projectId)
    widgets.delete(projectId)
    autoHiddenIds.delete(projectId) // User explicitly closed — don't auto-show
    idleHiddenIds.delete(projectId)
    userPinnedIds.delete(projectId)
    if (!isDestroying) saveState()
    if (w && !w.isDestroyed()) {
      w.destroy()
    }
    broadcastState()
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
    // Don't open immediately — queue them for activity-based restore.
    // syncWithActiveProjects() on the first monitor tick will open the active ones.
    log.info(`Queued ${ids.length} widget(s) for activity-based restore`)
    for (const id of ids) {
      autoHiddenIds.add(id)
    }
  },

  syncWithActiveProjects(activeProjectIds: Set<number>): void {
    // Auto-hide open widgets for projects without today activity (skip user-pinned)
    for (const [projectId, w] of widgets) {
      if (!activeProjectIds.has(projectId) && !userPinnedIds.has(projectId)) {
        log.info(`Auto-hiding widget for inactive project ${projectId}`)
        autoHiddenIds.add(projectId)
        widgets.delete(projectId)
        if (!w.isDestroyed()) w.destroy()
      }
    }
    // Auto-show widgets for projects that became active
    for (const projectId of autoHiddenIds) {
      if (activeProjectIds.has(projectId)) {
        log.info(`Auto-showing widget for active project ${projectId}`)
        autoHiddenIds.delete(projectId)
        this.open(projectId)
      }
    }
    broadcastState()
  },

  /** Hide widgets for idle projects, show them again when processing resumes */
  syncIdleState(processingProjectIds: Set<number>): void {
    // Hide open widgets for projects that stopped processing (skip user-pinned)
    for (const [projectId, w] of widgets) {
      if (!processingProjectIds.has(projectId) && !userPinnedIds.has(projectId)) {
        log.info(`Idle-hiding widget for project ${projectId}`)
        idleHiddenIds.add(projectId)
        if (!w.isDestroyed()) w.hide()
      }
    }
    // Show idle-hidden widgets for projects that started processing again
    for (const projectId of idleHiddenIds) {
      if (processingProjectIds.has(projectId)) {
        log.info(`Idle-showing widget for project ${projectId}`)
        idleHiddenIds.delete(projectId)
        const w = widgets.get(projectId)
        if (w && !w.isDestroyed()) {
          w.show()
        }
      }
    }
    broadcastState()
  },

  /** Toggle visibility of all widgets via hotkey */
  toggleAllVisibility(): void {
    // Read the real state instead of a remembered flag — widgets also get
    // shown/hidden by idle sync and by the per-project toggle.
    const anyVisible = visibleIds().length > 0
    for (const w of widgets.values()) {
      if (w.isDestroyed()) continue
      if (anyVisible) w.hide()
      else w.show()
    }
    log.info(anyVisible ? 'Widgets hidden via hotkey' : 'Widgets shown via hotkey')
    broadcastState()
  },

  /** Register global hotkey for toggling widget visibility */
  registerHotkey(accelerator?: string): void {
    // Unregister previous if any
    this.unregisterHotkey()

    const key = accelerator || DEFAULT_WIDGET_HOTKEY
    try {
      const success = globalShortcut.register(key, () => {
        this.toggleAllVisibility()
      })
      if (success) {
        registeredAccelerator = key
        log.info(`Widget hotkey registered: ${key}`)
      } else {
        log.warn(`Widget hotkey registration failed: ${key}`)
      }
    } catch (err) {
      log.warn(`Widget hotkey registration error for ${key}:`, err)
    }
  },

  /** Unregister the current widget hotkey */
  unregisterHotkey(): void {
    if (registeredAccelerator) {
      try {
        globalShortcut.unregister(registeredAccelerator)
      } catch {
        /* already unregistered */
      }
      registeredAccelerator = null
    }
  },

  /** Get the currently registered hotkey accelerator */
  getHotkey(): string {
    return registeredAccelerator ?? DEFAULT_WIDGET_HOTKEY
  },

  /** Open (or re-show) widgets for all given project IDs and pin them */
  showAll(projectIds: number[]): void {
    for (const id of projectIds) {
      userPinnedIds.add(id)
      autoHiddenIds.delete(id)
      idleHiddenIds.delete(id)
      this.open(id)
    }
    broadcastState()
  },

  /** Close every widget, visible or hidden */
  hideAll(): void {
    for (const id of [...widgets.keys()]) {
      this.close(id)
    }
    broadcastState()
  },

  /** True if any widget is currently open */
  hasAnyOpen(): boolean {
    return widgets.size > 0
  },

  destroy(): void {
    this.unregisterHotkey()
    isDestroying = true
    for (const [id] of widgets) {
      this.close(id)
    }
  }
}
