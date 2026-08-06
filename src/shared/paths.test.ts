import { describe, it, expect, afterEach } from 'vitest'
import { isExcludedProjectDir, isExcludedProjectPath, setCustomExcludedPaths } from './paths'

afterEach(() => {
  setCustomExcludedPaths([])
})

describe('isExcludedProjectPath', () => {
  it('excludes pipes worktree segments', () => {
    expect(isExcludedProjectPath('C:\\apps\\PipedCreations\\pipes\\ticket\\17')).toBe(true)
    expect(isExcludedProjectPath('C:\\apps\\3D\\Printing\\Game\\pipes\\ticket\\1')).toBe(true)
  })

  it('excludes piped scratch workspaces', () => {
    expect(isExcludedProjectPath('C:\\piped\\scratch\\scratch\\1a1d25')).toBe(true)
    expect(isExcludedProjectPath('C:\\piped\\scratch')).toBe(true)
  })

  it('excludes Claude Code worktrees (with or without leading dot)', () => {
    expect(
      isExcludedProjectPath(
        'C:\\clients\\x\\code\\.claude\\worktrees\\affectionate\\almeida\\308f80'
      )
    ).toBe(true)
    expect(
      isExcludedProjectPath(
        'C:\\clients\\x\\code\\claude\\worktrees\\affectionate\\almeida\\308f80'
      )
    ).toBe(true)
  })

  it('keeps real projects', () => {
    expect(isExcludedProjectPath('C:\\apps\\3DPrintz')).toBe(false)
    expect(isExcludedProjectPath('C:\\apps\\ClawdTime')).toBe(false)
    expect(isExcludedProjectPath('C:\\apps\\scratch')).toBe(false)
    expect(isExcludedProjectPath('C:\\work\\worktrees\\feature')).toBe(false)
  })
})

describe('isExcludedProjectDir', () => {
  it('excludes encoded pipes, piped-scratch, and claude-worktrees names', () => {
    expect(isExcludedProjectDir('C--apps-PipedCreations-pipes-ticket-17')).toBe(true)
    expect(isExcludedProjectDir('C--piped-scratch-scratch-1a1d25')).toBe(true)
    expect(
      isExcludedProjectDir('C--clients-x-code--claude-worktrees-affectionate-almeida-308f80')
    ).toBe(true)
  })

  it('matches encoded names ending exactly at the excluded dir', () => {
    expect(isExcludedProjectDir('C--piped-scratch')).toBe(true)
    expect(isExcludedProjectDir('C--apps-Foo-pipes')).toBe(true)
    expect(isExcludedProjectDir('C--code--claude-worktrees')).toBe(true)
  })

  it('keeps encoded real project names', () => {
    expect(isExcludedProjectDir('C--apps-3DPrintz')).toBe(false)
    expect(isExcludedProjectDir('C--apps-ClawdTime')).toBe(false)
  })
})

describe('custom excluded paths', () => {
  it('excludes configured folders and everything under them (case-insensitive)', () => {
    setCustomExcludedPaths(['C:\\piped\\benchmarks'])
    expect(isExcludedProjectPath('C:\\piped\\benchmarks')).toBe(true)
    expect(isExcludedProjectPath('C:\\piped\\benchmarks\\burning\\match\\2026')).toBe(true)
    expect(isExcludedProjectPath('c:/piped/BENCHMARKS/sub')).toBe(true)
    expect(isExcludedProjectPath('C:\\piped\\benchmarks2')).toBe(false)
    expect(isExcludedProjectPath('C:\\apps\\3DPrintz')).toBe(false)
  })

  it('matches encoded project dir names for configured folders', () => {
    setCustomExcludedPaths(['C:\\piped\\benchmarks'])
    expect(isExcludedProjectDir('C--piped-benchmarks')).toBe(true)
    expect(isExcludedProjectDir('C--piped-benchmarks-create-a-pacman-game')).toBe(true)
    expect(isExcludedProjectDir('C--piped-benchmarks2')).toBe(false)
    expect(isExcludedProjectDir('C--apps-3DPrintz')).toBe(false)
  })

  it('handles trailing slashes and blank entries', () => {
    setCustomExcludedPaths(['C:\\piped\\benchmarks\\', '  ', ''])
    expect(isExcludedProjectPath('C:\\piped\\benchmarks\\x')).toBe(true)
    expect(isExcludedProjectPath('C:\\apps\\ClawdTime')).toBe(false)
  })

  it('clearing the list restores default behavior', () => {
    setCustomExcludedPaths(['C:\\piped\\benchmarks'])
    setCustomExcludedPaths([])
    expect(isExcludedProjectPath('C:\\piped\\benchmarks')).toBe(false)
  })
})
