// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: {} }))
vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}))
vi.mock('./settings-service', () => ({ settingsService: {} }))
vi.mock('./session-service', () => ({
  sessionService: { _scanInProgress: false, scanSessions: vi.fn() }
}))
vi.mock('./client-project-service', () => ({
  clientProjectService: {
    autoCreateProject: vi.fn(),
    attributeSessions: vi.fn(),
    findProjectByDirectory: vi.fn()
  }
}))
vi.mock('./git-service', () => ({ gitService: {} }))
vi.mock('./discovery-service', () => ({ getClaudeConfigDirs: vi.fn() }))
vi.mock('./provider-tracking', () => ({ isProviderEnabled: () => true }))
vi.mock('../parsers/codex-parser', () => ({
  getCodexSessionsDir: () => 'codex',
  readCodexSessionMeta: async () => ({ cwd: 'C:\\repo\\.claude\\worktrees\\feature' })
}))
const { fileWatcherService } = await import('./file-watcher-service')
const { sessionService } = await import('./session-service')

beforeEach(() => {
  vi.useFakeTimers()
  sessionService._scanInProgress = false
  vi.spyOn(fileWatcherService, '_runIncrementalScan').mockResolvedValue()
})
afterEach(() => {
  vi.clearAllTimers()
  fileWatcherService._debounceTimers.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('updates a Codex worktree under its main project despite continuous file writes', async () => {
  for (let i = 0; i < 20; i++) {
    fileWatcherService._debouncedCodexScan('rollout.jsonl')
    await vi.advanceTimersByTimeAsync(1000)
  }
  expect(fileWatcherService._runIncrementalScan).toHaveBeenCalledExactlyOnceWith(
    'C--repo',
    'C:\\repo'
  )
})

it('retries Codex updates when another scan is running', async () => {
  sessionService._scanInProgress = true
  fileWatcherService._debouncedCodexScan('rollout.jsonl')
  await vi.advanceTimersByTimeAsync(20_000)
  expect(fileWatcherService._runIncrementalScan).not.toHaveBeenCalled()
  sessionService._scanInProgress = false
  await vi.advanceTimersByTimeAsync(20_000)
  expect(fileWatcherService._runIncrementalScan).toHaveBeenCalledOnce()
})

it('notifies the renderer of committed work and unresolved files after a partial background scan', async () => {
  vi.mocked(fileWatcherService._runIncrementalScan).mockRestore()
  const errors = [{ sourceFile: 'legacy.jsonl', message: 'Legacy history needs review' }]
  vi.mocked(sessionService.scanSessions).mockResolvedValue({
    newSessions: 1,
    updatedFiles: 1,
    totalFiles: 2,
    durationMs: 1,
    attributedCount: 0,
    errors
  })
  const send = vi.spyOn(fileWatcherService, '_sendToRenderer').mockImplementation(() => {})
  await fileWatcherService._runIncrementalScan('C--repo', 'C:\\repo')
  expect(send).toHaveBeenCalledWith('watcher:sessionsUpdated', { errors })
})
