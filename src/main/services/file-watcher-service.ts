import { watch, type FSWatcher } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import { homedir } from 'node:os'
import log from 'electron-log/main.js'
import { BrowserWindow } from 'electron'
import { getDb } from '../db'
import { projects } from '../db/schema/projects'
import { settingsService } from './settings-service'
import { sessionService } from './session-service'
import { clientProjectService } from './client-project-service'
import { gitService } from './git-service'
import { decodeProjectPath } from './session-detector'

const DEBOUNCE_MS = 3000

/**
 * Watches ~/.claude/projects/ for JSONL file changes and new project directories.
 * On JSONL change → incremental session scan for that file.
 * On new directory → check if it's a known project, notify renderer if not.
 */
export const fileWatcherService = {
  _watcher: null as FSWatcher | null,
  _mainWindow: null as BrowserWindow | null,
  _debounceTimers: new Map<string, ReturnType<typeof setTimeout>>(),
  _knownDirs: new Set<string>(),

  async start(mainWindow: BrowserWindow): Promise<void> {
    if (this._watcher) return

    this._mainWindow = mainWindow
    const claudeDir = settingsService.getSetting('claude_dir') ?? join(homedir(), '.claude')
    const projectsDir = join(claudeDir, 'projects')

    // Snapshot known directories for new-project detection
    try {
      const entries = await readdir(projectsDir, { withFileTypes: true })
      for (const e of entries) {
        if (e.isDirectory()) this._knownDirs.add(e.name)
      }
    } catch {
      log.warn('File watcher: cannot read projects dir, will retry on next change')
    }

    try {
      this._watcher = watch(projectsDir, { recursive: true }, (eventType, filename) => {
        if (!filename) return
        this._handleChange(projectsDir, filename)
      })

      this._watcher.on('error', (err) => {
        log.warn('File watcher error:', err)
      })

      log.info(`File watcher started on: ${projectsDir}`)

      // Run a full scan on startup to catch anything missed while the app was closed
      this._runStartupScan()
    } catch (err) {
      log.warn('File watcher: failed to start:', err)
    }
  },

  stop(): void {
    if (this._watcher) {
      this._watcher.close()
      this._watcher = null
      for (const timer of this._debounceTimers.values()) {
        clearTimeout(timer)
      }
      this._debounceTimers.clear()
      log.info('File watcher stopped')
    }
  },

  async _runStartupScan(): Promise<void> {
    try {
      log.info('File watcher: running startup scan to catch missed changes')
      await sessionService.scanSessions()
      clientProjectService.attributeSessions()
      gitService.scanCommits().then((r) => {
        const correlated = gitService.correlateCommitsWithSessions()
        log.info(`Startup git scan: ${r.newCommits} new commits, ${correlated} correlated`)
      }).catch((err) => {
        log.warn('Startup git scan failed (non-critical):', err)
      })
      this._notifyRenderer()
      log.info('File watcher: startup scan complete')
    } catch (err) {
      log.warn('File watcher: startup scan failed:', err)
    }
  },

  _handleChange(projectsDir: string, filename: string): void {
    // filename is relative to projectsDir, e.g. "C--apps-Foo/abc123.jsonl"
    const parts = filename.replace(/\\/g, '/').split('/')
    if (parts.length === 0) return

    const dirName = parts[0]

    // New project directory detection
    if (!this._knownDirs.has(dirName)) {
      this._knownDirs.add(dirName)
      this._handleNewProject(dirName)
    }

    // JSONL file change → incremental scan
    if (parts.length >= 2 && extname(parts[parts.length - 1]).toLowerCase() === '.jsonl') {
      const fullPath = join(projectsDir, ...parts)
      this._debouncedScan(fullPath)
    }
  },

  _debouncedScan(filePath: string): void {
    const existing = this._debounceTimers.get(filePath)
    if (existing) clearTimeout(existing)

    this._debounceTimers.set(
      filePath,
      setTimeout(() => {
        this._debounceTimers.delete(filePath)
        this._runIncrementalScan(filePath)
      }, DEBOUNCE_MS)
    )
  },

  async _runIncrementalScan(filePath: string): Promise<void> {
    try {
      // Extract the project dir name from the file path to create a filter
      // filePath = .../projects/C--apps-Foo/abc123.jsonl
      const parts = filePath.replace(/\\/g, '/').split('/')
      const projectsIdx = parts.lastIndexOf('projects')
      const projectDirName = projectsIdx >= 0 ? parts[projectsIdx + 1] : null

      if (!projectDirName) return

      const decodedPath = decodeProjectPath(projectDirName)
      log.info(`File watcher: incremental scan for ${basename(filePath)} (${decodedPath})`)

      // Run incremental scan filtered to just this project's files
      await sessionService.scanSessions(undefined, [projectDirName])
      clientProjectService.attributeSessions()

      // Notify renderer to refresh data
      this._notifyRenderer()
    } catch (err) {
      log.warn('File watcher: incremental scan failed:', err)
    }
  },

  _handleNewProject(dirName: string): void {
    const decodedPath = decodeProjectPath(dirName)
    log.info(`File watcher: new project directory detected: ${decodedPath}`)

    // Check if this project path already exists in DB
    const db = getDb()
    const existing = db
      .select()
      .from(projects)
      .all()
      .find((p) => p.directoryPath.toLowerCase() === decodedPath.toLowerCase())

    if (!existing) {
      // Notify renderer about new project
      const projectName = basename(decodedPath) || dirName
      this._sendToRenderer('watcher:newProject', { dirName, decodedPath, projectName })
      log.info(`File watcher: notified renderer about new project: ${projectName}`)
    }
  },

  _notifyRenderer(): void {
    this._sendToRenderer('watcher:sessionsUpdated', {})
  },

  _sendToRenderer(channel: string, data: unknown): void {
    try {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(channel, data)
        }
      }
    } catch {
      // Window may have been closed
    }
  }
}
