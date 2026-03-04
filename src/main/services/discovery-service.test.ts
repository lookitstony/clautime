// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

// Mock fs/promises
const mockReaddir = vi.fn()
vi.mock('node:fs/promises', () => ({
  readdir: (...args: unknown[]) => mockReaddir(...args),
  stat: vi.fn()
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

describe('discoveryService', () => {
  it('discovers projects from .claude/projects directory', async () => {
    // Root folder has .claude directory
    mockReaddir.mockImplementation(async (dir: string, opts?: unknown) => {
      if (dir === '/projects') {
        return [dirent('.claude', true), dirent('README.md', false)]
      }
      if (dir === join('/projects', '.claude', 'projects')) {
        return [
          dirent('C--apps-ClawdTime', true),
          dirent('C--apps-OtherProject', true)
        ]
      }
      return []
    })

    const result = await discoveryService.discoverProjects('/projects')
    expect(result).toHaveLength(2)
    expect(result[0].projectName).toBe('ClawdTime')
    expect(result[0].projectPath).toBe('C:\\apps\\ClawdTime')
    expect(result[0].encodedName).toBe('C--apps-ClawdTime')
    expect(result[0].hasClaudeDir).toBe(true)
    expect(result[1].projectName).toBe('OtherProject')
  })

  it('returns empty array when no .claude directories found', async () => {
    mockReaddir.mockImplementation(async () => {
      return [dirent('src', true), dirent('package.json', false)]
    })

    const result = await discoveryService.discoverProjects('/projects')
    expect(result).toHaveLength(0)
  })

  it('handles permission errors gracefully', async () => {
    mockReaddir.mockImplementation(async (dir: string) => {
      if (dir === '/projects') {
        return [dirent('restricted', true)]
      }
      throw new Error('EACCES: permission denied')
    })

    const result = await discoveryService.discoverProjects('/projects')
    expect(result).toHaveLength(0)
  })

  it('skips node_modules and .git directories', async () => {
    const calls: string[] = []
    mockReaddir.mockImplementation(async (dir: string) => {
      calls.push(dir)
      if (dir === '/projects') {
        return [
          dirent('node_modules', true),
          dirent('.git', true),
          dirent('src', true)
        ]
      }
      return []
    })

    await discoveryService.discoverProjects('/projects')
    expect(calls).not.toContain(join('/projects', 'node_modules'))
    expect(calls).not.toContain(join('/projects', '.git'))
  })

  it('recursively scans subdirectories', async () => {
    mockReaddir.mockImplementation(async (dir: string) => {
      if (dir === '/root') {
        return [dirent('workspace', true)]
      }
      if (dir === join('/root', 'workspace')) {
        return [dirent('.claude', true)]
      }
      if (dir === join('/root', 'workspace', '.claude', 'projects')) {
        return [dirent('-home-user-myproject', true)]
      }
      return []
    })

    const result = await discoveryService.discoverProjects('/root')
    expect(result).toHaveLength(1)
    expect(result[0].projectPath).toBe('/home/user/myproject')
    expect(result[0].projectName).toBe('myproject')
  })

  it('handles .claude dir without projects subfolder', async () => {
    mockReaddir.mockImplementation(async (dir: string) => {
      if (dir === '/projects') {
        return [dirent('.claude', true)]
      }
      // .claude/projects doesn't exist
      throw new Error('ENOENT')
    })

    const result = await discoveryService.discoverProjects('/projects')
    expect(result).toHaveLength(0)
  })
})
