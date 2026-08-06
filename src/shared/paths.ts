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
 * User-configured excluded folders (from the `excluded_paths` setting), kept as
 * module state so the pure exclusion predicates below stay call-site-compatible
 * everywhere. The main process loads this at startup and re-applies it whenever
 * the setting changes; built-in rules (pipes/, piped scratch, worktrees) always
 * apply regardless.
 */
let customPathPrefixes: string[] = []
let customEncodedPrefixes: string[] = []

/** Claude's projects-dir encoding: every non-alphanumeric char becomes `-`. */
function encodePathToDirPrefix(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
}

export function setCustomExcludedPaths(paths: string[]): void {
  const cleaned = paths.map((p) => p.trim()).filter(Boolean)
  customPathPrefixes = cleaned.map((p) =>
    normalizePath(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  )
  customEncodedPrefixes = cleaned.map((p) => encodePathToDirPrefix(normalizePath(p)))
}

export function getCustomExcludedPaths(): string[] {
  return [...customPathPrefixes]
}

/**
 * Piped-swarm creates throwaway git worktrees under a `pipes/` folder
 * (e.g. C:\apps\Foo\pipes\ticket-1). Claude encodes those dir names with a
 * `-pipes-` segment. They are transient and noisy, not real projects, so we
 * exclude them from discovery and scanning. `encodedName` is the
 * .claude/projects/ folder name (path separators replaced with `-`).
 * User-configured excluded folders (see {@link setCustomExcludedPaths}) are
 * matched as encoded prefixes on a `-` boundary.
 */
export function isExcludedProjectDir(encodedName: string): boolean {
  if (/-pipes(-|$)|-piped-scratch(-|$)|-claude-worktrees(-|$)/i.test(encodedName)) return true
  const lower = encodedName.toLowerCase()
  return customEncodedPrefixes.some((prefix) => lower === prefix || lower.startsWith(prefix + '-'))
}

/**
 * Decoded-path equivalent of {@link isExcludedProjectDir}: true when any path
 * segment is a `pipes` folder (e.g. C:\apps\Foo\pipes\ticket\1), a piped-swarm
 * scratch workspace (…\piped\scratch\…), or a Claude Code worktree
 * (…\.claude\worktrees\… — decoded folder names drop the leading dot). Used to
 * keep transient agent workspaces out of discovery, scanning, and the
 * auto-created projects list.
 */
export function isExcludedProjectPath(projectPath: string): boolean {
  const normalized = normalizePath(projectPath).replace(/\\/g, '/').toLowerCase()
  if (
    customPathPrefixes.some(
      (prefix) => normalized === prefix || normalized.startsWith(prefix + '/')
    )
  ) {
    return true
  }
  const segments = normalized.split('/').filter(Boolean)
  return segments.some((seg, i) => {
    if (seg === 'pipes') return true
    if (seg === 'scratch' && segments[i - 1] === 'piped') return true
    if (seg === 'worktrees' && (segments[i - 1] === '.claude' || segments[i - 1] === 'claude'))
      return true
    return false
  })
}
