import { describe, it, expect } from 'vitest'
import { isExcludedProjectDir, isExcludedProjectPath } from './paths'

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
