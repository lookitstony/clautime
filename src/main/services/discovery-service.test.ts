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

describe('discoveryService.discoverDefaultProjects', () => {
  it('discovers projects from ~/.claude/projects directory', async () => {
    mockReaddir.mockResolvedValue([
      dirent('C--apps-ClawdTime', true),
      dirent('C--apps-OtherProject', true),
      dirent('.DS_Store', false)
    ])

    const result = await discoveryService.discoverDefaultProjects()
    expect(mockReaddir).toHaveBeenCalledWith(
      expect.stringContaining('.claude'),
      { withFileTypes: true }
    )
    expect(result).toHaveLength(2)
    expect(result[0].projectName).toBe('ClawdTime')
    expect(result[0].projectPath).toBe('C:\\apps\\ClawdTime')
    expect(result[0].encodedName).toBe('C--apps-ClawdTime')
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

  it('skips non-directory entries', async () => {
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
  it('filters projects to those under the given folder', async () => {
    mockReaddir.mockResolvedValue([
      dirent('C--apps-ClawdTime', true),
      dirent('C--apps-ButtonMaker', true),
      dirent('C--other-SomeProject', true)
    ])

    const result = await discoveryService.discoverProjectsUnderFolder('C:\\apps')
    expect(result).toHaveLength(2)
    expect(result[0].projectName).toBe('ClawdTime')
    expect(result[1].projectName).toBe('ButtonMaker')
  })

  it('returns empty when no projects match the folder', async () => {
    mockReaddir.mockResolvedValue([
      dirent('C--apps-ClawdTime', true)
    ])

    const result = await discoveryService.discoverProjectsUnderFolder('D:\\work')
    expect(result).toHaveLength(0)
  })

  it('is case-insensitive on Windows paths', async () => {
    mockReaddir.mockResolvedValue([
      dirent('C--Apps-ClawdTime', true)
    ])

    const result = await discoveryService.discoverProjectsUnderFolder('c:\\apps')
    expect(result).toHaveLength(1)
  })
})
