import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { normalizePath } from '../../shared/paths'

/** Resolve linked worktrees, including logs left behind after a worktree was removed. */
export function mainProjectPath(directory: string): string {
  const normalized = normalizePath(directory)
  // Claude's lossy folder decoding can drop dots and turn hyphens into separators.
  const conventional = normalized
    .replace(/\\/g, '/')
    .match(/^(.*?)[/]+(?:\.?claude\/worktrees|\.?review[-/]worktrees|pipes)\//i)
  if (conventional) {
    const parent = conventional[1] || '/'
    return normalizePath(/^[a-z]:$/i.test(parent) ? `${parent}/` : parent)
  }

  let current = normalized
  while (true) {
    const marker = join(current, '.git')
    try {
      if (statSync(marker).isDirectory()) return normalized
      const gitdir = readFileSync(marker, 'utf8').match(/^gitdir:\s*(.+)\s*$/m)?.[1]
      if (!gitdir) return normalized
      const adminDir = resolve(current, gitdir.trim())
      const commonDir = resolve(adminDir, readFileSync(join(adminDir, 'commondir'), 'utf8').trim())
      if (commonDir !== adminDir && /[/\\]\.git$/i.test(commonDir)) {
        return normalizePath(dirname(commonDir))
      }
      return normalized
    } catch {
      // No Git metadata here; a session may have started in a worktree subdirectory.
    }
    const parent = dirname(current)
    if (parent === current || parent === '.') return normalized
    current = parent
  }
}

/** Claude's encoded directory names retain recognizable worktree containers. */
export function mainProjectEncoded(encoded: string): string {
  return encoded.replace(/-+(?:claude-worktrees|review-worktrees|pipes)-.*$/i, '')
}
