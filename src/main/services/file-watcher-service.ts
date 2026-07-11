import { watch, type FSWatcher } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, extname } from 'node:path'
import log from 'electron-log/main.js'
import { BrowserWindow } from 'electron'
import { settingsService } from './settings-service'
import { sessionService } from './session-service'
import { clientProjectService } from './client-project-service'
import { gitService } from './git-service'
import { getClaudeConfigDirs } from './discovery-service'
import { decodeProjectPath } from './session-detector'

// Per-project debounce before an incremental scan. Kept high because each scan
// re-parses the project's (often large, actively-growing) JSONL and writes to
// better-sqlite3 synchronously — expensive work that blocks the main process.
// A short debounce meant the active project re-parsed every few seconds and
// froze the UI. The Live view has its own poll, so real-time status is
// unaffected by scanning less eagerly; this only delays session persistence.
const DEBOUNCE_MS = 20000

/**
 * Watches ~/.claude/projects/ for JSONL file changes and new project directories.
 * On JSONL change → incremental session scan for that file.
 * On new directory → check if it's a known project, notify renderer if not.
 */
export const fileWatcherService = {
  _watchers: [] as FSWatcher[],
  _mainWindow: null as BrowserWindow | null,
  _debounceTimers: new Map<string, ReturnType<typeof setTimeout>>(),
  _knownDirs: new Set<string>(),

  async start(mainWindow: BrowserWindow): Promise<void> {
    if (this._watchers.length > 0) return

    this._mainWindow = mainWindow

    // Watch every Claude profile (~/.claude, ~/.claude-vss, …) so switching
    // accounts keeps live tracking working. A claude_dir override pins to one.
    const override = settingsService.getSetting('claude_dir')
    const configDirs = override ? [override] : await getClaudeConfigDirs()

    for (const configDir of configDirs) {
      const projectsDir = join(configDir, 'projects')

      // Snapshot known directories for new-project detection
      try {
        const entries = await readdir(projectsDir, { withFileTypes: true })
        for (const e of entries) {
          if (e.isDirectory()) this._knownDirs.add(e.name)
        }
      } catch {
        log.warn(`File watcher: cannot read ${projectsDir}, will retry on next change`)
        continue
      }

      try {
        const watcher = watch(projectsDir, { recursive: true }, (_eventType, filename) => {
          if (!filename) return
          this._handleChange(projectsDir, filename)
        })
        watcher.on('error', (err) => {
          log.warn(`File watcher error (${projectsDir}):`, err)
        })
        this._watchers.push(watcher)
        log.info(`File watcher started on: ${projectsDir}`)
      } catch (err) {
        log.warn(`File watcher: failed to start on ${projectsDir}:`, err)
      }
    }

    // Run a full scan on startup to catch anything missed while the app was closed
    this._runStartupScan()
  },

  stop(): void {
    if (this._watchers.length === 0) return
    for (const watcher of this._watchers) {
      watcher.close()
    }
    this._watchers = []
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer)
    }
    this._debounceTimers.clear()
    log.info('File watcher stopped')
  },

  async _runStartupScan(): Promise<void> {
    try {
      log.info('File watcher: running startup scan to catch missed changes')
      await sessionService.scanSessions()

      // Auto-create projects for all unregistered directories
      let autoCreated = 0
      for (const dirName of this._knownDirs) {
        const decodedPath = decodeProjectPath(dirName)
        const created = clientProjectService.autoCreateProject(decodedPath)
        if (created) autoCreated++
      }
      if (autoCreated > 0) {
        log.info(`File watcher: auto-created ${autoCreated} project(s) under Unassigned`)
      }

      clientProjectService.attributeSessions()
      gitService
        .scanCommits()
        .then((r) => {
          const correlated = gitService.correlateCommitsWithSessions()
          log.info(`Startup git scan: ${r.newCommits} new commits, ${correlated} correlated`)
        })
        .catch((err) => {
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
    // Debounce per project directory (not per file) since _runIncrementalScan
    // scans the entire project dir anyway. Multiple file changes in the same
    // project (main JSONL + subagent files) collapse into a single scan.
    const parts = filePath.replace(/\\/g, '/').split('/')
    const projectsIdx = parts.lastIndexOf('projects')
    const projectDirName = projectsIdx >= 0 ? parts[projectsIdx + 1] : null
    if (!projectDirName) return

    const existing = this._debounceTimers.get(projectDirName)
    if (existing) clearTimeout(existing)

    this._debounceTimers.set(
      projectDirName,
      setTimeout(() => {
        this._debounceTimers.delete(projectDirName)
        this._runIncrementalScan(projectDirName)
      }, DEBOUNCE_MS)
    )
  },

  async _runIncrementalScan(projectDirName: string): Promise<void> {
    try {
      const decodedPath = decodeProjectPath(projectDirName)
      log.info(`File watcher: incremental scan for project ${decodedPath}`)

      // Run incremental scan filtered to just this project's files
      await sessionService.scanSessions(undefined, [projectDirName])
      clientProjectService.attributeSessions()

      // Pick up any new git commits for this project, then correlate.
      // Without this, long-running app sessions never see commits made after startup.
      gitService
        .scanCommits()
        .then(() => {
          gitService.correlateCommitsWithSessions()
        })
        .catch((err) => {
          log.warn('Incremental git scan failed (non-critical):', err)
        })

      // Notify renderer to refresh data
      this._notifyRenderer()
    } catch (err) {
      log.warn('File watcher: incremental scan failed:', err)
    }
  },

  _handleNewProject(dirName: string): void {
    const decodedPath = decodeProjectPath(dirName)
    log.info(`File watcher: new project directory detected: ${decodedPath}`)

    // Auto-create the project under "Unassigned" if not already registered
    const created = clientProjectService.autoCreateProject(decodedPath)

    if (created) {
      const projectName = created.name
      this._sendToRenderer('watcher:newProject', { dirName, decodedPath, projectName })
      log.info(`File watcher: auto-created and notified renderer about new project: ${projectName}`)
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
