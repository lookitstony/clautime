import type { SessionTool } from './types/session'

/**
 * Normalize a directory path for consistent comparison.
 * Windows: uppercase drive letter + backslashes.
 */
export function normalizePath(p: string): string {
  const driveMatch = p.match(/^([a-zA-Z]):/)
  if (driveMatch) {
    return driveMatch[1].toUpperCase() + ':' + p.slice(2).replace(/\//g, '\\')
  }
  return p
}

export function getProjectName(projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  return segments[segments.length - 1] || projectPath
}

/**
 * Which coding agent wrote a session file, derived from its path.
 * Codex rollouts live under ~/.codex/, Gemini CLI chats under ~/.gemini/,
 * OpenCode sessions under <data-dir>/opencode/storage/; everything else is Claude.
 */
export function toolForSourceFile(sourceFile: string): SessionTool {
  if (/[\\/]\.codex[\\/]/i.test(sourceFile)) return 'codex'
  if (/[\\/]\.gemini[\\/]/i.test(sourceFile)) return 'gemini'
  if (/[\\/]opencode[\\/]storage[\\/]/i.test(sourceFile)) return 'opencode'
  return 'claude'
}

/**
 * Piped-swarm creates throwaway git worktrees under a `pipes/` folder
 * (e.g. C:\apps\Foo\pipes\ticket-1). Claude encodes those dir names with a
 * `-pipes-` segment. They are transient and noisy, not real projects, so we
 * exclude them from discovery and scanning. `encodedName` is the
 * .claude/projects/ folder name (path separators replaced with `-`).
 */
export function isExcludedProjectDir(encodedName: string): boolean {
  return /-pipes-/i.test(encodedName)
}

/**
 * Decoded-path equivalent of {@link isExcludedProjectDir}: true when any path
 * segment is a `pipes` folder (e.g. C:\apps\Foo\pipes\ticket\1). Used to keep
 * piped-swarm worktrees out of the auto-created projects list.
 */
export function isExcludedProjectPath(projectPath: string): boolean {
  return projectPath
    .replace(/\\/g, '/')
    .split('/')
    .some((segment) => segment.toLowerCase() === 'pipes')
}
