// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

// Mock os.homedir
vi.mock('node:os', () => ({
  homedir: () => '/home/testuser'
}))

// Mock fs/promises
const mockReaddir = vi.fn()
vi.mock('node:fs/promises', () => ({
  readdir: (...args: unknown[]) => mockReaddir(...args)
}))

// Settings pulls in the DB/electron — stub it (track_codex unset ⇒ enabled)
vi.mock('./settings-service', () => ({
  settingsService: { getSetting: vi.fn(() => null) }
}))

// Codex discovery has its own fs walk — keep these tests focused on Claude dirs
const mockCodexFiles = vi.fn(async (): Promise<string[]> => [])
const mockCodexMeta = vi.fn(async (): Promise<{ sessionId: string; cwd: string | null } | null> => null)
vi.mock('../providers/codex-provider', () => ({
  codexProvider: {
    id: 'codex',
    discoverFiles: (...args: unknown[]) => mockCodexFiles(...(args as [])),
    readMeta: (...args: unknown[]) => mockCodexMeta(...(args as []))
  }
}))

import { discoveryService } from './discovery-service'

function dirent(name: string, isDir: boolean): import('node:fs').Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    path: '',
    parentPath: ''
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// Windows-path decoding relies on path.win32 semantics — skip on non-Windows CI.
const itWin = process.platform === 'win32' ? it : it.skip

describe('discoveryService.discoverDefaultProjects', () => {
  itWin('discovers projects from ~/.claude/projects directory', async () => {
    mockReaddir.mockResolvedValue([
      dirent('C--apps-ClauTime', true),
      dirent('C--apps-OtherProject', true),
      dirent('.DS_Store', false)
    ])

    const result = await discoveryService.discoverDefaultProjects()
    expect(mockReaddir).toHaveBeenCalledWith(expect.stringContaining('.claude'), {
      withFileTypes: true
    })
    expect(result).toHaveLength(2)
    expect(result[0].projectName).toBe('ClauTime')
    expect(result[0].projectPath).toBe('C:\\apps\\ClauTime')
    expect(result[0].encodedName).toBe('C--apps-ClauTime')
    expect(result[0].hasClaudeDir).toBe(true)
    expect(result[1].projectName).toBe('OtherProject')
  })

  it('returns empty array when ~/.claude/projects does not exist', async () => {
    mockReaddir.mockRejectedValue(new Error('ENOENT'))

    const result = await discoveryService.discoverDefaultProjects()
    expect(result).toHaveLength(0)
  })

  it('decodes Unix paths correctly', async () => {
    mockReaddir.mockResolvedValue([dirent('-home-user-myproject', true)])

    const result = await discoveryService.discoverDefaultProjects()
    expect(result).toHaveLength(1)
    expect(result[0].projectPath).toBe('/home/user/myproject')
    expect(result[0].projectName).toBe('myproject')
  })

  itWin('skips non-directory entries', async () => {
    mockReaddir.mockResolvedValue([
      dirent('C--apps-MyApp', true),
      dirent('settings.json', false),
      dirent('.DS_Store', false)
    ])

    const result = await discoveryService.discoverDefaultProjects()
    expect(result).toHaveLength(1)
    expect(result[0].projectName).toBe('MyApp')
  })
})

describe('discoveryService.discoverProjectsUnderFolder', () => {
  itWin('filters projects to those under the given folder', async () => {
    mockReaddir.mockResolvedValue([
      dirent('C--apps-ClauTime', true),
      dirent('C--apps-ButtonMaker', true),
      dirent('C--other-SomeProject', true)
    ])

    const result = await discoveryService.discoverProjectsUnderFolder('C:\\apps')
    expect(result).toHaveLength(2)
    expect(result[0].projectName).toBe('ClauTime')
    expect(result[1].projectName).toBe('ButtonMaker')
  })

  itWin('returns empty when no projects match the folder', async () => {
    mockReaddir.mockResolvedValue([dirent('C--apps-ClauTime', true)])

    const result = await discoveryService.discoverProjectsUnderFolder('D:\\work')
    expect(result).toHaveLength(0)
  })

  itWin('is case-insensitive on Windows paths', async () => {
    mockReaddir.mockResolvedValue([dirent('C--Apps-ClauTime', true)])

    const result = await discoveryService.discoverProjectsUnderFolder('c:\\apps')
    expect(result).toHaveLength(1)
  })
})

describe('discoveryService codex merge', () => {
  itWin('adds Codex-only projects grouped by session_meta cwd', async () => {
    mockReaddir.mockResolvedValue([dirent('C--apps-ClauTime', true)])
    mockCodexFiles.mockResolvedValue([
      'C:\\Users\\t\\.codex\\sessions\\2026\\07\\19\\rollout-a.jsonl',
      'C:\\Users\\t\\.codex\\sessions\\2026\\07\\19\\rollout-b.jsonl'
    ])
    mockCodexMeta
      .mockResolvedValueOnce({ sessionId: 'a', cwd: 'C:\\apps\\CodexOnly' })
      .mockResolvedValueOnce({ sessionId: 'b', cwd: 'C:\\apps\\ClauTime' }) // dupes with Claude project

    const result = await discoveryService.discoverDefaultProjects()
    expect(result).toHaveLength(2)
    const codexOnly = result.find((p) => p.projectName === 'CodexOnly')
    expect(codexOnly).toBeDefined()
    expect(codexOnly!.projectPath).toBe('C:\\apps\\CodexOnly')
    expect(codexOnly!.hasClaudeDir).toBe(false)
  })
})
