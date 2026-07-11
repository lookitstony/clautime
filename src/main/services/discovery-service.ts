import { readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import log from 'electron-log/main.js'
import { isExcludedProjectDir } from '../../shared/paths'
import type { DiscoveredProject } from '../../shared/types/session'

/**
 * DiscoveryService reads ~/.claude/projects/ to find all Claude Code projects.
 * Claude CLI stores all project data centrally at ~/.claude/projects/{encoded-path}/
 */
export const discoveryService = {
  /**
   * Discover all projects from ~/.claude/projects/.
   */
  async discoverDefaultProjects(): Promise<DiscoveredProject[]> {
    return readClaudeProjects()
  },

  /**
   * Discover projects from ~/.claude/projects/ filtered to only those
   * whose decoded path starts with the given folder.
   */
  async discoverProjectsUnderFolder(folder: string): Promise<DiscoveredProject[]> {
    const all = await readClaudeProjects()
    const normalized = folder.replace(/\\/g, '/').toLowerCase()
    return all.filter((p) => p.projectPath.replace(/\\/g, '/').toLowerCase().startsWith(normalized))
  }
}

/**
 * Resolve every Claude config directory to scan. Claude Code stores sessions
 * under CLAUDE_CONFIG_DIR, and users who juggle multiple accounts point it at
 * sibling dirs like ~/.claude-vss or ~/.claude-feature23. We enumerate every
 * ~/.claude* folder that actually has a projects/ subdir so switching accounts
 * doesn't silently stop tracking. Returns [~/.claude] as a fallback.
 */
export async function getClaudeConfigDirs(): Promise<string[]> {
  const home = homedir()
  const fallback = join(home, '.claude')

  let entries: import('node:fs').Dirent<string>[]
  try {
    entries = await readdir(home, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return [fallback]
  }

  const dirs: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name !== '.claude' && !entry.name.startsWith('.claude-')) continue
    const base = join(home, entry.name)
    try {
      // Only include profiles that actually hold session data.
      await readdir(join(base, 'projects'))
      dirs.push(base)
    } catch {
      // No projects/ subdir — not a session-bearing profile, skip.
    }
  }

  return dirs.length > 0 ? dirs : [fallback]
}

async function readClaudeProjects(): Promise<DiscoveredProject[]> {
  const configDirs = await getClaudeConfigDirs()
  const byEncodedName = new Map<string, DiscoveredProject>()

  for (const configDir of configDirs) {
    const projectsDir = join(configDir, 'projects')
    log.info(`Discovery: reading projects from: ${projectsDir}`)
    try {
      const entries = await readdir(projectsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (isExcludedProjectDir(entry.name)) continue
        const encodedName = entry.name
        if (byEncodedName.has(encodedName)) continue
        const projectPath = decodeProjectName(encodedName)
        byEncodedName.set(encodedName, {
          projectPath,
          projectName: basename(projectPath) || encodedName,
          encodedName,
          hasClaudeDir: true
        })
      }
    } catch {
      log.warn(`Discovery: ${projectsDir} not found or inaccessible`)
    }
  }

  const projects = [...byEncodedName.values()]
  log.info(`Discovery: found ${projects.length} projects across ${configDirs.length} config dir(s)`)
  return projects
}

/**
 * Decode a .claude/projects/ folder name back to a project path.
 * Claude CLI encodes paths by replacing `:`, `\`, and `/` with `-`.
 * Example: "C--apps-ClauTime" → "C:\apps\ClauTime" (Windows)
 * Example: "-home-user-projects-myapp" → "/home/user/projects/myapp" (Unix)
 */
function decodeProjectName(encoded: string): string {
  // Windows drive letter pattern: C--apps-Foo → C:\apps\Foo
  const windowsDriveMatch = encoded.match(/^([A-Za-z])-(-?.*)$/)
  if (windowsDriveMatch) {
    const drive = windowsDriveMatch[1]
    const rest = windowsDriveMatch[2]
    const path = rest.replace(/-/g, '\\')
    return `${drive}:${path}`
  }

  // Unix path: leading dash means root /
  if (encoded.startsWith('-')) {
    return encoded.replace(/-/g, '/')
  }

  // Fallback: replace dashes with OS separator
  return encoded.replace(/-/g, '/')
}
