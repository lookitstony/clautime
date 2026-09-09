// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { mainProjectPath, mainProjectEncoded } from './worktree-paths'

const temporary: string[] = []
afterEach(() =>
  temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
)

describe('worktree project paths', () => {
  it('maps removed Claude and review worktrees, including lossy decoded paths', () => {
    for (const path of [
      'C:/repo/.claude/worktrees/issue+SOL-4192',
      'C:/repo/.review-worktrees/pr-894',
      'C:/repo//review/worktrees/pr/894'
    ])
      expect(mainProjectPath(path)).toBe('C:\\repo')
    expect(mainProjectEncoded('C--repo--claude-worktrees-issue-SOL-4192')).toBe('C--repo')
    expect(mainProjectEncoded('C--repo--review-worktrees-pr-894')).toBe('C--repo')
  })

  it('resolves Git metadata for worktrees outside the repository and their subdirectories', () => {
    const root = mkdtempSync(join(tmpdir(), 'clautime-worktree-'))
    temporary.push(root)
    const main = join(root, 'main')
    const admin = join(main, '.git', 'worktrees', 'feature')
    const worktree = join(root, 'elsewhere', 'feature')
    mkdirSync(admin, { recursive: true })
    mkdirSync(join(worktree, 'src'), { recursive: true })
    writeFileSync(join(worktree, '.git'), `gitdir: ${relative(worktree, admin)}\n`)
    writeFileSync(join(admin, 'commondir'), '../..\n')
    expect(mainProjectPath(worktree)).toBe(main)
    expect(mainProjectPath(join(worktree, 'src'))).toBe(main)
    expect(mainProjectPath(main)).toBe(main)
    // An ordinary nested project remains independently tracked.
    expect(mainProjectPath(join(main, 'src'))).toBe(join(main, 'src'))
  })
})
