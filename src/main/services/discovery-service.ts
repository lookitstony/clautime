import { readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import log from 'electron-log/main.js'
import {
  isExcludedProjectDir,
  isExcludedProjectPath,
  normalizePath,
  getProjectName
} from '../../shared/paths'
import { codexProvider } from '../providers/codex-provider'
import { encodeProjectPath } from './session-detector'
import { isProviderEnabled } from './provider-tracking'
import type { DiscoveredProject } from '../../shared/types/session'

/**
 * DiscoveryService finds all tracked coding-agent projects:
 * - Claude Code stores project data centrally at ~/.claude/projects/{encoded-path}/
 * - Codex CLI stores per-session rollouts at ~/.codex/sessions/YYYY/MM/DD/ with
 *   the project path (cwd) inside each file's session_meta header.
 */
export const discoveryService = {
  /**
   * Discover all projects from every ~/.claude* profile and ~/.codex/sessions.
   */
  async discoverDefaultProjects(): Promise<DiscoveredProject[]> {
    const projects = await readClaudeProjects()
    return mergeCodexProjects(projects)
  },

  /**
   * Discover projects filtered to only those whose decoded path starts with
   * the given folder.
   */
  async discoverProjectsUnderFolder(folder: string): Promise<DiscoveredProject[]> {
    const all = await mergeCodexProjects(await readClaudeProjects())
    const normalized = folder.replace(/\\/g, '/').toLowerCase()
    return all.filter((p) => p.projectPath.replace(/\\/g, '/').toLowerCase().startsWith(normalized))
  }
}

/** Add Codex-only projects (grouped by session_meta cwd) to a discovery result. */
async function mergeCodexProjects(projects: DiscoveredProject[]): Promise<DiscoveredProject[]> {
  if (!isProviderEnabled('codex')) return projects

  const byEncodedName = new Map(projects.map((p) => [p.encodedName, p]))
  let codexFiles: string[]
  try {
    codexFiles = await codexProvider.discoverFiles()
  } catch {
    return projects
  }
  if (codexFiles.length === 0) return projects

  let added = 0
  for (const file of codexFiles) {
    const meta = await codexProvider.readMeta(file)
    if (!meta?.cwd) continue
    const projectPath = normalizePath(meta.cwd)
    if (isExcludedProjectPath(projectPath)) continue
    const encodedName = encodeProjectPath(projectPath)
    if (byEncodedName.has(encodedName)) continue
    byEncodedName.set(encodedName, {
      projectPath,
      projectName: getProjectName(projectPath),
      encodedName,
      hasClaudeDir: false
    })
    added++
  }
  if (added > 0) log.info(`Discovery: found ${added} Codex-only project(s)`)
  return [...byEncodedName.values()]
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
