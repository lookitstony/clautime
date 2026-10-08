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
import { decodeProjectPath, encodeProjectPath } from './session-detector'
import { getCodexSessionsDir, readCodexSessionMeta } from '../parsers/codex-parser'
import { mainProjectPath } from './worktree-paths'
import { setMarkedFolderListener } from './project-folder-marker'
import { isProviderEnabled } from './provider-tracking'
import { isExcludedProjectDir, isExcludedProjectPath } from '../../shared/paths'
import type { Project } from '../../shared/types/client-project'

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
  _pendingCodexFiles: new Set<string>(),
  _knownDirs: new Set<string>(),

  async start(mainWindow: BrowserWindow): Promise<void> {
    if (this._watchers.length > 0) return

    this._mainWindow = mainWindow
    setMarkedFolderListener((event) => this._sendToRenderer('watcher:projectFolder', event))
    clientProjectService.setDiscoveredProjectListener((project) =>
      this._onDiscoveredProject(project)
    )

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

    const codexRoot = getCodexSessionsDir()
    try {
      const watcher = watch(codexRoot, { recursive: true }, (_eventType, filename) => {
        if (
          filename &&
          extname(filename).toLowerCase() === '.jsonl' &&
          isProviderEnabled('codex')
        ) {
          this._debouncedCodexScan(join(codexRoot, filename))
        }
      })
      watcher.on('error', (err) => log.warn('Codex file watcher error:', err))
      this._watchers.push(watcher)
    } catch (err) {
      log.debug('Codex session directory is not available for watching:', err)
    }

    // Run a full scan on startup to catch anything missed while the app was closed
    this._runStartupScan()
  },

  stop(): void {
    setMarkedFolderListener(undefined)
    clientProjectService.setDiscoveredProjectListener(undefined)
    for (const watcher of this._watchers) {
      watcher.close()
    }
    this._watchers = []
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer)
    }
    this._debounceTimers.clear()
    this._pendingCodexFiles.clear()
    log.info('File watcher stopped')
  },

  async _runStartupScan(): Promise<void> {
    try {
      log.info('File watcher: running startup scan to catch missed changes')
      const result = await sessionService.scanSessions()

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
      clientProjectService.writeProjectMarkers()
      gitService
        .scanCommits()
        .then((r) => {
          const correlated = gitService.correlateCommitsWithSessions()
          log.info(`Startup git scan: ${r.newCommits} new commits, ${correlated} correlated`)
        })
        .catch((err) => {
          log.warn('Startup git scan failed (non-critical):', err)
        })
      this._notifyRenderer(result.errors)
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

    // Excluded dirs (pipes, scratch, user-configured folders) churn constantly
    // during agent/benchmark runs — never let them trigger scan machinery
    if (isExcludedProjectDir(dirName)) return

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

  _debouncedCodexScan(filePath: string): void {
    this._pendingCodexFiles.add(filePath)
    const key = 'codex'
    // Keep the first deadline so continuous writes still update the displayed time.
    if (this._debounceTimers.has(key)) return
    this._debounceTimers.set(
      key,
      setTimeout(async () => {
        this._debounceTimers.delete(key)
        if (!isProviderEnabled('codex')) return
        if (sessionService._scanInProgress) {
          this._debouncedCodexScan(filePath)
          return
        }
        const files = [...this._pendingCodexFiles]
        this._pendingCodexFiles.clear()
        const projects = new Map<string, string[]>()
        for (const changedFile of files) {
          try {
            const meta = await readCodexSessionMeta(changedFile)
            if (!meta?.cwd || isExcludedProjectPath(meta.cwd)) continue
            const directory = mainProjectPath(meta.cwd)
            const related = projects.get(directory) ?? []
            related.push(changedFile)
            projects.set(directory, related)
          } catch (err) {
            log.warn('Codex incremental scan failed:', err)
          }
        }
        // Many changed transcripts can belong to one project. Scan that project
        // once per batch, retaining new writes for the next deadline.
        for (const [directory, changedFiles] of projects) {
          if (sessionService._scanInProgress) {
            for (const changedFile of changedFiles) this._debouncedCodexScan(changedFile)
            continue
          }
          try {
            clientProjectService.autoCreateProject(directory)
            await this._runIncrementalScan(encodeProjectPath(directory), directory)
          } catch (err) {
            log.warn('Codex incremental scan failed:', err)
          }
        }
      }, DEBOUNCE_MS)
    )
  },

  async _runIncrementalScan(projectDirName: string, directoryPath?: string): Promise<void> {
    try {
      const decodedPath = directoryPath ?? decodeProjectPath(projectDirName)
      log.info(`File watcher: incremental scan for project ${decodedPath}`)

      // Run incremental scan filtered to just this project's files
      const result = await sessionService.scanSessions(undefined, [projectDirName])
      clientProjectService.attributeSessions()

      // Pick up any new git commits for THIS project only, then correlate.
      // A full scanCommits() here spawned git for every registered project on
      // every incremental scan — hundreds of process spawns per minute during
      // active coding, which blocked the main thread and froze the UI.
      const project = clientProjectService.findProjectByDirectory(decodedPath)
      if (project) {
        gitService
          .scanCommits([project.id])
          .then((r) => {
            if (r.newCommits > 0) gitService.correlateCommitsWithSessions()
          })
          .catch((err) => {
            log.warn('Incremental git scan failed (non-critical):', err)
          })
      }

      // Notify renderer to refresh data
      this._notifyRenderer(result.errors)
    } catch (err) {
      log.warn('File watcher: incremental scan failed:', err)
    }
  },

  /** A git-history check released a held folder: finish what discovery would have done. */
  _onDiscoveredProject(project: Project): void {
    const decodedPath = project.directoryPath ?? ''
    this._sendToRenderer('watcher:newProject', {
      dirName: encodeProjectPath(decodedPath),
      decodedPath,
      projectName: project.name
    })
    this._notifyRenderer()
    gitService
      .scanCommits([project.id])
      .then((r) => {
        if (r.newCommits > 0) gitService.correlateCommitsWithSessions()
      })
      .catch((err) => log.warn('Git scan of a discovered project failed:', err))
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

  _notifyRenderer(errors?: import('../../shared/types/session').SessionScanError[]): void {
    this._sendToRenderer('watcher:sessionsUpdated', { errors })
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
